import type { AiChatParams, ChatMessage } from "../protocol/types.js";
import { chatWithProvider } from "../providers/provider-chat.js";
import type { ProviderChatOptions } from "../providers/provider-types.js";

const TITLE_MAX_CHARS: number = 28;
const TITLE_INITIAL_MAX_TOKENS: number = 40;
const TITLE_RETRY_MAX_TOKENS: number = 64;

function clipText(text: string, maxChars: number): string {
	const normalized: string = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxChars) {
		return normalized;
	}

	return normalized.slice(0, maxChars);
}

export function shouldApplyGeneratedSessionTitle(originalTitle: string | undefined, currentTitle: string | undefined): boolean {
	return (currentTitle ?? "").trim() === (originalTitle ?? "").trim();
}

export function isFirstSessionUserTurn(messages: readonly ChatMessage[], requestId: string): boolean {
	return !messages.some((message: ChatMessage): boolean => (
		message.role === "user" && message.requestId !== requestId
	));
}

export function normalizeGeneratedSessionTitle(rawTitle: string): string {
	let title: string = rawTitle
		.replace(/^[\s"'“”‘’`]+|[\s"'“”‘’`]+$/g, "")
		.replace(/^标题[:：]\s*/i, "")
		.replace(/\s+/g, " ")
		.trim();
	const newlineIndex: number = title.indexOf("\n");
	if (newlineIndex >= 0) {
		title = title.slice(0, newlineIndex).trim();
	}
	title = title.replace(/[。.!！?？]+$/g, "").trim();
	return clipText(title, TITLE_MAX_CHARS);
}

export function createFallbackSessionTitle(userMessage: string): string {
	const normalized: string = userMessage
		.replace(/\s+/g, " ")
		.replace(/^\/[a-zA-Z0-9_-]+\s*/, "")
		.trim();
	if (normalized.length === 0) {
		return "Untitled";
	}

	return clipText(normalized, TITLE_MAX_CHARS);
}

function isEmptyLlmResponseError(error: unknown): boolean {
	return error instanceof Error && error.message === "LLM returned empty response";
}

function createTitlePrompt(retryAfterEmptyResponse: boolean): string {
	const lines: string[] = [
		"你是 Godot Daedalus 的会话命名器。请只输出一个简短会话名，不要解释，不要加引号。",
		"要求：",
		"- 6 到 14 个中文字符，或 2 到 5 个英文单词。",
		"- 准确概括用户目标，不要使用泛称。",
		"- 不要直接复述完整用户输入，优先提炼成名词短语。",
		"- 不要包含标点、编号或表情。",
		"- 可见输出必须是最终标题本身。"
	];
	if (retryAfterEmptyResponse) {
		lines.push("- 上一次响应只产生了隐藏 reasoning，没有可见标题；这次请直接输出标题。");
	}
	return lines.join("\n");
}

function createTitleParams(userMessage: string, maxTokens: number): AiChatParams {
	return {
		message: [
			"请为下面用户刚发送的第一条消息生成会话名。",
			"",
			"用户：",
			clipText(userMessage, 1200)
		].join("\n"),
		options: {
			temperature: 0.2,
			maxTokens,
			workflow: "single"
		}
	};
}

function createTitleOptions(options: ProviderChatOptions): ProviderChatOptions {
	return {
		...options,
		// 标题是短文本分类任务；推理会抢占极小的输出预算并造成空标题。
		reasoningMode: "disabled"
	};
}

export async function generateSessionTitle(
	userMessage: string,
	options: ProviderChatOptions,
	abortSignal?: AbortSignal | undefined
): Promise<string> {
	const titleOptions: ProviderChatOptions = createTitleOptions(options);
	let text: string;
	try {
		text = await chatWithProvider(
			createTitleParams(userMessage, TITLE_INITIAL_MAX_TOKENS),
			titleOptions,
			[] satisfies ChatMessage[],
			createTitlePrompt(false),
			abortSignal
		);
	} catch (error: unknown) {
		if (!isEmptyLlmResponseError(error)) {
			throw error;
		}

		try {
			text = await chatWithProvider(
				createTitleParams(userMessage, TITLE_RETRY_MAX_TOKENS),
				titleOptions,
				[] satisfies ChatMessage[],
				createTitlePrompt(true),
				abortSignal
			);
		} catch (retryError: unknown) {
			if (!isEmptyLlmResponseError(retryError)) {
				throw retryError;
			}

			return createFallbackSessionTitle(userMessage);
		}
	}
	const title: string = normalizeGeneratedSessionTitle(text);
	return title.length > 0 ? title : createFallbackSessionTitle(userMessage);
}
