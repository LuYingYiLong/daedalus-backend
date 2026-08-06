import { createHash } from "node:crypto";
import type WebSocket from "ws";
import { logger } from "../logger.js";
import { saveAgentRunState } from "../session/agent-run-store.js";
import type { ToolEvent } from "../tools/tool-dispatcher.js";
import { isToolApplicabilityCode } from "../tools/tool-applicability.js";
import { getEffectiveToolPolicy, type ToolRisk } from "../tools/tool-policy.js";
import {
	cloneAgentRunState,
	createAgentRunState,
	transitionAgentRunState,
	type AgentRunIntent,
	type AgentRunLane,
	type AgentRunScope,
	type AgentRunStage,
	type AgentRunState,
	type AgentRunStatePatch,
	type ExecutionEvidence
} from "../workflow/agent-run-state.js";
import type { ClientSession } from "./client-session.js";
import { enqueueSessionEventWrite, sendSessionEvent } from "./session-events.js";
import { notifyGoalRunState } from "./goal-run-observer.js";
import { enqueueGoalWriteCheckpointUnavailable } from "./goal-checkpoints.js";
import type { WorkspaceFileRef } from "../workspace/source-context.js";

function stableJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableJson).join(",")}]`;
	}
	if (typeof value === "object" && value !== null) {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]): number => left.localeCompare(right))
			.map(([key, item]): string => `${JSON.stringify(key)}:${stableJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function createWriteFingerprint(toolName: string, args: Record<string, unknown>): string {
	return createHash("sha256").update(`${toolName}\n${stableJson(args)}`).digest("hex");
}

function queueAgentRunSave(session: ClientSession, state: AgentRunState): void {
	const snapshot: AgentRunState = cloneAgentRunState(state);
	enqueueSessionEventWrite(session, async (): Promise<void> => {
		await saveAgentRunState(snapshot);
	});
}

export function emitAgentRunState(socket: WebSocket, session: ClientSession, state: AgentRunState): void {
	queueAgentRunSave(session, state);
	sendSessionEvent(
		socket,
		state.requestId,
		session,
		"agent.run.state",
		cloneAgentRunState(state),
		state.requestId,
		state.sessionId
	);
}

export function beginAgentRun(params: {
	socket: WebSocket;
	session: ClientSession;
	sessionId: string;
	requestId: string;
	title: string;
	intent?: AgentRunIntent | undefined;
	scope?: AgentRunScope | undefined;
	lane?: AgentRunLane | undefined;
	runId?: string | undefined;
	rootRequestId?: string | undefined;
	retryOfRunId?: string | undefined;
	goalId?: string | undefined;
	goalCycle?: number | undefined;
}): AgentRunState {
	const state: AgentRunState = createAgentRunState(params);
	params.session.agentRuns.set(state.runId, state);
	params.session.agentRunToolCalls.set(state.runId, new Map());
	emitAgentRunState(params.socket, params.session, state);
	return state;
}

export function getAgentRun(session: ClientSession, runId: string): AgentRunState | undefined {
	return session.agentRuns.get(runId);
}

export function updateAgentRun(
	socket: WebSocket,
	session: ClientSession,
	runId: string,
	stage: AgentRunStage,
	patch: AgentRunStatePatch = {}
): AgentRunState {
	const current: AgentRunState | undefined = session.agentRuns.get(runId);
	if (current === undefined) {
		throw new Error(`Unknown agent run: ${runId}.`);
	}
	const next: AgentRunState = transitionAgentRunState(current, stage, patch);
	session.agentRuns.set(runId, next);
	emitAgentRunState(socket, session, next);
	notifyGoalRunState(socket, session, next);
	return next;
}

export function recordAgentRunToolEvent(
	socket: WebSocket,
	session: ClientSession,
	runId: string,
	event: ToolEvent,
	writeCheckpointCovered: boolean = false
): void {
	const current: AgentRunState | undefined = session.agentRuns.get(runId);
	if (current === undefined || current.terminal !== null) {
		return;
	}
	const calls: Map<string, { toolName: string; risk: ToolRisk; args: Record<string, unknown> }> = session.agentRunToolCalls.get(runId) ?? new Map();
	session.agentRunToolCalls.set(runId, calls);

	if (event.type === "tool.call") {
		const risk: ToolRisk = getEffectiveToolPolicy(
			event.toolName,
			event.args,
			session.activeWorkspace?.id
		)?.risk ?? "read";
		calls.set(event.toolCallId, {
			toolName: event.toolName,
			risk,
			args: structuredClone(event.args)
		});
		if (risk === "verify" && current.stage === "executing") {
			updateAgentRun(socket, session, runId, "verifying");
		}
		return;
	}
	if (event.type !== "tool.result" && event.type !== "tool.error") {
		return;
	}

	const call = calls.get(event.toolCallId);
	const risk: ToolRisk = call?.risk ?? getEffectiveToolPolicy(event.toolName, {}, session.activeWorkspace?.id)?.risk ?? "read";
	const eventRecord: Record<string, unknown> = event as unknown as Record<string, unknown>;
		const artifactRefs: string[] = Array.isArray(eventRecord.artifactRefs)
			? eventRecord.artifactRefs.filter((item: unknown): item is string => typeof item === "string")
			: [];
		const artifactFileRefs: WorkspaceFileRef[] = Array.isArray(eventRecord.artifactFileRefs)
			? eventRecord.artifactFileRefs.filter((item: unknown): item is WorkspaceFileRef => (
				typeof item === "object"
					&& item !== null
					&& typeof (item as Record<string, unknown>).workspaceId === "string"
					&& typeof (item as Record<string, unknown>).sourceFolderId === "string"
					&& typeof (item as Record<string, unknown>).relativePath === "string"
			))
			: [];
	const evidence: ExecutionEvidence = {
		toolCallId: event.toolCallId,
		toolName: event.toolName,
		risk,
		status: event.type === "tool.error"
			? "failed"
			: eventRecord.validationStatus === "not_applicable"
				? "succeeded"
				: eventRecord.ok === false ? "failed" : "succeeded",
			artifactRefs,
			artifactFileRefs: artifactFileRefs.length > 0 ? artifactFileRefs : undefined,
			sourceFolderId: typeof eventRecord.sourceFolderId === "string" ? eventRecord.sourceFolderId : call?.args.sourceFolderId as string | undefined,
		summary: typeof eventRecord.summary === "string"
			? eventRecord.summary
			: event.type === "tool.error"
				? event.message
				: undefined,
		validationStatus: eventRecord.validationStatus === "passed"
			|| eventRecord.validationStatus === "failed"
			|| eventRecord.validationStatus === "not_applicable"
			? eventRecord.validationStatus
			: undefined,
		environmentIssue: eventRecord.environmentIssue === true,
		applicabilityCode: isToolApplicabilityCode(eventRecord.applicabilityCode)
			? eventRecord.applicabilityCode
			: undefined,
		terminalObservation: event.type === "tool.result"
			&& current.lane === "probe"
			&& event.toolName === "mcp_terminal_run_command"
			&& eventRecord.ok !== false
			&& eventRecord.validationStatus !== "not_applicable"
			&& eventRecord.terminalJobStatus !== "running",
		observedAt: new Date().toISOString()
	};
	if (
		current.goalId !== undefined
		&& evidence.status === "succeeded"
		&& (risk === "write" || risk === "destructive")
		&& !writeCheckpointCovered
		&& !(event.type === "tool.result" && event.fileEditDraft !== undefined)
	) {
		enqueueGoalWriteCheckpointUnavailable(runId, `untracked_write_tool:${event.toolName}`);
	}
	const evidenceWithoutDuplicate: ExecutionEvidence[] = current.checkpoint.evidence
		.filter((item: ExecutionEvidence): boolean => item.toolCallId !== evidence.toolCallId);
	evidenceWithoutDuplicate.push(evidence);
	const successfulWriteFingerprints: string[] = [...current.checkpoint.successfulWriteFingerprints];
	if (
		evidence.status === "succeeded"
		&& (risk === "write" || risk === "destructive")
		&& call !== undefined
	) {
		const fingerprint: string = createWriteFingerprint(call.toolName, call.args);
		if (!successfulWriteFingerprints.includes(fingerprint)) {
			successfulWriteFingerprints.push(fingerprint);
		}
	}
	const nextStage: AgentRunStage = current.stage === "verifying" && risk !== "verify"
		? "executing"
		: current.stage;
	try {
		updateAgentRun(socket, session, runId, nextStage, {
			checkpoint: {
				evidence: evidenceWithoutDuplicate,
				successfulWriteFingerprints,
				lastWriteAt: successfulWriteFingerprints.length > current.checkpoint.successfulWriteFingerprints.length
					? evidence.observedAt
					: current.checkpoint.lastWriteAt
			}
		});
	} catch (error: unknown) {
		logger.error("agent_run", "tool_evidence_transition_failed", error, {
			runId,
			toolCallId: event.toolCallId,
			toolName: event.toolName
		});
	}
}

export function recordAgentRunApprovedToolResult(
	socket: WebSocket,
	session: ClientSession,
	runId: string,
	params: {
		toolCallId: string;
		toolName: string;
		args: Record<string, unknown>;
		succeeded: boolean;
		summary?: string | undefined;
		artifactRefs?: string[] | undefined;
		writeCheckpointCovered?: boolean | undefined;
	}
): void {
	const calls: Map<string, { toolName: string; risk: ToolRisk; args: Record<string, unknown> }> =
		session.agentRunToolCalls.get(runId) ?? new Map();
	const risk: ToolRisk = getEffectiveToolPolicy(
		params.toolName,
		params.args,
		session.activeWorkspace?.id
	)?.risk ?? "read";
	calls.set(params.toolCallId, {
		toolName: params.toolName,
		risk,
		args: structuredClone(params.args)
	});
	session.agentRunToolCalls.set(runId, calls);
	recordAgentRunToolEvent(socket, session, runId, params.succeeded
		? {
			type: "tool.result",
			step: 0,
			toolCallId: params.toolCallId,
			toolName: params.toolName,
			resultChars: params.summary?.length ?? 0,
			truncated: false,
			ok: true,
			artifactRefs: params.artifactRefs
		}
		: {
			type: "tool.error",
			step: 0,
			toolCallId: params.toolCallId,
			toolName: params.toolName,
			message: params.summary ?? "Approved tool execution failed."
		}, params.writeCheckpointCovered === true);
}
