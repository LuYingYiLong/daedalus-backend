import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { AiChatParams, ChatMessage } from "../protocol/types.js";
import { getImageAttachments, getProviderUserText, type ProviderImageAttachment } from "./provider-image-content.js";
import { normalizeConfiguredProviderBaseUrl, resolveProviderBaseUrl } from "./provider-base-url.js";
import type { ProviderChatOptions } from "./provider-types.js";
import { getProviderDefaultModel } from "./provider-registry.js";
import type { NormalizedLlmUsage } from "../usage/metrics-types.js";
import { getProviderUsageErrorCode, getProviderUsageStatusForError, recordProviderUsage } from "../usage/provider-recorder.js";
import { parseAnthropicUsage } from "../usage/usage-parser.js";
import { ProviderHttpError, ProviderIncompleteStreamError } from "./provider-resilience.js";
import { ProviderEmptyResponseError } from "./provider-response-error.js";
import { applyProviderRequestOverridesToFetchInit } from "./provider-request-overrides.js";
import { resolveReasoningEffort } from "./reasoning-effort.js";

export type AnthropicTextBlock = {
	type: "text";
	text: string;
};

export type AnthropicImageBlock = {
	type: "image";
	source: {
		type: "base64";
		media_type: string;
		data: string;
	};
};

export type AnthropicToolUseBlock = {
	type: "tool_use";
	id: string;
	name: string;
	input: Record<string, unknown>;
};

export type AnthropicToolResultBlock = {
	type: "tool_result";
	tool_use_id: string;
	content: string;
	is_error?: boolean | undefined;
};

export type AnthropicContentBlock =
	| AnthropicTextBlock
	| AnthropicImageBlock
	| AnthropicToolUseBlock
	| AnthropicToolResultBlock;

export type AnthropicMessageParam = {
	role: "user" | "assistant";
	content: string | AnthropicContentBlock[];
};

export type AnthropicToolDefinition = {
	name: string;
	description?: string | undefined;
	input_schema: Record<string, unknown>;
};

export type AnthropicMessageResponse = {
	id?: string | undefined;
	type?: string | undefined;
	role?: "assistant" | undefined;
	model?: string | undefined;
	content: AnthropicContentBlock[];
	stop_reason?: string | null | undefined;
	usage?: unknown | undefined;
};

export type StreamedAnthropicMessage = {
	content: AnthropicContentBlock[];
	text: string;
};

type AnthropicRequestBody = {
	model: string;
	max_tokens: number;
	system?: string | undefined;
	messages: AnthropicMessageParam[];
	tools?: AnthropicToolDefinition[] | undefined;
	stream?: boolean | undefined;
	temperature?: number | undefined;
	top_p?: number | undefined;
	stop_sequences?: string[] | undefined;
	output_config?: {
		effort: string;
	} | undefined;
};

type StreamingContentBlock =
	| AnthropicTextBlock
	| AnthropicToolUseBlock
	| null;

type StreamingToolUseAccumulator = {
	id: string;
	name: string;
	inputJson: string;
};

export function resolveAnthropicModel(options: ProviderChatOptions): string {
	return options.model ?? getProviderDefaultModel(options.provider);
}

function createAnthropicEndpoint(options: ProviderChatOptions): string {
	return `${normalizeConfiguredProviderBaseUrl(options.baseUrl) ?? resolveProviderBaseUrl(options.provider, undefined)}/messages`;
}

function normalizeBase64ImageData(image: ProviderImageAttachment): string {
	const prefix: string = `data:${image.mimeType};base64,`;
	return image.dataUrl.startsWith(prefix) ? image.dataUrl.slice(prefix.length) : image.dataUrl;
}

function createImageBlocks(params: AiChatParams): AnthropicImageBlock[] {
	return getImageAttachments(params.additionalContext).map((image: ProviderImageAttachment): AnthropicImageBlock => ({
		type: "image",
		source: {
			type: "base64",
			media_type: image.mimeType,
			data: normalizeBase64ImageData(image)
		}
	}));
}

export function createCurrentAnthropicUserMessage(params: AiChatParams): AnthropicMessageParam {
	const contentBlocks: AnthropicContentBlock[] = createImageBlocks(params);
	const userText: string = getProviderUserText(params);
	if (contentBlocks.length === 0) {
		return {
			role: "user",
			content: userText
		};
	}

	contentBlocks.push({
		type: "text",
		text: userText
	});

	return {
		role: "user",
		content: contentBlocks
	};
}

export function createAnthropicMessages(params: AiChatParams, history: ChatMessage[]): AnthropicMessageParam[] {
	const messages: AnthropicMessageParam[] = [];
	for (const message of history) {
		if (message.role === "system") {
			continue;
		}
		messages.push({
			role: message.role,
			content: message.content
		});
	}
	messages.push(createCurrentAnthropicUserMessage(params));
	return messages;
}

type ChatCompletionFunctionTool = Extract<ChatCompletionTool, { type: "function" }>;

function isFunctionTool(tool: ChatCompletionTool): tool is ChatCompletionFunctionTool {
	return tool.type === "function";
}

export function convertChatToolsToAnthropicTools(tools: readonly ChatCompletionTool[]): AnthropicToolDefinition[] {
	return tools
		.filter(isFunctionTool)
		.map((tool: ChatCompletionFunctionTool): AnthropicToolDefinition => ({
			name: tool.function.name,
			description: tool.function.description,
			input_schema: isRecord(tool.function.parameters)
				? tool.function.parameters
				: { type: "object", properties: {} }
		}));
}

export function createAnthropicRequestBody(
	params: AiChatParams,
	options: ProviderChatOptions,
	messages: AnthropicMessageParam[],
	systemPrompt: string,
	tools?: readonly AnthropicToolDefinition[] | undefined,
	stream?: boolean | undefined
): AnthropicRequestBody {
	const maxTokens: number = params.options?.maxTokens
		?? options.modelProfile?.defaultOutputReserveTokens
		?? 4096;
	const body: AnthropicRequestBody = {
		model: resolveAnthropicModel(options),
		max_tokens: maxTokens,
		system: systemPrompt,
		messages
	};
	if (tools !== undefined && tools.length > 0) {
		body.tools = [...tools];
	}
	if (stream === true) {
		body.stream = true;
	}
	if (params.options?.temperature !== undefined) {
		body.temperature = params.options.temperature;
	}
	if (params.options?.topP !== undefined) {
		body.top_p = params.options.topP;
	}
	if (params.options?.stop !== undefined) {
		body.stop_sequences = Array.isArray(params.options.stop) ? params.options.stop : [params.options.stop];
	}
	if (options.reasoningMode !== "disabled") {
		const reasoningEffort: string | undefined = resolveReasoningEffort(
			options.provider,
			resolveAnthropicModel(options),
			params.options?.reasoningEffort
		);
		if (reasoningEffort !== undefined) {
			body.output_config = { effort: reasoningEffort };
		}
	}
	return body;
}

async function readErrorMessage(response: Response): Promise<string> {
	try {
		const body: unknown = await response.json() as unknown;
		if (isRecord(body)) {
			const error = body.error;
			if (isRecord(error) && typeof error.message === "string") {
				return error.message;
			}
			if (typeof body.message === "string") {
				return body.message;
			}
		}
	} catch {
		// 忽略 JSON 解析失败，保留 HTTP 状态。
	}
	return `Anthropic-compatible request failed with HTTP ${response.status}`;
}

function normalizeContentBlocks(value: unknown): AnthropicContentBlock[] {
	if (!Array.isArray(value)) {
		return [];
	}

	const blocks: AnthropicContentBlock[] = [];
	for (const item of value) {
		if (!isRecord(item) || typeof item.type !== "string") {
			continue;
		}
		if (item.type === "text" && typeof item.text === "string") {
			blocks.push({ type: "text", text: item.text });
			continue;
		}
		if (item.type === "tool_use" && typeof item.id === "string" && typeof item.name === "string") {
			blocks.push({
				type: "tool_use",
				id: item.id,
				name: item.name,
				input: isRecord(item.input) ? item.input : {}
			});
		}
	}
	return blocks;
}

function parseMessageResponse(body: unknown): AnthropicMessageResponse {
	if (!isRecord(body)) {
		throw new Error("Anthropic-compatible response is not an object");
	}
	return {
		id: typeof body.id === "string" ? body.id : undefined,
		type: typeof body.type === "string" ? body.type : undefined,
		role: body.role === "assistant" ? "assistant" : undefined,
		model: typeof body.model === "string" ? body.model : undefined,
		content: normalizeContentBlocks(body.content),
		stop_reason: typeof body.stop_reason === "string" ? body.stop_reason : null,
		usage: isRecord(body.usage) ? body.usage : undefined
	};
}

export function extractAnthropicText(blocks: readonly AnthropicContentBlock[]): string {
	return blocks
		.filter((block): block is AnthropicTextBlock => block.type === "text")
		.map((block: AnthropicTextBlock): string => block.text)
		.join("");
}

export function extractAnthropicToolUseBlocks(blocks: readonly AnthropicContentBlock[]): AnthropicToolUseBlock[] {
	return blocks.filter((block): block is AnthropicToolUseBlock => block.type === "tool_use");
}

export async function createAnthropicMessage(
	params: AiChatParams,
	options: ProviderChatOptions,
	messages: AnthropicMessageParam[],
	systemPrompt: string,
	tools?: readonly AnthropicToolDefinition[] | undefined,
	abortSignal?: AbortSignal | undefined
): Promise<AnthropicMessageResponse> {
	const requestBody: AnthropicRequestBody = createAnthropicRequestBody(params, options, messages, systemPrompt, tools);
	const requestInit: RequestInit = {
		method: "POST",
		headers: {
			"Authorization": `Bearer ${options.apiKey}`,
			"Content-Type": "application/json"
		},
		body: JSON.stringify(requestBody)
	};
	if (abortSignal !== undefined) {
		requestInit.signal = abortSignal;
	}
	const startedAtMs: number = Date.now();
	let response: Response;
	try {
		response = await fetch(createAnthropicEndpoint(options), applyProviderRequestOverridesToFetchInit(requestInit, options.requestOverrides));
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

	if (!response.ok) {
		const errorMessage: string = await readErrorMessage(response);
		await recordProviderUsage({
			options,
			requestBody,
			startedAtMs,
			status: "error",
			errorCode: `http_${response.status}`,
			streaming: false
		});
		throw new ProviderHttpError(errorMessage, response.status, response.headers);
	}

	const body: unknown = await response.json() as unknown;
	const message: AnthropicMessageResponse = parseMessageResponse(body);
	await recordProviderUsage({
		options,
		requestBody,
		responseBody: body,
		outputText: extractAnthropicText(message.content),
		startedAtMs,
		status: "success",
		streaming: false,
		usage: parseAnthropicUsage(body)
	});
	return message;
}

export async function* streamAnthropicMessageText(
	params: AiChatParams,
	options: ProviderChatOptions,
	messages: AnthropicMessageParam[],
	systemPrompt: string,
	abortSignal?: AbortSignal | undefined
): AsyncGenerator<string> {
	const streamed = streamAnthropicMessage(params, options, messages, systemPrompt, undefined, abortSignal);
	for await (const event of streamed) {
		if (event.type === "text_delta") {
			yield event.text;
		}
	}
}

export type AnthropicStreamEvent =
	| { type: "text_delta"; text: string }
	| { type: "thinking_delta"; text: string }
	| { type: "message_stop"; message: StreamedAnthropicMessage };

export async function* streamAnthropicMessage(
	params: AiChatParams,
	options: ProviderChatOptions,
	messages: AnthropicMessageParam[],
	systemPrompt: string,
	tools?: readonly AnthropicToolDefinition[] | undefined,
	abortSignal?: AbortSignal | undefined,
	markActivity?: (() => void) | undefined
): AsyncGenerator<AnthropicStreamEvent> {
	const requestBody: AnthropicRequestBody = createAnthropicRequestBody(params, options, messages, systemPrompt, tools, true);
	const requestInit: RequestInit = {
		method: "POST",
		headers: {
			"Authorization": `Bearer ${options.apiKey}`,
			"Content-Type": "application/json"
		},
		body: JSON.stringify(requestBody)
	};
	if (abortSignal !== undefined) {
		requestInit.signal = abortSignal;
	}
	const startedAtMs: number = Date.now();
	let firstTokenAtMs: number | undefined;
	let finalUsage: NormalizedLlmUsage | null = null;
	let response: Response;
	try {
		response = await fetch(createAnthropicEndpoint(options), applyProviderRequestOverridesToFetchInit(requestInit, options.requestOverrides));
	} catch (error: unknown) {
		await recordProviderUsage({
			options,
			requestBody,
			startedAtMs,
			status: getProviderUsageStatusForError(error),
			errorCode: getProviderUsageErrorCode(error),
			streaming: true
		});
		throw error;
	}

	if (!response.ok) {
		const errorMessage: string = await readErrorMessage(response);
		await recordProviderUsage({
			options,
			requestBody,
			startedAtMs,
			status: "error",
			errorCode: `http_${response.status}`,
			streaming: true
		});
		throw new ProviderHttpError(errorMessage, response.status, response.headers);
	}
	if (response.body === null) {
		await recordProviderUsage({
			options,
			requestBody,
			startedAtMs,
			status: "error",
			errorCode: "empty_stream_body",
			streaming: true
		});
		throw new ProviderIncompleteStreamError("Anthropic-compatible streaming response has no body.");
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer: string = "";
	const contentBlocks: StreamingContentBlock[] = [];
	let text: string = "";
	let receivedMessageStop: boolean = false;

	try {
		while (true) {
			const readResult = await reader.read();
			if (readResult.done) {
				break;
			}
			markActivity?.();
			buffer += decoder.decode(readResult.value, { stream: true });
			const chunks: string[] = buffer.split("\n\n");
			buffer = chunks.pop() ?? "";
			for (const chunk of chunks) {
				const dataLines: string[] = chunk
					.split(/\r?\n/u)
					.filter((line: string): boolean => line.startsWith("data:"))
					.map((line: string): string => line.slice("data:".length).trim());
				for (const dataLine of dataLines) {
					if (dataLine.length === 0 || dataLine === "[DONE]") {
						continue;
					}
					const parsed: unknown = JSON.parse(dataLine) as unknown;
					if (isRecord(parsed) && parsed.type === "message_stop") {
						receivedMessageStop = true;
					}
					finalUsage = parseAnthropicUsage(parsed) ?? finalUsage;
					for (const event of applyStreamEvent(parsed, contentBlocks)) {
						if (firstTokenAtMs === undefined && (event.type === "text_delta" || event.type === "thinking_delta")) {
							firstTokenAtMs = Date.now();
						}
						if (event.type === "text_delta") {
							text += event.text;
						}
						yield event;
					}
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
	if (!receivedMessageStop) {
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
		throw new ProviderIncompleteStreamError("Anthropic stream ended without message_stop.");
	}

	const finalBlocks: AnthropicContentBlock[] = contentBlocks
		.filter((block): block is Exclude<StreamingContentBlock, null> => block !== null)
		.map((block: Exclude<StreamingContentBlock, null>): AnthropicContentBlock => {
			if (block.type === "tool_use") {
				return {
					...block,
					input: isRecord(block.input) ? block.input : {}
				};
			}
			return block;
		});
	await recordProviderUsage({
		options,
		requestBody,
		outputText: text,
		startedAtMs,
		firstTokenAtMs,
		status: "success",
		streaming: true,
		usage: finalUsage
	});
	yield {
		type: "message_stop",
		message: {
			content: finalBlocks,
			text
		}
	};
}

function applyStreamEvent(value: unknown, contentBlocks: StreamingContentBlock[]): AnthropicStreamEvent[] {
	if (!isRecord(value) || typeof value.type !== "string") {
		return [];
	}
	if (value.type === "content_block_start") {
		const index: number = typeof value.index === "number" ? value.index : contentBlocks.length;
		const contentBlock: unknown = value.content_block;
		if (isRecord(contentBlock) && contentBlock.type === "text") {
			contentBlocks[index] = { type: "text", text: typeof contentBlock.text === "string" ? contentBlock.text : "" };
		} else if (isRecord(contentBlock) && contentBlock.type === "tool_use" && typeof contentBlock.id === "string" && typeof contentBlock.name === "string") {
			const accumulator: StreamingToolUseAccumulator = {
				id: contentBlock.id,
				name: contentBlock.name,
				inputJson: ""
			};
			contentBlocks[index] = {
				type: "tool_use",
				id: accumulator.id,
				name: accumulator.name,
				input: { __partialJson: accumulator.inputJson }
			};
		} else {
			contentBlocks[index] = null;
		}
		return [];
	}

	if (value.type === "content_block_delta") {
		const index: number | undefined = typeof value.index === "number" ? value.index : undefined;
		const delta: unknown = value.delta;
		if (index === undefined || !isRecord(delta) || typeof delta.type !== "string") {
			return [];
		}
		const block: StreamingContentBlock | undefined = contentBlocks[index];
		if (delta.type === "text_delta" && typeof delta.text === "string") {
			if (block?.type === "text") {
				block.text += delta.text;
			}
			return [{ type: "text_delta", text: delta.text }];
		}
		if ((delta.type === "thinking_delta" || delta.type === "signature_delta") && typeof delta.thinking === "string") {
			return [{ type: "thinking_delta", text: delta.thinking }];
		}
		if (delta.type === "input_json_delta" && typeof delta.partial_json === "string" && block?.type === "tool_use") {
			const previousPartial: unknown = block.input.__partialJson;
			block.input.__partialJson = `${typeof previousPartial === "string" ? previousPartial : ""}${delta.partial_json}`;
		}
		return [];
	}

	if (value.type === "content_block_stop") {
		const index: number | undefined = typeof value.index === "number" ? value.index : undefined;
		if (index !== undefined) {
			const block: StreamingContentBlock | undefined = contentBlocks[index];
			if (block?.type === "tool_use") {
				const partialJson: unknown = block.input.__partialJson;
				delete block.input.__partialJson;
				if (typeof partialJson === "string" && partialJson.trim().length > 0) {
					try {
						const parsedInput: unknown = JSON.parse(partialJson) as unknown;
						block.input = isRecord(parsedInput) ? parsedInput : {};
					} catch {
						block.input = {};
					}
				}
			}
		}
	}

	return [];
}

export async function chatWithAnthropicCompatible(
	params: AiChatParams,
	options: ProviderChatOptions,
	history: ChatMessage[],
	systemPrompt: string,
	abortSignal?: AbortSignal | undefined
): Promise<string> {
	const message = await createAnthropicMessage(
		params,
		options,
		createAnthropicMessages(params, history),
		systemPrompt,
		undefined,
		abortSignal
	);
	const text: string = extractAnthropicText(message.content);
	if (text.length === 0) {
		throw new ProviderEmptyResponseError({
			finishReason: message.stop_reason ?? undefined
		});
	}
	return text;
}

export async function* streamChatWithAnthropicCompatible(
	params: AiChatParams,
	options: ProviderChatOptions,
	history: ChatMessage[],
	systemPrompt: string,
	abortSignal?: AbortSignal | undefined
): AsyncGenerator<string> {
	yield* streamAnthropicMessageText(params, options, createAnthropicMessages(params, history), systemPrompt, abortSignal);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
