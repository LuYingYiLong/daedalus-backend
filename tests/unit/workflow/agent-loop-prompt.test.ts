import assert from "node:assert/strict";
import test from "node:test";
import {
	createHiddenAnswerChatParams,
	createHiddenAnswerSystemPrompt
} from "../../../src/server/chat-orchestrator.js";
import type { WorkflowRouteDecision } from "../../../src/workflow/router.js";

const workspaceAgentLoop: WorkflowRouteDecision = {
	intent: "answer",
	scope: "unknown",
	lane: "agent_loop",
	outputTarget: "workspace",
	reason: "test",
	planningHint: ""
};

test("agent loop defaults workspace edits to the project-edit budget", (): void => {
	const defaultParams = createHiddenAnswerChatParams({ message: "task", mode: "agent" }, workspaceAgentLoop);
	assert.equal(defaultParams.options?.toolBudget, "project_edit");
	const explicitParams = createHiddenAnswerChatParams({
		message: "task",
		mode: "agent",
		options: { toolBudget: "normal" }
	}, workspaceAgentLoop);
	assert.equal(explicitParams.options?.toolBudget, "normal");
});

test("agent loop prompt grants sequencing freedom without mandatory stage controls", (): void => {
	const prompt: string = createHiddenAnswerSystemPrompt("BASE", workspaceAgentLoop, "best_effort");
	assert.match(prompt, /Daedalus free Agent Loop/u);
	assert.match(prompt, /There are no fixed inspect, implement, verify, or summarize phases/u);
	assert.match(prompt, /begin with 1-3 visible sentences/u);
	assert.match(prompt, /more than three meaningful steps/u);
	assert.match(prompt, /daedalus_update_todo_list/u);
	assert.match(prompt, /Todo is optional display metadata/u);
	assert.match(prompt, /Do not ask the user to extend an internal tool-count budget/u);
	assert.match(prompt, /agent_loop_no_progress_detected/u);
	assert.match(prompt, /agent_loop_safety_limit_reached/u);
	assert.match(prompt, /Ordinary visible assistant text may complete the turn/u);
	assert.doesNotMatch(prompt, /must finish by calling daedalus_report_execution_decision/u);
	assert.doesNotMatch(prompt, /only complete the current phase/iu);
});

test("verification policy changes quality guidance without creating a repair phase", (): void => {
	const skipPrompt: string = createHiddenAnswerSystemPrompt("BASE", workspaceAgentLoop, "skip");
	const requiredPrompt: string = createHiddenAnswerSystemPrompt("BASE", workspaceAgentLoop, "required");
	assert.match(skipPrompt, /Do not run validation solely to satisfy a framework rule/u);
	assert.match(requiredPrompt, /Run proportionate available validation/u);
	assert.match(requiredPrompt, /do not create an automatic repair phase/u);
});
