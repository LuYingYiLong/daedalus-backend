import OpenAI from "openai";
import type {
	EasyInputMessage,
	ResponseCreateParamsBase,
	ResponseCreateParamsNonStreaming,
	ResponseCreateParamsStreaming,
	ResponseInputContent,
	ResponseInputItem,
	ResponseStreamEvent
} from "openai/resources/responses/responses";
import type { AiChatParams, ChatMessage } from "../protocol/types.js";
import { getProviderDefaultModel } from "./provider-registry.js";
import { resolveReasoningEffort } from "./reasoning-effort.js";
import { ProviderEmptyResponseError } from "./provider-response-error.js";
import { getImageAttachments, getProviderUserText, type ProviderImageAttachment } from "./provider-image-content.js";
import type { ProviderChatOptions } from "./deepseek-client.js";
import { normalizeConfiguredProviderBaseUrl } from "./provider-base-url.js";
import { getProviderUsageErrorCode, getProviderUsageStatusForError, recordProviderUsage } from "../usage/provider-recorder.js";
import { parseOpenAIResponsesUsage } from "../usage/usage-parser.js";
import { createTransportActivityFetch, type ProviderTransportActivity } from "./provider-chat-completions-client.js";
import { createProviderRequestOverrideFetch } from "./provider-request-overrides.js";

export function createOpenAIResponsesClient(options: ProviderChatOptions, onTransportActivity?: ProviderTransportActivity | undefined): OpenAI {
	const clientOptions: ConstructorParameters<typeof OpenAI>[0] = {
		apiKey: options.apiKey,
		maxRetries: 0,
		timeout: 60_000
	};
	if (options.sensitivePayload === true) {
		clientOptions.logLevel = "off";
	}
	const normalizedBaseUrl: string | undefined = normalizeConfiguredProviderBaseUrl(options.baseUrl);
	if (normalizedBaseUrl !== undefined) {
		clientOptions.baseURL = normalizedBaseUrl;
	}
	const requestFetch: typeof fetch = createProviderRequestOverrideFetch(globalThis.fetch, options.requestOverrides);
	if (onTransportActivity !== undefined) {
		clientOptions.fetch = createTransportActivityFetch(requestFetch, onTransportActivity);
	} else if (requestFetch !== globalThis.fetch) {
		clientOptions.fetch = requestFetch;
	}
	return new OpenAI(clientOptions);
}

export function resolveOpenAIResponsesModel(options: ProviderChatOptions): string {
	return options.model ?? getProviderDefaultModel("openai");
}

function createCurrentUserInputContent(params: AiChatParams): string | ResponseInputContent[] {
	const images: ProviderImageAttachment[] = getImageAttachments(params.additionalContext);
	const userText: string = getProviderUserText(params);
	if (images.length === 0) {
		return userText;
	}

	const parts: ResponseInputContent[] = images.map((image: ProviderImageAttachment): ResponseInputContent => ({
		type: "input_image",
		image_url: image.dataUrl,
		detail: "auto"
	}));
	parts.push({
		type: "input_text",
		text: userText
	});
	return parts;
}

export function createOpenAIResponseInput(params: AiChatParams, history: ChatMessage[]): ResponseInputItem[] {
	const input: ResponseInputItem[] = history.map((message: ChatMessage): ResponseInputItem => {
		const inputMessage: EasyInputMessage = {
			type: "message",
			role: message.role,
			content: message.content
		};
		if (message.role === "assistant") {
			inputMessage.phase = "final_answer";
		}
		return inputMessage;
	});

	input.push({
		type: "message",
		role: "user",
		content: createCurrentUserInputContent(params)
	} satisfies EasyInputMessage);
	return input;
}

export function applyOpenAIResponsesOptions(
	requestBody: ResponseCreateParamsBase,
	params: AiChatParams,
	options?: ProviderChatOptions | undefined
): void {
	if (params.options?.temperature !== undefined) {
		requestBody.temperature = params.options.temperature;
	}
	if (params.options?.topP !== undefined) {
		requestBody.top_p = params.options.topP;
	}
	if (params.options?.maxTokens !== undefined) {
		requestBody.max_output_tokens = params.options.maxTokens;
	}
	if (params.options?.responseFormat === "json") {
		requestBody.text = {
			format: { type: "json_object" }
		};
	}
	if (options?.reasoningMode !== "disabled") {
		const model: string = typeof requestBody.model === "string" ? requestBody.model : "";
		const reasoningEffort: string | undefined = resolveReasoningEffort(options?.provider ?? "openai", model, params.options?.reasoningEffort);
		if (reasoningEffort !== undefined) {
			(requestBody as unknown as { reasoning?: { effort: string } }).reasoning = { effort: reasoningEffort };
		}
	}
}

export function createOpenAIResponsesRequestBody(
	params: AiChatParams,
	options: ProviderChatOptions,
	history: ChatMessage[],
	instructions: string
): ResponseCreateParamsNonStreaming {
	const requestBody: ResponseCreateParamsNonStreaming = {
		model: resolveOpenAIResponsesModel(options),
		instructions,
		input: createOpenAIResponseInput(params, history),
		store: false
	};
	applyOpenAIResponsesOptions(requestBody, params, options);
	return requestBody;
}

export async function chatWithOpenAIResponses(
	params: AiChatParams,
	options: ProviderChatOptions,
	history: ChatMessage[],
	instructions: string,
	abortSignal?: AbortSignal | undefined
): Promise<string> {
	const client: OpenAI = createOpenAIResponsesClient(options);
	const requestBody: ResponseCreateParamsNonStreaming = createOpenAIResponsesRequestBody(params, options, history, instructions);
	const startedAtMs: number = Date.now();
	let response;
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
	const text: string = response.output_text;
	if (text.length === 0) {
		await recordProviderUsage({
			options,
			requestBody,
			responseBody: response,
			startedAtMs,
			status: "error",
			errorCode: "empty_response",
			streaming: false,
			usage: parseOpenAIResponsesUsage(response)
		});
		throw new ProviderEmptyResponseError({
			responseStatus: response.status,
			incompleteReason: response.incomplete_details?.reason,
			refused: response.output.some((item): boolean => (
				item.type === "message"
				&& item.content.some((content): boolean => content.type === "refusal")
			))
		});
	}
	await recordProviderUsage({
		options,
		requestBody,
		responseBody: response,
		outputText: text,
		startedAtMs,
		status: "success",
		streaming: false,
		usage: parseOpenAIResponsesUsage(response)
	});
	return text;
}

export async function* streamChatWithOpenAIResponses(
	params: AiChatParams,
	options: ProviderChatOptions,
	history: ChatMessage[],
	instructions: string,
	abortSignal?: AbortSignal | undefined
): AsyncGenerator<string> {
	const client: OpenAI = createOpenAIResponsesClient(options);
	const requestBody: ResponseCreateParamsStreaming = {
		...createOpenAIResponsesRequestBody(params, options, history, instructions),
		stream: true
	};
	const startedAtMs: number = Date.now();
	let firstTokenAtMs: number | undefined;
	let outputText: string = "";
	let completedResponse: unknown = null;
	try {
		const stream = await client.responses.create(requestBody, { signal: abortSignal });
		for await (const event of stream) {
			const streamEvent: ResponseStreamEvent = event as ResponseStreamEvent;
			if (streamEvent.type === "response.output_text.delta" && streamEvent.delta.length > 0) {
				if (firstTokenAtMs === undefined) {
					firstTokenAtMs = Date.now();
				}
				outputText += streamEvent.delta;
				yield streamEvent.delta;
			}
			if (streamEvent.type === "response.completed") {
				completedResponse = streamEvent.response;
			}
		}
		await recordProviderUsage({
			options,
			requestBody,
			responseBody: completedResponse,
			outputText,
			startedAtMs,
			firstTokenAtMs,
			status: "success",
			streaming: true,
			usage: parseOpenAIResponsesUsage(completedResponse)
		});
	} catch (error: unknown) {
		await recordProviderUsage({
			options,
			requestBody,
			responseBody: completedResponse,
			outputText,
			startedAtMs,
			firstTokenAtMs,
			status: getProviderUsageStatusForError(error),
			errorCode: getProviderUsageErrorCode(error),
			streaming: true,
			usage: parseOpenAIResponsesUsage(completedResponse)
		});
		throw error;
	}
}
