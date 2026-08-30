import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { getGeneralSettings } from "../general-settings-store.js";
import { logger } from "../logger.js";
import type { ServerEvent } from "../protocol/types.js";
import { buildTraceRecordFromEvent, createTraceRecordId, createTurnTraceRecord, type TraceSourceEvent } from "./trace-builder.js";
import { hashTraceContent } from "./trace-redactor.js";
import { completeTraceTurn, upsertTraceRecord } from "./trace-store.js";
import type { NormalizedLlmUsage } from "../usage/metrics-types.js";
import type { TracePromptSection, TracePromptSectionKind, TraceRecord, TraceRecordStatus, TraceRecordWrite } from "./trace-types.js";

const textBuffers: Map<string, string> = new Map();
const providerCalls: Map<string, {
	sessionId: string;
	requestId: string;
	startedAt: string;
	runId?: string | undefined;
	provider?: string | undefined;
	model?: string | undefined;
	inputTokens?: number | undefined;
	outputTokens?: number | undefined;
	cacheReadTokens?: number | undefined;
	cacheCreationTokens?: number | undefined;
	totalTokens?: number | undefined;
	realTotalTokens?: number | undefined;
}> = new Map();
const activeProviderTrace: AsyncLocalStorage<string> = new AsyncLocalStorage<string>();
const eventSequenceBySession: Map<string, number> = new Map();

function nextEventSequence(sessionId: string): number {
	const next: number = Math.max(Date.now() * 1000, (eventSequenceBySession.get(sessionId) ?? 0) + 1);
	eventSequenceBySession.set(sessionId, next);
	return next;
}

export function publishTraceRecordUpdate(record: TraceRecord, changeType: "created" | "updated" | "completed"): void {
	const envelope: ServerEvent = {
		protocolVersion: 3,
		type: "event",
		eventId: `trace-event-${randomUUID()}`,
		event: "session.trace.updated",
		sessionId: record.sessionId,
		requestId: record.requestId,
		runId: record.runId ?? record.requestId,
		sequence: nextEventSequence(record.sessionId),
		createdAt: new Date().toISOString(),
		data: {
			revision: record.revision,
			recordId: record.recordId,
			changeType,
			record
		}
	};
	void import("../server/client-connections.js")
		.then(({ broadcastToStudioSessionSubscribers }): void => {
			broadcastToStudioSessionSubscribers(record.sessionId, envelope);
		})
		.catch((error: unknown): void => {
			logger.warn("trace", "broadcast_failed", { sessionId: record.sessionId, error });
		});
}

async function writeTrace(write: TraceRecordWrite, changeType: "created" | "updated" | "completed"): Promise<TraceRecord> {
	const developerMode: boolean = (await getGeneralSettings()).developerMode;
	const record: TraceRecord = await upsertTraceRecord({
		...write,
		detailLevel: developerMode ? write.detailLevel : "summary",
		payload: developerMode ? write.payload : undefined
	});
	publishTraceRecordUpdate(record, changeType);
	return record;
}

function eventText(event: TraceSourceEvent): string {
	if (typeof event.data !== "object" || event.data === null || Array.isArray(event.data)) return "";
	const data = event.data as Record<string, unknown>;
	for (const key of ["delta", "text", "content"]) {
		if (typeof data[key] === "string") return data[key];
	}
	return "";
}

export async function recordTraceFromSessionEvent(sessionId: string, event: TraceSourceEvent): Promise<void> {
	if (event.event === "session.trace.updated") return;
	try {
		const write: TraceRecordWrite | null = buildTraceRecordFromEvent(sessionId, event);
		if (write?.kind === "thinking") {
			const combined: string = `${textBuffers.get(write.recordId) ?? ""}${eventText(event)}`;
			textBuffers.set(write.recordId, combined);
			write.payload = { thinking: combined };
			write.summary = { ...write.summary, charCount: combined.length };
			if (event.event.endsWith(".done")) textBuffers.delete(write.recordId);
		}
		if (write !== null) {
			const completed: boolean = write.status !== "running";
			await writeTrace(write, completed ? "completed" : "updated");
		}
		const terminalStatus: Extract<TraceRecordStatus, "success" | "error" | "cancelled"> | null = event.event === "agent.message.done" || event.event === "agent.run.done"
			? "success"
			: event.event === "agent.run.error"
				? "error"
				: event.event === "agent.run.cancelled"
					? "cancelled"
					: null;
		if (terminalStatus !== null) {
			const turnRecord = await completeTraceTurn(sessionId, createTraceRecordId(sessionId, event.requestId, "turn"), event.createdAt, terminalStatus);
			if (turnRecord !== null) publishTraceRecordUpdate(turnRecord, "completed");
		}
	} catch (error: unknown) {
		logger.warn("trace", "record_event_failed", { sessionId, requestId: event.requestId, event: event.event, error });
	}
}

function createPromptSection(id: string, kind: TracePromptSectionKind, label: string, content: unknown): TracePromptSection {
	const serialized: string = typeof content === "string" ? content : JSON.stringify(content);
	return { id, kind, label, content, charCount: serialized.length, contentHash: hashTraceContent(content), truncated: false };
}

export async function recordPromptSnapshot(params: {
	sessionId: string;
	requestId: string;
	runId?: string | undefined;
	sections: Array<{ kind: TracePromptSectionKind; label: string; content: unknown }>;
	provider?: string | undefined;
	model?: string | undefined;
	providerParameters?: unknown;
}): Promise<void> {
	const startedAt: string = new Date().toISOString();
	const sections: TracePromptSection[] = params.sections.map((section, index): TracePromptSection =>
		createPromptSection(`${index + 1}-${section.kind}`, section.kind, section.label, section.content));
	await writeTrace(createTurnTraceRecord(params.sessionId, params.requestId, startedAt), "updated");
	await writeTrace({
		recordId: createTraceRecordId(params.sessionId, params.requestId, params.runId, "prompt"),
		parentId: createTraceRecordId(params.sessionId, params.requestId, "turn"),
		sessionId: params.sessionId,
		kind: "prompt",
		status: "success",
		requestId: params.requestId,
		runId: params.runId,
		provider: params.provider,
		model: params.model,
		startedAt,
		finishedAt: startedAt,
		detailLevel: "full",
		summary: { sectionCount: sections.length, charCount: sections.reduce((total, section): number => total + section.charCount, 0) },
		truncated: false,
		payload: { promptSections: sections, request: params.providerParameters }
	}, "completed");
}

export async function beginProviderTrace(params: {
	sessionId?: string | undefined;
	requestId?: string | undefined;
	runId?: string | undefined;
	provider?: string | undefined;
	model?: string | undefined;
	request: unknown;
}): Promise<string | null> {
	if (params.sessionId === undefined || params.requestId === undefined) return null;
	const callId: string = `model-call-${randomUUID()}`;
	const startedAt: string = new Date().toISOString();
	providerCalls.set(callId, {
		sessionId: params.sessionId,
		requestId: params.requestId,
		startedAt,
		runId: params.runId,
		provider: params.provider,
		model: params.model
	});
	await writeTrace({
		recordId: callId,
		parentId: createTraceRecordId(params.sessionId, params.requestId, "turn"),
		sessionId: params.sessionId,
		kind: "model_call",
		status: "running",
		requestId: params.requestId,
		runId: params.runId,
		provider: params.provider,
		model: params.model,
		startedAt,
		detailLevel: "full",
		summary: {},
		truncated: false,
		payload: { request: params.request }
	}, "created");
	return callId;
}

export async function runWithProviderTraceContext<T>(callId: string | null, execute: () => Promise<T>): Promise<T> {
	return callId === null ? execute() : activeProviderTrace.run(callId, execute);
}

export async function recordActiveProviderTraceUsage(params: {
	usage: NormalizedLlmUsage;
	request: unknown;
	response?: unknown | undefined;
	outputText?: string | undefined;
}): Promise<void> {
	const callId: string | undefined = activeProviderTrace.getStore();
	if (callId === undefined) return;
	const call = providerCalls.get(callId);
	if (call === undefined) return;
	const { usage } = params;
	call.inputTokens = (call.inputTokens ?? 0) + usage.inputTokens;
	call.outputTokens = (call.outputTokens ?? 0) + usage.outputTokens;
	call.cacheReadTokens = (call.cacheReadTokens ?? 0) + usage.cacheReadTokens;
	call.cacheCreationTokens = (call.cacheCreationTokens ?? 0) + usage.cacheCreationTokens;
	call.totalTokens = (call.totalTokens ?? 0) + usage.totalTokens;
	call.realTotalTokens = (call.realTotalTokens ?? 0) + usage.realTotalTokens;
	await writeTrace({
		recordId: callId,
		parentId: createTraceRecordId(call.sessionId, call.requestId, "turn"),
		sessionId: call.sessionId,
		kind: "model_call",
		status: "running",
		requestId: call.requestId,
		runId: call.runId,
		provider: call.provider,
		model: call.model,
		startedAt: call.startedAt,
		inputTokens: call.inputTokens,
		outputTokens: call.outputTokens,
		detailLevel: "summary",
		summary: {
			usageSource: usage.usageSource,
			cacheReadTokens: call.cacheReadTokens,
			cacheCreationTokens: call.cacheCreationTokens,
			totalTokens: call.totalTokens,
			realTotalTokens: call.realTotalTokens
		},
		truncated: false,
		payload: {
			request: params.request,
			...(params.response !== undefined
				? { response: params.response }
				: params.outputText === undefined
					? {}
					: { response: params.outputText })
		}
	}, "updated");
}

export async function completeProviderTrace(callId: string | null, params: {
	status: Extract<TraceRecordStatus, "success" | "error" | "cancelled">;
	provider?: string | undefined;
	model?: string | undefined;
	runId?: string | undefined;
	response?: unknown;
	error?: unknown;
	inputTokens?: number | undefined;
	outputTokens?: number | undefined;
}): Promise<void> {
	if (callId === null) return;
	const call = providerCalls.get(callId);
	if (call === undefined) return;
	providerCalls.delete(callId);
	const finishedAt: string = new Date().toISOString();
	await writeTrace({
		recordId: callId,
		parentId: createTraceRecordId(call.sessionId, call.requestId, "turn"),
		sessionId: call.sessionId,
		kind: "model_call",
		status: params.status,
		requestId: call.requestId,
		runId: params.runId ?? call.runId,
		provider: params.provider ?? call.provider,
		model: params.model ?? call.model,
		startedAt: call.startedAt,
		finishedAt,
		durationMs: Date.parse(finishedAt) - Date.parse(call.startedAt),
		inputTokens: params.inputTokens ?? call.inputTokens,
		outputTokens: params.outputTokens ?? call.outputTokens,
		detailLevel: "full",
		summary: params.error === undefined ? {} : { error: params.error instanceof Error ? params.error.message : String(params.error) },
		truncated: false,
		payload: { providerResult: params.response, error: params.error instanceof Error ? params.error.message : params.error }
	}, "completed");
}

export async function attachToolTraceOutput(params: {
	sessionId?: string | undefined;
	requestId?: string | undefined;
	runId?: string | undefined;
	stepId?: string | undefined;
	toolCallId?: string | undefined;
	toolName?: string | undefined;
	output: unknown;
}): Promise<void> {
	if (params.sessionId === undefined || params.requestId === undefined || params.toolCallId === undefined) return;
	const now: string = new Date().toISOString();
	let observationId: string | undefined;
	if (params.toolName?.startsWith("mcp_computer_")) {
		try { const output = typeof params.output === "string" ? JSON.parse(params.output) : params.output; if (typeof output?.observationId === "string") observationId = output.observationId; } catch { /* 摘要不解析任意窗口文字 */ }
	}
	await writeTrace({
		recordId: createTraceRecordId(params.sessionId, params.requestId, params.toolCallId, "tool_call"),
		parentId: createTraceRecordId(params.sessionId, params.requestId, "turn"),
		sessionId: params.sessionId,
		kind: "tool_call",
		status: "success",
		requestId: params.requestId,
		runId: params.runId,
		stepId: params.stepId,
		toolCallId: params.toolCallId,
		startedAt: now,
		finishedAt: now,
		detailLevel: "full",
		summary: { ...(params.toolName === undefined ? {} : { toolName: params.toolName }), ...(observationId ? { observationId } : {}) },
		truncated: false,
		payload: { toolOutput: observationId ? { observationId, evidence: "desktop_observation" } : params.output }
	}, "completed");
}
