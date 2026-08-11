import { CHAT_TOOL_RESULT_CHAR_LIMIT, MAX_TOTAL_TOOL_RESULT_CHARS, TOOL_BUDGET_CONTINUE_STEPS, TOOL_RESULT_CONTINUE_CHARS, resolveToolBudget } from "../tools/llm-tool-budget.js";
import type { AiChatParams } from "../protocol/types.js";
import type { AgentContinuation, ProviderAgentResult, ToolBudgetLimitKind } from "./agent-types.js";

/**
 * 新 Agent Loop 不再把普通工具步数变成用户决策点。这个上限只用于阻止
 * provider 永久循环；到达后要求模型基于现有结果自然收束，不创建预算审批。
 */
export const AUTONOMOUS_AGENT_TOOL_HARD_LIMIT = 256 as const;

/**
 * 工具预算是资源边界，不是审批边界
 * 到达边界必须保留 provider continuation，避免 auto-safe/full-trust
 * 把未完成任务错误收束为最终回答，导致用户无法从既有进度继续
 */
export function shouldPauseForToolBudget(autonomousAgentLoop: boolean = false): boolean {
	return !autonomousAgentLoop;
}

export function createToolBudgetId(): string {
	return `tool-budget-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getInitialMaxToolSteps(params: AiChatParams, autonomousAgentLoop: boolean = false): number {
	const configuredLimit: number = resolveToolBudget(
		(params.options as Record<string, unknown> | undefined)?.["toolBudget"] as string | undefined,
		params.skillRefs?.[0]
	);
	return autonomousAgentLoop
		? Math.max(configuredLimit, AUTONOMOUS_AGENT_TOOL_HARD_LIMIT)
		: configuredLimit;
}

export function getInitialToolResultCharLimit(params: AiChatParams): number {
	return params.options?.outputTarget === "chat"
		? CHAT_TOOL_RESULT_CHAR_LIMIT
		: MAX_TOTAL_TOOL_RESULT_CHARS;
}

export function getContinuationMaxSteps(
	params: AiChatParams,
	continuation: AgentContinuation,
	autonomousAgentLoop: boolean = false
): number {
	const continuedLimit: number = continuation.maxSteps ?? getInitialMaxToolSteps(params, autonomousAgentLoop);
	return autonomousAgentLoop
		? Math.max(continuedLimit, AUTONOMOUS_AGENT_TOOL_HARD_LIMIT)
		: continuedLimit;
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
