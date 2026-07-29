import WebSocket from "ws";
import type { ProviderAgentResult } from "../providers/agent-types.js";
import type { ProviderChatOptions } from "../providers/provider-types.js";
import type { PendingToolBudget, PendingToolBudgetPhaseStats } from "../session/pending-tool-budget.js";
import { saveAgentRunContinuation } from "../session/agent-run-store.js";
import type { WorkflowRunState, WorkflowToolObservation } from "../workflow/types.js";
import type { LightweightActionState } from "../workflow/lightweight-action.js";
import type { ClientSession, PendingAiContinuation } from "./client-session.js";
import { createPendingAiContinuation } from "./approval-continuation.js";
import { enqueueSessionEventWrite, sendSessionEvent } from "./session-events.js";
import { setWorkbenchActiveRun } from "./workbench.js";
import { getAgentRun } from "./agent-run-controller.js";

export function createPendingToolBudget(
	params: {
		agentResult: Extract<ProviderAgentResult, { status: "tool_budget_required" }>;
		chatParams: PendingAiContinuation["params"];
		options: ProviderChatOptions;
		allowedToolNames: readonly string[] | undefined;
		userMessage: string;
		requestId: string;
		userCreatedAt: string;
		stream: boolean;
		workflowState?: WorkflowRunState | undefined;
		lightweightActionState?: LightweightActionState | undefined;
		workflowPhaseToolStats?: PendingToolBudgetPhaseStats | undefined;
		workflowToolObservations?: WorkflowToolObservation[] | undefined;
		executionControl?: PendingAiContinuation["executionControl"];
	}
): PendingToolBudget {
	const continuation: PendingAiContinuation = createPendingAiContinuation(
		params.chatParams,
		params.options,
		params.agentResult.continuation,
		params.allowedToolNames,
		params.userMessage,
		params.requestId,
		params.userCreatedAt,
		params.stream,
		params.workflowState,
		params.lightweightActionState,
		params.executionControl
	);
	return {
		budgetId: params.agentResult.budgetId,
		requestId: params.requestId,
		reason: params.agentResult.reason,
		limitKind: params.agentResult.limitKind,
		usedSteps: params.agentResult.usedSteps,
		maxSteps: params.agentResult.maxSteps,
		totalToolResultChars: params.agentResult.totalToolResultChars,
		toolResultCharLimit: params.agentResult.toolResultCharLimit,
		additionalSteps: params.agentResult.additionalSteps,
		createdAt: new Date().toISOString(),
		continuation,
		workflowPhaseToolStats: params.workflowPhaseToolStats,
		workflowToolObservations: params.workflowToolObservations
	};
}

export function registerPendingToolBudget(session: ClientSession, pending: PendingToolBudget): void {
	session.pendingToolBudgets.set(pending.budgetId, pending);
	setWorkbenchActiveRun(session, {
		status: "paused",
		statusCode: "tool_budget",
		requestId: pending.requestId
	});
}

export function sendToolBudgetRequired(socket: WebSocket, requestId: string, session: ClientSession, runId: string, pending: PendingToolBudget, persistRequestId: string = requestId): void {
	sendSessionEvent(socket, requestId, session, "agent.run.tool_budget_required", {
		runId,
		requestId: pending.requestId,
		status: "paused",
		statusCode: "tool_budget",
		sequence: session.workbenchActiveRun.sequence ?? session.workbenchActiveRunSequence,
		reason: pending.reason,
		budgetId: pending.budgetId,
		limitKind: pending.limitKind,
		usedSteps: pending.usedSteps,
		maxSteps: pending.maxSteps,
		totalToolResultChars: pending.totalToolResultChars,
		toolResultCharLimit: pending.toolResultCharLimit,
		additionalSteps: pending.additionalSteps,
		message: "工具调用预算已达到上限，等待用户决定是否继续。"
	}, persistRequestId);
	const pausedRun = getAgentRun(session, persistRequestId);
	if (pausedRun !== undefined) {
		enqueueSessionEventWrite(session, async (): Promise<void> => {
			await saveAgentRunContinuation(pausedRun, {
				kind: "tool_budget",
				pauseId: pending.budgetId,
				revision: pausedRun.revision,
				pending
			});
		});
	}
}

export function cancelPendingToolBudgetsForRequest(session: ClientSession, requestId: string): string[] {
	const cancelledBudgetIds: string[] = [];
	for (const [budgetId, pending] of session.pendingToolBudgets) {
		if (pending.requestId !== requestId) {
			continue;
		}
		session.pendingToolBudgets.delete(budgetId);
		cancelledBudgetIds.push(budgetId);
	}
	return cancelledBudgetIds;
}

export function createToolBudgetStopReason(pending: PendingToolBudget): string {
	return [
		"用户选择不继续放行工具调用预算。",
		`停止原因：${pending.reason}。`,
		"请停止请求更多工具，基于当前已经获得的工具结果直接回答用户；如果信息不完整，请明确说明仍缺少哪些检查。"
	].join("\n");
}
