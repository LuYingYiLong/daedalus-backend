import assert from "node:assert/strict";
import test from "node:test";
import { createAgentGoalTelemetrySnapshot } from "../../../src/server/goal-controller.js";
import { createAgentGoalState } from "../../../src/workflow/agent-goal-state.js";

test("Goal telemetry sums linked provider usage without changing the persisted revision", (): void => {
	const state = createAgentGoalState({
		goalId: "goal-test",
		sessionId: "session-test",
		rootRequestId: "request-root",
		title: "Telemetry",
		condition: "Measure usage",
		modelSnapshot: {
			provider: "deepseek",
			model: "deepseek-v4-flash",
			reasoningEffort: "high",
			approvalMode: "auto-safe",
			workspaceId: "workspace-test"
		}
	});
	state.usage.tokens = 50;
	state.usage.activeMilliseconds = 2_000;
	const snapshot = createAgentGoalTelemetrySnapshot(state, ["request-root", "goal-cycle-2"], [
		{ requestId: "request-root", runId: "request-root", realTotalTokens: 120, usageSource: "provider" },
		{ requestId: "goal-cycle-2", runId: "goal-cycle-2", realTotalTokens: 80, usageSource: "estimated" },
		{ requestId: "unrelated", runId: "unrelated", realTotalTokens: 10_000, usageSource: "provider" }
	], 500);

	assert.equal(snapshot.usage.tokens, 250);
	assert.equal(snapshot.usage.activeMilliseconds, 2_500);
	assert.equal(snapshot.usage.estimatedTokens, true);
	assert.equal(snapshot.revision, state.revision);
	assert.equal(state.usage.tokens, 50);
});

test("Goal telemetry backfills a terminal Goal without double-counting persisted usage", (): void => {
	const state = createAgentGoalState({
		goalId: "goal-terminal",
		sessionId: "session-test",
		rootRequestId: "request-root",
		title: "Terminal telemetry",
		condition: "Measure completed usage",
		modelSnapshot: {
			provider: "deepseek",
			model: "deepseek-v4-flash",
			reasoningEffort: "high",
			approvalMode: "auto-safe",
			workspaceId: "workspace-test"
		}
	});
	state.usage.tokens = 180;
	const snapshot = createAgentGoalTelemetrySnapshot(state, ["request-root"], [
		{ requestId: "request-root", runId: "request-root", realTotalTokens: 200, usageSource: "provider" }
	], 0, "max");

	assert.equal(snapshot.usage.tokens, 200);
	state.usage.tokens = 240;
	const persistedSnapshot = createAgentGoalTelemetrySnapshot(state, ["request-root"], [
		{ requestId: "request-root", runId: "request-root", realTotalTokens: 200, usageSource: "provider" }
	], 0, "max");
	assert.equal(persistedSnapshot.usage.tokens, 240);
});
