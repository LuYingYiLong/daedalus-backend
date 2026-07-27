import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { resolve } from "node:path";
import { getBackendRuntimeRoot } from "../app-paths.js";
import { getDefaultBackendPort } from "../server/backend-runtime.js";
import {
	BACKEND_CONNECTION_ID_ENV,
	readRuntimeConnectionAuthProtocol,
	readRuntimeConnectionMetadata,
	type RuntimeConnectionMetadata
} from "./connection-registry.js";
import { createSelfInvocation } from "./self-invocation.js";

const START_LOCK_STALE_MS: number = 30_000;
const START_TIMEOUT_MS: number = 12_000;
const POLL_INTERVAL_MS: number = 100;

export type SharedRuntimeClient = "studio" | "godot";

export type SharedRuntimeAcquireResult = {
	ok: true;
	leaseId: string;
	client: SharedRuntimeClient;
	url: string;
	authProtocol: string;
	connection: RuntimeConnectionMetadata;
	projectPath?: string | undefined;
};

export type SharedRuntimeStatusResult = {
	ok: true;
	running: boolean;
	connection: RuntimeConnectionMetadata | null;
};

function delay(ms: number): Promise<void> {
	return new Promise<void>((resolveDelay): void => {
		setTimeout(resolveDelay, ms);
	});
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function canConnect(metadata: RuntimeConnectionMetadata): Promise<boolean> {
	if (!isProcessAlive(metadata.pid)) {
		return false;
	}
	return await new Promise<boolean>((resolveProbe): void => {
		const socket = connect({ host: metadata.host, port: metadata.port });
		const finish = (value: boolean): void => {
			socket.removeAllListeners();
			socket.destroy();
			resolveProbe(value);
		};
		socket.setTimeout(750);
		socket.once("connect", (): void => finish(true));
		socket.once("timeout", (): void => finish(false));
		socket.once("error", (): void => finish(false));
	});
}

async function readActiveConnection(): Promise<RuntimeConnectionMetadata | null> {
	const metadata: RuntimeConnectionMetadata | null = await readRuntimeConnectionMetadata();
	return metadata !== null && await canConnect(metadata) ? metadata : null;
}

async function readLockTimestamp(lockPath: string): Promise<number> {
	try {
		const value: unknown = JSON.parse(await readFile(lockPath, "utf8")) as unknown;
		return typeof value === "object"
			&& value !== null
			&& typeof (value as { createdAt?: unknown }).createdAt === "number"
			? (value as { createdAt: number }).createdAt
			: 0;
	} catch {
		return 0;
	}
}

async function acquireStartLock(): Promise<() => Promise<void>> {
	const runtimeRoot: string = getBackendRuntimeRoot();
	const lockDir: string = resolve(runtimeRoot, "start.lock");
	const ownerPath: string = resolve(lockDir, "owner.json");
	await mkdir(runtimeRoot, { recursive: true });
	for (;;) {
		try {
			await mkdir(lockDir);
			await writeFile(ownerPath, JSON.stringify({
				pid: process.pid,
				createdAt: Date.now()
			}), "utf8");
			return async (): Promise<void> => {
				await rm(lockDir, { recursive: true, force: true });
			};
		} catch (error: unknown) {
			const code: string | undefined = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") {
				throw error;
			}
			const createdAt: number = await readLockTimestamp(ownerPath);
			if (createdAt === 0 || Date.now() - createdAt > START_LOCK_STALE_MS) {
				await rm(lockDir, { recursive: true, force: true });
				continue;
			}
			await delay(POLL_INTERVAL_MS);
		}
	}
}

async function waitForConnection(connectionId: string): Promise<RuntimeConnectionMetadata> {
	const deadline: number = Date.now() + START_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const metadata: RuntimeConnectionMetadata | null = await readActiveConnection();
		if (metadata?.connectionId === connectionId) {
			return metadata;
		}
		await delay(POLL_INTERVAL_MS);
	}
	throw new Error("Timed out waiting for the shared Daedalus backend to start.");
}

async function startSharedRuntime(): Promise<RuntimeConnectionMetadata> {
	const invocation = createSelfInvocation(["serve"]);
	const connectionId: string = randomBytes(32).toString("base64url");
	const authToken: string = randomBytes(32).toString("base64url");
	const child = spawn(invocation.command, invocation.args, {
		cwd: process.cwd(),
		detached: true,
		windowsHide: true,
		stdio: "ignore",
		env: {
			...process.env,
			DAEDALUS_BACKEND_MODE: "runtime",
			PORT: String(getDefaultBackendPort("runtime")),
			DAEDALUS_BACKEND_AUTH_TOKEN: authToken,
			[BACKEND_CONNECTION_ID_ENV]: connectionId
		}
	});
	child.unref();
	return await waitForConnection(connectionId);
}

export async function getSharedRuntimeStatus(): Promise<SharedRuntimeStatusResult> {
	const connection: RuntimeConnectionMetadata | null = await readActiveConnection();
	return {
		ok: true,
		running: connection !== null,
		connection
	};
}

export async function acquireSharedRuntime(input: {
	client: SharedRuntimeClient;
	projectPath?: string | undefined;
}): Promise<SharedRuntimeAcquireResult> {
	let connection: RuntimeConnectionMetadata | null = await readActiveConnection();
	if (connection === null) {
		const releaseLock: () => Promise<void> = await acquireStartLock();
		try {
			connection = await readActiveConnection();
			connection ??= await startSharedRuntime();
		} finally {
			await releaseLock();
		}
	}
	const authProtocol: string = await readRuntimeConnectionAuthProtocol(connection.connectionId);
	return {
		ok: true,
		leaseId: `lease-${randomBytes(18).toString("base64url")}`,
		client: input.client,
		url: `ws://${connection.host}:${connection.port}`,
		authProtocol,
		connection,
		...(input.projectPath === undefined ? {} : { projectPath: resolve(input.projectPath) })
	};
}

export function releaseSharedRuntimeLease(leaseId: string): {
	ok: true;
	released: true;
	leaseId: string;
} {
	if (!/^lease-[A-Za-z0-9_-]{16,128}$/u.test(leaseId)) {
		throw new Error("Runtime lease ID is invalid.");
	}
	return { ok: true, released: true, leaseId };
}
