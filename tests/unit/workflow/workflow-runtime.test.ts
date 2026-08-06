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
