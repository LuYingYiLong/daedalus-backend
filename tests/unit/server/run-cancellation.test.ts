import assert from "node:assert/strict";
import test from "node:test";
import { createClientSession } from "../../../src/server/client-session.js";
import {
	findCancellableAgentRun,
	resolveCancellationTargetRequestId,
	shouldTerminalizeReturnedAgentRun
} from "../../../src/server/run-cancellation.js";
import { createAgentRunState, transitionAgentRunState } from "../../../src/workflow/agent-run-state.js";

test("cancellation targets a live controller before a Goal child run", (): void => {
	assert.equal(resolveCancellationTargetRequestId({
		requestedRequestId: "root-request",
		requestWithController: "controller-request",
		activeSessionRequestId: "session-request",
		activeGoalRunId: "goal-cycle-request",
		activeRuntimeRequestId: "runtime-request"
	}), "controller-request");
});

test("cancellation falls back to the active Goal child when runtime controllers are gone", (): void => {
	assert.equal(resolveCancellationTargetRequestId({
		requestedRequestId: "root-request",
		activeGoalRunId: "goal-cycle-request"
	}), "goal-cycle-request");
});

test("a returned active run must be terminalized while legitimate pauses remain resumable", (): void => {
	const initial = createAgentRunState({ sessionId: "session-test", requestId: "run-test" });
	const probing = transitionAgentRunState(initial, "probing");
	const awaitingApproval = transitionAgentRunState(probing, "awaiting_approval", {
		pause: {
			kind: "approval",
			id: "approval-test",
			toolName: "mcp_test",
			reason: "approval_required"
		}
	});
	assert.equal(shouldTerminalizeReturnedAgentRun(probing), true);
	assert.equal(shouldTerminalizeReturnedAgentRun(awaitingApproval), false);
});

test("hard cancellation resolves an in-memory Goal child through its root request", async (): Promise<void> => {
	const session = createClientSession(undefined);
	session.sessionId = "session-test";
	const initial = createAgentRunState({
		sessionId: "session-test",
		requestId: "goal-cycle-request",
		rootRequestId: "root-request",
		runId: "goal-cycle-request",
		goalId: "goal-test",
		goalCycle: 2
	});
	const probing = transitionAgentRunState(initial, "probing");
	session.agentRuns.set(probing.runId, probing);

	const resolved = await findCancellableAgentRun(session, ["root-request"]);
	assert.equal(resolved?.runId, "goal-cycle-request");
});
