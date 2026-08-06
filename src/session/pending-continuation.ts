import type { AiChatParams } from "../protocol/types.js";
import type { AgentContinuation } from "../providers/agent-types.js";
import type { ProviderChatOptions } from "../providers/deepseek-client.js";
import type { LightweightActionState } from "../workflow/lightweight-action.js";
import type { WorkflowRunState } from "../workflow/types.js";
import type { ExecutionControlContext } from "../tools/execution-control.js";
import type { ChatCompletionContext } from "../tools/chat-completion-control.js";

export type PendingAiContinuation = {
	params: AiChatParams;
	options: ProviderChatOptions;
	continuation: AgentContinuation;
	allowedToolNames?: readonly string[] | undefined;
	userMessage: string;
	requestId: string;
	userCreatedAt: string;
	stream: boolean;
	lightweightActionState?: LightweightActionState | undefined;
	agentRunState?: WorkflowRunState | undefined;
	workflowState?: WorkflowRunState | undefined;
	executionControl?: ExecutionControlContext | undefined;
	chatCompletion?: ChatCompletionContext | undefined;
};
