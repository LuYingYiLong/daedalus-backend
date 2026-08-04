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
			{ executionControl: { lane: "probe", allowMutationEscalation: true, requireDecision: true } }
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
			{ executionControl: { lane: "probe", allowMutationEscalation: true, requireDecision: true } }
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

test("execution control upgrades oversized lightweight decisions to workflow", async (): Promise<void> => {
	const decisionJson: string = JSON.stringify({
		disposition: "use_lightweight",
		summary: "The inspected change spans multiple files.",
		evidenceToolCallIds: ["read-1"],
		expectedArtifacts: ["src/a.ts", "src/b.ts", "src/c.ts"],
		expectedLogicalWrites: 3
	});

	await assert.rejects(
		dispatchToolCalls(
			{} as McpHost,
			[controlToolCall(decisionJson)],
			1,
			{} as ApprovalGateway,
			undefined,
			undefined,
			{ executionControl: { lane: "probe", allowMutationEscalation: true, requireDecision: true } }
		),
		(error: unknown): boolean => (
			error instanceof ExecutionDecisionSignal
			&& error.decision.disposition === "use_workflow"
			&& error.decision.expectedLogicalWrites === undefined
		)
	);
});

test("read lanes require complete_read and only Agent-capable scopes may escalate mutation", async (): Promise<void> => {
	const completeReadJson: string = JSON.stringify({
		disposition: "complete_read",
		summary: "The disappearing line is caused by viewport-relative drawing.",
		evidenceToolCallIds: ["read-1"],
		expectedArtifacts: []
	});
	await assert.rejects(
		dispatchToolCalls(
			{} as McpHost,
			[controlToolCall(completeReadJson)],
			1,
			{} as ApprovalGateway,
			undefined,
			undefined,
			{ executionControl: { lane: "read", allowMutationEscalation: false, requireDecision: true } }
		),
		(error: unknown): boolean => error instanceof ExecutionDecisionSignal
			&& error.decision.disposition === "complete_read"
			&& error.decision.summary.includes("viewport")
	);

	const mutationJson: string = JSON.stringify({
		disposition: "use_lightweight",
		summary: "One bounded fix is needed.",
		evidenceToolCallIds: ["read-1"],
		expectedArtifacts: ["scripts/tech_tree.gd"],
		expectedLogicalWrites: 1
	});
	await assert.rejects(
		dispatchToolCalls(
			{} as McpHost,
			[controlToolCall(mutationJson)],
			1,
			{} as ApprovalGateway,
			undefined,
			undefined,
			{ executionControl: { lane: "read", allowMutationEscalation: true, requireDecision: true } }
		),
		(error: unknown): boolean => error instanceof ExecutionDecisionSignal
			&& error.decision.disposition === "use_lightweight"
			&& error.decision.expectedArtifacts.includes("scripts/tech_tree.gd")
	);
	await assert.rejects(
		dispatchToolCalls(
			{} as McpHost,
			[controlToolCall(mutationJson)],
			1,
			{} as ApprovalGateway,
			undefined,
			undefined,
			{ executionControl: { lane: "read", allowMutationEscalation: false, requireDecision: true } }
		),
		/Mutation escalation is not allowed/u
	);
});
