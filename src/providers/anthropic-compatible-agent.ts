import type {
	ChatCompletionMessageToolCall,
	ChatCompletionTool,
	ChatCompletionToolMessageParam
} from "openai/resources/chat/completions";
import type { AiChatParams, ChatMessage } from "../protocol/types.js";
import type { McpHost } from "../mcp/mcp-host.js";
import { createWorkspaceToolCatalog, type ToolExecutionContext } from "../tools/tool-catalog.js";
import { MAX_TOTAL_TOOL_RESULT_CHARS } from "../tools/llm-tool-budget.js";
import { dispatchToolCalls, ToolApprovalRequiredError, type OnToolEvent, type ToolResultEnricher } from "../tools/tool-dispatcher.js";
import { ExecutionDecisionSignal } from "../tools/execution-control.js";
import { ApprovalGateway } from "../tools/approval-gateway.js";
import type { ApprovedToolResult, AnthropicMessagesAgentContinuation, ProviderAgentResult } from "./agent-types.js";
import { createToolResultLimitFallback, createToolResultLimitReason, fitToolResultContent } from "./tool-result-budget.js";
import type { ProviderChatOptions } from "./provider-types.js";
import {
	convertChatToolsToAnthropicTools,
	createAnthropicMessage,
	createAnthropicMessages,
	extractAnthropicText,
	extractAnthropicToolUseBlocks,
	streamAnthropicMessage,
	type AnthropicContentBlock,
	type AnthropicMessageParam,
	type AnthropicToolDefinition,
	type AnthropicToolResultBlock,
	type AnthropicToolUseBlock
} from "./anthropic-compatible-client.js";
import {
	createToolBudgetRequiredResult,
	getContinuationMaxSteps,
	getContinuationToolResultCharLimit,
	getContinuedMaxSteps,
	getContinuedToolResultCharLimit,
	getInitialMaxToolSteps,
	shouldPauseForToolBudget
} from "./agent-tool-budget.js";
import { injectToolImagesIntoAnthropicMessages } from "./provider-tool-image-content.js";
import type { ProviderToolImageReference } from "./tool-image-reference.js";
import {
	createDelegatedObservationText,
	isProviderImageInputUnsupportedError,
	recognizeToolImageReferences
} from "./tool-image-recognition.js";

const FINALIZE_AFTER_TOOL_LIMIT_PROMPT: string =
	"工具调用阶段已经达到后端限制。请停止请求更多工具，基于目前已经获得的工具结果直接回答用户。"
	+ "如果信息不完整，请明确说明哪些部分是根据已有信息总结的，哪些部分还需要进一步检查。";

export type AnthropicCompatibleAgentResult = ProviderAgentResult;

function createToolCallFromAnthropicBlock(block: AnthropicToolUseBlock): ChatCompletionMessageToolCall {
	return {
		id: block.id,
		type: "function",
		function: {
			name: block.name,
			arguments: JSON.stringify(block.input ?? {})
		}
	};
}

function createAnthropicToolResultBlock(result: ChatCompletionToolMessageParam): AnthropicToolResultBlock {
	const content = result.content;
	return {
		type: "tool_result",
		tool_use_id: result.tool_call_id,
		content: typeof content === "string" ? content : JSON.stringify(content)
	};
}

function createApprovedToolResultBlock(result: ApprovedToolResult, totalToolResultChars: number, maxTotalToolResultChars: number): {
	block: AnthropicToolResultBlock;
	totalToolResultChars: number;
	limitReached: boolean;
	reason?: string | undefined;
} {
	const budgetedResult = fitToolResultContent(result.content, totalToolResultChars, maxTotalToolResultChars);
	const created: {
		block: AnthropicToolResultBlock;
		totalToolResultChars: number;
		limitReached: boolean;
	} = {
		block: {
			type: "tool_result",
			tool_use_id: result.toolCallId,
			content: budgetedResult.content
		},
		totalToolResultChars: totalToolResultChars + budgetedResult.chars,
		limitReached: budgetedResult.limitReached
	};
	if (budgetedResult.reason !== null) {
		return { ...created, reason: budgetedResult.reason };
	}
	return created;
}

function createAssistantMessage(content: string, toolUseBlocks: readonly AnthropicToolUseBlock[]): AnthropicMessageParam {
	const blocks: AnthropicContentBlock[] = [];
	if (content.length > 0) {
		blocks.push({ type: "text", text: content });
	}
	blocks.push(...toolUseBlocks.map((block: AnthropicToolUseBlock): AnthropicToolUseBlock => ({
		type: "tool_use",
		id: block.id,
		name: block.name,
		input: block.input
	})));
	return {
		role: "assistant",
		content: blocks
	};
}

function createToolResultMessage(blocks: readonly AnthropicToolResultBlock[]): AnthropicMessageParam {
	return {
		role: "user",
		content: [...blocks]
	};
}

function createFinalAnswerMessage(reason: string): AnthropicMessageParam {
	return {
		role: "user",
		content: `${FINALIZE_AFTER_TOOL_LIMIT_PROMPT}\n\n收束原因：${reason}`
	};
}

function extractToolResultText(result: ChatCompletionToolMessageParam): string {
	return typeof result.content === "string" ? result.content : JSON.stringify(result.content);
}

function createAnthropicTools(tools: readonly ChatCompletionTool[]): AnthropicToolDefinition[] {
	return convertChatToolsToAnthropicTools(tools);
}

async function createFinalAnswer(
	params: AiChatParams,
	options: ProviderChatOptions,
	messages: AnthropicMessageParam[],
	systemPrompt: string,
	reason: string,
	abortSignal?: AbortSignal | undefined,
	toolImageReferences: readonly ProviderToolImageReference[] = []
): Promise<string> {
	const finalMessages: AnthropicMessageParam[] = await injectToolImagesIntoAnthropicMessages(
		[...messages, createFinalAnswerMessage(reason)],
		toolImageReferences
	);
	const message = await createAnthropicMessage(params, options, finalMessages, systemPrompt, undefined, abortSignal);
	const text: string = extractAnthropicText(message.content);
	return text.length > 0 ? text : createToolResultLimitFallback(reason);
}

async function readAssistantMessage(
	params: AiChatParams,
	options: ProviderChatOptions,
	messages: AnthropicMessageParam[],
	systemPrompt: string,
	tools: readonly AnthropicToolDefinition[],
	streamAssistant: boolean,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined
): Promise<{ text: string; toolUseBlocks: AnthropicToolUseBlock[] }> {
	if (!streamAssistant) {
		const message = await createAnthropicMessage(params, options, messages, systemPrompt, tools, abortSignal);
		return {
			text: extractAnthropicText(message.content),
			toolUseBlocks: extractAnthropicToolUseBlocks(message.content)
		};
	}

	let text: string = "";
	let contentBlocks: AnthropicContentBlock[] = [];
	for await (const event of streamAnthropicMessage(params, options, messages, systemPrompt, tools, abortSignal)) {
		if (event.type === "text_delta") {
			text += event.text;
			onEvent?.({ type: "ai.delta", text: event.text });
			continue;
		}
		if (event.type === "thinking_delta") {
			onEvent?.({ type: "ai.thinking.delta", text: event.text });
			continue;
		}
		contentBlocks = event.message.content;
	}
	return {
		text,
		toolUseBlocks: extractAnthropicToolUseBlocks(contentBlocks)
	};
}

async function runAgentLoop(
	params: AiChatParams,
	options: ProviderChatOptions,
	messages: AnthropicMessageParam[],
	systemPrompt: string,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	tools: ChatCompletionTool[],
	startStep: number,
	maxSteps: number,
	initialToolResultChars: number,
	maxTotalToolResultChars: number,
	streamAssistant: boolean,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	toolResultEnricher?: ToolResultEnricher | undefined,
	toolContext?: ToolExecutionContext | undefined,
	initialToolImageReferences: readonly ProviderToolImageReference[] = []
): Promise<AnthropicCompatibleAgentResult> {
	let totalToolResultChars: number = initialToolResultChars;
	const toolImageReferences: ProviderToolImageReference[] = [...initialToolImageReferences];
	const anthropicTools: AnthropicToolDefinition[] = createAnthropicTools(tools);
	let imageFallbackAttempted: boolean = false;

	for (let step: number = startStep; step < maxSteps; step += 1) {
		if (abortSignal?.aborted) {
			throw new Error("Request cancelled");
		}

		let assistant: { text: string; toolUseBlocks: AnthropicToolUseBlock[] };
		try {
			assistant = await readAssistantMessage(
				params,
				options,
				await injectToolImagesIntoAnthropicMessages(messages, toolImageReferences),
				systemPrompt,
				anthropicTools,
				streamAssistant,
				onEvent,
				abortSignal
			);
		} catch (error: unknown) {
			if (!imageFallbackAttempted && toolImageReferences.length > 0 && isProviderImageInputUnsupportedError(error)) {
				const observation = await recognizeToolImageReferences(toolImageReferences, options, params.message, abortSignal, false);
				messages.push({ role: "user", content: createDelegatedObservationText(observation) });
				toolImageReferences.splice(0, toolImageReferences.length);
				imageFallbackAttempted = true;
				step -= 1;
				continue;
			}
			throw error;
		}

		if (assistant.toolUseBlocks.length === 0) {
			if (assistant.text.length === 0) {
				throw new Error("LLM returned empty response");
			}
			return { status: "completed", text: assistant.text };
		}

		const toolCalls: ChatCompletionMessageToolCall[] = assistant.toolUseBlocks.map(createToolCallFromAnthropicBlock);
		messages.push(createAssistantMessage(assistant.text, assistant.toolUseBlocks));

		let toolResults: Awaited<ReturnType<typeof dispatchToolCalls>>;
		try {
			toolResults = await dispatchToolCalls(mcpHost, toolCalls, step, gateway, onEvent, toolResultEnricher, toolContext, abortSignal);
		} catch (error: unknown) {
			if (error instanceof ExecutionDecisionSignal) {
				return {
					status: "execution_decision",
					decision: error.decision
				};
			}
			if (error instanceof ToolApprovalRequiredError) {
				const pendingBlock: AnthropicToolUseBlock | undefined = assistant.toolUseBlocks.find(
					(block: AnthropicToolUseBlock): boolean => block.id === error.pendingApproval.toolCallId
				);
				const continuationMessages: AnthropicMessageParam[] = [...messages];
				if (pendingBlock !== undefined) {
					continuationMessages[continuationMessages.length - 1] = createAssistantMessage(assistant.text, [pendingBlock]);
				}

				return {
					status: "approval_required",
					approvalId: error.pendingApproval.approvalId,
					toolName: error.pendingApproval.llmToolName,
					reason: error.pendingApproval.reason,
					continuation: {
						kind: "anthropic_messages",
						systemPrompt,
						messages: continuationMessages,
						nextStep: step + 1,
						totalToolResultChars,
						maxSteps,
						toolResultCharLimit: maxTotalToolResultChars,
						toolImageReferences: [...toolImageReferences]
					}
				};
			}
			throw error;
		}

		const resultBlocks: AnthropicToolResultBlock[] = [];
		let toolResultLimitReason: string | null = null;
		for (const result of toolResults) {
			if (result.imageReferences !== undefined) {
				toolImageReferences.push(...result.imageReferences);
			}
			const budgetedResult = fitToolResultContent(extractToolResultText(result), totalToolResultChars, maxTotalToolResultChars);
			totalToolResultChars += budgetedResult.chars;
			resultBlocks.push(createAnthropicToolResultBlock({
				...result,
				content: budgetedResult.content
			}));
			if (budgetedResult.limitReached) {
				toolResultLimitReason = budgetedResult.reason ?? createToolResultLimitReason(totalToolResultChars, maxTotalToolResultChars);
			}
		}
		messages.push(createToolResultMessage(resultBlocks));

		if (toolResultLimitReason !== null || totalToolResultChars >= maxTotalToolResultChars) {
			const reason: string = toolResultLimitReason ?? createToolResultLimitReason(totalToolResultChars, maxTotalToolResultChars);
			if (shouldPauseForToolBudget(gateway)) {
				return createToolBudgetRequiredResult({
					limitKind: "tool_result_chars",
					reason,
					usedSteps: step + 1,
					maxSteps,
					totalToolResultChars,
					toolResultCharLimit: maxTotalToolResultChars,
					continuation: {
						kind: "anthropic_messages",
						systemPrompt,
						messages: [...messages],
						nextStep: step + 1,
						totalToolResultChars,
						maxSteps,
						toolResultCharLimit: maxTotalToolResultChars,
						toolImageReferences: [...toolImageReferences]
					}
				});
			}
			const finalText: string = await createFinalAnswer(
				params,
				options,
				messages,
				systemPrompt,
				reason,
				abortSignal,
				toolImageReferences
			);
			if (streamAssistant) {
				onEvent?.({ type: "ai.delta", text: finalText });
			}
			return { status: "completed", text: finalText };
		}
	}

	const stepLimitReason: string = `工具调用达到最大步数 ${maxSteps}，当前工具结果总量为 ${totalToolResultChars} 字符`;
	if (shouldPauseForToolBudget(gateway)) {
		return createToolBudgetRequiredResult({
			limitKind: "steps",
			reason: stepLimitReason,
			usedSteps: maxSteps,
			maxSteps,
			totalToolResultChars,
			toolResultCharLimit: maxTotalToolResultChars,
			continuation: {
				kind: "anthropic_messages",
				systemPrompt,
				messages: [...messages],
				nextStep: maxSteps,
				totalToolResultChars,
				maxSteps,
				toolResultCharLimit: maxTotalToolResultChars,
				toolImageReferences: [...toolImageReferences]
			}
		});
	}

	const finalText: string = await createFinalAnswer(
		params,
		options,
		messages,
		systemPrompt,
		stepLimitReason,
		abortSignal,
		toolImageReferences
	);
	if (streamAssistant) {
		onEvent?.({ type: "ai.delta", text: finalText });
	}
	return { status: "completed", text: finalText };
}

function getTools(allowedToolNames: readonly string[] | undefined, toolContext: ToolExecutionContext | undefined): ChatCompletionTool[] {
	const toolCatalog = createWorkspaceToolCatalog(toolContext);
	return allowedToolNames !== undefined
		? toolCatalog.getDefinitionsForNames(allowedToolNames)
		: toolCatalog.getDefinitions();
}

function getMaxSteps(params: AiChatParams): number {
	return getInitialMaxToolSteps(params);
}

export async function runAnthropicCompatibleAgent(
	params: AiChatParams,
	options: ProviderChatOptions,
	history: ChatMessage[],
	systemPrompt: string,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames?: readonly string[] | undefined,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	toolResultEnricher?: ToolResultEnricher | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<AnthropicCompatibleAgentResult> {
	return runAgentLoop(
		params,
		options,
		createAnthropicMessages(params, history),
		systemPrompt,
		mcpHost,
		gateway,
		getTools(allowedToolNames, toolContext),
		0,
		getMaxSteps(params),
		0,
		MAX_TOTAL_TOOL_RESULT_CHARS,
		false,
		onEvent,
		abortSignal,
		toolResultEnricher,
		toolContext
	);
}

export async function runAnthropicCompatibleAgentStreaming(
	params: AiChatParams,
	options: ProviderChatOptions,
	history: ChatMessage[],
	systemPrompt: string,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames?: readonly string[] | undefined,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	toolResultEnricher?: ToolResultEnricher | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<AnthropicCompatibleAgentResult> {
	return runAgentLoop(
		params,
		options,
		createAnthropicMessages(params, history),
		systemPrompt,
		mcpHost,
		gateway,
		getTools(allowedToolNames, toolContext),
		0,
		getMaxSteps(params),
		0,
		MAX_TOTAL_TOOL_RESULT_CHARS,
		true,
		onEvent,
		abortSignal,
		toolResultEnricher,
		toolContext
	);
}

async function continueAnthropicCompatibleAgentInternal(
	params: AiChatParams,
	options: ProviderChatOptions,
	continuation: AnthropicMessagesAgentContinuation,
	approvedToolResult: ApprovedToolResult,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames: readonly string[] | undefined,
	onEvent: OnToolEvent | undefined,
	abortSignal: AbortSignal | undefined,
	toolResultEnricher: ToolResultEnricher | undefined,
	toolContext: ToolExecutionContext | undefined,
	streamAssistant: boolean
): Promise<AnthropicCompatibleAgentResult> {
	const maxTotalToolResultChars: number = getContinuationToolResultCharLimit(continuation);
	const approvedResult = createApprovedToolResultBlock(approvedToolResult, continuation.totalToolResultChars, maxTotalToolResultChars);
	const messages: AnthropicMessageParam[] = [
		...continuation.messages,
		createToolResultMessage([approvedResult.block])
	];

	if (approvedResult.limitReached || approvedResult.totalToolResultChars >= maxTotalToolResultChars) {
		const reason: string = approvedResult.reason ?? createToolResultLimitReason(approvedResult.totalToolResultChars, maxTotalToolResultChars);
		if (shouldPauseForToolBudget(gateway)) {
			return createToolBudgetRequiredResult({
				limitKind: "tool_result_chars",
				reason,
				usedSteps: continuation.nextStep,
				maxSteps: getContinuationMaxSteps(params, continuation),
				totalToolResultChars: approvedResult.totalToolResultChars,
				toolResultCharLimit: maxTotalToolResultChars,
				continuation: {
					...continuation,
					messages,
					totalToolResultChars: approvedResult.totalToolResultChars,
					maxSteps: getContinuationMaxSteps(params, continuation),
					toolResultCharLimit: maxTotalToolResultChars
				}
			});
		}
		const finalText: string = await createFinalAnswer(
			params,
			options,
			messages,
			continuation.systemPrompt,
			reason,
			abortSignal,
			continuation.toolImageReferences ?? []
		);
		if (streamAssistant) {
			onEvent?.({ type: "ai.delta", text: finalText });
		}
		return { status: "completed", text: finalText };
	}

	return runAgentLoop(
		params,
		options,
		messages,
		continuation.systemPrompt,
		mcpHost,
		gateway,
		getTools(allowedToolNames, toolContext),
		continuation.nextStep,
		getContinuationMaxSteps(params, continuation),
		approvedResult.totalToolResultChars,
		maxTotalToolResultChars,
		streamAssistant,
		onEvent,
		abortSignal,
		toolResultEnricher,
		toolContext,
		continuation.toolImageReferences ?? []
	);
}

export async function continueAnthropicCompatibleAgent(
	params: AiChatParams,
	options: ProviderChatOptions,
	continuation: AnthropicMessagesAgentContinuation,
	approvedToolResult: ApprovedToolResult,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames?: readonly string[] | undefined,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	toolResultEnricher?: ToolResultEnricher | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<AnthropicCompatibleAgentResult> {
	return continueAnthropicCompatibleAgentInternal(params, options, continuation, approvedToolResult, mcpHost, gateway, allowedToolNames, onEvent, abortSignal, toolResultEnricher, toolContext, false);
}

export async function continueAnthropicCompatibleAgentStreaming(
	params: AiChatParams,
	options: ProviderChatOptions,
	continuation: AnthropicMessagesAgentContinuation,
	approvedToolResult: ApprovedToolResult,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames?: readonly string[] | undefined,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	toolResultEnricher?: ToolResultEnricher | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<AnthropicCompatibleAgentResult> {
	return continueAnthropicCompatibleAgentInternal(params, options, continuation, approvedToolResult, mcpHost, gateway, allowedToolNames, onEvent, abortSignal, toolResultEnricher, toolContext, true);
}

async function continueAnthropicCompatibleAgentAfterToolBudgetInternal(
	params: AiChatParams,
	options: ProviderChatOptions,
	continuation: AnthropicMessagesAgentContinuation,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames: readonly string[] | undefined,
	onEvent: OnToolEvent | undefined,
	abortSignal: AbortSignal | undefined,
	toolResultEnricher: ToolResultEnricher | undefined,
	toolContext: ToolExecutionContext | undefined,
	streamAssistant: boolean
): Promise<AnthropicCompatibleAgentResult> {
	return runAgentLoop(
		params,
		options,
		[...continuation.messages],
		continuation.systemPrompt,
		mcpHost,
		gateway,
		getTools(allowedToolNames, toolContext),
		continuation.nextStep,
		getContinuedMaxSteps(params, continuation),
		continuation.totalToolResultChars,
		getContinuedToolResultCharLimit(continuation),
		streamAssistant,
		onEvent,
		abortSignal,
		toolResultEnricher,
		toolContext,
		continuation.toolImageReferences ?? []
	);
}

export async function continueAnthropicCompatibleAgentAfterToolBudget(
	params: AiChatParams,
	options: ProviderChatOptions,
	continuation: AnthropicMessagesAgentContinuation,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames?: readonly string[] | undefined,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	toolResultEnricher?: ToolResultEnricher | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<AnthropicCompatibleAgentResult> {
	return continueAnthropicCompatibleAgentAfterToolBudgetInternal(params, options, continuation, mcpHost, gateway, allowedToolNames, onEvent, abortSignal, toolResultEnricher, toolContext, false);
}

export async function continueAnthropicCompatibleAgentAfterToolBudgetStreaming(
	params: AiChatParams,
	options: ProviderChatOptions,
	continuation: AnthropicMessagesAgentContinuation,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames?: readonly string[] | undefined,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	toolResultEnricher?: ToolResultEnricher | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<AnthropicCompatibleAgentResult> {
	return continueAnthropicCompatibleAgentAfterToolBudgetInternal(params, options, continuation, mcpHost, gateway, allowedToolNames, onEvent, abortSignal, toolResultEnricher, toolContext, true);
}

async function finalizeAnthropicCompatibleAgentAfterToolBudgetInternal(
	params: AiChatParams,
	options: ProviderChatOptions,
	continuation: AnthropicMessagesAgentContinuation,
	reason: string,
	onEvent: OnToolEvent | undefined,
	abortSignal: AbortSignal | undefined,
	streamAssistant: boolean
): Promise<AnthropicCompatibleAgentResult> {
	const finalText: string = await createFinalAnswer(
		params,
		options,
		[...continuation.messages],
		continuation.systemPrompt,
		reason,
		abortSignal,
		continuation.toolImageReferences ?? []
	);
	if (streamAssistant) {
		onEvent?.({ type: "ai.delta", text: finalText });
	}
	return { status: "completed", text: finalText };
}

export async function finalizeAnthropicCompatibleAgentAfterToolBudget(
	params: AiChatParams,
	options: ProviderChatOptions,
	continuation: AnthropicMessagesAgentContinuation,
	_allowedToolNames: readonly string[] | undefined,
	reason: string,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	_toolContext?: ToolExecutionContext | undefined
): Promise<AnthropicCompatibleAgentResult> {
	return finalizeAnthropicCompatibleAgentAfterToolBudgetInternal(params, options, continuation, reason, onEvent, abortSignal, false);
}

export async function finalizeAnthropicCompatibleAgentAfterToolBudgetStreaming(
	params: AiChatParams,
	options: ProviderChatOptions,
	continuation: AnthropicMessagesAgentContinuation,
	_allowedToolNames: readonly string[] | undefined,
	reason: string,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	_toolContext?: ToolExecutionContext | undefined
): Promise<AnthropicCompatibleAgentResult> {
	return finalizeAnthropicCompatibleAgentAfterToolBudgetInternal(params, options, continuation, reason, onEvent, abortSignal, true);
}
