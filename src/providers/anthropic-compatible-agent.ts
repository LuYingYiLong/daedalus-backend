import type {
	ChatCompletionMessageToolCall,
	ChatCompletionTool,
	ChatCompletionToolMessageParam
} from "openai/resources/chat/completions";
import type { AiChatParams, ChatMessage } from "../protocol/types.js";
import type { McpHost } from "../mcp/mcp-host.js";
import { createWorkspaceToolCatalog, type ToolExecutionContext } from "../tools/tool-catalog.js";
import { dispatchToolCalls, ToolApprovalRequiredError, type OnToolEvent, type ToolResultEnricher } from "../tools/tool-dispatcher.js";
import { ExecutionDecisionSignal } from "../tools/execution-control.js";
import { ChatAnswerSignal } from "../tools/chat-completion-control.js";
import { ApprovalGateway } from "../tools/approval-gateway.js";
import type { ApprovedToolResult, AnthropicMessagesAgentContinuation, ProviderAgentResult } from "./agent-types.js";
import {
	compactToolResultEntries,
	createToolResultLimitFallback,
	fitToolResultContent
} from "./tool-result-budget.js";
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
	getInitialToolResultCharLimit,
	shouldPauseForToolBudget
} from "./agent-tool-budget.js";
import { injectToolImagesIntoAnthropicMessages } from "./provider-tool-image-content.js";
import type { ProviderToolImageReference } from "./tool-image-reference.js";
import {
	createDelegatedObservationText,
	isProviderImageInputUnsupportedError,
	recognizeToolImageReferences
} from "./tool-image-recognition.js";
import {
	createProviderReconnectState,
	runProviderRequestWithResilience,
	type ProviderReconnectState
} from "./provider-resilience.js";
import { prepareProviderContextLengthRetry } from "./provider-context-recovery.js";

const FINALIZE_AFTER_TOOL_LIMIT_PROMPT: string =
	"工具调用阶段已经达到后端限制。请停止请求更多工具，基于目前已经获得的工具结果直接回答用户。"
	+ "如果信息不完整，请明确说明哪些部分是根据已有信息总结的，哪些部分还需要进一步检查。";
const TOOL_PROTOCOL_VIOLATION_RETRY_LIMIT: number = 2;

export type AnthropicCompatibleAgentResult = ProviderAgentResult;

function shouldRequireToolCallOnStep(params: AiChatParams, step: number, startStep: number): boolean {
	const options: Record<string, unknown> | undefined = params.options as Record<string, unknown> | undefined;
	return options?.requireChatCompletionTool === true
		|| (startStep === 0 && step === 0 && options?.requireToolCallOnFirstStep === true);
}

function createMissingRequiredToolCallCorrection(toolNames: readonly string[]): string {
	return [
		"上一条 assistant 响应没有通过 API tool_use 调用当前阶段要求的工具。",
		"不要只输出进度预告或最终正文。下一步必须调用一个真实工具；如果答案已经完整，请调用 daedalus_submit_chat_answer。",
		"当前阶段可用工具名如下：",
		...toolNames.map((toolName: string): string => `- ${toolName}`)
	].join("\n");
}

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

function createApprovedToolResultBlock(result: ApprovedToolResult, totalToolResultChars: number, maxTotalToolResultChars: number): AnthropicToolResultBlock {
	const budgetedResult = fitToolResultContent(result.content, totalToolResultChars, maxTotalToolResultChars);
	return {
		type: "tool_result",
		tool_use_id: result.toolCallId,
		content: budgetedResult.content
	};
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

function compactAnthropicToolResults(messages: AnthropicMessageParam[], emergency: boolean = false): number {
	const resultBlocks: AnthropicToolResultBlock[] = [];
	for (const message of messages) {
		if (!Array.isArray(message.content)) {
			continue;
		}
		for (const block of message.content) {
			if (block.type === "tool_result") {
				resultBlocks.push(block);
			}
		}
	}
	if (resultBlocks.length === 0) {
		return 0;
	}

	const compacted = compactToolResultEntries(
		resultBlocks,
		(block: AnthropicToolResultBlock): string => block.content,
		(block: AnthropicToolResultBlock, content: string): AnthropicToolResultBlock => ({ ...block, content }),
		{
			recentRawCount: emergency ? 0 : undefined,
			createCapsule: (block: AnthropicToolResultBlock, content: string): string => (
				`${content}\nRecover with blockId tool:${block.tool_use_id}.`
			)
		}
	);
	if (compacted.compactedCount === 0) {
		return compacted.totalChars;
	}

	let resultIndex: number = 0;
	for (const message of messages) {
		if (!Array.isArray(message.content)) {
			continue;
		}
		message.content = message.content.map((block: AnthropicContentBlock): AnthropicContentBlock => {
			if (block.type !== "tool_result") {
				return block;
			}
			const replacement: AnthropicToolResultBlock = compacted.entries[resultIndex]!;
			resultIndex += 1;
			return replacement;
		});
	}
	return compacted.totalChars;
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
	const message = await runProviderRequestWithResilience({
		providerOptions: options,
		abortSignal,
		watchInactivity: false,
		execute: async (attempt) => createAnthropicMessage(params, options, finalMessages, systemPrompt, undefined, attempt.signal)
	});
	const text: string = extractAnthropicText(message.content);
	return text.length > 0 ? text : createToolResultLimitFallback(reason);
}

async function readAssistantMessageAttempt(
	params: AiChatParams,
	options: ProviderChatOptions,
	messages: AnthropicMessageParam[],
	systemPrompt: string,
	tools: readonly AnthropicToolDefinition[],
	streamAssistant: boolean,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	markActivity?: (() => void) | undefined
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
	for await (const event of streamAnthropicMessage(params, options, messages, systemPrompt, tools, abortSignal, markActivity)) {
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

async function readAssistantMessage(
	params: AiChatParams,
	options: ProviderChatOptions,
	messages: AnthropicMessageParam[],
	systemPrompt: string,
	tools: readonly AnthropicToolDefinition[],
	streamAssistant: boolean,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	reconnectState?: ProviderReconnectState | undefined
): Promise<{ text: string; toolUseBlocks: AnthropicToolUseBlock[] }> {
	return runProviderRequestWithResilience({
		providerOptions: options,
		onEvent,
		abortSignal,
		reconnectState,
		watchInactivity: streamAssistant,
		execute: async (attempt): Promise<{ text: string; toolUseBlocks: AnthropicToolUseBlock[] }> => readAssistantMessageAttempt(
			params,
			options,
			messages,
			systemPrompt,
			tools,
			streamAssistant,
			streamAssistant ? attempt.onEvent : onEvent,
			attempt.signal,
			attempt.markActivity
		)
	});
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
	totalToolResultChars = compactAnthropicToolResults(messages);
	const toolImageReferences: ProviderToolImageReference[] = [...initialToolImageReferences];
	const anthropicTools: AnthropicToolDefinition[] = createAnthropicTools(tools);
	let imageFallbackAttempted: boolean = false;
	let contextLengthRetryUsed: boolean = false;
	let toolProtocolViolationRetries: number = 0;
	let stepReconnectState: ProviderReconnectState | undefined;

	for (let step: number = startStep; step < maxSteps; step += 1) {
		if (abortSignal?.aborted) {
			throw new Error("Request cancelled");
		}
		stepReconnectState ??= createProviderReconnectState();

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
				abortSignal,
				stepReconnectState
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
			if (await prepareProviderContextLengthRetry({
				error,
				retryUsed: contextLengthRetryUsed,
				contextControl: toolContext?.contextControl,
				compactProviderToolResults: (): void => {
					totalToolResultChars = compactAnthropicToolResults(messages, true);
				}
			})) {
				contextLengthRetryUsed = true;
				stepReconnectState = undefined;
				step -= 1;
				continue;
			}
			throw error;
		}

		if (assistant.toolUseBlocks.length === 0) {
			if (shouldRequireToolCallOnStep(params, step, startStep) && anthropicTools.length > 0) {
				if (toolProtocolViolationRetries < TOOL_PROTOCOL_VIOLATION_RETRY_LIMIT) {
					toolProtocolViolationRetries += 1;
					messages.push(createAssistantMessage(assistant.text, []));
					messages.push({ role: "user", content: createMissingRequiredToolCallCorrection(anthropicTools.map((tool): string => tool.name)) });
					step -= 1;
					continue;
				}
				return {
					status: "protocol_violation",
					text: "",
					reason: assistant.text.length > 0
						? "模型返回了正文，但没有通过 API tool_use 调用当前阶段要求的工具。"
						: "模型没有通过 API tool_use 调用当前阶段要求的工具，且没有返回用户可见正文。"
				};
			}
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
			if (error instanceof ChatAnswerSignal) {
				return {
					status: "chat_answer",
					answer: error.answer
				};
			}
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
						toolImageReferences: [...toolImageReferences],
						contextState: toolContext?.contextControl?.getState()
					}
				};
			}
			throw error;
		}

		const resultMessage: AnthropicMessageParam = createToolResultMessage([]);
		messages.push(resultMessage);
		for (const result of toolResults) {
			if (result.imageReferences !== undefined) {
				toolImageReferences.push(...result.imageReferences);
			}
			totalToolResultChars = compactAnthropicToolResults(messages);
			const budgetedResult = fitToolResultContent(extractToolResultText(result), totalToolResultChars, maxTotalToolResultChars);
			if (!Array.isArray(resultMessage.content)) {
				throw new Error("Anthropic tool result message has invalid content");
			}
			resultMessage.content.push(createAnthropicToolResultBlock({
				...result,
				content: budgetedResult.content
			}));
			totalToolResultChars = compactAnthropicToolResults(messages);
		}
		totalToolResultChars = compactAnthropicToolResults(messages);

		if (totalToolResultChars >= maxTotalToolResultChars) {
			totalToolResultChars = compactAnthropicToolResults(messages, true);
		}

		// 工具执行成功后进入新的模型步骤，新的步骤使用新的重连链。
		stepReconnectState = undefined;
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
				toolImageReferences: [...toolImageReferences],
				contextState: toolContext?.contextControl?.getState()
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
		getInitialToolResultCharLimit(params),
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
		getInitialToolResultCharLimit(params),
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
	const messages: AnthropicMessageParam[] = [...continuation.messages];
	let totalToolResultChars: number = compactAnthropicToolResults(messages);
	const approvedResult: AnthropicToolResultBlock = createApprovedToolResultBlock(approvedToolResult, totalToolResultChars, maxTotalToolResultChars);
	messages.push(createToolResultMessage([approvedResult]));
	totalToolResultChars = compactAnthropicToolResults(messages);

	if (totalToolResultChars >= maxTotalToolResultChars) {
		totalToolResultChars = compactAnthropicToolResults(messages, true);
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
		totalToolResultChars,
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
	const messages: AnthropicMessageParam[] = [...continuation.messages];
	const totalToolResultChars: number = compactAnthropicToolResults(messages);
	return runAgentLoop(
		params,
		options,
		messages,
		continuation.systemPrompt,
		mcpHost,
		gateway,
		getTools(allowedToolNames, toolContext),
		continuation.nextStep,
		getContinuedMaxSteps(params, continuation),
		totalToolResultChars,
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
