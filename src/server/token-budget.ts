import type { AdditionalContextItem, AiChatParams, ChatMessage, ModelProfile } from "../protocol/types.js";
import { type TokenCounter } from "../tokens/token-counter.js";
import { createTokenCounter } from "../tokens/token-counter-factory.js";
import { computeInputBudget, selectMessagesWithinBudget } from "../session/session-compressor.js";
import type { SessionSummary } from "../session/session-store.js";
import { createWorkspaceMetadataBackfill, openSession, updateSessionTranscript, type StoredMessage } from "../session/session-store.js";
import { estimateProviderMessagesTokens, estimateProviderTextTokens } from "../providers/provider-token-estimator.js";
import {
	createCurrentUserMessage,
	getImageAttachments,
	hasImageAttachments
} from "../providers/provider-image-content.js";
import { getProviderDisplayName } from "../providers/provider-registry.js";
import type { ProviderChatOptions } from "../providers/deepseek-client.js";
import type { ClientSession } from "./client-session.js";
import { cloneAdditionalContextItems } from "./additional-context.js";
import { logger } from "../logger.js";
import { readRuntimeAssetText } from "../runtime/runtime-assets.js";
import { filterLlmContextMessages, filterSessionLlmContextMessages, isLlmContextMessage } from "./transcript-history.js";
import { filterMessagesOutsideContextLedger } from "../context/context-ledger.js";

export { appendFailedChatTurnToSession, filterLlmContextMessages, filterSessionLlmContextMessages, isLlmContextMessage } from "./transcript-history.js";

const tokenCounterPromise: Promise<TokenCounter> = createTokenCounter();
let sessionCompressorPromptCache: string | undefined;

export async function getTokenCounter(): Promise<TokenCounter> {
	return tokenCounterPromise;
}

export async function loadSessionCompressorPrompt(): Promise<string> {
	if (sessionCompressorPromptCache !== undefined) {
		return sessionCompressorPromptCache;
	}

	const content: string = await readRuntimeAssetText("prompt.internal.sessionCompressor");
	const trimmedContent: string = content.trim();
	sessionCompressorPromptCache = trimmedContent;
	return trimmedContent;
}

export async function estimateTextTokens(text: string): Promise<number> {
	const tc: TokenCounter = await getTokenCounter();
	return tc.countText(text);
}

export async function estimateMessagesTokens(messages: ChatMessage[]): Promise<number> {
	const tc: TokenCounter = await getTokenCounter();
	let total: number = 0;

	for (const message of messages) {
		if (!isLlmContextMessage(message)) {
			continue;
		}
		total += await tc.countText(`${message.role}: ${message.content}`);
	}

	return total;
}

export async function estimateTextTokensForProvider(options: ProviderChatOptions, text: string, abortSignal?: AbortSignal | undefined): Promise<number> {
	try {
		const providerEstimate: number | null = await estimateProviderTextTokens(options, text, abortSignal);
		if (providerEstimate !== null) {
			return providerEstimate;
		}
	} catch (error: unknown) {
		const message: string = error instanceof Error ? error.message : String(error);
		logger.warn("token_counter", "provider_text_estimate_failed", {
			provider: options.provider,
			providerName: getProviderDisplayName(options.provider),
			message
		});
	}

	return estimateTextTokens(text);
}

export async function estimateCurrentMessageTokensForProvider(options: ProviderChatOptions, params: AiChatParams, abortSignal?: AbortSignal | undefined): Promise<number> {
	if (!hasImageAttachments(params)) {
		return estimateTextTokensForProvider(options, params.message, abortSignal);
	}

	try {
		const providerEstimate: number | null = await estimateProviderMessagesTokens(options, [createCurrentUserMessage(params)], abortSignal);
		if (providerEstimate !== null) {
			return providerEstimate;
		}
	} catch (error: unknown) {
		const message: string = error instanceof Error ? error.message : String(error);
		logger.warn("token_counter", "provider_multimodal_estimate_failed", {
			provider: options.provider,
			providerName: getProviderDisplayName(options.provider),
			message
		});
	}

	const imageTokens: number = getImageAttachments(params.additionalContext)
		.reduce((sum: number, image): number => sum + Math.ceil(image.byteSize / 384), 0);
	return await estimateTextTokens(params.message) + imageTokens;
}

export async function selectHistoryWithinBudget(messages: ChatMessage[], budgetTokens: number): Promise<ChatMessage[]> {
	const tc: TokenCounter = await getTokenCounter();
	return selectMessagesWithinBudget(filterLlmContextMessages(messages), budgetTokens, tc);
}

export async function computeHistoryBudget(
	profile: ModelProfile,
	options: ProviderChatOptions,
	params: AiChatParams,
	systemPrompt: string,
	mcpContext: string,
	abortSignal?: AbortSignal | undefined
): Promise<number> {
	const tc: TokenCounter = await getTokenCounter();
	const outputReserveTokens: number = params.options?.maxTokens ?? profile.defaultOutputReserveTokens;
	const systemPromptTokens: number = await estimateTextTokensForProvider(options, systemPrompt, abortSignal);
	const mcpContextTokens: number = await estimateTextTokensForProvider(options, mcpContext, abortSignal);
	const currentMessageTokens: number = await estimateCurrentMessageTokensForProvider(options, params, abortSignal);

	return computeInputBudget({
		profile,
		outputReserveTokens,
		systemPromptTokens,
		mcpContextTokens,
		toolDefinitionsTokens: 0,
		currentMessageTokens,
		tokenCounter: tc
	});
}

export async function appendChatTurnToSession(
	session: ClientSession,
	_history: ChatMessage[],
	userMessage: string,
	assistantMessage: string,
	requestId: string,
	userCreatedAt: string = new Date().toISOString(),
	assistantCreatedAt: string = new Date().toISOString(),
	additionalContext?: readonly AdditionalContextItem[] | undefined,
	persistUserMessage: boolean = true
): Promise<boolean> {
	if (!session.sessionId) {
		return false;
	}

	const sessionId: string = session.sessionId;
	return updateSessionTranscript(sessionId, (stored): { messages: ChatMessage[]; metadata: ReturnType<typeof createWorkspaceMetadataBackfill>; result: boolean } => {
		const clonedAdditionalContext: AdditionalContextItem[] | undefined = cloneAdditionalContextItems(additionalContext);
		const nextMessages: ChatMessage[] = stored.messages.map((message: StoredMessage): ChatMessage => ({ ...message }));
		const existingUserIndex: number = nextMessages.findIndex((message: ChatMessage): boolean => message.requestId === requestId && message.role === "user");
		const existingAssistantIndex: number = nextMessages.findIndex((message: ChatMessage): boolean => message.requestId === requestId && message.role === "assistant");
		let changed: boolean = false;

		if (persistUserMessage && existingUserIndex < 0) {
			const userChatMessage: ChatMessage = { role: "user", content: userMessage, requestId, createdAt: userCreatedAt };
			if (clonedAdditionalContext !== undefined) {
				userChatMessage.additionalContext = clonedAdditionalContext;
			}
			nextMessages.push(userChatMessage);
			changed = true;
		} else if (
			persistUserMessage
			&& existingUserIndex >= 0
			&& clonedAdditionalContext !== undefined
			&& nextMessages[existingUserIndex]?.additionalContext === undefined
		) {
			nextMessages[existingUserIndex] = {
				...nextMessages[existingUserIndex]!,
				additionalContext: clonedAdditionalContext
			};
			changed = true;
		}

		if (existingAssistantIndex < 0) {
			nextMessages.push({ role: "assistant", content: assistantMessage, requestId, createdAt: assistantCreatedAt });
			changed = true;
		}

		if (changed) {
			session.messages = nextMessages;
		}

		return {
			messages: nextMessages,
			metadata: createWorkspaceMetadataBackfill(stored.metadata, session.activeWorkspace),
			result: changed
		};
	});
}

export async function appendUserMessageToSession(
	session: ClientSession,
	userMessage: string,
	requestId: string,
	userCreatedAt: string = new Date().toISOString(),
	additionalContext?: readonly AdditionalContextItem[] | undefined
): Promise<boolean> {
	if (!session.sessionId) {
		return false;
	}
	const sessionId: string = session.sessionId;
	return updateSessionTranscript(sessionId, (stored): { messages: ChatMessage[]; metadata: ReturnType<typeof createWorkspaceMetadataBackfill>; result: boolean } => {
		const nextMessages: ChatMessage[] = stored.messages.map((message: StoredMessage): ChatMessage => ({ ...message }));
		if (nextMessages.some((message: ChatMessage): boolean => message.requestId === requestId && message.role === "user")) {
			session.messages = nextMessages;
			return {
				messages: nextMessages,
				metadata: createWorkspaceMetadataBackfill(stored.metadata, session.activeWorkspace),
				result: false
			};
		}

		const userChatMessage: ChatMessage = { role: "user", content: userMessage, requestId, createdAt: userCreatedAt };
		const clonedAdditionalContext: AdditionalContextItem[] | undefined = cloneAdditionalContextItems(additionalContext);
		if (clonedAdditionalContext !== undefined) {
			userChatMessage.additionalContext = clonedAdditionalContext;
		}

		const messages: ChatMessage[] = [...nextMessages, userChatMessage];
		session.messages = messages;
		return {
			messages,
			metadata: createWorkspaceMetadataBackfill(stored.metadata, session.activeWorkspace),
			result: true
		};
	});
}

export async function selectHistoryForModel(session: ClientSession, budgetTokens: number, excludeRequestId?: string | undefined): Promise<ChatMessage[]> {
	const filterRequest = (messages: ChatMessage[]): ChatMessage[] => excludeRequestId === undefined
		? messages
		: messages.filter((message: ChatMessage): boolean => message.requestId !== excludeRequestId);

	if (session.summaryMessage === undefined) {
		return selectHistoryWithinBudget(filterRequest(filterSessionLlmContextMessages(session)), budgetTokens);
	}

	const summaryTokens: number = await estimateMessagesTokens([session.summaryMessage]);
	const recentBudgetTokens: number = Math.max(0, budgetTokens - summaryTokens);
	const recentSourceMessages: ChatMessage[] = session.contextLedger !== undefined
		? filterMessagesOutsideContextLedger(session.messages, session.contextLedger.coveredMessageKeys)
		: session.summaryCoveredMessageCount !== undefined
			? session.messages.slice(session.summaryCoveredMessageCount)
			: session.messages;
	const recentMessages: ChatMessage[] = await selectHistoryWithinBudget(filterRequest(filterSessionLlmContextMessages(session, recentSourceMessages)), recentBudgetTokens);
	return [session.summaryMessage, ...recentMessages];
}

export function createSummaryMessage(summary: SessionSummary): ChatMessage {
	const generatedAtText: string = summary.generatedAt.length > 0
		? ` — 生成于 ${summary.generatedAt}`
		: "";

	return {
		role: "system",
		content: `[会话摘要${generatedAtText}]\n${summary.content}`
	};
}
