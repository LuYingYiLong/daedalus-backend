import assert from "node:assert/strict";
import test from "node:test";
import {
	createAgentGoalState,
	transitionAgentGoalState
} from "../../../src/workflow/agent-goal-state.js";

function createGoal() {
	return createAgentGoalState({
		goalId: "goal-test",
		sessionId: "session-test",
		rootRequestId: "request-test",
		title: "  Finish the implementation  ",
		condition: "Finish the implementation and verify it",
		modelSnapshot: {
			provider: "deepseek",
			model: "deepseek-v4-pro",
			reasoningEffort: "high",
			approvalMode: "manual",
			workspaceId: "workspace-test"
		},
		now: "2026-08-01T00:00:00.000Z"
	});
}

test("agent goal defaults, revisions and terminal stages are stable", (): void => {
	const initial = createGoal();
	assert.equal(initial.title, "Finish the implementation");
	assert.deepEqual(initial.budget, { maxCycles: 6, maxTokens: 200_000, maxActiveMinutes: 60 });
	assert.equal(initial.stage, "readiness");

	const running = transitionAgentGoalState(initial, "running", {
		cycle: 1,
		activeRunId: "request-test",
		usage: { ...initial.usage, cycles: 1 }
	}, "2026-08-01T00:00:01.000Z");
	const evaluating = transitionAgentGoalState(running, "evaluating", {
		activeRunId: null
	}, "2026-08-01T00:00:02.000Z");
	const achieved = transitionAgentGoalState(evaluating, "achieved", {}, "2026-08-01T00:00:03.000Z");

	assert.equal(achieved.revision, 4);
	assert.equal(achieved.completedAt, "2026-08-01T00:00:03.000Z");
	assert.throws(() => transitionAgentGoalState(achieved, "cancelled"), /already terminal/u);

	const rolledBack = transitionAgentGoalState(achieved, "achieved", {
		checkpoint: { ...achieved.checkpoint, status: "rolled_back" }
	}, "2026-08-01T00:00:04.000Z");
	assert.equal(rolledBack.revision, 5);
	assert.equal(rolledBack.completedAt, achieved.completedAt);
	assert.equal(rolledBack.checkpoint.status, "rolled_back");
});

test("agent goal rejects illegal lane changes and supports a readiness recheck", (): void => {
	const initial = createGoal();
	assert.throws(() => transitionAgentGoalState(initial, "achieved"), /Illegal agent goal transition/u);
	const paused = transitionAgentGoalState(initial, "paused", { pauseReason: "readiness_blocked" });
	const resumed = transitionAgentGoalState(paused, "readiness", { pauseReason: null });
	assert.equal(resumed.stage, "readiness");
	assert.equal(resumed.pauseReason, null);
});
