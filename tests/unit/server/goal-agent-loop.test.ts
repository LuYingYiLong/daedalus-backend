import assert from "node:assert/strict";
import test from "node:test";
import {
	createGoalContinuationPrompt,
	normalizeGoalAgentLoopParams
} from "../../../src/server/goal-controller.js";
import type { AiChatParams } from "../../../src/protocol/types.js";
import { createAgentGoalState } from "../../../src/workflow/agent-goal-state.js";
import { routeWorkflowExecution } from "../../../src/workflow/router.js";

test("Goal cycle normalization removes legacy workflow selection without changing safety preferences", (): void => {
	const params: AiChatParams = {
		message: "Refactor the project entry point.",
		mode: "goal",
		options: {
			workflow: "multi_phase",
			outputTarget: "chat",
			executionPolicy: "read_only",
			verificationPolicy: "skip",
			toolBudget: "project_edit"
		}
	};

	const normalized = normalizeGoalAgentLoopParams(params);

	assert.equal(normalized.mode, "agent");
	assert.equal(normalized.options?.workflow, undefined);
	assert.equal(normalized.options?.outputTarget, "workspace");
	assert.equal(normalized.options?.executionPolicy, "read_only");
	assert.equal(normalized.options?.verificationPolicy, "skip");
	assert.equal(normalized.options?.toolBudget, "project_edit");
	assert.equal(routeWorkflowExecution(normalized, { hasActiveWorkspace: true }).lane, "read");
});

test("workspace Goal cycles always choose the free Agent Loop after legacy workflow options are removed", (): void => {
	const normalized = normalizeGoalAgentLoopParams({
		message: "Build the requested feature.",
		mode: "goal",
		options: { workflow: "llm_planned", executionPolicy: "auto" }
	});

	const route = routeWorkflowExecution(normalized, { hasActiveWorkspace: true });
	assert.equal(route.lane, "agent_loop");
	assert.equal(route.outputTarget, "workspace");
});

test("Goal continuation preserves skip verification instead of adding a fixed verify stage", (): void => {
	const state = createAgentGoalState({
		sessionId: "session-goal-loop",
		rootRequestId: "request-goal-loop",
		title: "Update a workspace file",
		condition: "Update a workspace file",
		modelSnapshot: {
			provider: "deepseek",
			model: "deepseek-v4-flash",
			reasoningEffort: null,
			verificationPolicy: "skip",
			approvalMode: "auto-safe",
			workspaceId: "workspace-test"
		}
	});

	const prompt = createGoalContinuationPrompt(state, []);
	assert.match(prompt, /verificationPolicy=skip/);
	assert.match(prompt, /Choose the smallest useful next action yourself/);
	assert.doesNotMatch(prompt, /Verify changes after the final relevant write/);
});
