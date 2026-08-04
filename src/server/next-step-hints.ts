import { chatWithDeepSeek, type ProviderChatOptions } from "../providers/deepseek-client.js";
import { parseJsonObjectFromLlm } from "../providers/llm-json.js";
import type { ChatMessage } from "../protocol/types.js";
import { logger } from "../logger.js";
import type { ClientSession } from "./client-session.js";
import { clipTextByChars } from "./additional-context.js";
import { filterSessionLlmContextMessages } from "./transcript-history.js";

const DEFAULT_NEXT_STEP_HINT_COUNT: number = 3;
const MAX_NEXT_STEP_HINT_COUNT: number = 5;
const MAX_NEXT_STEP_HINT_MESSAGE_CHARS: number = 320;

export type NextStepHint = {
	title: string;
	message: string;
};

export function parseJsonObjectLoose(text: string): unknown {
	return parseJsonObjectFromLlm(text, "LLM did not return valid JSON");
}

export function normalizeNextStepHints(raw: unknown, maxHints: number): NextStepHint[] {
	const source: unknown = typeof raw === "object" && raw !== null && !Array.isArray(raw)
		? (raw as Record<string, unknown>).hints
		: raw;
	if (!Array.isArray(source)) {
		return [];
	}

	const hints: NextStepHint[] = [];
	for (const item of source) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			continue;
		}

		const record: Record<string, unknown> = item as Record<string, unknown>;
		const title: string = String(record.title ?? "").trim();
		const message: string = String(record.message ?? "").trim();
		const normalizedMessage: string = clipTextByChars(message.length > 0 ? message : title, MAX_NEXT_STEP_HINT_MESSAGE_CHARS);
		if (normalizedMessage.length === 0) {
			continue;
		}

		hints.push({
			title: clipTextByChars(title.length > 0 ? title : normalizedMessage, 48),
			message: normalizedMessage
		});
		if (hints.length >= maxHints) {
			break;
		}
	}

	return hints;
}

export function createNextStepHintPrompt(trigger: string, anchorRequestId: string | undefined): string {
	return [
		"你是 Godot Daedalus 的对话引导器。只生成下一步建议，不调用工具，不修改会话，不输出解释文本。",
		"输出必须是 JSON object，格式：{\"hints\":[{\"title\":\"短标题\",\"message\":\"可直接填入输入框的一句话\"}]}",
		"规则：",
		"- 生成 2 到 3 条。",
		"- message 必须短、具体、可直接作为用户下一轮消息。",
		"- 避免重复刚刚已经完成的动作。",
		"- 如果用户当前正在修改代码，优先建议验证、补测、总结或继续明确目标。",
		`- 触发点：${trigger || "done"}。`,
		anchorRequestId ? `- 锚点请求：${anchorRequestId}。` : ""
	].filter((line: string): boolean => line.length > 0).join("\n");
}

export async function createNextStepHints(
	session: ClientSession,
	options: ProviderChatOptions,
	maxHints: number,
	trigger: string,
	anchorRequestId: string | undefined,
	abortSignal?: AbortSignal | undefined
): Promise<NextStepHint[]> {
	const clippedMaxHints: number = Math.max(1, Math.min(MAX_NEXT_STEP_HINT_COUNT, Math.floor(maxHints)));
	const history: ChatMessage[] = filterSessionLlmContextMessages(session).slice(-8);
	const latestMessages: string = history
		.map((message: ChatMessage): string => `${message.role}: ${clipTextByChars(message.content, 1200)}`)
		.join("\n\n");
	const text: string = await chatWithDeepSeek(
		{
			message: [
				"请基于下面最近会话生成下一步提示。",
				"",
				"## 最近会话",
				latestMessages.length > 0 ? latestMessages : "暂无会话历史。"
			].join("\n"),
			options: {
				temperature: 0.35,
				maxTokens: 600,
				responseFormat: "json",
				workflow: "single"
			}
		},
		options,
		[],
		createNextStepHintPrompt(trigger, anchorRequestId),
		abortSignal
	);
	try {
		return normalizeNextStepHints(parseJsonObjectLoose(text), clippedMaxHints);
	} catch (error: unknown) {
		logger.warn("ai", "next_step_hints_parse_failed", {
			error: error instanceof Error ? error.message : String(error),
			responseChars: text.length
		});
		return [];
	}
}

export { DEFAULT_NEXT_STEP_HINT_COUNT, MAX_NEXT_STEP_HINT_COUNT };
