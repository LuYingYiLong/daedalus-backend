import assert from "node:assert/strict";
import test from "node:test";
import {
	resolveGoalPostEvaluationAction,
	resolveGoalTerminalRunDisposition
} from "../../../src/server/goal-controller.js";
import { createAgentGoalState, type AgentGoalState, type GoalEvaluation } from "../../../src/workflow/agent-goal-state.js";

function createGoalState(): AgentGoalState {
	return createAgentGoalState({
		sessionId: "session-goal-auto-continue",
		rootRequestId: "request-goal-auto-continue",
		title: "Complete the requested change",
		condition: "Complete the requested change",
		modelSnapshot: {
			provider: "deepseek",
			model: "deepseek-v4-flash",
			reasoningEffort: null,
			approvalMode: "auto-safe",
			workspaceId: "workspace-test"
		}
	});
}

function createEvaluation(disposition: GoalEvaluation["disposition"]): GoalEvaluation {
	return {
		disposition,
		summary: "Evaluation summary",
		evidenceToolCallIds: [],
		unmetCriteria: disposition === "continue" ? ["More work remains."] : [],
		nextAction: disposition === "continue" ? "Continue the implementation." : null
	};
}

test("a failed Goal run cannot be hidden by a pending pause request", (): void => {
	assert.equal(resolveGoalTerminalRunDisposition("pausing", "failed"), "fail");
});

test("an explicitly cancelled Goal run completes the pause request", (): void => {
	assert.equal(resolveGoalTerminalRunDisposition("pausing", "cancelled"), "pause");
});

test("a successful Goal run pauses at the requested safe boundary", (): void => {
	assert.equal(resolveGoalTerminalRunDisposition("pausing", "completed"), "pause");
});

test("an unexpected cancellation fails instead of becoming resumable", (): void => {
	assert.equal(resolveGoalTerminalRunDisposition("running", "cancelled"), "fail");
});

test("a Goal evaluation automatically continues while every budget has capacity", (): void => {
	const state = createGoalState();
	state.usage = { cycles: 1, tokens: 12_000, activeMilliseconds: 30_000, estimatedTokens: false };
	assert.equal(resolveGoalPostEvaluationAction(state, createEvaluation("continue"), false), "continue");
});

test("a Goal pauses only when a configured budget boundary is exhausted", (): void => {
	for (const usage of [
		{ cycles: 12, tokens: 12_000, activeMilliseconds: 30_000 },
		{ cycles: 1, tokens: 1_000_000, activeMilliseconds: 30_000 },
		{ cycles: 1, tokens: 12_000, activeMilliseconds: 180 * 60_000 }
	]) {
		const state = createGoalState();
		state.usage = { ...usage, estimatedTokens: false };
		assert.equal(resolveGoalPostEvaluationAction(state, createEvaluation("continue"), false), "pause_budget_exhausted");
	}
});

test("Goal completion, blocking, and no-progress decisions stop automatic continuation", (): void => {
	const state = createGoalState();
	assert.equal(resolveGoalPostEvaluationAction(state, createEvaluation("achieved"), true), "achieve");
	assert.equal(resolveGoalPostEvaluationAction(state, createEvaluation("blocked"), false), "pause_blocked");
	assert.equal(resolveGoalPostEvaluationAction(state, createEvaluation("continue"), true), "pause_no_progress");
});
