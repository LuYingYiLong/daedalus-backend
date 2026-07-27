import type WebSocket from "ws";
import type { WebSocketServer } from "ws";
import { closeLogger, getCurrentBackendLogPath, installProcessLogHandlers, logger } from "./logger.js";
import { McpHost } from "./mcp/mcp-host.js";
import { getBackendBuildMetadata } from "./runtime/build-metadata.js";
import {
	BACKEND_CONNECTION_ID_ENV,
	clearRuntimeConnection,
	publishRuntimeConnection
} from "./runtime/connection-registry.js";
import { startStudioParentMonitor } from "./runtime/parent-monitor.js";
import { registerBackendShutdownHandler } from "./runtime/shutdown.js";
import { closeSessionDatabases } from "./session/session-database.js";
import { cleanupUnsentSessionAttachments } from "./session/session-attachments.js";
import { deleteSession, listTemporarySessions } from "./session/session-store.js";
import { getBackendPortFromEnv } from "./server/backend-runtime.js";
import { createServer, waitForServerListening } from "./server/websocket-server.js";
import {
	getActiveClientConnectionCount,
	hasActiveSessionRuns
} from "./server/client-connections.js";
import { closeUsageMetricsStore, initializeUsageMetricsStore } from "./usage/metrics-store.js";

const SHUTDOWN_TIMEOUT_MS: number = 10_000;
const SHARED_RUNTIME_IDLE_TIMEOUT_MS: number = 60_000;
const SHARED_RUNTIME_IDLE_POLL_MS: number = 5_000;

export type BackendApplication = {
	server: WebSocketServer;
	mcpHost: McpHost;
	close(reason?: string): Promise<void>;
};

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
	for (const client of server.clients as Set<WebSocket>) {
		client.close(1001, "Daedalus backend is shutting down");
	}
	await new Promise<void>((resolve): void => {
		server.close((): void => resolve());
	});
}

export async function startBackendApplication(): Promise<BackendApplication> {
	const port: number = getBackendPortFromEnv();
	const build = getBackendBuildMetadata();

	installProcessLogHandlers();
	logger.info("backend", "starting", {
		port,
		pid: process.pid,
		mode: process.env.DAEDALUS_BACKEND_MODE ?? "development",
		version: build.version,
		buildId: build.buildId,
		distribution: build.distribution,
		logPath: getCurrentBackendLogPath()
	});
	await initializeUsageMetricsStore();
	try {
		const temporarySessions = await listTemporarySessions();
		for (const temporarySession of temporarySessions) {
			await deleteSession(temporarySession.id);
		}
		const removedAttachmentCount: number = await cleanupUnsentSessionAttachments();
		logger.info("session", "startup_draft_cleanup_completed", {
			removedTemporarySessions: temporarySessions.length,
			removedUnsentAttachments: removedAttachmentCount
		});
	} catch (error: unknown) {
		logger.warn("session", "startup_draft_cleanup_failed", {
			error: error instanceof Error ? error.message : String(error)
		});
	}

	const mcpHost: McpHost = new McpHost();
	try {
		await mcpHost.connectAll();
	} catch (error: unknown) {
		logger.warn("mcp", "connect_all_failed", {
			error: error instanceof Error ? error.message : error
		}, "Server will start without MCP support");
	}

	const server: WebSocketServer = createServer(port, mcpHost, {
		host: "127.0.0.1",
		authToken: process.env.DAEDALUS_BACKEND_AUTH_TOKEN
	});
	try {
		await waitForServerListening(server);
	} catch (error: unknown) {
		const message: string = error instanceof Error ? error.message : String(error);
		logger.error("backend", "startup_failed", error, { port });
		await mcpHost.closeAll();
		await Promise.all([
			closeSessionDatabases(),
			closeUsageMetricsStore()
		]);
		await closeLogger();
		throw new Error(`Daedalus backend could not listen on 127.0.0.1:${port}: ${message}`);
	}
	const runtimeConnectionId: string | null =
		process.env[BACKEND_CONNECTION_ID_ENV]?.trim() || null;
	const runtimeAuthToken: string | null =
		process.env.DAEDALUS_BACKEND_AUTH_TOKEN?.trim() || null;
	if ((runtimeConnectionId === null) !== (runtimeAuthToken === null)) {
		await closeWebSocketServer(server);
		await mcpHost.closeAll();
		throw new Error(
			"DAEDALUS_BACKEND_CONNECTION_ID and DAEDALUS_BACKEND_AUTH_TOKEN must be configured together."
		);
	}
	if (runtimeConnectionId !== null && runtimeAuthToken !== null) {
		try {
			await publishRuntimeConnection({
				connectionId: runtimeConnectionId,
				authToken: runtimeAuthToken,
				port
			});
		} catch (error: unknown) {
			await closeWebSocketServer(server);
			await mcpHost.closeAll();
			await Promise.all([
				closeSessionDatabases(),
				closeUsageMetricsStore()
			]);
			await closeLogger();
			throw error;
		}
	}
	let closePromise: Promise<void> | null = null;
	const close = async (reason: string = "requested"): Promise<void> => {
		closePromise ??= (async (): Promise<void> => {
			logger.info("backend", "shutdown_started", { reason });
			const timeout = setTimeout((): void => {
				logger.error("backend", "shutdown_timeout", new Error("Backend graceful shutdown timed out."));
				process.exitCode = 1;
			}, SHUTDOWN_TIMEOUT_MS);
			timeout.unref();
			try {
				await closeWebSocketServer(server);
				await mcpHost.closeAll();
				await Promise.all([
					closeSessionDatabases(),
					closeUsageMetricsStore(),
					...(runtimeConnectionId === null
						? []
						: [clearRuntimeConnection(runtimeConnectionId)])
				]);
				logger.info("backend", "shutdown_completed", { reason });
			} finally {
				clearTimeout(timeout);
				await closeLogger();
			}
		})();
		return closePromise;
	};

	return { server, mcpHost, close };
}

export async function runBackendUntilShutdown(): Promise<void> {
	const application: BackendApplication = await startBackendApplication();
	let shuttingDown: boolean = false;
	let stopParentMonitor: () => void = (): void => {};
	let idleSince: number | null = null;
	const shutdown = (reason: string): Promise<void> => {
		if (shuttingDown) {
			return Promise.resolve();
		}
		shuttingDown = true;
		stopParentMonitor();
		return application.close(reason).finally((): void => {
			registerBackendShutdownHandler(null);
			process.exit(process.exitCode ?? 0);
		});
	};
	registerBackendShutdownHandler(shutdown);
	stopParentMonitor = startStudioParentMonitor((): void => {
		void shutdown("studio_parent_exited");
	});
	process.once("SIGINT", (): void => {
		void shutdown("SIGINT");
	});
	process.once("SIGTERM", (): void => {
		void shutdown("SIGTERM");
	});
	if (process.env.DAEDALUS_BACKEND_MODE === "runtime") {
		const idleTimer: NodeJS.Timeout = setInterval((): void => {
			if (getActiveClientConnectionCount() > 0 || hasActiveSessionRuns()) {
				idleSince = null;
				return;
			}
			idleSince ??= Date.now();
			if (Date.now() - idleSince >= SHARED_RUNTIME_IDLE_TIMEOUT_MS) {
				clearInterval(idleTimer);
				void shutdown("shared_runtime_idle");
			}
		}, SHARED_RUNTIME_IDLE_POLL_MS);
		idleTimer.unref();
	}
}
