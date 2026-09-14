import { randomBytes } from "node:crypto";
import { isSea } from "node:sea";
import { getBackendNativeRoot } from "../app-paths.js";
import { materializeRuntimeAsset } from "../runtime/runtime-assets.js";

declare const __DAEDALUS_SEA_BUILD__: boolean | undefined;

export type SecretStoreDriver = {
	getPassword(service: string, account: string): Promise<string | null>;
	setPassword(service: string, account: string, password: string): Promise<void>;
	deletePassword(service: string, account: string): Promise<boolean>;
};

const KEYTAR_MODULE_NAME: string = "keytar";

let cachedDriver: Promise<SecretStoreDriver | null> | null = null;
let testDriver: SecretStoreDriver | null | undefined;

export class SecretStoreUnavailableError extends Error {
	readonly code: "secret_store_unavailable" = "secret_store_unavailable";

	constructor(message: string = "System secret storage is unavailable. Install the optional keytar native module or configure a supported system keychain.") {
		super(message);
		this.name = "SecretStoreUnavailableError";
	}
}

function isSecretStoreDriver(value: unknown): value is SecretStoreDriver {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const record: Partial<SecretStoreDriver> = value as Partial<SecretStoreDriver>;
	return typeof record.getPassword === "function"
		&& typeof record.setPassword === "function"
		&& typeof record.deletePassword === "function";
}

async function importKeytarDriver(): Promise<SecretStoreDriver | null> {
	if (
		(typeof __DAEDALUS_SEA_BUILD__ !== "undefined" && __DAEDALUS_SEA_BUILD__)
		|| isSea()
	) {
		return loadEmbeddedKeytarDriver();
	}

	try {
		const imported: unknown = await import(KEYTAR_MODULE_NAME);
		const candidate: unknown = typeof imported === "object" && imported !== null && "default" in imported
			? (imported as { default?: unknown }).default
			: imported;
		return isSecretStoreDriver(candidate) ? candidate : null;
	} catch {
		return null;
	}
}

async function loadEmbeddedKeytarDriver(): Promise<SecretStoreDriver | null> {
	if (process.arch !== "x64"
				|| (process.platform !== "win32" && process.platform !== "linux")) {
		return null;
	}

	try {
		const keytarAsset: "native.keytar.win32-x64" | "native.keytar.linux-x64" =
				process.platform === "win32"
						? "native.keytar.win32-x64"
						: "native.keytar.linux-x64";
		const nativeAsset = await materializeRuntimeAsset(keytarAsset, {
			rootDir: getBackendNativeRoot(),
			fileName: "keytar.node"
		});
		const nativeModule: { exports: unknown } = { exports: {} };
		process.dlopen(nativeModule, nativeAsset.path);
		return isSecretStoreDriver(nativeModule.exports) ? nativeModule.exports : null;
	} catch {
		return null;
	}
}

async function loadSecretStoreDriver(): Promise<SecretStoreDriver | null> {
	if (testDriver !== undefined) {
		return testDriver;
	}

	cachedDriver ??= importKeytarDriver();
	return cachedDriver;
}

export function setSecretStoreDriverForTests(driver: SecretStoreDriver | null | undefined): void {
	testDriver = driver;
	cachedDriver = null;
}

export async function isSecretStoreAvailable(): Promise<boolean> {
	return (await loadSecretStoreDriver()) !== null;
}

export async function runSecretStoreSelfTest(): Promise<void> {
	const driver: SecretStoreDriver | null = await loadSecretStoreDriver();
	if (driver === null) {
		throw new SecretStoreUnavailableError();
	}

	const service: string = "Daedalus Backend Self Test";
	const account: string = `self-test-${process.pid}-${randomBytes(8).toString("hex")}`;
	const expectedValue: string = randomBytes(24).toString("base64url");
	try {
		await driver.setPassword(service, account, expectedValue);
		const actualValue: string | null = await driver.getPassword(service, account);
		if (actualValue !== expectedValue) {
			throw new Error("System secret store returned an unexpected value.");
		}
	} finally {
		await driver.deletePassword(service, account).catch((): boolean => false);
	}
}

export async function readSecret(service: string, account: string): Promise<string | null> {
	const driver: SecretStoreDriver | null = await loadSecretStoreDriver();
	if (driver === null) {
		return null;
	}

	try {
		return await driver.getPassword(service, account);
	} catch {
		return null;
	}
}

export async function writeSecret(service: string, account: string, value: string): Promise<void> {
	const driver: SecretStoreDriver | null = await loadSecretStoreDriver();
	if (driver === null) {
		throw new SecretStoreUnavailableError();
	}

	await driver.setPassword(service, account, value);
}

export async function deleteSecret(service: string, account: string): Promise<boolean> {
	const driver: SecretStoreDriver | null = await loadSecretStoreDriver();
	if (driver === null) {
		return false;
	}

	return driver.deletePassword(service, account);
}
