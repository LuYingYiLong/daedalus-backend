import WebSocket from "ws";
import { SessionRuntimeRegistry } from "../application/session-runtime-registry.js";
import type { ServerEvent } from "../protocol/types.js";
import type { ClientSession } from "./client-session.js";
import { sendJson } from "./send-json.js";
import { sessionSearchService } from "../session-search/service.js";

export type ClientType = "godot_editor_bridge" | "studio" | "studio_remote" | "studio_scheduler" | "cli" | "smoke" | "external_mcp" | "legacy";

export type ClientCapabilities = Partial<Record<
	"editorTools" | "editorUndoRedo" | "sceneViewCapture" | "inlineDiffUndo" | "inlineDiffView" | "sessionSubscribe" | "approval" | "externalMcp" | "browserTools" | "computerObservation" | "computerControl" | "scheduledTasks" | "scheduledTaskReport" | "remoteControl",
	boolean
>>;

export function isStudioSessionClientType(clientType: ClientType | undefined): boolean {
	return clientType === "studio" || clientType === "studio_remote";
}

export type ClientConnectionInfo = {
	connectionId: string;
	clientType: ClientType;
	clientName: string;
	connectedAt: string;
	workspaceId?: string | undefined;
	workspaceRoot?: string | undefined;
	editorInstanceId?: string | undefined;
	bridgeProtocolVersion?: number | undefined;
	bridgeHandshakeAccepted: boolean;
	capabilities: ClientCapabilities;
};

export type ClientActorSummary = {
	clientType: ClientType;
	clientName: string;
	connectionId: string;
};

type ConnectionRecord = ClientConnectionInfo & {
	socket: WebSocket;
	session: ClientSession;
	subscribedSessionIds: Set<string>;
};

const socketConnections: Map<WebSocket, ConnectionRecord> = new Map();
const sessionSubscribers: Map<string, Set<WebSocket>> = new Map();
const activeSessionRuns: Map<string, string> = new Map();
const activeSessionRunControllers: Map<string, AbortController> = new Map();
const sessionRuntimes: SessionRuntimeRegistry<ClientSession> = new SessionRuntimeRegistry<ClientSession>();

function createConnectionId(): string {
	return `conn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function toPublicInfo(record: ConnectionRecord): ClientConnectionInfo {
	return {
		connectionId: record.connectionId,
		clientType: record.clientType,
		clientName: record.clientName,
		connectedAt: record.connectedAt,
		workspaceId: record.workspaceId,
		workspaceRoot: record.workspaceRoot,
		editorInstanceId: record.editorInstanceId,
		bridgeProtocolVersion: record.bridgeProtocolVersion,
		bridgeHandshakeAccepted: record.bridgeHandshakeAccepted,
		capabilities: { ...record.capabilities }
	};
}

export function registerClientConnection(socket: WebSocket, session: ClientSession): ClientConnectionInfo {
	const existing: ConnectionRecord | undefined = socketConnections.get(socket);
	if (existing !== undefined) {
		return toPublicInfo(existing);
	}

	const record: ConnectionRecord = {
		socket,
		session,
		connectionId: createConnectionId(),
		clientType: "legacy",
		clientName: "Legacy Client",
		connectedAt: new Date().toISOString(),
		bridgeHandshakeAccepted: false,
		capabilities: {},
		subscribedSessionIds: new Set()
	};
	socketConnections.set(socket, record);
	return toPublicInfo(record);
}

export function unregisterClientConnection(socket: WebSocket): ClientConnectionInfo | null {
	const record: ConnectionRecord | undefined = socketConnections.get(socket);
	if (record === undefined) {
		return null;
	}

	for (const sessionId of record.subscribedSessionIds) {
		const subscribers: Set<WebSocket> | undefined = sessionSubscribers.get(sessionId);
		subscribers?.delete(socket);
		if (subscribers !== undefined && subscribers.size === 0) {
			sessionSubscribers.delete(sessionId);
		}
	}
	socketConnections.delete(socket);
	sessionSearchService.releaseOwner(record.connectionId);
	return toPublicInfo(record);
}

export function updateClientConnection(socket: WebSocket, update: {
	clientType?: ClientType | undefined;
	clientName?: string | undefined;
	workspaceId?: string | null | undefined;
	workspaceRoot?: string | null | undefined;
	editorInstanceId?: string | undefined;
	bridgeProtocolVersion?: number | undefined;
	bridgeHandshakeAccepted?: boolean | undefined;
	capabilities?: ClientCapabilities | undefined;
}): ClientConnectionInfo {
	const record: ConnectionRecord | undefined = socketConnections.get(socket);
	if (record === undefined) {
		throw new Error("Client connection is not registered");
	}

	record.clientType = update.clientType ?? record.clientType;
	record.clientName = update.clientName ?? record.clientName;
	if (Object.hasOwn(update, "workspaceId")) {
		record.workspaceId = update.workspaceId ?? undefined;
	}
	if (Object.hasOwn(update, "workspaceRoot")) {
		record.workspaceRoot = update.workspaceRoot ?? undefined;
	}
	record.editorInstanceId = update.editorInstanceId ?? record.editorInstanceId;
	record.bridgeProtocolVersion = update.bridgeProtocolVersion ?? record.bridgeProtocolVersion;
	record.bridgeHandshakeAccepted = update.bridgeHandshakeAccepted ?? record.bridgeHandshakeAccepted;
	record.capabilities = update.capabilities ?? record.capabilities;
	return toPublicInfo(record);
}

export function updateClientConnectionsForSession(sessionId: string, update: {
	workspaceId: string | null;
	workspaceRoot: string | null;
	editorInstanceId?: string | null;
}): void {
	for (const record of socketConnections.values()) {
		if (record.session.sessionId !== sessionId) {
			continue;
		}
		record.workspaceId = update.workspaceId ?? undefined;
		record.workspaceRoot = update.workspaceRoot ?? undefined;
		if (update.editorInstanceId !== undefined) {
			record.editorInstanceId = update.editorInstanceId ?? undefined;
		}
	}
}

export function getClientConnection(socket: WebSocket): ClientConnectionInfo | null {
	const record: ConnectionRecord | undefined = socketConnections.get(socket);
	return record === undefined ? null : toPublicInfo(record);
}

export function getConnectionSession(socket: WebSocket): ClientSession | undefined {
	return socketConnections.get(socket)?.session;
}

export function getActiveConnectionSessions(): ClientSession[] {
	return Array.from(new Set(Array.from(socketConnections.values()).map((record: ConnectionRecord): ClientSession => record.session)));
}

export function getActiveClientConnectionCount(): number {
	return socketConnections.size;
}

export function getActiveClientTypeCounts(): Partial<Record<ClientType, number>> {
	const counts: Partial<Record<ClientType, number>> = {};
	for (const record of socketConnections.values()) {
		counts[record.clientType] = (counts[record.clientType] ?? 0) + 1;
	}
	return counts;
}

export function hasActiveSessionRuns(): boolean {
	return activeSessionRuns.size > 0;
}

export function hasOtherConnectionsForSession(socket: WebSocket, sessionId: string | undefined): boolean {
	if (sessionId === undefined) {
		return false;
	}

	for (const [candidateSocket, record] of socketConnections) {
		if (candidateSocket !== socket && record.session.sessionId === sessionId) {
			return true;
		}
	}
	return false;
}

export function getSessionRuntime(sessionId: string): ClientSession | undefined {
	return sessionRuntimes.get(sessionId);
}

export function bindConnectionToSessionRuntime(socket: WebSocket, sessionId: string, candidate: ClientSession): ClientSession {
	const record: ConnectionRecord | undefined = socketConnections.get(socket);
	if (record === undefined) {
		return candidate;
	}

	const runtime: ClientSession = sessionRuntimes.bind(sessionId, candidate);
	record.session = runtime;
	return runtime;
}

export function subscribeSocketToSession(socket: WebSocket, sessionId: string): void {
	const record: ConnectionRecord | undefined = socketConnections.get(socket);
	if (record === undefined) {
		return;
	}

	let subscribers: Set<WebSocket> | undefined = sessionSubscribers.get(sessionId);
	if (subscribers === undefined) {
		subscribers = new Set();
		sessionSubscribers.set(sessionId, subscribers);
	}
	subscribers.add(socket);
	record.subscribedSessionIds.add(sessionId);
}

export function unsubscribeSocketFromSession(socket: WebSocket, sessionId: string): void {
	const record: ConnectionRecord | undefined = socketConnections.get(socket);
	record?.subscribedSessionIds.delete(sessionId);
	const subscribers: Set<WebSocket> | undefined = sessionSubscribers.get(sessionId);
	subscribers?.delete(socket);
	if (subscribers !== undefined && subscribers.size === 0) {
		sessionSubscribers.delete(sessionId);
	}
}

export function getSessionSubscriberInfos(sessionId: string): ClientConnectionInfo[] {
	const subscribers: Set<WebSocket> | undefined = sessionSubscribers.get(sessionId);
	if (subscribers === undefined) {
		return [];
	}

	return Array.from(subscribers)
		.map((socket: WebSocket): ConnectionRecord | undefined => socketConnections.get(socket))
		.filter((record: ConnectionRecord | undefined): record is ConnectionRecord => record !== undefined)
		.map(toPublicInfo);
}

export function broadcastSessionEvent(
	originSocket: WebSocket,
	sessionId: string,
	envelope: ServerEvent
): void {
	const subscribers: Set<WebSocket> | undefined = sessionSubscribers.get(sessionId);
	if (subscribers === undefined) {
		return;
	}

	for (const socket of subscribers) {
		if (socket === originSocket || socket.readyState !== WebSocket.OPEN) {
			continue;
		}
		sendJson(socket, envelope);
	}
}

export function broadcastStudioSessionEvent(
	originSocket: WebSocket,
	sessionId: string,
	envelope: ServerEvent
): void {
	const subscribers: Set<WebSocket> | undefined = sessionSubscribers.get(sessionId);
	if (subscribers === undefined) return;
	for (const socket of subscribers) {
		if (socket === originSocket || socket.readyState !== WebSocket.OPEN) continue;
		if (!isStudioSessionClientType(socketConnections.get(socket)?.clientType)) continue;
		sendJson(socket, envelope);
	}
}

export function getClientActorSummary(socket: WebSocket): ClientActorSummary | undefined {
	const connection: ClientConnectionInfo | null = getClientConnection(socket);
	return connection === null ? undefined : {
		clientType: connection.clientType,
		clientName: connection.clientName,
		connectionId: connection.connectionId,
	};
}

export function broadcastToStudioSessionSubscribers(sessionId: string, envelope: ServerEvent): void {
	const subscribers: Set<WebSocket> | undefined = sessionSubscribers.get(sessionId);
	if (subscribers === undefined) return;
	for (const socket of subscribers) {
		if (socket.readyState !== WebSocket.OPEN) continue;
		if (!isStudioSessionClientType(socketConnections.get(socket)?.clientType)) continue;
		sendJson(socket, envelope);
	}
}

export function broadcastGlobalEvent(requestId: string, eventName: ServerEvent["event"], data: unknown): void {
	for (const record of socketConnections.values()) {
		if (record.socket.readyState !== WebSocket.OPEN) {
			continue;
		}
		sendJson(record.socket, {
			protocolVersion: 3,
			type: "event",
			eventId: `global-${requestId}-${Date.now().toString(36)}`,
			event: eventName,
			sessionId: "",
			requestId,
			runId: requestId,
			sequence: Date.now() * 1000,
			createdAt: new Date().toISOString(),
			data
		});
	}
}

export function findSessionWithPendingApproval(approvalId: string): ClientSession | undefined {
	for (const record of socketConnections.values()) {
		if (record.session.approvalGateway.getPending(approvalId) !== undefined) {
			return record.session;
		}
	}

	return undefined;
}

export function findSessionWithPendingToolBudget(budgetId: string): ClientSession | undefined {
	for (const record of socketConnections.values()) {
		if (record.session.pendingToolBudgets.has(budgetId)) {
			return record.session;
		}
	}

	return undefined;
}

export function beginSessionRun(sessionId: string | undefined, requestId: string): { ok: true } | { ok: false; activeRequestId: string } {
	if (sessionId === undefined) {
		return { ok: true };
	}

	const activeRequestId: string | undefined = activeSessionRuns.get(sessionId);
	if (activeRequestId !== undefined) {
		return { ok: false, activeRequestId };
	}

	activeSessionRuns.set(sessionId, requestId);
	sessionSearchService.pauseBackgroundBuilds();
	return { ok: true };
}

export function getActiveSessionRunRequestId(sessionId: string | undefined): string | undefined {
	if (sessionId === undefined) {
		return undefined;
	}

	return activeSessionRuns.get(sessionId);
}

export function registerSessionRunController(sessionId: string | undefined, requestId: string, controller: AbortController): void {
	if (sessionId === undefined) {
		return;
	}

	if (activeSessionRuns.get(sessionId) === requestId) {
		activeSessionRunControllers.set(sessionId, controller);
	}
}

export function getActiveSessionRunController(sessionId: string | undefined, requestId?: string | undefined): { requestId: string; controller: AbortController } | undefined {
	if (sessionId === undefined) {
		return undefined;
	}

	const activeRequestId: string | undefined = activeSessionRuns.get(sessionId);
	const controller: AbortController | undefined = activeSessionRunControllers.get(sessionId);
	if (activeRequestId === undefined || controller === undefined) {
		return undefined;
	}
	if (requestId !== undefined && requestId !== activeRequestId) {
		return undefined;
	}
	return {
		requestId: activeRequestId,
		controller
	};
}

export function finishSessionRun(sessionId: string | undefined, requestId: string): void {
	if (sessionId === undefined) {
		return;
	}

	if (activeSessionRuns.get(sessionId) === requestId) {
		activeSessionRuns.delete(sessionId);
		activeSessionRunControllers.delete(sessionId);
	}
}
