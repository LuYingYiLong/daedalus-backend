import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import type { AnthropicMessageParam } from "./anthropic-compatible-client.js";
import type { ExecutionDecision } from "../workflow/agent-run-state.js";
import type { ProviderToolImageReference } from "./tool-image-reference.js";
import type { ChatAnswer } from "../tools/chat-completion-control.js";
import type { AgentContextState } from "../context/context-types.js";

export type ChatCompletionsAgentContinuation = {
	kind?: "chat_completions";
	messages: ChatCompletionMessageParam[];
	nextStep: number;
	totalToolResultChars: number;
	maxSteps?: number | undefined;
	toolResultCharLimit?: number | undefined;
	toolImageReferences?: ProviderToolImageReference[] | undefined;
	contextState?: AgentContextState | undefined;
};

export type ResponsesAgentContinuation = {
	kind: "responses";
	instructions: string;
	inputItems: ResponseInputItem[];
	nextStep: number;
	totalToolResultChars: number;
	maxSteps?: number | undefined;
	toolResultCharLimit?: number | undefined;
	toolImageReferences?: ProviderToolImageReference[] | undefined;
	contextState?: AgentContextState | undefined;
};

export type AnthropicMessagesAgentContinuation = {
	kind: "anthropic_messages";
	systemPrompt: string;
	messages: AnthropicMessageParam[];
	nextStep: number;
	totalToolResultChars: number;
	maxSteps?: number | undefined;
	toolResultCharLimit?: number | undefined;
	toolImageReferences?: ProviderToolImageReference[] | undefined;
	contextState?: AgentContextState | undefined;
};

export type AgentContinuation = ChatCompletionsAgentContinuation | ResponsesAgentContinuation | AnthropicMessagesAgentContinuation;

export type ToolBudgetLimitKind = "steps" | "tool_result_chars";

export type ProviderAgentResult =
	| { status: "completed"; text: string }
	| { status: "protocol_violation"; text: string; reason: string }
	| { status: "execution_decision"; decision: ExecutionDecision }
	| { status: "chat_answer"; answer: ChatAnswer }
	| {
		status: "approval_required";
		approvalId: string;
		toolName: string;
		reason: string;
		continuation: AgentContinuation;
	}
	| {
		status: "tool_budget_required";
		budgetId: string;
		limitKind: ToolBudgetLimitKind;
		reason: string;
		usedSteps: number;
		maxSteps: number;
		totalToolResultChars: number;
		toolResultCharLimit: number;
		additionalSteps: number;
		continuation: AgentContinuation;
	};

export type ApprovedToolResult = {
	toolCallId: string;
	content: string;
};
