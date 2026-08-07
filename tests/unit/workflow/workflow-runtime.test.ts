import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { McpHost } from "../../../src/mcp/mcp-host.js";
import type { ProviderChatOptions } from "../../../src/providers/provider-types.js";
import { ProviderResponseStalledError } from "../../../src/providers/provider-resilience.js";
import { createClientSession } from "../../../src/server/client-session.js";
import { continueWorkflowExecution } from "../../../src/server/workflow/continuation.js";
import { hasProviderResponseStalledError, WorkflowExecutionError } from "../../../src/server/workflow/workflow-error.js";
import { createEmptyWorkflowPhaseToolStats } from "../../../src/server/workflow/tool-events.js";
import type { WorkflowPhase, WorkflowRunState } from "../../../src/workflow/types.js";

const PROVIDER_OPTIONS: ProviderChatOptions = {
	provider: "deepseek",
	apiKey: "test-key",
	model: "deepseek-v4-flash"
};

const FAKE_MCP_HOST: McpHost = {
	getConnectedServerIds: (): string[] => []
} as McpHost;

function createSummaryState(): WorkflowRunState {
	const phase: WorkflowPhase = {
		id: "summarize",
		title: "总结",
		toolGroup: "summarize",
		toolBudget: "simple",
		allowedTools: [],
		instruction: "基于已有事实回答用户。"
	};
	return {
		plan: { id: "workflow-runtime", title: "Runtime test", phases: [phase], todos: [] },
		phaseIndex: 0,
		phaseOutputs: [],
		originalParams: { message: "测试" },
		history: [],
		historyBudgetTokens: 100
	};
}

test("workflow runtime seam completes a phase without a live provider", async (): Promise<void> => {
	const session = createClientSession(undefined);
	let phaseCalls: number = 0;

	await continueWorkflowExecution(
		{ readyState: WebSocket.CLOSED } as WebSocket,
		"request-runtime",
		session,
		FAKE_MCP_HOST,
		PROVIDER_OPTIONS,
		createSummaryState(),
		new Date().toISOString(),
		undefined,
		"request-runtime",
		undefined,
		[],
		undefined,
		{
			createPhasePrompt: async (): Promise<string> => "fake prompt",
			runPhase: async () => {
				phaseCalls += 1;
				return {
					agentResult: { status: "completed", text: "完成" },
					toolStats: createEmptyWorkflowPhaseToolStats(),
					toolObservations: [],
					capturedAttachments: []
				};
			}
		}
	);

	assert.equal(phaseCalls, 1);
});

test("workflow runtime gracefully blocks a business failure and still runs summary", async (): Promise<void> => {
	const phases: WorkflowPhase[] = [
		{ id: "inspect", title: "Inspect", toolGroup: "read", toolBudget: "normal", allowedTools: ["mcp_workspace_read_text_file"], instruction: "Inspect" },
		{ id: "implement", title: "Implement", toolGroup: "write", toolBudget: "project_edit", allowedTools: ["mcp_workspace_replace_text_in_file"], instruction: "Implement" },
		{ id: "verify", title: "Verify", toolGroup: "verify", toolBudget: "normal", allowedTools: [], instruction: "Verify" },
		{ id: "summarize", title: "Summarize", toolGroup: "summarize", toolBudget: "simple", allowedTools: [], instruction: "Summarize" }
	];
	const state: WorkflowRunState = {
		plan: {
			id: "workflow-business-failure",
			title: "Business failure",
			phases,
			todos: phases.map((phase: WorkflowPhase) => ({ id: phase.id, phaseId: phase.id, text: phase.title, status: "pending" }))
		},
		phaseIndex: 0,
		phaseOutputs: [],
		originalParams: { message: "Connect a missing signal node" },
		history: [],
		historyBudgetTokens: 100
	};
	const session = createClientSession(undefined);
	const calledPhases: string[] = [];
	const sentPayloads: Array<Record<string, unknown>> = [];
	const socket = {
		readyState: WebSocket.OPEN,
		send: (payload: string): void => {
			sentPayloads.push(JSON.parse(payload) as Record<string, unknown>);
		}
	} as unknown as WebSocket;

	await continueWorkflowExecution(
		socket,
		"request-business-failure",
		session,
		FAKE_MCP_HOST,
		PROVIDER_OPTIONS,
		state,
		new Date().toISOString(),
		undefined,
		"request-business-failure",
		undefined,
		[],
		undefined,
		{
			createPhasePrompt: async (): Promise<string> => "fake prompt",
			runPhase: async (_socket, _params, _options, _history, _prompt, phase) => {
				calledPhases.push(phase.id);
				return phase.toolGroup === "summarize"
					? {
						agentResult: { status: "completed", text: "" },
					toolStats: createEmptyWorkflowPhaseToolStats(),
					toolObservations: [],
					capturedAttachments: []
				}
					: {
					agentResult: { status: "completed", text: "I will inspect the scene." },
					toolStats: createEmptyWorkflowPhaseToolStats(),
					toolObservations: [{
						toolCallId: "missing-node",
						toolName: "mcp_godot_connect_signal",
						risk: "read",
						status: "failed",
						artifactRefs: ["scenes/Main.tscn"],
						failure: {
							code: "signal_node_not_found",
							category: "business",
							message: "Signal source node Player does not exist.",
							retryable: true,
							artifactRefs: ["scenes/Main.tscn"]
						}
					}],
					capturedAttachments: []
				};
			}
		}
	);

	assert.deepEqual(calledPhases, ["inspect", "summarize"]);
	assert.equal(session.agentRuns.get("request-business-failure")?.terminal?.resultStatus, "blocked");
	const response = sentPayloads.find((payload: Record<string, unknown>): boolean => payload.type === "response");
	assert.equal(response?.ok, true);
	assert.match(String((response?.result as Record<string, unknown> | undefined)?.text ?? ""), /signal_node_not_found/);
});

test("workflow runtime seam never calls a provider after cancellation", async (): Promise<void> => {
	const controller: AbortController = new AbortController();
	controller.abort();
	let phaseCalls: number = 0;

	await assert.rejects(continueWorkflowExecution(
		{ readyState: WebSocket.CLOSED } as WebSocket,
		"request-cancelled",
		createClientSession(undefined),
		FAKE_MCP_HOST,
		PROVIDER_OPTIONS,
		createSummaryState(),
		new Date().toISOString(),
		undefined,
		"request-cancelled",
		controller.signal,
		[],
		undefined,
		{
			createPhasePrompt: async (): Promise<string> => "fake prompt",
			runPhase: async () => {
				phaseCalls += 1;
				throw new Error("must not run");
			}
		}
	));

	assert.equal(phaseCalls, 0);
});

test("workflow preserves a nested provider stall as a recoverable interruption", (): void => {
	const original = new ProviderResponseStalledError(new Error("silent stream"));
	const wrapped = new WorkflowExecutionError("Workflow phase failed", createSummaryState().plan, original);

	assert.equal(hasProviderResponseStalledError(wrapped), true);
	assert.equal(hasProviderResponseStalledError(new WorkflowExecutionError("ordinary failure", createSummaryState().plan, new Error("failed"))), false);
});
