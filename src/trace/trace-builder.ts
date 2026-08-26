import { createHash } from "node:crypto";
import type { TraceRecordKind, TraceRecordStatus, TraceRecordWrite } from "./trace-types.js";

export type TraceSourceEvent = {
	id: string;
	requestId: string;
	event: string;
	data: unknown;
	createdAt: string;
	sequence?: number | undefined;
};

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, ...keys: string[]): string | undefined {
	const source = record(value);
	for (const key of keys) {
		const candidate: unknown = source[key];
		if (typeof candidate === "string" && candidate.length > 0) return candidate;
	}
	return undefined;
}

function stableId(...parts: Array<string | undefined>): string {
	return `trace-${createHash("sha256").update(parts.filter(Boolean).join("\u0000")).digest("hex").slice(0, 24)}`;
}

function statusForEvent(event: string, data: unknown): TraceRecordStatus {
	if (event === "agent.run.started" && text(data, "retryOfRunId") !== undefined) return "success";
	if (event === "agent.step.outcome") {
		const outcomeStatus: string | undefined = text(record(data).outcome, "status", "resultStatus");
		return outcomeStatus !== undefined && /error|fail|cancel|blocked|needs_fix/i.test(outcomeStatus) ? "error" : "success";
	}
	if (event === "agent.provider.reconnect") {
		const reconnectStatus: string | undefined = text(data, "status");
		if (reconnectStatus === "failed") return "error";
		if (reconnectStatus === "recovered") return "success";
	}
	if (event.endsWith(".error") || event.endsWith(".failed")) return "error";
	if (event.endsWith(".cancelled")) return "cancelled";
	if (event.endsWith(".approval_required")) return "approval_required";
	if (event.endsWith(".done") || event.endsWith(".completed") || event.endsWith(".result") || event.endsWith(".approved") || event.endsWith(".rejected")) return "success";
	return "running";
}

function collectFilePaths(data: Record<string, unknown>): string[] {
	const paths: string[] = [];
	const add = (value: unknown): void => {
		if (typeof value === "string" && value.trim().length > 0 && !paths.includes(value.trim())) paths.push(value.trim());
	};
	for (const source of [data, record(data.args), record(data.fileEditBatch)]) {
		for (const key of ["path", "filePath", "relativePath", "targetPath", "sourcePath", "destinationPath"]) add(source[key]);
	}
	const editedFiles: unknown = record(data.fileEditBatch).editedFiles;
	if (Array.isArray(editedFiles)) {
		for (const file of editedFiles) add(record(file).path ?? record(file).filePath);
	}
	return paths.slice(0, 32);
}

function kindForEvent(event: string, data: unknown): TraceRecordKind | null {
	if (event.startsWith("agent.thinking.")) return "thinking";
	if (event.startsWith("agent.tool.approv") || event === "agent.tool.rejected" || event === "agent.run.tool_budget_required" || event === "agent.run.tool_budget.resolved") return "approval";
	if (event.startsWith("agent.tool.")) return "tool_call";
	if (event === "agent.provider.reconnect") return "provider_reconnect";
	if (event === "agent.message.done") return "final_response";
	if (event === "agent.step.started" || event === "agent.step.outcome") return "step";
	if (event === "agent.run.error" || event === "agent.run.cancelled") return "error";
	if (event === "agent.run.started" && text(data, "retryOfRunId") !== undefined) return "retry";
	return null;
}

export function buildTraceRecordFromEvent(sessionId: string, event: TraceSourceEvent): TraceRecordWrite | null {
	const kind: TraceRecordKind | null = kindForEvent(event.event, event.data);
	if (kind === null) return null;
	const data: Record<string, unknown> = record(event.data);
	const runId: string | undefined = text(data, "runId");
	const stepId: string | undefined = text(data, "stepId", "stepRunId");
	const toolCallId: string | undefined = text(data, "toolCallId", "callId");
	const approvalId: string | undefined = text(data, "approvalId");
	const reconnectId: string | undefined = text(data, "reconnectId");
	const groupingId: string = kind === "thinking" || kind === "final_response"
		? `${sessionId}:${event.requestId}:${runId ?? ""}:${kind}`
		: kind === "tool_call" || kind === "approval"
			? `${sessionId}:${event.requestId}:${toolCallId ?? approvalId ?? event.id}:${kind}`
			: kind === "step"
				? `${sessionId}:${event.requestId}:${stepId ?? event.id}:${kind}`
				: kind === "provider_reconnect"
					? `${sessionId}:${event.requestId}:${reconnectId ?? event.id}:${kind}`
					: kind === "retry"
						? `${sessionId}:${event.requestId}:${runId ?? event.id}:${kind}`
						: `${sessionId}:${event.requestId}:${event.id}:${kind}`;
	const toolName: string | undefined = text(data, "toolName", "name");
	const filePaths: string[] = collectFilePaths(data);
	const status: TraceRecordStatus = statusForEvent(event.event, event.data);
	const summary: Record<string, unknown> = {
		event: event.event,
		...(toolName === undefined ? {} : { toolName }),
		...(text(data, "title") === undefined ? {} : { title: text(data, "title") }),
		...(text(data, "message", "error") === undefined ? {} : { message: text(data, "message", "error") }),
		...(approvalId === undefined ? {} : { approvalId }),
		...(text(data, "retryOfRunId") === undefined ? {} : { retryOfRunId: text(data, "retryOfRunId") }),
		...(text(data, "code", "errorCode") === undefined ? {} : { errorCode: text(data, "code", "errorCode") }),
		...(filePaths.length === 0 ? {} : { filePaths }),
		...(typeof data.resultChars === "number" ? { resultChars: data.resultChars } : {}),
		...(typeof data.truncated === "boolean" ? { truncated: data.truncated } : {})
	};
	const payload = kind === "thinking"
		? { thinking: text(data, "delta", "text", "content") ?? "" }
		: kind === "tool_call"
			? { toolInput: data.args ?? data.arguments ?? data.input, response: data.result ?? data.output }
			: kind === "final_response"
				? { response: text(data, "text", "content") ?? "" }
				: { response: data };
	return {
		recordId: stableId(groupingId),
		parentId: stableId(sessionId, event.requestId, "turn"),
		sessionId,
		kind,
		status,
		requestId: event.requestId,
		runId,
		stepId,
		toolCallId,
		startedAt: event.createdAt,
		finishedAt: status === "running" ? undefined : event.createdAt,
		detailLevel: "full",
		summary,
		truncated: false,
		payload
	};
}

export function createTurnTraceRecord(sessionId: string, requestId: string, createdAt: string): TraceRecordWrite {
	return {
		recordId: stableId(sessionId, requestId, "turn"),
		sessionId,
		kind: "turn",
		status: "running",
		requestId,
		startedAt: createdAt,
		detailLevel: "summary",
		summary: {},
		truncated: false
	};
}

export function createTraceRecordId(...parts: Array<string | undefined>): string {
	return stableId(...parts);
}
