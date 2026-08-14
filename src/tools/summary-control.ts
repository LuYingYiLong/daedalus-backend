import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { z } from "zod";

export const SUMMARY_PREPARATION_RESULT_MARKER = "[[daedalus_summary_preparation]]";
export const SUMMARY_PREPARATION_TOOL_NAME = "daedalus_prepare_summary";

export type SummaryPreparationInput = Record<string, never>;

export type SummaryPreparationContext = {
	execute(input: SummaryPreparationInput): Promise<Record<string, unknown>>;
};

const summaryPreparationInputSchema = z.object({}).strict();

export const SUMMARY_PREPARATION_TOOL_DEFINITION: ChatCompletionTool = {
	type: "function",
	function: {
		name: SUMMARY_PREPARATION_TOOL_NAME,
		description: "Run the final pre-summary checkpoint for the free Agent Loop. Call this only when useful work and proportionate verification are complete and you are ready to write the final user-facing summary; do not call it during planning or progress updates. It checks unfinished Todo items and unresolved tool failures, then tells you whether to summarize or continue the Agent Loop.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {}
		}
	}
};

export function parseSummaryPreparationInput(value: unknown): SummaryPreparationInput {
	return summaryPreparationInputSchema.parse(value);
}

export function serializeSummaryPreparationResult(result: Record<string, unknown>): string {
	return `${SUMMARY_PREPARATION_RESULT_MARKER}\n${JSON.stringify(result)}`;
}

export function isSummaryPreparationResult(content: string): boolean {
	return content.startsWith(SUMMARY_PREPARATION_RESULT_MARKER);
}
