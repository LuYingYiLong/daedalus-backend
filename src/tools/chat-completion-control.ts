import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { z } from "zod";

export const CHAT_COMPLETION_CONTROL_TOOL_NAME = "daedalus_submit_chat_answer";

export type ChatCompletionContext = {
	requireSubmission: boolean;
};

export type ChatAnswer = {
	answer: string;
};

const chatAnswerSchema = z.object({
	answer: z.string().trim().min(1).max(32000)
}).strict();

export const CHAT_COMPLETION_CONTROL_TOOL_DEFINITION: ChatCompletionTool = {
	type: "function",
	function: {
		name: CHAT_COMPLETION_CONTROL_TOOL_NAME,
		description: "Submit the final user-facing answer for this chat turn. This is an internal completion signal, not a workspace operation. Call it exactly once when the answer is complete. You may call read or verify tools before it, but never combine this tool with another tool in the same assistant response. For a general question, call it directly with the complete answer. Do not submit a progress announcement or a plan to read later.",
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["answer"],
			properties: {
				answer: {
					type: "string",
					minLength: 1,
					maxLength: 32000,
					description: "The complete answer shown to the user. It must contain the conclusion, not a progress update."
				}
			}
		}
	}
};

export class ChatAnswerSignal extends Error {
	readonly answer: ChatAnswer;

	constructor(answer: ChatAnswer) {
		super("Structured chat answer submitted.");
		this.name = "ChatAnswerSignal";
		this.answer = answer;
	}
}

export function parseChatAnswer(value: unknown): ChatAnswer {
	return chatAnswerSchema.parse(value);
}
