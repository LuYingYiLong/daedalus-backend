import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getExecutionPolicy, routeWorkflowExecution } from "../../../src/workflow/router.js";

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

test("agent auto requests with a workspace always probe independent of prose", (): void => {
	const messages = [
		"Explain e2e testing; do not edit files.",
		"Refactor multiple files and migrate configuration.",
		"Fix one setting."
	];
	for (const message of messages) {
		const route = routeWorkflowExecution({ message, mode: "agent", options: { executionPolicy: "auto" } }, workspaceContext);
		assert.equal(route.intent, "inspect");
		assert.equal(route.scope, "unknown");
		assert.equal(route.lane, "probe");
	}
});

test("explicit multi-phase and llm-planned options start workflows only with a workspace", (): void => {
	for (const workflow of ["multi_phase", "llm_planned"] as const) {
		const route = routeWorkflowExecution({ message: "Any request", mode: "agent", options: { workflow } }, workspaceContext);
		assert.equal(route.lane, "workflow");
		assert.equal(route.forcedByOption, workflow);
		assert.equal(routeWorkflowExecution({ message: "Any request", mode: "agent", options: { workflow } }, noWorkspaceContext).lane, "direct");
	}
});

test("single does not bypass the agent probe policy", (): void => {
	const route = routeWorkflowExecution({ message: "Change a file", mode: "agent", options: { workflow: "single" } }, workspaceContext);
	assert.equal(route.lane, "probe");
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
