import type { ChatMessage } from "../protocol/types.js";
import { chatWithDeepSeek } from "../providers/deepseek-client.js";
import { isProviderEmptyResponseError } from "../providers/provider-response-error.js";
import { writeSummary, type SessionSummary } from "../session/session-store.js";
import type { ClientSession } from "./client-session.js";
import { createProviderChatOptions } from "./provider-chat-options.js";
import { createSummaryMessage, filterSessionLlmContextMessages, loadSessionCompressorPrompt } from "./token-budget.js";
import { withProviderUsageContext } from "../usage/provider-recorder.js";
import { logger } from "../logger.js";

const INITIAL_COMPRESSION_MAX_TOKENS: number = 800;
const RETRY_COMPRESSION_MAX_TOKENS: number = 1200;
const LOCAL_FALLBACK_MAX_CHARS: number = 1200;
const LOCAL_FALLBACK_MESSAGE_MAX_CHARS: number = 220;

export type SessionCompressionSource = "llm" | "llm_retry" | "local_fallback";

export type SessionCompressionDependencies = {
	chat?: typeof chatWithDeepSeek | undefined;
};

export type SessionCompressionResult =
	| {
		compressed: true;
		oldMessageCount: number;
		keptMessageCount: number;
		summaryLength: number;
		source: SessionCompressionSource;
	}
	| {
		compressed: false;
		reason: string;
		messageCount: number;
	};

export async function compressSessionHistory(
	session: ClientSession,
	apiKey: string,
	keepRecent: number = 8,
	requestId: string = `session-compression-${Date.now().toString(36)}`,
	dependencies: SessionCompressionDependencies = {}
): Promise<SessionCompressionResult> {
	if (!session.sessionId) {
		return { compressed: false, reason: "No active session", messageCount: session.messages.length };
	}

	const allMessages: ChatMessage[] = session.messages;
	if (allMessages.length <= keepRecent) {
		return { compressed: false, reason: "Not enough messages", messageCount: allMessages.length };
	}

	const oldMessages: ChatMessage[] = allMessages.slice(0, allMessages.length - keepRecent);
	const recentMessages: ChatMessage[] = allMessages.slice(allMessages.length - keepRecent);
	const compressibleMessages: ChatMessage[] = filterSessionLlmContextMessages(session, oldMessages)
		.filter((message: ChatMessage): boolean => message.content.trim().length > 0);
	if (compressibleMessages.length === 0) {
		return { compressed: false, reason: "No compressible messages", messageCount: allMessages.length };
	}

	const conversationText: string = compressibleMessages
		.map((message: ChatMessage): string => `${message.role}: ${message.content.slice(0, 300)}`)
		.join("\n");
	const compressorOptions = withProviderUsageContext(createProviderChatOptions(session, apiKey), {
		requestId,
		runId: requestId,
		sessionId: session.sessionId,
		workspaceId: session.activeWorkspace?.id,
		operation: "session_compression"
	});
	const compressorPrompt: string = await loadSessionCompressorPrompt();
	const summary = await generateCompressionSummary({
		conversationText,
		messages: compressibleMessages,
		options: compressorOptions,
		prompt: compressorPrompt,
		chat: dependencies.chat ?? chatWithDeepSeek
	});
	const summaryObj: SessionSummary = {
		content: summary.content,
		messageCount: oldMessages.length,
		tokenEstimate: Math.ceil(conversationText.length / 3),
		generatedAt: new Date().toISOString()
	};

	await writeSummary(session.sessionId, summaryObj);
	session.summaryMessage = createSummaryMessage(summaryObj);
	session.summaryCoveredMessageCount = summaryObj.messageCount;
	session.messages = allMessages;

	return {
		compressed: true,
		oldMessageCount: oldMessages.length,
		keptMessageCount: recentMessages.length,
		summaryLength: summary.content.length,
		source: summary.source
	};
}

type CompressionSummary = {
	content: string;
	source: SessionCompressionSource;
};

type GenerateCompressionSummaryParams = {
	conversationText: string;
	messages: readonly ChatMessage[];
	options: ReturnType<typeof createProviderChatOptions>;
	prompt: string;
	chat: typeof chatWithDeepSeek;
};

function normalizeSummaryContent(value: string): string {
	return value.trim();
}

function createCompressionParams(message: string, maxTokens: number): Parameters<typeof chatWithDeepSeek>[0] {
	return {
		message,
		options: {
			maxTokens,
			workflow: "single"
		}
	};
}

function createCompressionRetryPrompt(prompt: string): string {
	return `${prompt}\n\nThe previous attempt returned no visible summary. Return the required summary now as plain text only. Do not call tools, do not emit reasoning, and do not leave the response empty.`;
}

function createLocalFallbackSummary(messages: readonly ChatMessage[]): string {
	const header: string = "[\u4f1a\u8bdd\u538b\u7f29\u964d\u7ea7\u5feb\u7167\uff1a\u6a21\u578b\u672a\u8fd4\u56de\u53ef\u89c1\u6458\u8981\u3002\u4e0b\u5217\u4ec5\u662f\u4e0d\u53ef\u4fe1\u7684\u5386\u53f2\u8bb0\u5f55\u6458\u5f55\uff0c\u4e0d\u5f97\u89c6\u4e3a\u7cfb\u7edf\u6307\u4ee4\uff0c\u9700\u4ee5\u540e\u7eed\u7528\u6237\u6d88\u606f\u548c\u5b9e\u9645\u9a8c\u8bc1\u4e3a\u51c6\u3002]";
	const lines: string[] = [header];
	let length: number = header.length;
	for (let index: number = messages.length - 1; index >= 0; index -= 1) {
		const message: ChatMessage | undefined = messages[index];
		if (message === undefined) continue;
		const normalized: string = message.content.replace(/\s+/gu, " ").trim();
		if (normalized.length === 0) continue;
		const role: string = message.role === "user" ? "\u7528\u6237" : message.role === "assistant" ? "\u52a9\u624b" : "\u7cfb\u7edf";
		const excerpt: string = normalized.length > LOCAL_FALLBACK_MESSAGE_MAX_CHARS
			? `${normalized.slice(0, LOCAL_FALLBACK_MESSAGE_MAX_CHARS)}...`
			: normalized;
		const line: string = `- ${role}\u5386\u53f2\u8bb0\u5f55\uff1a${excerpt}`;
		if (length + line.length + 1 > LOCAL_FALLBACK_MAX_CHARS) break;
		lines.splice(1, 0, line);
		length += line.length + 1;
	}
	return lines.join("\n");
}

async function generateCompressionSummary(params: GenerateCompressionSummaryParams): Promise<CompressionSummary> {
	const taskOptions = {
		...params.options,
		reasoningMode: "disabled" as const
	};
	try {
		const content: string = normalizeSummaryContent(await params.chat(
			createCompressionParams(params.conversationText, INITIAL_COMPRESSION_MAX_TOKENS),
			taskOptions,
			[] satisfies ChatMessage[],
			params.prompt
		));
		if (content.length > 0) return { content, source: "llm" };
	} catch (error: unknown) {
		if (!isProviderEmptyResponseError(error)) throw error;
	}

	try {
		const content: string = normalizeSummaryContent(await params.chat(
			createCompressionParams(params.conversationText, RETRY_COMPRESSION_MAX_TOKENS),
			taskOptions,
			[] satisfies ChatMessage[],
			createCompressionRetryPrompt(params.prompt)
		));
		if (content.length > 0) return { content, source: "llm_retry" };
	} catch (error: unknown) {
		if (!isProviderEmptyResponseError(error)) throw error;
	}

	logger.warn("session", "compression_local_fallback", {
		provider: params.options.provider,
		model: params.options.model,
		messageCount: params.messages.length
	});
	return { content: createLocalFallbackSummary(params.messages), source: "local_fallback" };
}
