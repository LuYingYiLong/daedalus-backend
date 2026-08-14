import assert from "node:assert/strict";
import test from "node:test";
import { createAgentRunState, type AgentRunState } from "../../../src/workflow/agent-run-state.js";
import { evaluateSummaryPreparation } from "../../../src/server/summary-preparation-runtime.js";

function createRun(): AgentRunState {
	const run: AgentRunState = createAgentRunState({
		sessionId: "session-summary",
		requestId: "request-summary",
		lane: "agent_loop",
		scope: "complex"
	});
	run.stage = "executing";
	return run;
}

test("summary preparation is ready after completed Agent Loop work", (): void => {
	const run: AgentRunState = createRun();
	run.todo = {
		workflowId: "agent-loop:run",
		title: "Implement feature",
		source: "agent_loop",
		revision: 1,
		phases: [{ id: "edit", title: "Edit the feature", status: "done" }],
		todos: [{ id: "edit", phaseId: "edit", text: "Edit the feature", status: "done" }]
	};
	run.checkpoint.evidence.push({
		toolCallId: "verify-1",
		toolName: "mcp_terminal_run_safe_preset",
		risk: "verify",
		status: "succeeded",
		artifactRefs: [],
		validationStatus: "passed",
		observedAt: new Date().toISOString()
	});

	const result = evaluateSummaryPreparation(run);
	assert.equal(result.ready, true);
	assert.deepEqual(result.remainingTodoItems, []);
	assert.deepEqual(result.unresolvedFailures, []);
});

test("summary preparation asks the Agent Loop to continue when Todo or failures remain", (): void => {
	const run: AgentRunState = createRun();
	run.todo = {
		workflowId: "agent-loop:run",
		title: "Implement feature",
		source: "agent_loop",
		revision: 1,
		phases: [{ id: "edit", title: "Edit the feature", status: "pending" }],
		todos: [{ id: "edit", phaseId: "edit", text: "Edit the feature", status: "pending" }]
	};
	run.checkpoint.evidence.push({
		toolCallId: "read-1",
		toolName: "mcp_workspace_read_text_file",
		risk: "read",
		status: "failed",
		artifactRefs: [],
		summary: "Target was not found",
		failure: {
			code: "target_not_found",
			category: "business",
			message: "Target was not found",
			retryable: false,
			artifactRefs: []
		},
		observedAt: new Date().toISOString()
	});

	const result = evaluateSummaryPreparation(run);
	assert.equal(result.ready, false);
	assert.deepEqual(result.remainingTodoItems, ["Edit the feature"]);
	assert.deepEqual(result.unresolvedFailures, ["[target_not_found] Target was not found"]);
	assert.match(result.warnings.join("\n"), /Unresolved tool failures/u);
});
