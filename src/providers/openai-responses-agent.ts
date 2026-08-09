import type { ChatCompletionMessageToolCall, ChatCompletionTool } from "openai/resources/chat/completions";
import type {
	FunctionTool,
	Response,
	ResponseCreateParamsNonStreaming,
	ResponseCreateParamsStreaming,
	ResponseFunctionToolCall,
	ResponseInputItem,
	ResponseOutputItem,
	ResponseStreamEvent,
	Tool
} from "openai/resources/responses/responses";
import type { AiChatParams, ChatMessage } from "../protocol/types.js";
import type { McpHost } from "../mcp/mcp-host.js";
import { ApprovalGateway } from "../tools/approval-gateway.js";
import { dispatchToolCalls, ToolApprovalRequiredError, type OnToolEvent, type ToolResultEnricher } from "../tools/tool-dispatcher.js";
import { ExecutionDecisionSignal } from "../tools/execution-control.js";
import { ChatAnswerSignal } from "../tools/chat-completion-control.js";
import { createWorkspaceToolCatalog, type ToolExecutionContext } from "../tools/tool-catalog.js";
import type { ApprovedToolResult, ProviderAgentResult, ResponsesAgentContinuation } from "./agent-types.js";
import type { ProviderChatOptions } from "./deepseek-client.js";
import {
	applyOpenAIResponsesOptions,
	createOpenAIResponseInput,
	createOpenAIResponsesClient,
	resolveOpenAIResponsesModel
} from "./openai-responses-client.js";
import {
	compactToolResultEntries,
	createToolResultLimitFallback,
	createToolResultLimitReason,
	fitToolResultContent
} from "./tool-result-budget.js";
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
import type { NormalizedLlmUsage } from "../usage/metrics-types.js";
import { getProviderUsageErrorCode, getProviderUsageStatusForError, recordProviderUsage } from "../usage/provider-recorder.js";
import { parseOpenAIResponsesUsage } from "../usage/usage-parser.js";
import { injectToolImagesIntoResponseInput } from "./provider-tool-image-content.js";
import type { ProviderToolImageReference } from "./tool-image-reference.js";
import {
	createDelegatedObservationText,
	isProviderImageInputUnsupportedError,
	recognizeToolImageReferences
} from "./tool-image-recognition.js";
import {
	createProviderReconnectState,
	ProviderIncompleteStreamError,
	runProviderRequestWithResilience,
	type ProviderReconnectState
} from "./provider-resilience.js";

const FINALIZE_AFTER_TOOL_LIMIT_PROMPT: string =
	"工具调用阶段已经达到后端限制。请停止请求更多工具，基于目前已经获得的工具结果直接回答用户。"
	+ "如果信息不完整，请明确说明哪些部分是根据已有信息总结的，哪些部分还需要进一步检查。";
const TOOL_PROTOCOL_VIOLATION_RETRY_LIMIT: number = 1;

type ResponsesAssistantMessage = {
	text: string;
	toolCalls: ResponseFunctionToolCall[];
	outputItems: ResponseOutputItem[];
};

type AppendToolResultItemsResult = {
	totalToolResultChars: number;
};

function shouldRequireToolCallOnStep(params: AiChatParams, step: number, startStep: number): boolean {
	const options: Record<string, unknown> | undefined = params.options as Record<string, unknown> | undefined;
	return options?.requireChatCompletionTool === true
		|| (startStep === 0 && step === 0 && options?.requireToolCallOnFirstStep === true);
}

function convertToolDefinition(tool: ChatCompletionTool): FunctionTool | null {
	if (tool.type !== "function") {
		return null;
	}

	return {
		type: "function",
		name: tool.function.name,
		description: tool.function.description ?? null,
		parameters: tool.function.parameters ?? null,
		strict: false
	};
}

export function convertToolDefinitions(tools: ChatCompletionTool[]): Tool[] {
	const responsesTools: Tool[] = [];
	for (const tool of tools) {
		const convertedTool: FunctionTool | null = convertToolDefinition(tool);
		if (convertedTool !== null) {
			responsesTools.push(convertedTool);
		}
	}
	return responsesTools;
}

function getAllowedToolNames(tools: ChatCompletionTool[]): ReadonlySet<string> {
	const allowedToolNames: Set<string> = new Set();
	for (const tool of tools) {
		if (tool.type === "function") {
			allowedToolNames.add(tool.function.name);
		}
	}
	return allowedToolNames;
}

function createMissingRequiredToolCallCorrectionMessage(allowedToolNames: readonly string[], hadVisibleText: boolean = false): string {
	const lines: string[] = [
		hadVisibleText
			? "上一条 assistant 响应输出了正文，但没有通过 API function_call 调用工具。"
			: "上一条 assistant 响应没有通过 API function_call 调用工具。",
		"当前阶段要求先调用工具；不要只在正文中说明准备调用工具。"
	];
	if (allowedToolNames.length > 0) {
		lines.push("下一步必须调用真实工具。");
		lines.push("本阶段可用工具名如下：");
		for (const toolName of allowedToolNames) {
			lines.push(`- ${toolName}`);
		}
	}

	return lines.join("\n");
}

function appendMissingRequiredToolCallCorrection(inputItems: ResponseInputItem[], allowedToolNames: readonly string[], hadVisibleText: boolean = false): void {
	inputItems.push({
		type: "message",
		role: "user",
		content: createMissingRequiredToolCallCorrectionMessage(allowedToolNames, hadVisibleText)
	} as ResponseInputItem);
}

function isAllowedFunctionCall(toolCall: ResponseFunctionToolCall, allowedToolNames: ReadonlySet<string>): boolean {
	return allowedToolNames.has(toolCall.name);
}

function convertResponsesToolCall(toolCall: ResponseFunctionToolCall): ChatCompletionMessageToolCall {
	return {
		id: toolCall.call_id,
		type: "function",
		function: {
			name: toolCall.name,
			arguments: toolCall.arguments
		}
	} as ChatCompletionMessageToolCall;
}

export function convertResponsesToolCalls(toolCalls: ResponseFunctionToolCall[], allowedToolNames: ReadonlySet<string>): ChatCompletionMessageToolCall[] {
	return toolCalls
		.filter((toolCall: ResponseFunctionToolCall): boolean => isAllowedFunctionCall(toolCall, allowedToolNames))
		.map(convertResponsesToolCall);
}

function extractFunctionCalls(outputItems: readonly ResponseOutputItem[]): ResponseFunctionToolCall[] {
	return outputItems.filter((item: ResponseOutputItem): item is ResponseFunctionToolCall => item.type === "function_call");
}

function appendResponseOutputItems(inputItems: ResponseInputItem[], outputItems: readonly ResponseOutputItem[]): void {
	for (const item of outputItems) {
		inputItems.push(item as ResponseInputItem);
	}
}

function isFunctionCallOutputItem(item: ResponseInputItem): boolean {
	return (item as { type?: unknown }).type === "function_call_output";
}

function compactOpenAIResponsesToolResults(inputItems: ResponseInputItem[]): number {
	const toolResultItems: ResponseInputItem[] = inputItems.filter(isFunctionCallOutputItem);
	if (toolResultItems.length === 0) {
		return 0;
	}

	const compacted = compactToolResultEntries(
		toolResultItems,
		(item: ResponseInputItem): string => {
			const output: unknown = (item as { output?: unknown }).output;
			return typeof output === "string" ? output : JSON.stringify(output);
		},
		(item: ResponseInputItem, output: string): ResponseInputItem => ({
			...(item as unknown as Record<string, unknown>),
			output
		}) as ResponseInputItem
	);
	if (compacted.compactedCount === 0) {
		return compacted.totalChars;
	}

	let toolResultIndex: number = 0;
	for (let index: number = 0; index < inputItems.length; index += 1) {
		if (isFunctionCallOutputItem(inputItems[index]!)) {
			inputItems[index] = compacted.entries[toolResultIndex]!;
			toolResultIndex += 1;
		}
	}
	return compacted.totalChars;
}

function appendToolResultItems(
	inputItems: ResponseInputItem[],
	toolResults: Awaited<ReturnType<typeof dispatchToolCalls>>,
	currentTotalChars: number,
	maxTotalChars: number
): AppendToolResultItemsResult {
	let totalToolResultChars: number = currentTotalChars;
	for (const result of toolResults) {
		totalToolResultChars = compactOpenAIResponsesToolResults(inputItems);
		const content: string = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
		const budgetedResult = fitToolResultContent(content, totalToolResultChars, maxTotalChars);
		inputItems.push({
			type: "function_call_output",
			call_id: result.tool_call_id,
			output: budgetedResult.content
		} as ResponseInputItem);
		totalToolResultChars = compactOpenAIResponsesToolResults(inputItems);
	}
	return {
		totalToolResultChars
	};
}

function createRequestBody(
	params: AiChatParams,
	options: ProviderChatOptions,
	instructions: string,
	inputItems: ResponseInputItem[],
	tools?: Tool[] | undefined,
	requireToolCall: boolean = false
): ResponseCreateParamsNonStreaming {
	const requestBody: ResponseCreateParamsNonStreaming = {
		model: resolveOpenAIResponsesModel(options),
		instructions,
		input: inputItems,
		store: false
	};
	if (tools !== undefined && tools.length > 0) {
		requestBody.tools = tools;
		requestBody.parallel_tool_calls = false;
		if (requireToolCall) {
			requestBody.tool_choice = "required";
		}
	}
	applyOpenAIResponsesOptions(requestBody, params);
	return requestBody;
}

async function readResponsesAssistantMessageAttempt(
	params: AiChatParams,
	options: ProviderChatOptions,
	instructions: string,
	inputItems: ResponseInputItem[],
	tools: Tool[],
	streamAssistant: boolean,
	requireToolCall: boolean,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	markActivity?: (() => void) | undefined
): Promise<ResponsesAssistantMessage> {
	const client = createOpenAIResponsesClient(options, markActivity);
	if (!streamAssistant) {
		const requestBody: ResponseCreateParamsNonStreaming = createRequestBody(params, options, instructions, inputItems, tools, requireToolCall);
		const startedAtMs: number = Date.now();
		let response: Response;
		try {
			response = await client.responses.create(
				requestBody,
				{ signal: abortSignal }
			);
		} catch (error: unknown) {
			await recordProviderUsage({
				options,
				requestBody,
				startedAtMs,
				status: getProviderUsageStatusForError(error),
				errorCode: getProviderUsageErrorCode(error),
				streaming: false
			});
			throw error;
		}
		await recordProviderUsage({
			options,
			requestBody,
			responseBody: response,
			outputText: response.output_text.length > 0 ? response.output_text : JSON.stringify(response.output),
			startedAtMs,
			status: "success",
			streaming: false,
			usage: parseOpenAIResponsesUsage(response)
		});
		return {
			text: response.output_text,
			toolCalls: extractFunctionCalls(response.output),
			outputItems: response.output
		};
	}

	const requestBody: ResponseCreateParamsStreaming = {
		...createRequestBody(params, options, instructions, inputItems, tools, requireToolCall),
		stream: true
	};
	const outputItems: ResponseOutputItem[] = [];
	let text = "";
	let completedResponse: Response | null = null;
	const startedAtMs: number = Date.now();
	let firstTokenAtMs: number | undefined;
	let finalUsage: NormalizedLlmUsage | null = null;

	try {
		const stream = await client.responses.create(requestBody, { signal: abortSignal });
		for await (const event of stream) {
			markActivity?.();
			const streamEvent: ResponseStreamEvent = event as ResponseStreamEvent;
			if (streamEvent.type === "response.output_text.delta" && streamEvent.delta.length > 0) {
				if (firstTokenAtMs === undefined) {
					firstTokenAtMs = Date.now();
				}
				text += streamEvent.delta;
				if (!requireToolCall) {
					onEvent?.({ type: "ai.delta", text: streamEvent.delta });
				}
				continue;
			}
			if (streamEvent.type === "response.output_item.done") {
				if (firstTokenAtMs === undefined) {
					firstTokenAtMs = Date.now();
				}
				outputItems.push(streamEvent.item);
				continue;
			}
			if (streamEvent.type === "response.completed") {
				completedResponse = streamEvent.response;
				finalUsage = parseOpenAIResponsesUsage(streamEvent.response) ?? finalUsage;
			}
		}
	} catch (error: unknown) {
		await recordProviderUsage({
			options,
			requestBody,
			responseBody: completedResponse,
			outputText: text,
			startedAtMs,
			firstTokenAtMs,
			status: getProviderUsageStatusForError(error),
			errorCode: getProviderUsageErrorCode(error),
			streaming: true,
			usage: finalUsage
		});
		throw error;
	}
	if (completedResponse === null) {
		const error = new ProviderIncompleteStreamError("OpenAI Responses stream ended without response.completed.");
		await recordProviderUsage({
			options,
			requestBody,
			outputText: text,
			startedAtMs,
			firstTokenAtMs,
			status: "error",
			errorCode: "incomplete_stream",
			streaming: true,
			usage: finalUsage
		});
		throw error;
	}

	await recordProviderUsage({
		options,
		requestBody,
		responseBody: completedResponse,
		outputText: completedResponse?.output_text ?? text,
		startedAtMs,
		firstTokenAtMs,
		status: "success",
		streaming: true,
		usage: finalUsage
	});

	return {
		text: completedResponse?.output_text ?? text,
		toolCalls: extractFunctionCalls(outputItems),
		outputItems: outputItems.length > 0 ? outputItems : completedResponse?.output ?? []
	};
}

async function readResponsesAssistantMessage(
	params: AiChatParams,
	options: ProviderChatOptions,
	instructions: string,
	inputItems: ResponseInputItem[],
	tools: Tool[],
	streamAssistant: boolean,
	requireToolCall: boolean,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	reconnectState?: ProviderReconnectState | undefined
): Promise<ResponsesAssistantMessage> {
	return runProviderRequestWithResilience({
		providerOptions: options,
		onEvent,
		abortSignal,
		reconnectState,
		watchInactivity: streamAssistant,
		execute: async (attempt): Promise<ResponsesAssistantMessage> => readResponsesAssistantMessageAttempt(
			params,
			options,
			instructions,
			inputItems,
			tools,
			streamAssistant,
			requireToolCall,
			streamAssistant ? attempt.onEvent : onEvent,
			attempt.signal,
			attempt.markActivity
		)
	});
}

async function createFinalAnswer(
	params: AiChatParams,
	options: ProviderChatOptions,
	instructions: string,
	inputItems: ResponseInputItem[],
	reason: string,
	abortSignal?: AbortSignal | undefined,
	toolImageReferences: readonly ProviderToolImageReference[] = []
): Promise<string> {
	const client = createOpenAIResponsesClient(options);
	const finalInstructions: string = `${instructions}\n\n${FINALIZE_AFTER_TOOL_LIMIT_PROMPT}\n\n收束原因：${reason}`;
	const requestBody: ResponseCreateParamsNonStreaming = createRequestBody(
		params,
		options,
		finalInstructions,
		await injectToolImagesIntoResponseInput(inputItems, toolImageReferences)
	);
	const startedAtMs: number = Date.now();
	let response: Response;
	try {
		response = await runProviderRequestWithResilience({
			providerOptions: options,
			abortSignal,
			watchInactivity: false,
			execute: async (attempt): Promise<Response> => client.responses.create(
				requestBody,
				{ signal: attempt.signal }
			)
		});
	} catch (error: unknown) {
		await recordProviderUsage({
			options,
			requestBody,
			startedAtMs,
			status: getProviderUsageStatusForError(error),
			errorCode: getProviderUsageErrorCode(error),
			streaming: false
		});
		throw error;
	}
	await recordProviderUsage({
		options,
		requestBody,
		responseBody: response,
		outputText: response.output_text,
		startedAtMs,
		status: response.output_text.length > 0 ? "success" : "error",
		errorCode: response.output_text.length > 0 ? undefined : "empty_response",
		streaming: false,
		usage: parseOpenAIResponsesUsage(response)
	});
	if (response.output_text.length === 0) {
		return createToolResultLimitFallback(reason);
	}
	return response.output_text;
}

async function runResponsesAgentLoop(
	params: AiChatParams,
	options: ProviderChatOptions,
	instructions: string,
	inputItems: ResponseInputItem[],
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	chatTools: ChatCompletionTool[],
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
): Promise<ProviderAgentResult> {
	let totalToolResultChars: number = initialToolResultChars;
	totalToolResultChars = compactOpenAIResponsesToolResults(inputItems);
	const toolImageReferences: ProviderToolImageReference[] = [...initialToolImageReferences];
	const tools: Tool[] = convertToolDefinitions(chatTools);
	const allowedToolNames: ReadonlySet<string> = getAllowedToolNames(chatTools);
	let toolProtocolViolationRetries: number = 0;
	let imageFallbackAttempted: boolean = false;
	let stepReconnectState: ProviderReconnectState | undefined;

	for (let step: number = startStep; step < maxSteps; step += 1) {
		if (abortSignal?.aborted) {
			throw new Error("Request cancelled");
		}
		stepReconnectState ??= createProviderReconnectState();

		let assistantMessage: ResponsesAssistantMessage;
		try {
			assistantMessage = await readResponsesAssistantMessage(
				params,
				options,
				instructions,
				await injectToolImagesIntoResponseInput(inputItems, toolImageReferences),
				tools,
				streamAssistant,
				shouldRequireToolCallOnStep(params, step, startStep),
				onEvent,
				abortSignal,
				stepReconnectState
			);
		} catch (error: unknown) {
			if (!imageFallbackAttempted && toolImageReferences.length > 0 && isProviderImageInputUnsupportedError(error)) {
				const observation = await recognizeToolImageReferences(toolImageReferences, options, params.message, abortSignal, false);
				inputItems.push({
					role: "user",
					content: [{ type: "input_text", text: createDelegatedObservationText(observation) }]
				} as unknown as ResponseInputItem);
				toolImageReferences.splice(0, toolImageReferences.length);
				imageFallbackAttempted = true;
				step -= 1;
				continue;
			}
			throw error;
		}
		const toolCalls: ChatCompletionMessageToolCall[] = convertResponsesToolCalls(assistantMessage.toolCalls, allowedToolNames);

		if (toolCalls.length === 0) {
			if (shouldRequireToolCallOnStep(params, step, startStep) && allowedToolNames.size > 0) {
				if (toolProtocolViolationRetries < TOOL_PROTOCOL_VIOLATION_RETRY_LIMIT) {
					toolProtocolViolationRetries += 1;
					appendMissingRequiredToolCallCorrection(inputItems, Array.from(allowedToolNames), assistantMessage.text.length > 0);
					step -= 1;
					continue;
				}

				return {
					status: "protocol_violation",
					text: "",
					reason: assistantMessage.text.length > 0
						? "模型返回了正文，但没有通过 API function_call 调用当前阶段要求的工具。"
						: "模型没有通过 API function_call 调用当前阶段要求的工具，且没有返回用户可见正文。"
				};
			}

			if (assistantMessage.text.length === 0) {
				throw new Error("LLM returned empty response");
			}
			return { status: "completed", text: assistantMessage.text };
		}

		if ((!streamAssistant || shouldRequireToolCallOnStep(params, step, startStep)) && assistantMessage.text.trim().length > 0) {
			onEvent?.({ type: "ai.delta", text: `\n\n${assistantMessage.text.trim()}\n\n` });
		}

		appendResponseOutputItems(inputItems, assistantMessage.outputItems);

		try {
			const toolResults = await dispatchToolCalls(mcpHost, toolCalls, step, gateway, onEvent, toolResultEnricher, toolContext, abortSignal);
			for (const result of toolResults) {
				if (result.imageReferences !== undefined) {
					toolImageReferences.push(...result.imageReferences);
				}
			}
			const appendResult: AppendToolResultItemsResult = appendToolResultItems(inputItems, toolResults, totalToolResultChars, maxTotalToolResultChars);
			totalToolResultChars = appendResult.totalToolResultChars;
			if (totalToolResultChars >= maxTotalToolResultChars) {
				const reason: string = createToolResultLimitReason(totalToolResultChars, maxTotalToolResultChars);
				if (shouldPauseForToolBudget(gateway)) {
					return createToolBudgetRequiredResult({
						limitKind: "tool_result_chars",
						reason,
						usedSteps: step + 1,
						maxSteps,
						totalToolResultChars,
						toolResultCharLimit: maxTotalToolResultChars,
						continuation: {
							kind: "responses",
							instructions,
							inputItems: [...inputItems],
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
					instructions,
					inputItems,
					reason,
					abortSignal,
					toolImageReferences
				);
				if (streamAssistant) {
					onEvent?.({ type: "ai.delta", text: finalText });
				}
				return { status: "completed", text: finalText };
			}
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
				const continuationInputItems: ResponseInputItem[] = [...inputItems];
				return {
					status: "approval_required",
					approvalId: error.pendingApproval.approvalId,
					toolName: error.pendingApproval.llmToolName,
					reason: error.pendingApproval.reason,
					continuation: {
						kind: "responses",
						instructions,
						inputItems: continuationInputItems,
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

		if (totalToolResultChars >= maxTotalToolResultChars) {
			const reason: string = createToolResultLimitReason(totalToolResultChars, maxTotalToolResultChars);
			if (shouldPauseForToolBudget(gateway)) {
				return createToolBudgetRequiredResult({
					limitKind: "tool_result_chars",
					reason,
					usedSteps: step + 1,
					maxSteps,
					totalToolResultChars,
					toolResultCharLimit: maxTotalToolResultChars,
					continuation: {
						kind: "responses",
						instructions,
						inputItems: [...inputItems],
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
				instructions,
				inputItems,
				reason,
				abortSignal,
				toolImageReferences
			);
			if (streamAssistant) {
				onEvent?.({ type: "ai.delta", text: finalText });
			}
			return { status: "completed", text: finalText };
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
				kind: "responses",
				instructions,
				inputItems: [...inputItems],
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
		instructions,
		inputItems,
		stepLimitReason,
		abortSignal,
		toolImageReferences
	);
	if (streamAssistant) {
		onEvent?.({ type: "ai.delta", text: finalText });
	}
	return { status: "completed", text: finalText };
}

export async function runOpenAIResponsesAgent(
	params: AiChatParams,
	options: ProviderChatOptions,
	history: ChatMessage[],
	instructions: string,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames?: readonly string[] | undefined,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	toolResultEnricher?: ToolResultEnricher | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<ProviderAgentResult> {
	const toolCatalog = createWorkspaceToolCatalog(toolContext);
	const tools = allowedToolNames !== undefined
		? toolCatalog.getDefinitionsForNames(allowedToolNames)
		: toolCatalog.getDefinitions();
	const maxSteps: number = getInitialMaxToolSteps(params);

	return runResponsesAgentLoop(
		params,
		options,
		instructions,
		createOpenAIResponseInput(params, history),
		mcpHost,
		gateway,
		tools,
		0,
		maxSteps,
		0,
		getInitialToolResultCharLimit(params),
		false,
		onEvent,
		abortSignal,
		toolResultEnricher,
		toolContext
	);
}

export async function runOpenAIResponsesAgentStreaming(
	params: AiChatParams,
	options: ProviderChatOptions,
	history: ChatMessage[],
	instructions: string,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames?: readonly string[] | undefined,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	toolResultEnricher?: ToolResultEnricher | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<ProviderAgentResult> {
	const toolCatalog = createWorkspaceToolCatalog(toolContext);
	const tools = allowedToolNames !== undefined
		? toolCatalog.getDefinitionsForNames(allowedToolNames)
		: toolCatalog.getDefinitions();
	const maxSteps: number = getInitialMaxToolSteps(params);

	return runResponsesAgentLoop(
		params,
		options,
		instructions,
		createOpenAIResponseInput(params, history),
		mcpHost,
		gateway,
		tools,
		0,
		maxSteps,
		0,
		getInitialToolResultCharLimit(params),
		true,
		onEvent,
		abortSignal,
		toolResultEnricher,
		toolContext
	);
}

export async function continueOpenAIResponsesAgent(
	params: AiChatParams,
	options: ProviderChatOptions,
	continuation: ResponsesAgentContinuation,
	approvedToolResult: ApprovedToolResult,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames?: readonly string[] | undefined,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	toolResultEnricher?: ToolResultEnricher | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<ProviderAgentResult> {
	const toolCatalog = createWorkspaceToolCatalog(toolContext);
	const tools = allowedToolNames !== undefined
		? toolCatalog.getDefinitionsForNames(allowedToolNames)
		: toolCatalog.getDefinitions();
	const inputItems: ResponseInputItem[] = [...continuation.inputItems];
	const maxTotalToolResultChars: number = getContinuationToolResultCharLimit(continuation);
	let totalToolResultChars: number = compactOpenAIResponsesToolResults(inputItems);
	const budgetedResult = fitToolResultContent(approvedToolResult.content, totalToolResultChars, maxTotalToolResultChars);
	inputItems.push({
		type: "function_call_output",
		call_id: approvedToolResult.toolCallId,
		output: budgetedResult.content
	} as ResponseInputItem);
	totalToolResultChars = compactOpenAIResponsesToolResults(inputItems);

	if (totalToolResultChars >= maxTotalToolResultChars) {
		const reason: string = createToolResultLimitReason(totalToolResultChars, maxTotalToolResultChars);
		if (shouldPauseForToolBudget(gateway)) {
			return createToolBudgetRequiredResult({
				limitKind: "tool_result_chars",
				reason,
				usedSteps: continuation.nextStep,
				maxSteps: getContinuationMaxSteps(params, continuation),
				totalToolResultChars,
				toolResultCharLimit: maxTotalToolResultChars,
				continuation: {
					...continuation,
					inputItems: [...inputItems],
					totalToolResultChars,
					maxSteps: getContinuationMaxSteps(params, continuation),
					toolResultCharLimit: maxTotalToolResultChars
				}
			});
		}
		return {
			status: "completed",
			text: await createFinalAnswer(
				params,
				options,
				continuation.instructions,
				inputItems,
				reason,
				abortSignal,
				continuation.toolImageReferences ?? []
			)
		};
	}

	const maxSteps: number = getContinuationMaxSteps(params, continuation);
	return runResponsesAgentLoop(
		params,
		options,
		continuation.instructions,
		inputItems,
		mcpHost,
		gateway,
		tools,
		continuation.nextStep,
		maxSteps,
		totalToolResultChars,
		maxTotalToolResultChars,
		false,
		onEvent,
		abortSignal,
		toolResultEnricher,
		toolContext,
		continuation.toolImageReferences ?? []
	);
}

export async function continueOpenAIResponsesAgentStreaming(
	params: AiChatParams,
	options: ProviderChatOptions,
	continuation: ResponsesAgentContinuation,
	approvedToolResult: ApprovedToolResult,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames?: readonly string[] | undefined,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	toolResultEnricher?: ToolResultEnricher | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<ProviderAgentResult> {
	const toolCatalog = createWorkspaceToolCatalog(toolContext);
	const tools = allowedToolNames !== undefined
		? toolCatalog.getDefinitionsForNames(allowedToolNames)
		: toolCatalog.getDefinitions();
	const inputItems: ResponseInputItem[] = [...continuation.inputItems];
	const maxTotalToolResultChars: number = getContinuationToolResultCharLimit(continuation);
	let totalToolResultChars: number = compactOpenAIResponsesToolResults(inputItems);
	const budgetedResult = fitToolResultContent(approvedToolResult.content, totalToolResultChars, maxTotalToolResultChars);
	inputItems.push({
		type: "function_call_output",
		call_id: approvedToolResult.toolCallId,
		output: budgetedResult.content
	} as ResponseInputItem);
	totalToolResultChars = compactOpenAIResponsesToolResults(inputItems);

	if (totalToolResultChars >= maxTotalToolResultChars) {
		const reason: string = createToolResultLimitReason(totalToolResultChars, maxTotalToolResultChars);
		if (shouldPauseForToolBudget(gateway)) {
			return createToolBudgetRequiredResult({
				limitKind: "tool_result_chars",
				reason,
				usedSteps: continuation.nextStep,
				maxSteps: getContinuationMaxSteps(params, continuation),
				totalToolResultChars,
				toolResultCharLimit: maxTotalToolResultChars,
				continuation: {
					...continuation,
					inputItems: [...inputItems],
					totalToolResultChars,
					maxSteps: getContinuationMaxSteps(params, continuation),
					toolResultCharLimit: maxTotalToolResultChars
				}
			});
		}
		const finalText: string = await createFinalAnswer(
			params,
			options,
			continuation.instructions,
			inputItems,
			reason,
			abortSignal,
			continuation.toolImageReferences ?? []
		);
		onEvent?.({ type: "ai.delta", text: finalText });
		return { status: "completed", text: finalText };
	}

	const maxSteps: number = getContinuationMaxSteps(params, continuation);
	return runResponsesAgentLoop(
		params,
		options,
		continuation.instructions,
		inputItems,
		mcpHost,
		gateway,
		tools,
		continuation.nextStep,
		maxSteps,
		totalToolResultChars,
		maxTotalToolResultChars,
		true,
		onEvent,
		abortSignal,
		toolResultEnricher,
		toolContext,
		continuation.toolImageReferences ?? []
	);
}

async function continueOpenAIResponsesAgentAfterToolBudgetInternal(
	params: AiChatParams,
	options: ProviderChatOptions,
	continuation: ResponsesAgentContinuation,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames: readonly string[] | undefined,
	onEvent: OnToolEvent | undefined,
	abortSignal: AbortSignal | undefined,
	toolResultEnricher: ToolResultEnricher | undefined,
	toolContext: ToolExecutionContext | undefined,
	streamAssistant: boolean
): Promise<ProviderAgentResult> {
	const toolCatalog = createWorkspaceToolCatalog(toolContext);
	const tools = allowedToolNames !== undefined
		? toolCatalog.getDefinitionsForNames(allowedToolNames)
		: toolCatalog.getDefinitions();
	const inputItems: ResponseInputItem[] = [...continuation.inputItems];
	const totalToolResultChars: number = compactOpenAIResponsesToolResults(inputItems);
	return runResponsesAgentLoop(
		params,
		options,
		continuation.instructions,
		inputItems,
		mcpHost,
		gateway,
		tools,
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

export async function continueOpenAIResponsesAgentAfterToolBudget(
	params: AiChatParams,
	options: ProviderChatOptions,
	continuation: ResponsesAgentContinuation,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames?: readonly string[] | undefined,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	toolResultEnricher?: ToolResultEnricher | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<ProviderAgentResult> {
	return continueOpenAIResponsesAgentAfterToolBudgetInternal(params, options, continuation, mcpHost, gateway, allowedToolNames, onEvent, abortSignal, toolResultEnricher, toolContext, false);
}

export async function continueOpenAIResponsesAgentAfterToolBudgetStreaming(
	params: AiChatParams,
	options: ProviderChatOptions,
	continuation: ResponsesAgentContinuation,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames?: readonly string[] | undefined,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	toolResultEnricher?: ToolResultEnricher | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<ProviderAgentResult> {
	return continueOpenAIResponsesAgentAfterToolBudgetInternal(params, options, continuation, mcpHost, gateway, allowedToolNames, onEvent, abortSignal, toolResultEnricher, toolContext, true);
}

async function finalizeOpenAIResponsesAgentAfterToolBudgetInternal(
	params: AiChatParams,
	options: ProviderChatOptions,
	continuation: ResponsesAgentContinuation,
	reason: string,
	onEvent: OnToolEvent | undefined,
	abortSignal: AbortSignal | undefined,
	streamAssistant: boolean
): Promise<ProviderAgentResult> {
	const finalText: string = await createFinalAnswer(
		params,
		options,
		continuation.instructions,
		[...continuation.inputItems],
		reason,
		abortSignal,
		continuation.toolImageReferences ?? []
	);
	if (streamAssistant) {
		onEvent?.({ type: "ai.delta", text: finalText });
	}
	return { status: "completed", text: finalText };
}

export async function finalizeOpenAIResponsesAgentAfterToolBudget(
	params: AiChatParams,
	options: ProviderChatOptions,
	continuation: ResponsesAgentContinuation,
	_allowedToolNames: readonly string[] | undefined,
	reason: string,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	_toolContext?: ToolExecutionContext | undefined
): Promise<ProviderAgentResult> {
	return finalizeOpenAIResponsesAgentAfterToolBudgetInternal(params, options, continuation, reason, onEvent, abortSignal, false);
}

export async function finalizeOpenAIResponsesAgentAfterToolBudgetStreaming(
	params: AiChatParams,
	options: ProviderChatOptions,
	continuation: ResponsesAgentContinuation,
	_allowedToolNames: readonly string[] | undefined,
	reason: string,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	_toolContext?: ToolExecutionContext | undefined
): Promise<ProviderAgentResult> {
	return finalizeOpenAIResponsesAgentAfterToolBudgetInternal(params, options, continuation, reason, onEvent, abortSignal, true);
}
