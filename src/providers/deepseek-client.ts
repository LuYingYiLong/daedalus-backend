import type { AiChatParams, ChatMessage } from "../protocol/types.js";
import type { ProviderChatOptions } from "./provider-types.js";
import {
	applyChatOptions,
	chatWithProvider,
	createProviderClient,
	createMessages,
	resolveChatModel,
	streamChatWithProvider
} from "./provider-chat.js";

export type { ProviderChatOptions } from "./provider-types.js";
export type DeepSeekChatOptions = ProviderChatOptions;

export { applyChatOptions, chatWithProvider, createMessages, createProviderClient, resolveChatModel, streamChatWithProvider };

export function createDeepSeekClient(options: ProviderChatOptions, onTransportActivity?: (() => void) | undefined): OpenAI {
	return createProviderClient(options, onTransportActivity);
}

export async function chatWithDeepSeek(
	params: AiChatParams,
	options: ProviderChatOptions,
	history: ChatMessage[],
	systemPrompt: string,
	abortSignal?: AbortSignal | undefined
): Promise<string> {
	return chatWithProvider(params, options, history, systemPrompt, abortSignal);
}

export async function* streamChatWithDeepSeek(
	params: AiChatParams,
	options: ProviderChatOptions,
	history: ChatMessage[],
	systemPrompt: string,
	abortSignal?: AbortSignal | undefined
): AsyncGenerator<string> {
	yield* streamChatWithProvider(params, options, history, systemPrompt, abortSignal);
}
import OpenAI from "openai";
