import WebSocket from "ws";
import type { AiChatParams } from "../protocol/types.js";
import type { AgentContinuation, ProviderAgentResult } from "../providers/agent-types.js";
import type { ProviderChatOptions } from "../providers/deepseek-client.js";
import { appendApprovalEvent, readApprovalEvents } from "../session/session-store.js";
import { createPersistedApprovalRequestedData, createRuntimePendingContinuation, foldPendingApprovalStates, mergeHydratedPendingApprovalStates, type PendingApprovalState } from "../session/approval-persistence.js";
import type { WorkflowRunState, WorkflowToolObservation } from "../workflow/types.js";
import {
	cloneLightweightActionState,
	collectLightweightActionCompletionStatus,
	LightweightActionVerificationError,
	type LightweightActionState
} from "../workflow/lightweight-action.js";
import { evaluateToolCall, getToolPolicy } from "../tools/tool-policy.js";
import type { PendingApproval } from "../tools/approval-gateway.js";
import { getLlmToolExecutionIdentity } from "../tools/tool-idempotency.js";
import { resolveToolMapping } from "../tools/tool-mapping.js";
import { parseToolResultSummary } from "../tools/tool-result-parser.js";
import { McpHost } from "../mcp/mcp-host.js";
import type { ClientSession, PendingAiContinuation } from "./client-session.js";
import { appendChatTurnToSession } from "./token-budget.js";
import { sendSessionEvent } from "./session-events.js";
import { sendJson } from "./send-json.js";
import { createPendingToolBudget, registerPendingToolBudget, sendToolBudgetRequired } from "./tool-budget-continuation.js";

export function createPendingAiContinuation(
	params: AiChatParams,
	options: ProviderChatOptions,
	continuation: AgentContinuation,
	allowedToolNames: readonly string[] | undefined,
	userMessage: string,
	requestId: string,
	userCreatedAt: string,
	stream: boolean,
	workflowState?: WorkflowRunState | undefined,
	lightweightActionState?: LightweightActionState | undefined
): PendingAiContinuation {
	const pendingContinuation: PendingAiContinuation = {
		params,
		options,
		continuation,
		userMessage,
		requestId,
		userCreatedAt,
		stream
	};

	if (allowedToolNames !== undefined) {
		pendingContinuation.allowedToolNames = allowedToolNames;
	}
	if (lightweightActionState !== undefined) {
		pendingContinuation.lightweightActionState = cloneLightweightActionState(lightweightActionState);
	}

	if (workflowState !== undefined) {
		pendingContinuation.agentRunState = workflowState;
		pendingContinuation.workflowState = workflowState;
	}

	return pendingContinuation;
}

export async function persistApprovalRequested(
	session: ClientSession,
	mcpHost: McpHost,
	approvalId: string,
	pendingContinuation: PendingAiContinuation
): Promise<void> {
	if (session.sessionId === undefined) {
		return;
	}

	const pendingApproval: PendingApproval | undefined = session.approvalGateway.getPending(approvalId);
	if (pendingApproval === undefined) {
		return;
	}

	await appendApprovalEvent(
		session.sessionId,
		approvalId,
		pendingContinuation.requestId,
		"requested",
		createPersistedApprovalRequestedData(pendingApproval, pendingContinuation, mcpHost.getActiveWorkspaceId())
	);
}

export async function registerPendingApprovalContinuation(
	session: ClientSession,
	mcpHost: McpHost,
	approvalId: string,
	pendingContinuation: PendingAiContinuation
): Promise<void> {
	session.pendingAiContinuations.set(approvalId, pendingContinuation);
	await persistApprovalRequested(session, mcpHost, approvalId, pendingContinuation);
}

export async function cancelPendingApprovalsForRequest(session: ClientSession, requestId: string): Promise<string[]> {
	const approvalIds: Set<string> = new Set();
	for (const pendingApproval of session.approvalGateway.listPending()) {
		const continuation: PendingAiContinuation | undefined = session.pendingAiContinuations.get(pendingApproval.approvalId);
		if (continuation?.requestId === requestId) {
			approvalIds.add(pendingApproval.approvalId);
		}
	}

	if (session.sessionId !== undefined) {
		const states: PendingApprovalState[] = foldPendingApprovalStates(await readApprovalEvents(session.sessionId));
		for (const state of states) {
			if (state.requestId === requestId) {
				approvalIds.add(state.approval.approvalId);
			}
		}
	}

	const cancelledApprovalIds: string[] = [];
	for (const approvalId of approvalIds) {
		const pendingApproval: PendingApproval | undefined = session.approvalGateway.removePending(approvalId);
		session.pendingAiContinuations.delete(approvalId);
		cancelledApprovalIds.push(approvalId);
		if (session.sessionId !== undefined) {
			await appendApprovalEvent(session.sessionId, approvalId, requestId, "cancelled", {
				approvalId,
				toolName: pendingApproval?.llmToolName ?? null,
				reason: "run_cancelled"
			});
		}
	}

	return cancelledApprovalIds;
}

export async function loadHydratedPendingApprovalStates(
	session: ClientSession,
	apiKey?: string | undefined
): Promise<{ states: PendingApprovalState[]; hadEvents: boolean }> {
	if (session.sessionId === undefined) {
		return {
			states: createMemoryPendingApprovalStates(session),
			hadEvents: false
		};
	}

	const approvalEvents = await readApprovalEvents(session.sessionId);
	if (approvalEvents.length === 0) {
		return {
			states: createMemoryPendingApprovalStates(session),
			hadEvents: false
		};
	}

	const memoryStates: PendingApprovalState[] = createMemoryPendingApprovalStates(session);
	const states: PendingApprovalState[] = mergeHydratedPendingApprovalStates(
		foldPendingApprovalStates(approvalEvents),
		memoryStates
	);
	session.approvalGateway.replacePending(states.map((state: PendingApprovalState): PendingApproval => state.approval));
	const pendingIds: Set<string> = new Set(states.map((state: PendingApprovalState): string => state.approval.approvalId));
	for (const approvalId of session.pendingAiContinuations.keys()) {
		if (!pendingIds.has(approvalId)) {
			session.pendingAiContinuations.delete(approvalId);
		}
	}

	if (apiKey !== undefined) {
		for (const state of states) {
			if (state.continuation !== undefined) {
				session.pendingAiContinuations.set(state.approval.approvalId, createRuntimePendingContinuation(state.continuation, apiKey));
			}
		}
	}

	return {
		states,
		hadEvents: true
	};
}

export function createMemoryPendingApprovalStates(session: ClientSession): PendingApprovalState[] {
	return session.approvalGateway.listPending().map((pendingApproval: PendingApproval): PendingApprovalState => {
		const timestamp: string = new Date(pendingApproval.createdAt).toISOString();
		const continuation: PendingAiContinuation | undefined = session.pendingAiContinuations.get(pendingApproval.approvalId);
		return {
			approval: pendingApproval,
			status: "pending",
			restored: false,
			interrupted: false,
			requestId: continuation?.requestId ?? "",
			createdAt: timestamp,
			updatedAt: timestamp
		};
	});
}

export async function waitForPendingApprovalContinuationRegistration(
	session: ClientSession,
	approvalId: string,
	timeoutMs: number = 3000
): Promise<PendingAiContinuation | undefined> {
	const deadline: number = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const pendingContinuation: PendingAiContinuation | undefined = session.pendingAiContinuations.get(approvalId);
		if (pendingContinuation !== undefined) {
			return pendingContinuation;
		}
		await new Promise<void>((resolve: () => void): NodeJS.Timeout => setTimeout(resolve, 50));
	}

	return session.pendingAiContinuations.get(approvalId);
}

export function findPendingApprovalState(states: PendingApprovalState[], approvalId: string): PendingApprovalState | undefined {
	return states.find((state: PendingApprovalState): boolean => state.approval.approvalId === approvalId);
}

export async function restorePendingContinuationForApproval(
	session: ClientSession,
	state: PendingApprovalState | undefined,
	apiKey: string | undefined
): Promise<PendingAiContinuation | undefined> {
	const approvalId: string | undefined = state?.approval.approvalId;
	if (approvalId !== undefined) {
		const existingContinuation: PendingAiContinuation | undefined = session.pendingAiContinuations.get(approvalId);
		if (existingContinuation !== undefined) {
			return existingContinuation;
		}
	}

	if (state?.continuation === undefined || apiKey === undefined) {
		return undefined;
	}

	const restoredContinuation: PendingAiContinuation = createRuntimePendingContinuation(state.continuation, apiKey);
	session.pendingAiContinuations.set(state.approval.approvalId, restoredContinuation);
	return restoredContinuation;
}

export async function validatePendingApprovalBeforeExecution(
	session: ClientSession,
	mcpHost: McpHost,
	pendingApproval: PendingApproval
): Promise<string | null> {
	const decision = evaluateToolCall(
		session.approvalGateway.getMode(),
		pendingApproval.llmToolName,
		pendingApproval.args,
		pendingApproval.workspaceId
	);
	if (decision.action === "deny") {
		return decision.reason;
	}

	try {
		resolveToolMapping(pendingApproval.llmToolName, pendingApproval.workspaceId);
	} catch (error: unknown) {
		return error instanceof Error ? error.message : "审批工具当前不可用";
	}

	const currentIdentity = getLlmToolExecutionIdentity(
		pendingApproval.llmToolName,
		pendingApproval.args,
		pendingApproval.workspaceId ?? mcpHost.getActiveWorkspaceId(),
		pendingApproval.workspaceId
	);
	if (
		pendingApproval.executionFingerprint !== undefined
		&& currentIdentity !== undefined
		&& currentIdentity.fingerprint !== pendingApproval.executionFingerprint
	) {
		return "当前 workspace 与创建审批时不一致，不能执行该审批。";
	}

	return null;
}

export function createApprovedWorkflowToolObservation(pendingApproval: PendingApproval, content: string): WorkflowToolObservation {
	const parsedResult = parseToolResultSummary(pendingApproval.llmToolName, pendingApproval.args, content);
	const failed: boolean = parsedResult.validationStatus === "failed" || parsedResult.ok === false;
	return {
		toolCallId: pendingApproval.toolCallId,
		toolName: pendingApproval.llmToolName,
		risk: getToolPolicy(pendingApproval.llmToolName, pendingApproval.workspaceId)?.risk,
		status: failed ? "failed" : "succeeded",
		argsSummary: {},
		parsedResult: {
			...parsedResult
		},
		artifactRefs: parsedResult.artifactRefs ?? []
	};
}

export function sendAgentPaused(socket: WebSocket, requestId: string, session: ClientSession, runId: string, agentResult: Extract<ProviderAgentResult, { status: "approval_required" }>, persistRequestId: string = requestId): void {
	sendSessionEvent(socket, requestId, session, "agent.run.paused", {
		runId,
		requestId,
		status: "paused",
		statusCode: "approval_required",
		sequence: session.workbenchActiveRun.sequence ?? session.workbenchActiveRunSequence,
		reason: "approval_required",
		approvalId: agentResult.approvalId,
		toolName: agentResult.toolName,
		message: `工具 ${agentResult.toolName} 需要审批：${agentResult.approvalId}`
	}, persistRequestId);
}

export async function sendContinuedAgentResult(
	socket: WebSocket,
	requestId: string,
	session: ClientSession,
	mcpHost: McpHost,
	agentResult: ProviderAgentResult,
	pendingContinuation: PendingAiContinuation,
	historyBudgetTokens: number | null = null
): Promise<void> {
	if (agentResult.status === "approval_required") {
		const nextPendingContinuation: PendingAiContinuation = createPendingAiContinuation(
			pendingContinuation.params,
			pendingContinuation.options,
			agentResult.continuation,
			pendingContinuation.allowedToolNames,
			pendingContinuation.userMessage,
			pendingContinuation.requestId,
			pendingContinuation.userCreatedAt,
			pendingContinuation.stream,
			pendingContinuation.workflowState,
			pendingContinuation.lightweightActionState
		);
		await registerPendingApprovalContinuation(session, mcpHost, agentResult.approvalId, nextPendingContinuation);
		sendAgentPaused(socket, requestId, session, pendingContinuation.workflowState?.plan.id ?? pendingContinuation.requestId, agentResult, pendingContinuation.requestId);
		return;
	}
	if (agentResult.status === "tool_budget_required") {
		const pendingBudget = createPendingToolBudget({
			agentResult,
			chatParams: pendingContinuation.params,
			options: pendingContinuation.options,
			allowedToolNames: pendingContinuation.allowedToolNames,
			userMessage: pendingContinuation.userMessage,
			requestId: pendingContinuation.requestId,
			userCreatedAt: pendingContinuation.userCreatedAt,
			stream: pendingContinuation.stream,
			workflowState: pendingContinuation.workflowState,
			lightweightActionState: pendingContinuation.lightweightActionState
		});
		registerPendingToolBudget(session, pendingBudget);
		sendToolBudgetRequired(socket, requestId, session, pendingContinuation.workflowState?.plan.id ?? pendingContinuation.requestId, pendingBudget, pendingContinuation.requestId);
		return;
	}

	if (agentResult.status === "protocol_violation") {
		throw new Error(agentResult.reason);
	}

	const text: string = agentResult.text;
	const runId: string = pendingContinuation.workflowState?.plan.id ?? pendingContinuation.requestId;
	const stepRunId: string = pendingContinuation.workflowState?.activePhaseRunId ?? pendingContinuation.requestId;
	const completionStatus = pendingContinuation.lightweightActionState === undefined
		? {
			resultStatus: "completed" as const,
			verificationStatus: undefined,
			warnings: [] as string[],
			failureMessage: undefined
		}
		: collectLightweightActionCompletionStatus(pendingContinuation.lightweightActionState);
	if (completionStatus.failureMessage !== undefined) {
		throw new LightweightActionVerificationError(completionStatus.failureMessage);
	}

	if (!pendingContinuation.stream) {
		for (let index: number = 0; index < text.length; index += 1) {
			sendSessionEvent(socket, requestId, session, "agent.message.delta", {
				runId,
				stepRunId,
				text: text[index]
			}, pendingContinuation.requestId);
		}
	}

	await appendChatTurnToSession(
		session,
		[],
		pendingContinuation.userMessage,
		text,
		pendingContinuation.requestId,
		pendingContinuation.userCreatedAt,
		undefined,
		pendingContinuation.params.additionalContext
	);
	sendSessionEvent(socket, requestId, session, "agent.message.done", {
		runId,
		stepRunId,
		text,
		context: {
			historyMessagesStored: session.messages.length,
			historyBudgetTokens,
			mcpServers: mcpHost.getConnectedServerIds()
		}
	}, pendingContinuation.requestId);
	sendSessionEvent(socket, requestId, session, "agent.run.done", {
		runId,
		requestId: pendingContinuation.requestId,
		status: "done",
		resultStatus: completionStatus.resultStatus,
		verificationStatus: completionStatus.verificationStatus,
		warnings: completionStatus.warnings,
		sequence: session.workbenchActiveRun.sequence ?? session.workbenchActiveRunSequence
	}, pendingContinuation.requestId);
	sendJson(socket, {
		type: "response",
		id: pendingContinuation.requestId,
		ok: true,
		result: {
			text,
			context: {
				historyMessagesStored: session.messages.length,
				historyBudgetTokens,
				mcpServers: mcpHost.getConnectedServerIds()
			}
		}
	});
}
