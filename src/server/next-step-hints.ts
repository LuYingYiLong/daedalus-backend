import { parseJsonObjectFromLlm } from "../providers/llm-json.js";
import { chatWithProvider } from "../providers/provider-chat.js";
import type { ProviderChatOptions } from "../providers/provider-types.js";
import { resolveProviderTaskModelOptions } from "../providers/task-model-routing.js";
import type { ChatMessage } from "../protocol/types.js";
import { logger } from "../logger.js";
import type { ClientSession } from "./client-session.js";
import { clipTextByChars } from "./additional-context.js";
import { filterSessionLlmContextMessages } from "./transcript-history.js";

const DEFAULT_NEXT_STEP_HINT_COUNT: number = 3;
const MAX_NEXT_STEP_HINT_COUNT: number = 5;
const MAX_NEXT_STEP_HINT_MESSAGE_CHARS: number = 220;

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

export function createNextStepHintPrompt(
	trigger: string,
	anchorRequestId: string | undefined,
	maxHints: number = 1
): string {
	const hintLimit: number = Math.max(1, Math.min(MAX_NEXT_STEP_HINT_COUNT, Math.floor(maxHints)));
	return [
		`Generate up to ${hintLimit} concise, useful next-step suggestion${hintLimit === 1 ? "" : "s"} for the user. These texts are shown only as empty composer placeholders.`,
		"Return exactly one JSON object: {\"hints\":[{\"title\":\"short label\",\"message\":\"a natural next user message\"}]}. Return {\"hints\":[]} when no honest suggestion is useful.",
		"Rules:",
		"- Do not call tools, alter the conversation, explain your reasoning, or claim work was completed.",
		"- Follow the language used by the latest user message.",
		"- The message must be concrete, optional, and suitable for the user to send verbatim.",
		"- Do not repeat the just-completed request or invent an unfinished task.",
		"- Prefer a focused follow-up, verification, comparison, or next decision when it genuinely helps.",
		`- Trigger: ${trigger || "done"}.`,
		anchorRequestId === undefined ? "" : `- Anchor request: ${anchorRequestId}.`
	].filter((line: string): boolean => line.length > 0).join("\n");
}

export async function resolveNextStepHintOptions(currentOptions: ProviderChatOptions): Promise<ProviderChatOptions> {
	try {
		const routed = await resolveProviderTaskModelOptions("nextStepHints", currentOptions);
		return {
			...routed.options,
			usageContext: currentOptions.usageContext,
			reasoningMode: "disabled"
		};
	} catch (error: unknown) {
		logger.warn("ai", "next_step_hints_task_model_fallback", {
			message: error instanceof Error ? error.message : String(error)
		});
		return {
			...currentOptions,
			reasoningMode: "disabled"
		};
	}
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
	const text: string = await chatWithProvider(
		{
			message: [
				"Generate a next-step suggestion from this recent conversation.",
				"",
				"## Recent conversation",
				latestMessages.length > 0 ? latestMessages : "No conversation history is available."
			].join("\n"),
			options: {
				temperature: 0.2,
				maxTokens: 220,
				responseFormat: "json"
			}
		},
		options,
		[] satisfies ChatMessage[],
		createNextStepHintPrompt(trigger, anchorRequestId, clippedMaxHints),
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
