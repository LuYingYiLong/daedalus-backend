import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { z } from "zod";

export const AGENT_ASK_USER_TOOL_NAME = "daedalus_ask_user";

const choiceSchema = z.object({
	label: z.string().trim().min(1).max(80),
	text: z.string().trim().min(1).max(1000),
	description: z.string().trim().max(240).optional()
}).strict();

export const agentQuestionSchema = z.object({
	title: z.string().trim().min(1).max(160),
	question: z.string().trim().min(1).max(2000),
	choices: z.array(choiceSchema).max(5).default([])
}).strict();

export type AgentQuestionInput = z.infer<typeof agentQuestionSchema>;
export type AgentQuestionAnswer = { questionId: string; question: string; answer: string };

export type AgentClarificationContext = {
	execute: (input: AgentQuestionInput, toolCallId: string) => Promise<{ questionId: string; status: "pending" }>;
	takeAnswers: () => Promise<AgentQuestionAnswer[]>;
	commitAnswers: () => Promise<void>;
};

export const AGENT_ASK_USER_TOOL_DEFINITION: ChatCompletionTool = {
	type: "function",
	function: {
		name: AGENT_ASK_USER_TOOL_NAME,
		description: "Ask the current user one concrete question when a material ambiguity or a required local action cannot be resolved autonomously. This does not pause the Agent: continue independent work. Do not use it to request routine confirmation or permission. A user answer, if received, will arrive as later user guidance. Never assume an unanswered option was selected.",
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["title", "question"],
			properties: {
				title: { type: "string", minLength: 1, maxLength: 160 },
				question: { type: "string", minLength: 1, maxLength: 2000 },
				choices: {
					type: "array", maxItems: 5,
					items: {
						type: "object", additionalProperties: false, required: ["label", "text"],
						properties: {
							label: { type: "string", minLength: 1, maxLength: 80 },
							text: { type: "string", minLength: 1, maxLength: 1000 },
							description: { type: "string", maxLength: 240 }
						}
					}
				}
			}
		}
	}
};
