import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { canWriteToWorkspace, getExecutionPolicy, getOutputTarget, routeWorkflowExecution } from "../../../src/workflow/router.js";

const workspaceContext = { hasActiveWorkspace: true };
const noWorkspaceContext = { hasActiveWorkspace: false };

test("ask and plan modes always use a read lane", (): void => {
	for (const mode of ["ask", "plan"] as const) {
		const route = routeWorkflowExecution({ message: "Implement everything", mode }, workspaceContext);
		assert.equal(route.lane, "read");
		assert.equal(route.safetyOverride, "mode_read_only");
	}
});

test("explicit read-only policy wins over workflow options", (): void => {
	const route = routeWorkflowExecution({
		message: "Rewrite every project file",
		mode: "agent",
		options: { executionPolicy: "read_only", workflow: "multi_phase" }
	}, workspaceContext);
	assert.equal(route.lane, "read");
	assert.equal(route.safetyOverride, "execution_read_only");
});

test("agent auto requests with a workspace use the free agent loop independent of prose", (): void => {
	const messages = [
		"Explain e2e testing; do not edit files.",
		"Refactor multiple files and migrate configuration.",
		"Fix one setting."
	];
	for (const message of messages) {
		const route = routeWorkflowExecution({ message, mode: "agent", options: { executionPolicy: "auto" } }, workspaceContext);
		assert.equal(route.intent, "answer");
		assert.equal(route.scope, "unknown");
		assert.equal(route.lane, "agent_loop");
		assert.equal(route.outputTarget, "chat");
	}
});

test("workspace output is granted only by a structured target", (): void => {
	const chatRoute = routeWorkflowExecution({ message: "更新日志", mode: "agent" }, workspaceContext);
	const workspaceRoute = routeWorkflowExecution({
		message: "任意文本",
		mode: "agent",
		options: { outputTarget: "workspace" }
	}, workspaceContext);

	assert.equal(getOutputTarget({ message: "更新日志", mode: "agent" }), "chat");
	assert.equal(chatRoute.outputTarget, "chat");
	assert.equal(workspaceRoute.outputTarget, "workspace");
	assert.equal(canWriteToWorkspace({ message: "任意文本", mode: "agent" }), false);
	assert.equal(canWriteToWorkspace({ message: "任意文本", mode: "agent", options: { outputTarget: "workspace" } }), true);
});

test("explicit chat output keeps the agent loop read-only through its structured target", (): void => {
	const route = routeWorkflowExecution({
		message: "任意文本",
		mode: "agent",
		options: { outputTarget: "chat", workflow: "multi_phase" }
	}, workspaceContext);
	assert.equal(route.lane, "agent_loop");
	assert.equal(route.outputTarget, "chat");
	assert.equal(canWriteToWorkspace({
		message: "任意文本",
		mode: "agent",
		options: { outputTarget: "chat", workflow: "multi_phase" }
	}), false);
});

test("legacy explicit workflow remains a structured workspace authorization", (): void => {
	const params = { message: "任意文本", mode: "agent" as const, options: { workflow: "multi_phase" as const } };
	const route = routeWorkflowExecution(params, workspaceContext);
	assert.equal(getOutputTarget(params), "workspace");
	assert.equal(route.lane, "agent_loop");
	assert.equal(canWriteToWorkspace(params), true);
});

test("a tool budget never acts as workspace authorization", (): void => {
	const params = { message: "任意文本", mode: "agent" as const, options: { toolBudget: "project_edit" as const } };
	assert.equal(getOutputTarget(params), "chat");
	assert.equal(canWriteToWorkspace(params), false);
});

test("legacy workflow options map new workspace requests to the free agent loop", (): void => {
	for (const workflow of ["multi_phase", "llm_planned"] as const) {
		const route = routeWorkflowExecution({ message: "Any request", mode: "agent", options: { workflow } }, workspaceContext);
		assert.equal(route.lane, "agent_loop");
		assert.equal(route.forcedByOption, workflow);
		assert.equal(routeWorkflowExecution({ message: "Any request", mode: "agent", options: { workflow } }, noWorkspaceContext).lane, "direct");
	}
});

test("single also uses the free agent loop", (): void => {
	const route = routeWorkflowExecution({ message: "Change a file", mode: "agent", options: { workflow: "single" } }, workspaceContext);
	assert.equal(route.lane, "agent_loop");
});

test("missing execution policy is explicitly auto", (): void => {
	assert.equal(getExecutionPolicy({ message: "Any request", mode: "agent" }), "auto");
});

test("no workspace never exposes a project execution lane", (): void => {
	const route = routeWorkflowExecution({ message: "Create a project", mode: "agent" }, noWorkspaceContext);
	assert.equal(route.lane, "direct");
});

test("router contains no LLM dependency or prose classifiers", async (): Promise<void> => {
	const source = await readFile(new URL("../../../src/workflow/router.ts", import.meta.url), "utf8");
	for (const forbidden of ["chatWithProvider", "chatWithDeepSeek", "MUTATION_PHRASES", "hasWriteIntent", "RegExp", "workspaceSummary"]) {
		assert.equal(source.includes(forbidden), false, forbidden);
	}
});
