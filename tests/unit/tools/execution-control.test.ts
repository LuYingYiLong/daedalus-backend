import assert from "node:assert/strict";
import test from "node:test";
import type { ChatCompletionMessageToolCall } from "openai/resources/chat/completions";
import type { McpHost } from "../../../src/mcp/mcp-host.js";
import {
	EXECUTION_CONTROL_TOOL_NAME,
	ExecutionDecisionSignal
} from "../../../src/tools/execution-control.js";
import { dispatchToolCalls } from "../../../src/tools/tool-dispatcher.js";
import type { ApprovalGateway } from "../../../src/tools/approval-gateway.js";

function controlToolCall(argumentsJson: string): ChatCompletionMessageToolCall {
	return {
		id: "control-1",
		type: "function",
		function: {
			name: EXECUTION_CONTROL_TOOL_NAME,
			arguments: argumentsJson
		}
	};
}

test("execution decisions are isolated control calls and return structured signals", async (): Promise<void> => {
	const decisionJson: string = JSON.stringify({
		disposition: "use_lightweight",
		summary: "One bounded edit is required.",
		evidenceToolCallIds: ["read-1"],
		expectedArtifacts: [".gitignore"],
		expectedLogicalWrites: 1
	});
	await assert.rejects(
		dispatchToolCalls(
			{} as McpHost,
			[controlToolCall(decisionJson)],
			1,
			{} as ApprovalGateway,
			undefined,
			undefined,
			{ executionControl: { lane: "probe" } }
		),
		(error: unknown): boolean => (
			error instanceof ExecutionDecisionSignal
			&& error.decision.disposition === "use_lightweight"
			&& error.decision.expectedLogicalWrites === 1
		)
	);

	await assert.rejects(
		dispatchToolCalls(
			{} as McpHost,
			[
				controlToolCall(decisionJson),
				{
					id: "read-1",
					type: "function",
					function: {
						name: "mcp_workspace_read_text_file",
						arguments: "{\"relativePath\":\".gitignore\"}"
					}
				}
			],
			1,
			{} as ApprovalGateway,
			undefined,
			undefined,
			{ executionControl: { lane: "probe" } }
		),
		/cannot be mixed/u
	);

	await assert.rejects(
		dispatchToolCalls(
			{} as McpHost,
			[controlToolCall(decisionJson)],
			1,
			{} as ApprovalGateway
		),
		/not available/u
	);
});
