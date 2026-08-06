import assert from "node:assert/strict";
import test from "node:test";
import type { ChatCompletionMessageToolCall } from "openai/resources/chat/completions";
import type { McpHost } from "../../../src/mcp/mcp-host.js";
import {
	CHAT_COMPLETION_CONTROL_TOOL_NAME,
	ChatAnswerSignal
} from "../../../src/tools/chat-completion-control.js";
import { dispatchToolCalls } from "../../../src/tools/tool-dispatcher.js";
import type { ApprovalGateway } from "../../../src/tools/approval-gateway.js";

function chatAnswerToolCall(argumentsJson: string): ChatCompletionMessageToolCall {
	return {
		id: "chat-answer-1",
		type: "function",
		function: {
			name: CHAT_COMPLETION_CONTROL_TOOL_NAME,
			arguments: argumentsJson
		}
	};
}

test("structured chat completion is isolated and carries only the final answer", async (): Promise<void> => {
	await assert.rejects(
		dispatchToolCalls(
			{} as McpHost,
			[chatAnswerToolCall(JSON.stringify({ answer: "npm 是 Node.js 的包管理器。" }))],
			1,
			{} as ApprovalGateway,
			undefined,
			undefined,
			{ chatCompletion: { requireSubmission: true } }
		),
		(error: unknown): boolean => error instanceof ChatAnswerSignal
			&& error.answer.answer === "npm 是 Node.js 的包管理器。"
	);

	await assert.rejects(
		dispatchToolCalls(
			{} as McpHost,
			[
				chatAnswerToolCall(JSON.stringify({ answer: "done" })),
				{
					id: "read-1",
					type: "function",
					function: {
						name: "mcp_workspace_read_text_file",
						arguments: "{\"relativePath\":\"README.md\"}"
					}
				}
			],
			1,
			{} as ApprovalGateway,
			undefined,
			undefined,
			{ chatCompletion: { requireSubmission: true } }
		),
		/cannot be mixed/u
	);

	await assert.rejects(
		dispatchToolCalls(
			{} as McpHost,
			[chatAnswerToolCall(JSON.stringify({ answer: "   " }))],
			1,
			{} as ApprovalGateway,
			undefined,
			undefined,
			{ chatCompletion: { requireSubmission: true } }
		),
		/Too small/u
	);
});

test("structured chat completion is unavailable outside the dedicated chat lane", async (): Promise<void> => {
	await assert.rejects(
		dispatchToolCalls(
			{} as McpHost,
			[chatAnswerToolCall(JSON.stringify({ answer: "answer" }))],
			1,
			{} as ApprovalGateway
		),
		/not available/u
	);
});
