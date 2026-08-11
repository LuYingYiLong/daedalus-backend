import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
	AUTONOMOUS_AGENT_TOOL_HARD_LIMIT,
	createToolBudgetRequiredResult,
	getContinuedMaxSteps,
	getContinuationMaxSteps,
	getContinuedToolResultCharLimit,
	getInitialMaxToolSteps,
	shouldPauseForToolBudget
} from "../../../src/providers/agent-tool-budget.js";
import type { ChatCompletionsAgentContinuation } from "../../../src/providers/agent-types.js";
import { MAX_TOTAL_TOOL_RESULT_CHARS, TOOL_BUDGET_CONTINUE_STEPS, TOOL_RESULT_CONTINUE_CHARS, resolveToolBudget } from "../../../src/tools/llm-tool-budget.js";

test("tool budgets leave enough room for project-scale runs", (): void => {
	assert.equal(resolveToolBudget("simple"), 10);
	assert.equal(resolveToolBudget("normal"), 20);
	assert.equal(resolveToolBudget("codegen"), 32);
	assert.equal(resolveToolBudget("project_edit"), 48);
	assert.equal(MAX_TOTAL_TOOL_RESULT_CHARS, 128000);
});

test("legacy lanes preserve budget pauses while Agent Loop runs to a background safety limit", async (): Promise<void> => {
	assert.equal(shouldPauseForToolBudget(), true);
	assert.equal(shouldPauseForToolBudget(true), false);
	assert.equal(getInitialMaxToolSteps({ message: "long task", options: { toolBudget: "project_edit" } }, true), AUTONOMOUS_AGENT_TOOL_HARD_LIMIT);
	assert.equal(getContinuationMaxSteps({ message: "continue" }, {
		kind: "chat_completions",
		messages: [],
		nextStep: 48,
		totalToolResultChars: 0,
		maxSteps: 48
	}, true), AUTONOMOUS_AGENT_TOOL_HARD_LIMIT);

	for (const path of [
		"../../../src/providers/openai-compatible-agent.ts",
		"../../../src/providers/openai-responses-agent.ts",
		"../../../src/providers/anthropic-compatible-agent.ts"
	]) {
		const source: string = await readFile(new URL(path, import.meta.url), "utf8");
		assert.equal(source.includes("shouldPauseForToolBudget(toolContext?.agentLoopRecovery !== undefined)"), true);
		assert.equal(source.includes("return createToolBudgetRequiredResult({"), true);
	}
});

test("tool budget continuation grants the configured extra step and char budget", (): void => {
	const continuation: ChatCompletionsAgentContinuation = {
		kind: "chat_completions",
		messages: [],
		nextStep: 12,
		totalToolResultChars: 46000,
		maxSteps: 12,
		toolResultCharLimit: MAX_TOTAL_TOOL_RESULT_CHARS
	};

	const result = createToolBudgetRequiredResult({
		limitKind: "steps",
		reason: "工具调用达到最大步数 12",
		usedSteps: 12,
		maxSteps: 12,
		totalToolResultChars: 46000,
		toolResultCharLimit: MAX_TOTAL_TOOL_RESULT_CHARS,
		continuation
	});

	assert.equal(result.additionalSteps, TOOL_BUDGET_CONTINUE_STEPS);
	assert.equal(getContinuedMaxSteps({ message: "继续" }, result.continuation), 28);
	assert.equal(getContinuedToolResultCharLimit(result.continuation), MAX_TOTAL_TOOL_RESULT_CHARS + TOOL_RESULT_CONTINUE_CHARS);
});

test("tool budget decision acknowledges before resuming long-running continuation", async (): Promise<void> => {
	const source: string = await readFile(new URL("../../../src/server/chat-orchestrator.ts", import.meta.url), "utf8");
	const handlerStart: number = source.indexOf("async function handleToolBudgetDecision(");
	const runnerStart: number = source.indexOf("async function runToolBudgetDecisionContinuation(");
	assert.notEqual(handlerStart, -1);
	assert.notEqual(runnerStart, -1);

	const handlerSource: string = source.slice(handlerStart, runnerStart);
	const runnerSource: string = source.slice(runnerStart, source.indexOf("\nexport async function handleChatRequest", runnerStart));
	const ackResponseIndex: number = handlerSource.lastIndexOf("id: responseId");
	const runnerLaunchIndex: number = handlerSource.indexOf("void runToolBudgetDecisionContinuation({");

	assert.ok(ackResponseIndex >= 0);
	assert.ok(runnerLaunchIndex > ackResponseIndex);
	assert.equal(handlerSource.includes("accepted: true"), true);
	assert.equal(handlerSource.includes("session.activeAbortControllers.set(responseId"), false);
	assert.equal(runnerSource.includes("id: responseId"), false);
	assert.equal(runnerSource.includes("id: pending.requestId"), true);
});

test("tool-assisted chat pauses for a budget decision instead of escalating the write scope", async (): Promise<void> => {
	const source: string = await readFile(new URL("../../../src/server/chat-orchestrator.ts", import.meta.url), "utf8");
	const budgetStart: number = source.indexOf('if (agentResult.status === "tool_budget_required")');
	const budgetEnd: number = source.indexOf('if (agentResult.status === "chat_answer")', budgetStart);
	assert.ok(budgetStart >= 0);
	assert.ok(budgetEnd > budgetStart);

	const budgetBranch: string = source.slice(budgetStart, budgetEnd);
	assert.equal(budgetBranch.includes('routeDecision.lane === "tool_assisted"'), false);
	assert.equal(budgetBranch.includes("createPendingToolBudget"), true);
	assert.equal(budgetBranch.includes("sendToolBudgetRequired"), true);
});
