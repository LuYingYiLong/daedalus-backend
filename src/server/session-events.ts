import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import type {
	AiChatParams,
	CanonicalServerEventName,
	ServerEvent,
	ServerEventNameInput,
	StudioDirectEventName
} from "../protocol/types.js";
import type { ProviderChatOptions } from "../providers/deepseek-client.js";
import { appendAgentEvent, appendSessionEvent, appendWorkflowEvent, openSession, renameSession, type SessionMetadata } from "../session/session-store.js";
import { createFallbackSessionTitle, generateSessionTitle, shouldApplyGeneratedSessionTitle } from "./session-title.js";
import { resolveProviderTaskModelOptions } from "../providers/task-model-routing.js";
import type { ClientSession, ThinkingEventBuffer } from "./client-session.js";
import { sendJson } from "./send-json.js";
import { broadcastSessionEvent, broadcastStudioSessionEvent } from "./client-connections.js";
import { logger } from "../logger.js";
import { withProviderUsageContext } from "../usage/provider-recorder.js";
import { saveAgentRunState } from "../session/agent-run-store.js";
import { getGoalRunBinding, notifyGoalRunState } from "./goal-run-observer.js";
import {
	createAgentRunState,
	transitionAgentRunState,
	type AgentRunResultStatus,
	type AgentRunState
} from "../workflow/agent-run-state.js";
import { annotateActivityEvent, createActivityGroupAccumulator } from "../session/activity-groups.js";

const PERSISTED_DELTA_FLUSH_CHARS = 8192;
const LIVE_DELTA_FLUSH_MS = 32;
const MAX_TERMINAL_EVENT_FINGERPRINTS = 512;
const lastEventSequenceBySessionId: Map<string, number> = new Map();

type LiveDeltaBuffer = {
	socket: WebSocket;
	session: ClientSession;
	sessionId: string;
	requestId: string;
	persistRequestId: string;
	eventName: Extract<CanonicalServerEventName, "agent.message.delta" | "agent.thinking.delta">;
	data: Record<string, unknown>;
	text: string;
	timer: NodeJS.Timeout;
};

const liveDeltaBuffers: Map<string, LiveDeltaBuffer> = new Map();

const LEGACY_EVENT_NAMES: Readonly<Record<string, CanonicalServerEventName>> = {
	"ai.delta": "agent.message.delta",
	"ai.done": "agent.message.done",
	"ai.status": "agent.status",
	"ai.paused": "agent.status",
	"ai.thinking.delta": "agent.thinking.delta",
	"ai.thinking.done": "agent.thinking.done",
	"tool.call": "agent.tool.call",
	"tool.progress": "agent.tool.progress",
	"tool.result": "agent.tool.result",
	"tool.error": "agent.tool.error",
	"tool.approval_required": "agent.tool.approval_required",
	"tool.approved": "agent.tool.approved",
	"tool.rejected": "agent.tool.rejected",
	"workflow.started": "agent.status",
	"workflow.phase.started": "agent.step.started",
	"workflow.todo.updated": "agent.run.snapshot",
	"workflow.todo.dismissed": "agent.todo.dismissed",
	"workflow.phase.outcome": "agent.step.outcome",
	"workflow.phase.done": "agent.step.outcome",
	"workflow.done": "agent.run.done",
	"workflow.error": "agent.run.error"
};

export function canonicalizeServerEventName(eventName: ServerEventNameInput): CanonicalServerEventName {
	return LEGACY_EVENT_NAMES[eventName] ?? eventName as CanonicalServerEventName;
}

function nextEventSequence(sessionId: string): number {
	const wallClockFloor: number = Date.now() * 1000;
	const previous: number = lastEventSequenceBySessionId.get(sessionId) ?? 0;
	const next: number = Math.max(wallClockFloor, previous + 1);
	lastEventSequenceBySessionId.set(sessionId, next);
	return next;
}

function withSessionId(data: unknown, sessionId: string | undefined): unknown {
	if (sessionId === undefined || typeof data !== "object" || data === null || Array.isArray(data)) {
		return data;
	}

	return {
		...data,
		sessionId
	};
}

function getDataSessionId(data: unknown): string | undefined {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return undefined;
	}

	const sessionId: unknown = (data as Record<string, unknown>).sessionId;
	return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}

function getRecordString(data: unknown, key: string): string {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return "";
	}

	const value: unknown = (data as Record<string, unknown>)[key];
	return typeof value === "string" ? value.trim() : "";
}

function annotateSessionActivity(
	session: ClientSession,
	requestKey: string,
	eventName: CanonicalServerEventName,
	data: unknown
): unknown {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return data;
	}
	let accumulator = session.activityGroupAccumulators.get(requestKey);
	if (accumulator === undefined) {
		accumulator = createActivityGroupAccumulator();
		session.activityGroupAccumulators.set(requestKey, accumulator);
	}
	return annotateActivityEvent(accumulator, requestKey, eventName, data as Record<string, unknown>);
}

function createTerminalEventFingerprint(eventName: CanonicalServerEventName, data: unknown, sessionId: string | undefined, persistRequestId: string): string | null {
	if (eventName !== "agent.run.error" && eventName !== "agent.run.cancelled") {
		return null;
	}
	if (sessionId === undefined) {
		return null;
	}

	const message: string = eventName === "agent.run.cancelled"
		? getRecordString(data, "reason") || "cancelled"
		: getRecordString(data, "message");
	if (message.length === 0) {
		return null;
	}

	const terminalKind: string = eventName === "agent.run.cancelled" ? "cancelled" : "error";
	return `${sessionId}\n${persistRequestId}\n${terminalKind}\n${message}`;
}

function shouldSuppressDuplicateTerminalEvent(session: ClientSession, eventName: CanonicalServerEventName, data: unknown, sessionId: string | undefined, persistRequestId: string): boolean {
	const fingerprint: string | null = createTerminalEventFingerprint(eventName, data, sessionId, persistRequestId);
	if (fingerprint === null) {
		return false;
	}
	if (session.terminalErrorEventFingerprints.has(fingerprint)) {
		logger.debug("session", "duplicate_terminal_event_suppressed", {
			sessionId,
			requestId: persistRequestId,
			eventName,
			message: getRecordString(data, eventName === "agent.run.cancelled" ? "reason" : "message")
		});
		return true;
	}

	if (session.terminalErrorEventFingerprints.size >= MAX_TERMINAL_EVENT_FINGERPRINTS) {
		session.terminalErrorEventFingerprints.clear();
	}
	session.terminalErrorEventFingerprints.add(fingerprint);
	return false;
}

export function shouldPersistSessionEvent(eventName: ServerEventNameInput): boolean {
	const canonicalEventName: CanonicalServerEventName = canonicalizeServerEventName(eventName);
	return canonicalEventName.startsWith("agent.")
		|| eventName.startsWith("terminal.")
		|| eventName.startsWith("guide.")
		|| eventName.startsWith("skill.")
		|| eventName.startsWith("plan.")
		|| canonicalEventName === "session.model.changed";
}

export function getThinkingEventBufferKey(sessionId: string, requestId: string): string {
	return `${sessionId}\n${requestId}`;
}

export function resolveTimelineRequestId(
	session: ClientSession,
	requestId: string,
	persistRequestId: string,
	data: unknown
): { requestId: string; persistRequestId: string } {
	const dataGoalId: string = getRecordString(data, "goalId");
	const dataRootRequestId: string = getRecordString(data, "rootRequestId");
	const boundRootRequestId: string | undefined = getGoalRunBinding(requestId)?.rootRequestId;
	const storedRun: AgentRunState | undefined = session.agentRuns.get(requestId) ?? session.agentRuns.get(persistRequestId);
	const storedRootRequestId: string | undefined = storedRun?.goalId === undefined ? undefined : storedRun.rootRequestId;
	const rootRequestId: string | undefined = dataGoalId.length > 0 && dataRootRequestId.length > 0
		? dataRootRequestId
		: boundRootRequestId ?? storedRootRequestId;
	if (rootRequestId === undefined || rootRequestId.length === 0) {
		return { requestId, persistRequestId };
	}
	return {
		requestId: rootRequestId,
		persistRequestId: rootRequestId
	};
}

function getPersistedDeltaBufferKey(sessionId: string, requestId: string, eventName: string, data: unknown): string {
	return [
		getThinkingEventBufferKey(sessionId, requestId),
		eventName,
		getRecordString(data, "runId"),
		getRecordString(data, "stepRunId")
	].join("\n");
}

function getEventDataWithoutText(data: unknown): Record<string, unknown> {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return {};
	}
	const { text: _text, ...rest } = data as Record<string, unknown>;
	return rest;
}

export function getThinkingDeltaText(data: unknown): string {
	if (typeof data !== "object" || data === null || !("text" in data)) {
		return "";
	}

	return String((data as { text?: unknown }).text ?? "");
}

export function getWorkflowIdFromEventData(data: unknown): string | null {
	if (typeof data !== "object" || data === null || !("workflowId" in data)) {
		return null;
	}

	const workflowId: unknown = (data as { workflowId?: unknown }).workflowId;
	return typeof workflowId === "string" && workflowId.length > 0 ? workflowId : null;
}

export function getAgentRunIdFromEventData(data: unknown): string | null {
	if (typeof data !== "object" || data === null || !("runId" in data)) {
		return null;
	}

	const runId: unknown = (data as { runId?: unknown }).runId;
	return typeof runId === "string" && runId.length > 0 ? runId : null;
}

export function enqueueSessionEventWrite(session: ClientSession, operation: () => Promise<void>): void {
	const nextWrite: Promise<void> = session.eventPersistQueue.then(operation, operation);
	session.eventPersistQueue = nextWrite.catch((error: unknown): void => {
		logger.error("session", "event_persist_failed", error, {
			sessionId: session.sessionId
		});
	});
}

export function flushThinkingEventBuffer(session: ClientSession, key: string): void {
	const buffer: ThinkingEventBuffer | undefined = session.thinkingEventBuffers.get(key);
	if (buffer === undefined || buffer.text.length === 0) {
		return;
	}

	const text: string = buffer.text;
	buffer.text = "";
	enqueueSessionEventWrite(session, async (): Promise<void> => {
		await appendSessionEvent(buffer.sessionId, buffer.requestId, buffer.eventName, {
			...buffer.data,
			type: buffer.eventName,
			text
		});
	});
}

export function flushAllThinkingEventBuffers(session: ClientSession): void {
	for (const key of session.thinkingEventBuffers.keys()) {
		flushThinkingEventBuffer(session, key);
	}
}

export function flushAiDeltaEventBuffer(session: ClientSession, key: string): void {
	const buffer: ThinkingEventBuffer | undefined = session.aiDeltaEventBuffers.get(key);
	if (buffer === undefined || buffer.text.length === 0) {
		return;
	}

	const text: string = buffer.text;
	buffer.text = "";
	enqueueSessionEventWrite(session, async (): Promise<void> => {
		await appendSessionEvent(buffer.sessionId, buffer.requestId, buffer.eventName, {
			...buffer.data,
			type: buffer.eventName,
			text
		});
	});
}

export function flushAllAiDeltaEventBuffers(session: ClientSession): void {
	for (const key of session.aiDeltaEventBuffers.keys()) {
		flushAiDeltaEventBuffer(session, key);
	}
}

export async function waitForSessionEventPersistence(session: ClientSession): Promise<void> {
	flushLiveDeltaBuffersForSession(session);
	flushAllAiDeltaEventBuffers(session);
	flushAllThinkingEventBuffers(session);
	await session.eventPersistQueue;
}

export function persistSessionEvent(
	session: ClientSession,
	eventName: ServerEventNameInput,
	data: unknown,
	persistRequestId: string,
	sessionIdOverride?: string | undefined,
	identity?: {
		eventId: string;
		sequence: number;
		createdAt: string;
	} | undefined
): void {
	const canonicalEventName: CanonicalServerEventName = canonicalizeServerEventName(eventName);
	const sessionId: string | undefined = sessionIdOverride ?? getDataSessionId(data) ?? session.sessionId;
	if (sessionId === undefined || !shouldPersistSessionEvent(canonicalEventName)) {
		return;
	}
	if (identity !== undefined) {
		enqueueSessionEventWrite(session, async (): Promise<void> => {
			await appendSessionEvent(sessionId, persistRequestId, canonicalEventName, data, identity);
		});
		return;
	}

	if (canonicalEventName === "agent.message.delta") {
		flushAllThinkingEventBuffers(session);
		const text: string = getThinkingDeltaText(data);
		if (text.length === 0) {
			return;
		}

		const key: string = getPersistedDeltaBufferKey(sessionId, persistRequestId, canonicalEventName, data);
		const existingBuffer: ThinkingEventBuffer | undefined = session.aiDeltaEventBuffers.get(key);
		const buffer: ThinkingEventBuffer = existingBuffer ?? {
			sessionId,
			requestId: persistRequestId,
			eventName: canonicalEventName,
			data: getEventDataWithoutText(data),
			text: ""
		};
		buffer.text += text;
		session.aiDeltaEventBuffers.set(key, buffer);

		if (buffer.text.length >= PERSISTED_DELTA_FLUSH_CHARS) {
			flushAiDeltaEventBuffer(session, key);
		}
		return;
	}

	flushAllAiDeltaEventBuffers(session);

	if (canonicalEventName === "agent.thinking.delta") {
		const text: string = getThinkingDeltaText(data);
		if (text.length === 0) {
			return;
		}

		const key: string = getPersistedDeltaBufferKey(sessionId, persistRequestId, canonicalEventName, data);
		const existingBuffer: ThinkingEventBuffer | undefined = session.thinkingEventBuffers.get(key);
		const buffer: ThinkingEventBuffer = existingBuffer ?? {
			sessionId,
			requestId: persistRequestId,
			eventName: canonicalEventName,
			data: getEventDataWithoutText(data),
			text: ""
		};
		buffer.text += text;
		session.thinkingEventBuffers.set(key, buffer);

		if (buffer.text.length >= PERSISTED_DELTA_FLUSH_CHARS) {
			flushThinkingEventBuffer(session, key);
		}
		return;
	}

	if (canonicalEventName === "agent.thinking.done") {
		flushAllThinkingEventBuffers(session);
		session.thinkingEventBuffers.clear();
	} else {
		flushAllThinkingEventBuffers(session);
	}

	enqueueSessionEventWrite(session, async (): Promise<void> => {
		await appendSessionEvent(sessionId, persistRequestId, canonicalEventName, data);
		if (canonicalEventName.startsWith("agent.")) {
			const runId: string | null = getAgentRunIdFromEventData(data);
			if (runId !== null) {
				await appendAgentEvent(sessionId, runId, persistRequestId, canonicalEventName, data);
			}
		}
	});
}

function createEventEnvelope(
	eventName: CanonicalServerEventName | StudioDirectEventName,
	eventData: unknown,
	requestId: string,
	sessionId?: string | undefined
): ServerEvent {
	const runId: string = getRecordString(eventData, "runId");
	const createdAt: string = new Date().toISOString();
	return {
		protocolVersion: 3,
		type: "event",
		eventId: `event-${randomUUID()}`,
		event: eventName,
		sessionId: sessionId ?? "",
		requestId,
		runId: runId.length > 0 ? runId : requestId,
		sequence: nextEventSequence(sessionId ?? "__global__"),
		createdAt,
		data: eventData
	};
}

function emitCanonicalSessionEvent(
	socket: WebSocket,
	session: ClientSession,
	envelope: ServerEvent,
	persistRequestId: string
): void {
	sendJson(socket, envelope);
	if (envelope.sessionId.length > 0) {
		broadcastSessionEvent(socket, envelope.sessionId, envelope);
		persistSessionEvent(
			session,
			envelope.event as ServerEventNameInput,
			envelope.data,
			persistRequestId,
			envelope.sessionId,
			{
				eventId: envelope.eventId,
				sequence: envelope.sequence,
				createdAt: envelope.createdAt
			}
		);
	}
}

function getLiveDeltaBufferKey(
	sessionId: string,
	requestId: string,
	eventName: CanonicalServerEventName,
	data: unknown
): string {
	return [
		sessionId,
		requestId,
		eventName,
		getRecordString(data, "runId"),
		getRecordString(data, "stepRunId")
	].join("\n");
}

function flushLiveDeltaBuffer(key: string): void {
	const buffer: LiveDeltaBuffer | undefined = liveDeltaBuffers.get(key);
	if (buffer === undefined) {
		return;
	}
	liveDeltaBuffers.delete(key);
	clearTimeout(buffer.timer);
	if (buffer.text.length === 0) {
		return;
	}
	const eventData: Record<string, unknown> = {
		...buffer.data,
		text: buffer.text,
		sessionId: buffer.sessionId
	};
	emitCanonicalSessionEvent(
		buffer.socket,
		buffer.session,
		createEventEnvelope(buffer.eventName, eventData, buffer.requestId, buffer.sessionId),
		buffer.persistRequestId
	);
}

function flushLiveDeltaBuffersForSession(session: ClientSession): void {
	for (const [key, buffer] of liveDeltaBuffers) {
		if (buffer.session === session) {
			flushLiveDeltaBuffer(key);
		}
	}
}

function enqueueLiveDelta(
	socket: WebSocket,
	session: ClientSession,
	sessionId: string,
	requestId: string,
	persistRequestId: string,
	eventName: Extract<CanonicalServerEventName, "agent.message.delta" | "agent.thinking.delta">,
	data: unknown
): void {
	const text: string = getThinkingDeltaText(data);
	if (text.length === 0) {
		return;
	}
	const key: string = getLiveDeltaBufferKey(sessionId, requestId, eventName, data);
	const existing: LiveDeltaBuffer | undefined = liveDeltaBuffers.get(key);
	if (existing !== undefined) {
		existing.text += text;
		existing.data = getEventDataWithoutText(data);
		if (existing.text.length >= PERSISTED_DELTA_FLUSH_CHARS) {
			flushLiveDeltaBuffer(key);
		}
		return;
	}
	const timer: NodeJS.Timeout = setTimeout((): void => {
		flushLiveDeltaBuffer(key);
	}, LIVE_DELTA_FLUSH_MS);
	timer.unref();
	liveDeltaBuffers.set(key, {
		socket,
		session,
		sessionId,
		requestId,
		persistRequestId,
		eventName,
		data: getEventDataWithoutText(data),
		text,
		timer
	});
}

function asAgentRunResultStatus(value: unknown): AgentRunResultStatus {
	return value === "completed_with_warnings"
		|| value === "blocked"
		|| value === "failed"
		|| value === "cancelled"
		? value
		: "completed";
}

function findLifecycleAgentRun(
	session: ClientSession,
	requestId: string,
	persistRequestId: string,
	data: unknown
): AgentRunState | undefined {
	const runId: string = getRecordString(data, "runId");
	return (runId.length > 0 ? session.agentRuns.get(runId) : undefined)
		?? session.agentRuns.get(persistRequestId)
		?? session.agentRuns.get(requestId);
}

function emitLegacyLifecycleAsRunState(params: {
	socket: WebSocket;
	session: ClientSession;
	sessionId: string;
	requestId: string;
	persistRequestId: string;
	eventName: CanonicalServerEventName;
	data: unknown;
}): boolean {
	if (
		params.eventName !== "agent.run.started"
		&& params.eventName !== "agent.run.paused"
		&& params.eventName !== "agent.run.tool_budget_required"
		&& params.eventName !== "agent.run.tool_budget.resolved"
		&& params.eventName !== "agent.run.done"
		&& params.eventName !== "agent.run.error"
		&& params.eventName !== "agent.run.cancelled"
	) {
		return false;
	}

	let current: AgentRunState | undefined = findLifecycleAgentRun(
		params.session,
		params.requestId,
		params.persistRequestId,
		params.data
	);
	if (current === undefined) {
		current = createAgentRunState({
			sessionId: params.sessionId,
			requestId: params.persistRequestId,
			runId: params.persistRequestId,
			title: getRecordString(params.data, "title") || "Daedalus task"
		});
		params.session.agentRuns.set(current.runId, current);
		params.session.agentRunToolCalls.set(current.runId, new Map());
	}

	let next: AgentRunState = current;
	if (params.eventName === "agent.run.started") {
		if (current.stage === "routing") {
			next = transitionAgentRunState(current, "executing");
		}
	} else if (params.eventName === "agent.run.paused") {
		next = transitionAgentRunState(current, "awaiting_approval", {
			pause: {
				kind: "approval",
				id: getRecordString(params.data, "approvalId"),
				toolName: getRecordString(params.data, "toolName"),
				reason: getRecordString(params.data, "reason") || "approval_required"
			}
		});
	} else if (params.eventName === "agent.run.tool_budget_required") {
		next = transitionAgentRunState(current, "awaiting_tool_budget", {
			pause: {
				kind: "tool_budget",
				id: getRecordString(params.data, "budgetId"),
				reason: getRecordString(params.data, "reason") || "tool_budget"
			}
		});
	} else if (params.eventName === "agent.run.tool_budget.resolved") {
		next = transitionAgentRunState(current, "executing", { pause: null });
	} else if (params.eventName === "agent.run.done") {
		const finalizing: AgentRunState = current.stage === "finalizing"
			? current
			: transitionAgentRunState(current, "finalizing", {
				pause: null,
				verificationStatus: getRecordString(params.data, "verificationStatus") === "verified"
					? "verified"
					: getRecordString(params.data, "verificationStatus") === "failed"
						? "failed"
						: "unverified"
			});
		next = transitionAgentRunState(finalizing, "completed", {
			terminal: {
				resultStatus: asAgentRunResultStatus(
					typeof params.data === "object" && params.data !== null
						? (params.data as Record<string, unknown>).resultStatus
						: undefined
				),
				message: getRecordString(params.data, "message") || undefined,
				completedAt: new Date().toISOString()
			}
		});
	} else if (params.eventName === "agent.run.error") {
		next = transitionAgentRunState(current, "failed", {
			pause: null,
			verificationStatus: "failed",
			terminal: {
				resultStatus: "failed",
				message: getRecordString(params.data, "message") || "Agent run failed.",
				completedAt: new Date().toISOString()
			}
		});
	} else if (params.eventName === "agent.run.cancelled") {
		next = transitionAgentRunState(current, "cancelled", {
			pause: null,
			terminal: {
				resultStatus: "cancelled",
				message: getRecordString(params.data, "reason") || "cancelled",
				completedAt: new Date().toISOString()
			}
		});
	}

	params.session.agentRuns.set(next.runId, next);
	notifyGoalRunState(params.socket, params.session, next);
	if (params.sessionId.length > 0) {
		const snapshot: AgentRunState = structuredClone(next);
		enqueueSessionEventWrite(params.session, async (): Promise<void> => {
			await saveAgentRunState(snapshot);
		});
	}
	emitCanonicalSessionEvent(
		params.socket,
		params.session,
		createEventEnvelope(
			"agent.run.state",
			structuredClone(next),
			next.goalId === undefined ? next.requestId : next.rootRequestId,
			params.sessionId
		),
		next.goalId === undefined ? next.requestId : next.rootRequestId
	);
	return true;
}

export function sendSessionEvent(
	socket: WebSocket,
	requestId: string,
	session: ClientSession,
	eventName: ServerEventNameInput,
	data: unknown,
	persistRequestId: string = requestId,
	sessionIdOverride?: string | undefined
): void {
	const canonicalEventName: CanonicalServerEventName = canonicalizeServerEventName(eventName);
	const sessionId: string | undefined = sessionIdOverride ?? getDataSessionId(data) ?? session.sessionId;
	const baseEventData: unknown = withSessionId(data, sessionId);
	const timelineIdentity = resolveTimelineRequestId(session, requestId, persistRequestId, baseEventData);
	const eventData: unknown = annotateSessionActivity(session, timelineIdentity.persistRequestId, canonicalEventName, baseEventData);
	if (shouldSuppressDuplicateTerminalEvent(session, canonicalEventName, eventData, sessionId, timelineIdentity.persistRequestId)) {
		return;
	}
	if (
		emitLegacyLifecycleAsRunState({
			socket,
			session,
			sessionId: sessionId ?? "",
			// Goal cycle events share the root request only for timeline grouping.
			// Lifecycle transitions must keep using the concrete cycle Run or a
			// later cycle can accidentally transition the already-terminal root Run.
			requestId,
			persistRequestId,
			eventName: canonicalEventName,
			data: eventData
		})
	) {
		return;
	}
	if (
		sessionId !== undefined
		&& (canonicalEventName === "agent.message.delta" || canonicalEventName === "agent.thinking.delta")
	) {
		enqueueLiveDelta(
			socket,
			session,
			sessionId,
			timelineIdentity.requestId,
			timelineIdentity.persistRequestId,
			canonicalEventName,
			eventData
		);
		return;
	}
	if (
		canonicalEventName === "agent.message.done"
		|| canonicalEventName === "agent.thinking.done"
		|| canonicalEventName === "agent.provider.reconnect"
	) {
		flushLiveDeltaBuffersForSession(session);
	}
	emitCanonicalSessionEvent(
		socket,
		session,
		createEventEnvelope(canonicalEventName, eventData, timelineIdentity.requestId, sessionId),
		timelineIdentity.persistRequestId
	);
}

export function sendTransientSessionEvent(
	socket: WebSocket,
	requestId: string,
	session: ClientSession,
	eventName: Extract<CanonicalServerEventName, "agent.tool.progress">,
	data: unknown,
	persistRequestId: string = requestId,
	sessionIdOverride?: string | undefined
): void {
	const sessionId: string | undefined = sessionIdOverride ?? getDataSessionId(data) ?? session.sessionId;
	if (sessionId === undefined) {
		return;
	}
	const baseEventData: unknown = withSessionId(data, sessionId);
	const timelineIdentity = resolveTimelineRequestId(session, requestId, persistRequestId, baseEventData);
	const eventData: unknown = annotateSessionActivity(session, timelineIdentity.persistRequestId, eventName, baseEventData);
	const envelope: ServerEvent = createEventEnvelope(eventName, eventData, timelineIdentity.requestId, sessionId);
	if (socket.readyState === WebSocket.OPEN) {
		sendJson(socket, envelope);
	}
	broadcastStudioSessionEvent(socket, sessionId, envelope);
}

export function sendGlobalEvent(socket: WebSocket, requestId: string, eventName: ServerEventNameInput, data: unknown): void {
	if (socket.readyState !== WebSocket.OPEN) {
		return;
	}

	sendJson(socket, createEventEnvelope(canonicalizeServerEventName(eventName), data, requestId));
}

export function sendStudioDirectSessionEvent(
	socket: WebSocket,
	sessionId: string,
	requestId: string,
	runId: string,
	eventName: StudioDirectEventName,
	data: Record<string, unknown>
): void {
	if (socket.readyState !== WebSocket.OPEN) {
		return;
	}
	const eventData: Record<string, unknown> = {
		...data,
		sessionId,
		runId
	};
	sendJson(socket, createEventEnvelope(eventName, eventData, requestId, sessionId));
}

export function sendStudioPersistentSessionEvent(
	socket: WebSocket,
	session: ClientSession,
	sessionId: string,
	requestId: string,
	eventName: CanonicalServerEventName,
	data: Record<string, unknown>
): void {
	const eventData: Record<string, unknown> = { ...data, sessionId };
	const envelope: ServerEvent = createEventEnvelope(eventName, eventData, requestId, sessionId);
	if (socket.readyState === WebSocket.OPEN) sendJson(socket, envelope);
	broadcastStudioSessionEvent(socket, sessionId, envelope);
	persistSessionEvent(session, eventName, eventData, requestId, sessionId, {
		eventId: envelope.eventId,
		sequence: envelope.sequence,
		createdAt: envelope.createdAt
	});
}

export function maybeScheduleSessionTitleGeneration(
	socket: WebSocket,
	requestId: string,
	session: ClientSession,
	params: AiChatParams,
	options: ProviderChatOptions,
	wasFirstTurn: boolean
): void {
	const sessionId: string | undefined = session.sessionId;
	if (!wasFirstTurn || sessionId === undefined || params.retryFromRequestId !== undefined) {
		logger.debug("session_title", "skipped", {
			requestId,
			sessionId: sessionId ?? null,
			wasFirstTurn,
			retry: params.retryFromRequestId !== undefined
		});
		return;
	}

	const originalTitle: string | undefined = session.sessionTitle;
	logger.info("session_title", "scheduled", {
		requestId,
		sessionId,
		originalTitle: originalTitle ?? ""
	});

	void (async (): Promise<void> => {
		const storedBefore = await openSession(sessionId);
		if (!shouldApplyGeneratedSessionTitle(originalTitle, storedBefore.metadata.title)) {
			logger.info("session_title", "skipped_title_changed_before", {
				sessionId,
				originalTitle: originalTitle ?? "",
				currentTitle: storedBefore.metadata.title
			});
			return;
		}

		let generatedTitle: string;
		try {
			const titleOptions = withProviderUsageContext(
				(await resolveProviderTaskModelOptions("sessionTitle", options)).options,
				{ operation: "session_title" }
			);
			generatedTitle = await generateSessionTitle(params.message, titleOptions);
		} catch (error: unknown) {
			generatedTitle = createFallbackSessionTitle(params.message);
			logger.warn("session_title", "generation_failed_fallback", {
				sessionId,
				requestId,
				message: error instanceof Error ? error.message : String(error)
			});
		}
		if (generatedTitle.length === 0) {
			logger.info("session_title", "skipped_empty_title", {
				sessionId,
				currentTitle: storedBefore.metadata.title
			});
			return;
		}
		if (generatedTitle === storedBefore.metadata.title) {
			sendGlobalEvent(socket, requestId, "session.renamed", {
				sessionId,
				title: storedBefore.metadata.title,
				metadata: storedBefore.metadata
			});
			logger.info("session_title", "already_current", {
				sessionId,
				title: storedBefore.metadata.title
			});
			return;
		}

		const storedAfter = await openSession(sessionId);
		if (!shouldApplyGeneratedSessionTitle(originalTitle, storedAfter.metadata.title)) {
			logger.info("session_title", "skipped_title_changed_after", {
				sessionId,
				originalTitle: originalTitle ?? "",
				currentTitle: storedAfter.metadata.title,
				generatedTitle
			});
			return;
		}

		const metadata: SessionMetadata = await renameSession(sessionId, generatedTitle);
		if (session.sessionId === sessionId) {
			session.sessionTitle = metadata.title;
		}
		sendGlobalEvent(socket, requestId, "session.renamed", {
			sessionId,
			title: metadata.title,
			metadata
		});
		logger.info("session_title", "renamed", {
			sessionId,
			from: storedAfter.metadata.title,
			to: metadata.title
		});
	})().catch((error: unknown): void => {
		logger.error("session_title", "failed", error, {
			sessionId,
			requestId
		});
	});
}
