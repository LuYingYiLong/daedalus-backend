import OpenAI from "openai";
import type {
	ChatCompletionChunk,
	ChatCompletionCreateParamsBase,
	ChatCompletionCreateParamsNonStreaming,
	ChatCompletionCreateParamsStreaming,
	ChatCompletionMessageParam
} from "openai/resources/chat/completions";
import type { AiChatParams, ChatMessage } from "../protocol/types.js";
import { createProviderMessages } from "./provider-image-content.js";
import { normalizeConfiguredProviderBaseUrl, resolveProviderBaseUrl } from "./provider-base-url.js";
import type { ProviderChatOptions } from "./provider-types.js";
import { getProviderDefaultModel, getProviderEndpointConfig } from "./provider-registry.js";
import { resolveReasoningEffort } from "./reasoning-effort.js";
import { ProviderEmptyResponseError } from "./provider-response-error.js";
import { getProviderUsageErrorCode, getProviderUsageStatusForError, recordProviderUsage } from "../usage/provider-recorder.js";
import { parseOpenAIChatUsage } from "../usage/usage-parser.js";
import { createProviderRequestOverrideFetch } from "./provider-request-overrides.js";

export type ProviderTransportActivity = () => void;

/**
 * The OpenAI SDK intentionally drops SSE comments and other keep-alive frames.
 * Wrap its fetch response before parsing so the resilience layer sees raw body
 * bytes instead of treating parser output as the transport heartbeat.
 */
export function createTransportActivityFetch(
	fetchImplementation: typeof fetch,
	onActivity: ProviderTransportActivity
): typeof fetch {
	return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const response: Response = await fetchImplementation(input, init);
		if (response.body === null) {
			return response;
		}
		const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
		let released: boolean = false;
		const releaseReader = (): void => {
			if (!released) {
				released = true;
				reader.releaseLock();
			}
		};
		const trackedBody = new ReadableStream<Uint8Array>({
			async pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
				try {
					const result: ReadableStreamReadResult<Uint8Array> = await reader.read();
					if (result.done) {
						releaseReader();
						controller.close();
						return;
					}
					onActivity();
					controller.enqueue(result.value);
				} catch (error: unknown) {
					releaseReader();
					controller.error(error);
				}
			},
			async cancel(reason: unknown): Promise<void> {
				try {
					await reader.cancel(reason);
				} finally {
					releaseReader();
				}
			}
		});
		return new Response(trackedBody, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers
		});
	};
}

export function createOpenAICompatibleClient(options: ProviderChatOptions, onTransportActivity?: ProviderTransportActivity | undefined): OpenAI {
	const clientOptions: ConstructorParameters<typeof OpenAI>[0] = {
		apiKey: options.apiKey,
		baseURL: normalizeConfiguredProviderBaseUrl(options.baseUrl) ?? resolveProviderBaseUrl(options.provider, undefined),
		maxRetries: 0,
		timeout: 60_000
	};
	const requestFetch: typeof fetch = createProviderRequestOverrideFetch(globalThis.fetch, options.requestOverrides);
	if (onTransportActivity !== undefined) {
		clientOptions.fetch = createTransportActivityFetch(requestFetch, onTransportActivity);
	} else if (requestFetch !== globalThis.fetch) {
		clientOptions.fetch = requestFetch;
	}
	return new OpenAI(clientOptions);
}

export function resolveChatModel(options: ProviderChatOptions): string {
	return options.model ?? getProviderDefaultModel(options.provider);
}

export function createMessages(params: AiChatParams, history: ChatMessage[], systemPrompt: string): ChatCompletionMessageParam[] {
	return createProviderMessages(params, history, systemPrompt);
}

function normalizeTemperature(options: ProviderChatOptions, temperature: number): number {
	const constraint = getProviderEndpointConfig(options.provider, options.endpointType).temperature;
	if (constraint === undefined) {
		return temperature;
	}

	return Math.min(constraint.max, Math.max(constraint.min, temperature));
}

export function applyChatOptions(requestBody: ChatCompletionCreateParamsBase, params: AiChatParams, options: ProviderChatOptions): void {
	if (params.options?.temperature !== undefined) {
		requestBody.temperature = normalizeTemperature(options, params.options.temperature);
	}

	if (params.options?.topP !== undefined) {
		requestBody.top_p = params.options.topP;
	}

	if (params.options?.maxTokens !== undefined) {
		const maxTokensField = getProviderEndpointConfig(options.provider, options.endpointType).maxTokensField ?? "max_tokens";
		if (maxTokensField === "max_completion_tokens") {
			const providerRequest = requestBody as unknown as Record<string, unknown>;
			providerRequest.max_completion_tokens = params.options.maxTokens;
			delete providerRequest.max_tokens;
		} else {
			requestBody.max_tokens = params.options.maxTokens;
		}
	}

	if (params.options?.stop !== undefined) {
		requestBody.stop = params.options.stop;
	}

	if (params.options?.responseFormat === "json") {
		requestBody.response_format = { type: "json_object" };
	}

	if (options.reasoningMode === "disabled" && options.provider === "deepseek") {
		const providerRequest = requestBody as unknown as Record<string, unknown>;
		delete providerRequest.reasoning_effort;
		providerRequest.thinking = { type: "disabled" };
	} else {
		const reasoningEffort: string | undefined = resolveReasoningEffort(
			options.provider,
			resolveChatModel(options),
			params.options?.reasoningEffort
		);
		if (reasoningEffort !== undefined && (options.provider === "deepseek" || options.provider === "moonshot")) {
			const providerRequest = requestBody as unknown as Record<string, unknown>;
			providerRequest.reasoning_effort = reasoningEffort;
			if (options.provider === "deepseek") {
				providerRequest.thinking = { type: "enabled" };
			}
		}
	}
}

export async function chatWithOpenAICompatible(
	params: AiChatParams,
	options: ProviderChatOptions,
	history: ChatMessage[],
	systemPrompt: string,
	abortSignal?: AbortSignal | undefined
): Promise<string> {
	const client: OpenAI = createOpenAICompatibleClient(options);
	const requestBody: ChatCompletionCreateParamsNonStreaming = {
		model: resolveChatModel(options),
		messages: createMessages(params, history, systemPrompt)
	};

	applyChatOptions(requestBody, params, options);

	const startedAtMs: number = Date.now();
	let completion;
	try {
		completion = await client.chat.completions.create(requestBody, { signal: abortSignal });
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

	const choice = completion.choices[0];
	const text: string | null | undefined = choice?.message.content;
	if (!text) {
		await recordProviderUsage({
			options,
			requestBody,
			responseBody: completion,
			startedAtMs,
			status: "error",
			errorCode: "empty_response",
			streaming: false,
			usage: parseOpenAIChatUsage(completion)
		});
		const message = choice?.message as unknown as Record<string, unknown> | undefined;
		const reasoningContent: unknown = message?.reasoning_content;
		throw new ProviderEmptyResponseError({
			finishReason: choice?.finish_reason ?? undefined,
			reasoningChars: typeof reasoningContent === "string" ? reasoningContent.length : undefined,
			refused: typeof message?.refusal === "string" && message.refusal.length > 0
		});
	}
	await recordProviderUsage({
		options,
		requestBody,
		responseBody: completion,
		outputText: text,
		startedAtMs,
		status: "success",
		streaming: false,
		usage: parseOpenAIChatUsage(completion)
	});

	return text;
}

export async function* streamChatWithOpenAICompatible(
	params: AiChatParams,
	options: ProviderChatOptions,
	history: ChatMessage[],
	systemPrompt: string,
	abortSignal?: AbortSignal | undefined
): AsyncGenerator<string> {
	const client: OpenAI = createOpenAICompatibleClient(options);
	const requestBody: ChatCompletionCreateParamsStreaming = {
		model: resolveChatModel(options),
		messages: createMessages(params, history, systemPrompt),
		stream: true
	};

	applyChatOptions(requestBody, params, options);

	const startedAtMs: number = Date.now();
	let firstTokenAtMs: number | undefined;
	let outputText: string = "";
	let finalUsage = null;
	try {
		const stream = await client.chat.completions.create(requestBody, { signal: abortSignal });
		for await (const chunk of stream) {
			finalUsage = parseOpenAIChatUsage(chunk) ?? finalUsage;
			const delta: string | null | undefined = (chunk as ChatCompletionChunk).choices[0]?.delta.content;
			if (delta !== undefined && delta !== null && delta.length > 0) {
				if (firstTokenAtMs === undefined) {
					firstTokenAtMs = Date.now();
				}
				outputText += delta;
				yield delta;
			}
		}
		await recordProviderUsage({
			options,
			requestBody,
			outputText,
			startedAtMs,
			firstTokenAtMs,
			status: "success",
			streaming: true,
			usage: finalUsage
		});
	} catch (error: unknown) {
		await recordProviderUsage({
			options,
			requestBody,
			outputText,
			startedAtMs,
			firstTokenAtMs,
			status: getProviderUsageStatusForError(error),
			errorCode: getProviderUsageErrorCode(error),
			streaming: true,
			usage: finalUsage
		});
		throw error;
	}
}
