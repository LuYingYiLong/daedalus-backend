import assert from "node:assert/strict";
import test from "node:test";
import { SCHEDULED_TASK_TOOL_DEFINITIONS } from "../../src/tools/scheduled-task-tools.js";
import { evaluateToolCall } from "../../src/tools/tool-policy.js";
import { createWorkspaceToolCatalog } from "../../src/tools/tool-catalog.js";

test("scheduled task mutations always require approval", (): void => {
	for (const mode of ["manual", "auto-safe", "full-trust"] as const) {
		assert.equal(evaluateToolCall(mode, "mcp_scheduled_task_create", {}, undefined).action, "request_approval");
		assert.equal(evaluateToolCall(mode, "mcp_scheduled_task_delete", {}, undefined).action, "request_approval");
	}
});

test("scheduler client receives only the monitor report tool", (): void => {
	const names = createWorkspaceToolCatalog({
		clientType: "studio_scheduler",
		scheduledTaskControl: { execute: async (): Promise<Record<string, unknown>> => ({ accepted: true }) },
	}).getDefinitions().flatMap((definition): string[] => definition.type === "function" ? [definition.function.name] : []);
	assert.deepEqual(names.filter((name): boolean => name.startsWith("mcp_scheduled_")), ["mcp_scheduled_task_report"]);
});

test("scheduled task tool definitions have stable unique names", (): void => {
	const names = SCHEDULED_TASK_TOOL_DEFINITIONS.flatMap((definition): string[] => definition.type === "function" ? [definition.function.name] : []);
	assert.equal(new Set(names).size, 7);
});
