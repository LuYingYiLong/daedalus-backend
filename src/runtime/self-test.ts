import { DatabaseSync } from "node:sqlite";
import { isSea } from "node:sea";
import { runSecretStoreSelfTest } from "../secrets/secret-store.js";
import { getBackendBuildMetadata } from "./build-metadata.js";
import {
	materializeRuntimeAsset,
	readRuntimeAsset,
	RUNTIME_ASSET_PATHS,
	type RuntimeAssetKey
} from "./runtime-assets.js";

export type SelfTestCheck = {
	name: string;
	ok: boolean;
	details?: string | undefined;
};

export type BackendSelfTestResult = {
	ok: boolean;
	build: ReturnType<typeof getBackendBuildMetadata>;
	checks: SelfTestCheck[];
};

async function runCheck(name: string, operation: () => Promise<string | void> | string | void): Promise<SelfTestCheck> {
	try {
		const details: string | void = await operation();
		return {
			name,
			ok: true,
			...(typeof details === "string" && details.length > 0 ? { details } : {})
		};
	} catch (error: unknown) {
		return {
			name,
			ok: false,
			details: error instanceof Error ? error.message : String(error)
		};
	}
}

function verifySqlite(): string {
	const database = new DatabaseSync(":memory:");
	try {
		database.exec("CREATE TABLE self_test (value TEXT NOT NULL)");
		database.prepare("INSERT INTO self_test (value) VALUES (?)").run("ok");
		const row = database.prepare("SELECT value FROM self_test").get() as { value?: unknown } | undefined;
		if (row?.value !== "ok") {
			throw new Error("SQLite round trip failed.");
		}
		const integrity = database.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown } | undefined;
		if (integrity?.integrity_check !== "ok") {
			throw new Error(`SQLite integrity check failed: ${String(integrity?.integrity_check)}`);
		}
		database.exec("CREATE VIRTUAL TABLE self_test_fts USING fts5(value, tokenize = 'unicode61')");
		database.prepare("INSERT INTO self_test_fts (value) VALUES (?)").run("Godot documentation");
		const ftsRow = database.prepare("SELECT value FROM self_test_fts WHERE self_test_fts MATCH ?").get("Godot") as
			| { value?: unknown }
			| undefined;
		if (ftsRow?.value !== "Godot documentation") {
			throw new Error("SQLite FTS5 round trip failed.");
		}
		return process.versions.sqlite ?? "available";
	} finally {
		database.close();
	}
}

async function verifyEmbeddedAssets(): Promise<string> {
	let totalBytes: number = 0;
	for (const key of Object.keys(RUNTIME_ASSET_PATHS) as RuntimeAssetKey[]) {
		if (key === "native.keytar.win32-x64") {
			continue;
		}
		const content: Buffer = await readRuntimeAsset(key);
		if (content.byteLength === 0) {
			throw new Error(`Runtime asset is empty: ${key}`);
		}
		totalBytes += content.byteLength;
	}
	await materializeRuntimeAsset("godot.operationsScript");
	return `${Object.keys(RUNTIME_ASSET_PATHS).length - 1} assets, ${totalBytes} bytes`;
}

export async function runBackendSelfTest(options: {
	requireSecretStore?: boolean | undefined;
} = {}): Promise<BackendSelfTestResult> {
	const checks: SelfTestCheck[] = [];
	checks.push(await runCheck("runtime-assets", verifyEmbeddedAssets));
	checks.push(await runCheck("sqlite", verifySqlite));
	if (options.requireSecretStore === true || isSea()) {
		checks.push(await runCheck("secret-store", runSecretStoreSelfTest));
	}

	return {
		ok: checks.every((check: SelfTestCheck): boolean => check.ok),
		build: getBackendBuildMetadata(),
		checks
	};
}
