import type { ApprovalGateway } from "../tools/approval-gateway.js";
import { MAX_TOTAL_TOOL_RESULT_CHARS, TOOL_BUDGET_CONTINUE_STEPS, TOOL_RESULT_CONTINUE_CHARS, resolveToolBudget } from "../tools/llm-tool-budget.js";
import type { AiChatParams } from "../protocol/types.js";
import type { AgentContinuation, ProviderAgentResult, ToolBudgetLimitKind } from "./agent-types.js";

export function shouldPauseForToolBudget(gateway: ApprovalGateway): boolean {
	return gateway.getMode() === "manual";
}

export function createToolBudgetId(): string {
	return `tool-budget-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getInitialMaxToolSteps(params: AiChatParams): number {
	return resolveToolBudget(
		(params.options as Record<string, unknown> | undefined)?.["toolBudget"] as string | undefined,
		params.skillRefs?.[0]
	);
}

export function getContinuationMaxSteps(params: AiChatParams, continuation: AgentContinuation): number {
	return continuation.maxSteps ?? getInitialMaxToolSteps(params);
}

export function getContinuationToolResultCharLimit(continuation: AgentContinuation): number {
	return continuation.toolResultCharLimit ?? MAX_TOTAL_TOOL_RESULT_CHARS;
}

export function getContinuedMaxSteps(params: AiChatParams, continuation: AgentContinuation, additionalSteps: number = TOOL_BUDGET_CONTINUE_STEPS): number {
	return Math.max(getContinuationMaxSteps(params, continuation), continuation.nextStep) + additionalSteps;
}

export function getContinuedToolResultCharLimit(continuation: AgentContinuation, additionalChars: number = TOOL_RESULT_CONTINUE_CHARS): number {
	return getContinuationToolResultCharLimit(continuation) + additionalChars;
}

export function createToolBudgetRequiredResult(params: {
	limitKind: ToolBudgetLimitKind;
	reason: string;
	usedSteps: number;
	maxSteps: number;
	totalToolResultChars: number;
	toolResultCharLimit: number;
	continuation: AgentContinuation;
}): Extract<ProviderAgentResult, { status: "tool_budget_required" }> {
	return {
		status: "tool_budget_required",
		budgetId: createToolBudgetId(),
		limitKind: params.limitKind,
		reason: params.reason,
		usedSteps: params.usedSteps,
		maxSteps: params.maxSteps,
		totalToolResultChars: params.totalToolResultChars,
		toolResultCharLimit: params.toolResultCharLimit,
		additionalSteps: TOOL_BUDGET_CONTINUE_STEPS,
		continuation: {
			...params.continuation,
			maxSteps: params.maxSteps,
			toolResultCharLimit: params.toolResultCharLimit
		}
	};
}
