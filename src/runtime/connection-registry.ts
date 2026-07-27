import { mkdir, chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { getBackendConnectionPath } from "../app-paths.js";
import { deleteSecret, readSecret, writeSecret } from "../secrets/secret-store.js";
import { getBackendBuildMetadata } from "./build-metadata.js";

const CONNECTION_SCHEMA_VERSION: 1 = 1;
const CONNECTION_SECRET_SERVICE: string = "Daedalus Backend Runtime Connection";
const AUTH_PROTOCOL_PREFIX: string = "daedalus-auth.";
const CONNECTION_ID_PATTERN: RegExp = /^[A-Za-z0-9_-]{32,128}$/u;

export const BACKEND_CONNECTION_ID_ENV: string = "DAEDALUS_BACKEND_CONNECTION_ID";

export type RuntimeConnectionMetadata = {
	schemaVersion: 1;
	connectionId: string;
	host: "127.0.0.1";
	port: number;
	protocolVersion: number;
	pid: number;
	executablePath: string;
	version: string;
	buildId: string;
	createdAt: string;
	tokenStorage: "credential-manager";
};

export type PublishRuntimeConnectionInput = {
	connectionId: string;
	authToken: string;
	port: number;
};

function assertConnectionId(connectionId: string): string {
	const normalized: string = connectionId.trim();
	if (!CONNECTION_ID_PATTERN.test(normalized)) {
		throw new Error("Runtime connection ID is invalid.");
	}
	return normalized;
}

function getConnectionSecretAccount(connectionId: string): string {
	return `connection:${assertConnectionId(connectionId)}`;
}

function parseRuntimeConnectionMetadata(value: unknown): RuntimeConnectionMetadata | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const record = value as Record<string, unknown>;
	if (
		record.schemaVersion !== CONNECTION_SCHEMA_VERSION
		|| typeof record.connectionId !== "string"
		|| !CONNECTION_ID_PATTERN.test(record.connectionId)
		|| record.host !== "127.0.0.1"
		|| typeof record.port !== "number"
		|| !Number.isSafeInteger(record.port)
		|| record.port <= 0
		|| record.port > 65535
		|| typeof record.protocolVersion !== "number"
		|| !Number.isSafeInteger(record.protocolVersion)
		|| record.protocolVersion <= 0
		|| typeof record.pid !== "number"
		|| !Number.isSafeInteger(record.pid)
		|| record.pid <= 0
		|| typeof record.executablePath !== "string"
		|| !isAbsolute(record.executablePath)
		|| typeof record.version !== "string"
		|| record.version.length === 0
		|| typeof record.buildId !== "string"
		|| record.buildId.length === 0
		|| typeof record.createdAt !== "string"
		|| Number.isNaN(Date.parse(record.createdAt))
		|| record.tokenStorage !== "credential-manager"
	) {
		return null;
	}
	return {
		schemaVersion: CONNECTION_SCHEMA_VERSION,
		connectionId: record.connectionId,
		host: "127.0.0.1",
		port: record.port,
		protocolVersion: record.protocolVersion,
		pid: record.pid,
		executablePath: resolve(record.executablePath),
		version: record.version,
		buildId: record.buildId,
		createdAt: record.createdAt,
		tokenStorage: "credential-manager"
	};
}

export async function readRuntimeConnectionMetadata(): Promise<RuntimeConnectionMetadata | null> {
	try {
		return parseRuntimeConnectionMetadata(
			JSON.parse(await readFile(getBackendConnectionPath(), "utf8")) as unknown
		);
	} catch {
		return null;
	}
}

async function writeMetadataAtomic(metadata: RuntimeConnectionMetadata): Promise<void> {
	const filePath: string = getBackendConnectionPath();
	await mkdir(dirname(filePath), { recursive: true });
	const tempPath: string = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	try {
		await writeFile(tempPath, `${JSON.stringify(metadata, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600
		});
		await rename(tempPath, filePath);
		await chmod(filePath, 0o600).catch((): void => {});
	} finally {
		await rm(tempPath, { force: true }).catch((): void => {});
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export async function publishRuntimeConnection(
	input: PublishRuntimeConnectionInput
): Promise<RuntimeConnectionMetadata> {
	const connectionId: string = assertConnectionId(input.connectionId);
	if (input.authToken.trim().length < 32) {
		throw new Error("Runtime connection token is invalid.");
	}
	if (!Number.isSafeInteger(input.port) || input.port <= 0 || input.port > 65535) {
		throw new Error("Runtime connection port is invalid.");
	}

	const previous: RuntimeConnectionMetadata | null = await readRuntimeConnectionMetadata();
	const build = getBackendBuildMetadata();
	const metadata: RuntimeConnectionMetadata = {
		schemaVersion: CONNECTION_SCHEMA_VERSION,
		connectionId,
		host: "127.0.0.1",
		port: input.port,
		protocolVersion: build.protocolVersion,
		pid: process.pid,
		executablePath: resolve(process.execPath),
		version: build.version,
		buildId: build.buildId,
		createdAt: new Date().toISOString(),
		tokenStorage: "credential-manager"
	};

	await writeSecret(
		CONNECTION_SECRET_SERVICE,
		getConnectionSecretAccount(connectionId),
		input.authToken
	);
	try {
		await writeMetadataAtomic(metadata);
	} catch (error: unknown) {
		await deleteSecret(
			CONNECTION_SECRET_SERVICE,
			getConnectionSecretAccount(connectionId)
		).catch((): boolean => false);
		throw error;
	}

	if (previous !== null && previous.connectionId !== connectionId) {
		await deleteSecret(
			CONNECTION_SECRET_SERVICE,
			getConnectionSecretAccount(previous.connectionId)
		).catch((): boolean => false);
	}
	return metadata;
}

export async function readRuntimeConnectionAuthProtocol(
	connectionIdInput: string
): Promise<string> {
	const connectionId: string = assertConnectionId(connectionIdInput);
	const metadata: RuntimeConnectionMetadata | null = await readRuntimeConnectionMetadata();
	if (
		metadata === null
		|| metadata.connectionId !== connectionId
		|| resolve(metadata.executablePath) !== resolve(process.execPath)
		|| !isProcessAlive(metadata.pid)
	) {
		throw new Error("The requested runtime connection is not active.");
	}
	const token: string | null = await readSecret(
		CONNECTION_SECRET_SERVICE,
		getConnectionSecretAccount(connectionId)
	);
	if (token === null || token.length < 32) {
		throw new Error("The runtime connection credential is unavailable.");
	}
	return `${AUTH_PROTOCOL_PREFIX}${token}`;
}

export async function clearRuntimeConnection(connectionIdInput: string): Promise<void> {
	const connectionId: string = assertConnectionId(connectionIdInput);
	const metadata: RuntimeConnectionMetadata | null = await readRuntimeConnectionMetadata();
	if (metadata?.connectionId === connectionId) {
		await rm(getBackendConnectionPath(), { force: true });
	}
	await deleteSecret(
		CONNECTION_SECRET_SERVICE,
		getConnectionSecretAccount(connectionId)
	).catch((): boolean => false);
}
