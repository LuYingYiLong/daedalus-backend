import WebSocket, { type VerifyClientCallbackSync, WebSocketServer } from "ws";
import { clientRequestEnvelopeSchema } from "../protocol/schema.js";
import type { ClientRequest } from "../protocol/types.js";
import type { McpHost } from "../mcp/mcp-host.js";
import { getDefaultWorkspace } from "../workspace/registry.js";
import { updateSessionMetadata } from "../session/session-store.js";
import { createClientSession, type ClientSession } from "./client-session.js";
import { dispatchRequest } from "./request-dispatcher.js";
import { sendJson } from "./send-json.js";
import {
	beginRequestExecution,
	finishRequestExecution,
	parseMessage
} from "./request-lifecycle.js";
import { waitForFullSessionLoad } from "./session-preview.js";
import {
	waitForSessionEventPersistence
} from "./session-events.js";
import { createRuntimeSessionUiMetadata } from "./session-ui-metadata.js";
import { pauseAgentGoalAfterDisconnect } from "./goal-controller.js";
import { getClientConnection, getConnectionSession, hasOtherConnectionsForSession, registerClientConnection, unregisterClientConnection } from "./client-connections.js";
import { withMcpRequestContext } from "../mcp/request-context.js";
import { logger } from "../logger.js";
import { timingSafeEqual } from "node:crypto";
import { BACKEND_PROTOCOL_VERSION } from "../runtime/build-metadata.js";

export type WebSocketServerRuntimeOptions = {
	host?: string | undefined;
	authToken?: string | undefined;
};

function sendProtocolError(socket: WebSocket, code: string, message: string, requestId: string = ""): void {
	sendJson(socket, {
		type: "response",
		id: requestId,
		ok: false,
		error: {
			code,
			message
		}
	});
}

export function isUnsupportedProtocolEnvelope(value: unknown): value is { id?: unknown } {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}

	const record: Record<string, unknown> = value as Record<string, unknown>;
	if (record.type !== "request") {
		return false;
	}

	return record.protocolVersion !== BACKEND_PROTOCOL_VERSION;
}

export function getProtocolErrorRequestId(value: unknown): string {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return "";
	}
	const record: Record<string, unknown> = value as Record<string, unknown>;
	return record.type === "request" && typeof record.id === "string"
		? record.id
		: "";
}

function parseClientRequest(socket: WebSocket, data: WebSocket.RawData, isBinary: boolean): ClientRequest | null {
	let parsedMessage: unknown;

	try {
		parsedMessage = parseMessage(data, isBinary);
	} catch (error: unknown) {
		logger.warn("rpc", "parse_failed", {
			code: "parse_error",
			message: error instanceof Error ? error.message : "Invalid message",
			isBinary
		});
		sendProtocolError(socket, "parse_error", error instanceof Error ? error.message : "Invalid message");
		return null;
	}
	if (isUnsupportedProtocolEnvelope(parsedMessage)) {
		sendProtocolError(
			socket,
			"protocol_version_unsupported",
			`Daedalus backend requires protocolVersion: ${BACKEND_PROTOCOL_VERSION}. Upgrade Daedalus Studio or the Godot plugin before reconnecting.`,
			typeof parsedMessage.id === "string" ? parsedMessage.id : ""
		);
		return null;
	}

	const validationResult = clientRequestEnvelopeSchema.safeParse(parsedMessage);
	if (!validationResult.success) {
		logger.warn("rpc", "invalid_request", {
			code: "invalid_request",
			issueCount: validationResult.error.issues.length,
			firstIssueCode: validationResult.error.issues[0]?.code ?? "unknown"
		});
		sendProtocolError(
			socket,
			"invalid_request",
			validationResult.error.message,
			getProtocolErrorRequestId(parsedMessage)
		);
		return null;
	}

	return validationResult.data;
}

function sendUnhandledRequestError(socket: WebSocket, request: ClientRequest, error: unknown): void {
	logger.error("rpc", "unhandled_request_error", error, {
		requestId: request.id,
		method: request.method
	});
	const storageError = error as Error & { code?: string };
	if (storageError.code === "session_storage_unavailable") {
		sendProtocolError(
			socket,
			"session_storage_unavailable",
			storageError.message,
			request.id
		);
		return;
	}
	sendProtocolError(socket, "internal_error", error instanceof Error ? error.message : "Unhandled request error", request.id);
}

function getRemoteAddress(request: Parameters<WebSocketServer["emit"]>[1]): string {
	return request?.socket?.remoteAddress ?? "unknown";
}

function createSessionForConnection(): ClientSession {
	return createClientSession(getDefaultWorkspace());
}

function attachEditorBridgeSocket(socket: WebSocket, mcpHost: McpHost): void {
	mcpHost.getEditorBridge().attachSocket(socket);
}

function detachEditorBridgeSocket(socket: WebSocket, mcpHost: McpHost): void {
	mcpHost.getEditorBridge().detachSocket(socket);
}

function abortActiveRequests(session: ClientSession): void {
	for (const controller of session.activeAbortControllers.values()) {
		controller.abort();
	}
	session.activeAbortControllers.clear();
}

function shouldAutoSaveSession(session: ClientSession): boolean {
	return session.sessionId !== undefined && session.messages.length > 0;
}

async function saveSessionOnDisconnect(session: ClientSession): Promise<void> {
	await waitForFullSessionLoad(session);
	await waitForSessionEventPersistence(session);
	const sessionId: string | undefined = session.sessionId;
	if (sessionId === undefined || !shouldAutoSaveSession(session)) {
		return;
	}

	await updateSessionMetadata(sessionId, {
		...createRuntimeSessionUiMetadata(session),
	});
}

function scheduleSessionSaveOnDisconnect(session: ClientSession): void {
	void saveSessionOnDisconnect(session).catch((error: unknown): void => {
		logger.error("session", "disconnect_save_failed", error, {
			sessionId: session.sessionId
		});
	});
}

function handleSocketError(error: Error): void {
	logger.error("websocket", "socket_error", error);
}

function handleServerHeaders(headers: string[]): void {
	headers.push("X-Godot-Daedalus: websocket");
}

function handleServerListening(port: number, host: string): void {
	logger.info("websocket", "listening", {
		port,
		host,
		authenticationRequired: (process.env.DAEDALUS_BACKEND_AUTH_TOKEN?.length ?? 0) > 0
	}, `WebSocket server listening on ws://${host}:${port}`);
}

function handleServerError(error: Error): void {
	logger.error("websocket", "server_error", error);
}

function handleSocketMessage(
	socket: WebSocket,
	data: WebSocket.RawData,
	isBinary: boolean,
	session: ClientSession,
	mcpHost: McpHost
): void {
	const connectionSession: ClientSession = getConnectionSession(socket) ?? session;
	const requestData: ClientRequest | null = parseClientRequest(socket, data, isBinary);
	if (requestData === null) {
		return;
	}
	if (!beginRequestExecution(socket, requestData, connectionSession)) {
		logger.debug("rpc", "duplicate_request_ignored", {
			requestId: requestData.id,
			method: requestData.method,
			sessionId: connectionSession.sessionId,
			workspaceId: connectionSession.activeWorkspace?.id
		});
		return;
	}

	const startedAtMs: number = Date.now();
	logger.debug("rpc", "request_started", {
		requestId: requestData.id,
		method: requestData.method,
		sessionId: connectionSession.sessionId,
		workspaceId: connectionSession.activeWorkspace?.id,
		editorInstanceId: getClientConnection(socket)?.editorInstanceId,
		clientType: getClientConnection(socket)?.clientType
	});
	let failed: boolean = false;
	withMcpRequestContext({
		workspaceId: connectionSession.activeWorkspace?.id,
		editorInstanceId: connectionSession.editorInstanceId
	}, async (): Promise<void> => {
		await dispatchRequest(socket, requestData, connectionSession, mcpHost);
	}).catch((error: unknown): void => {
		failed = true;
		sendUnhandledRequestError(socket, requestData, error);
	}).finally((): void => {
		// 成功 RPC 包含健康检查、心跳和 UI 轮询，仅在传输排障时保留。
		logger.debug("rpc", "request_finished", {
			requestId: requestData.id,
			method: requestData.method,
			sessionId: connectionSession.sessionId,
			workspaceId: connectionSession.activeWorkspace?.id,
			editorInstanceId: getClientConnection(socket)?.editorInstanceId,
			clientType: getClientConnection(socket)?.clientType,
			durationMs: Date.now() - startedAtMs,
			failed
		});
		finishRequestExecution(requestData, connectionSession);
	});
}

function handleSocketClose(socket: WebSocket, session: ClientSession, mcpHost: McpHost, remoteAddress: string): void {
	const connectionSession: ClientSession = getConnectionSession(socket) ?? session;
	const disconnectedClientType = getClientConnection(socket)?.clientType;
	const hasOtherConnections: boolean = hasOtherConnectionsForSession(socket, connectionSession.sessionId);
	if (disconnectedClientType === "studio" && connectionSession.sessionId !== undefined) {
		void pauseAgentGoalAfterDisconnect(connectionSession.sessionId).catch((error: unknown): void => {
			logger.warn("goal", "disconnect_pause_failed", { error: error instanceof Error ? error.message : String(error) });
		});
	}
	detachEditorBridgeSocket(socket, mcpHost);
	unregisterClientConnection(socket);
	if (!hasOtherConnections) {
		abortActiveRequests(connectionSession);
		scheduleSessionSaveOnDisconnect(connectionSession);
	}
	logger.debug("websocket", "client_disconnected", {
		remoteAddress,
		sessionId: connectionSession.sessionId,
		workspaceId: connectionSession.activeWorkspace?.id
	});
}

function attachSocketHandlers(socket: WebSocket, session: ClientSession, mcpHost: McpHost, remoteAddress: string): void {
	socket.on("error", handleSocketError);
	socket.on("message", (data: WebSocket.RawData, isBinary: boolean): void => {
		handleSocketMessage(socket, data, isBinary, session, mcpHost);
	});
	socket.on("close", (): void => {
		handleSocketClose(socket, session, mcpHost, remoteAddress);
	});
}

function handleConnection(socket: WebSocket, request: Parameters<WebSocketServer["emit"]>[1], mcpHost: McpHost): void {
	const session: ClientSession = createSessionForConnection();
	const remoteAddress: string = getRemoteAddress(request);
	logger.debug("websocket", "client_connected", {
		remoteAddress
	});

	registerClientConnection(socket, session);
	attachEditorBridgeSocket(socket, mcpHost);
	attachSocketHandlers(socket, session, mcpHost, remoteAddress);
}

export const WEBSOCKET_AUTH_PROTOCOL_PREFIX: string = "daedalus-auth.";

function tokensMatch(actualToken: string, expectedToken: string): boolean {
	const expected: Buffer = Buffer.from(expectedToken, "utf8");
	const actual: Buffer = Buffer.from(actualToken, "utf8");
	return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function readProtocolAuthToken(headerValue: string | string[] | undefined): string | null {
	const protocols: string[] = (Array.isArray(headerValue) ? headerValue : [headerValue ?? ""])
		.flatMap((value: string): string[] => value.split(","))
		.map((value: string): string => value.trim());
	const authProtocol: string | undefined = protocols.find(
		(value: string): boolean => value.startsWith(WEBSOCKET_AUTH_PROTOCOL_PREFIX)
	);
	return authProtocol?.slice(WEBSOCKET_AUTH_PROTOCOL_PREFIX.length) ?? null;
}

export function matchesWebSocketAuth(
	authorizationHeader: string | undefined,
	protocolHeader: string | string[] | undefined,
	expectedToken: string | undefined
): boolean {
	if (expectedToken === undefined || expectedToken.length === 0) {
		return true;
	}
	if (authorizationHeader !== undefined && authorizationHeader.startsWith("Bearer ")) {
		return tokensMatch(authorizationHeader.slice("Bearer ".length), expectedToken);
	}
	const protocolToken: string | null = readProtocolAuthToken(protocolHeader);
	return protocolToken !== null && tokensMatch(protocolToken, expectedToken);
}

export function createServer(
	port: number,
	mcpHost: McpHost,
	options: WebSocketServerRuntimeOptions = {}
): WebSocketServer {
	const host: string = options.host ?? "127.0.0.1";
	const verifyClient: VerifyClientCallbackSync = ({ req }): boolean =>
		matchesWebSocketAuth(
			req.headers.authorization,
			req.headers["sec-websocket-protocol"],
			options.authToken
		);
	const server: WebSocketServer = new WebSocketServer({
		port,
		host,
		verifyClient
	});

	server.on("headers", handleServerHeaders);
	server.on("connection", (socket: WebSocket, request): void => {
		handleConnection(socket, request, mcpHost);
	});
	server.on("listening", (): void => {
		handleServerListening(port, host);
	});
	server.on("error", handleServerError);

	return server;
}

export function waitForServerListening(server: WebSocketServer): Promise<void> {
	if (server.address() !== null) {
		return Promise.resolve();
	}

	return new Promise<void>((resolve, reject): void => {
		const cleanup = (): void => {
			server.off("listening", handleListening);
			server.off("error", handleError);
		};
		const handleListening = (): void => {
			cleanup();
			resolve();
		};
		const handleError = (error: Error): void => {
			cleanup();
			reject(error);
		};

		server.once("listening", handleListening);
		server.once("error", handleError);
	});
}
