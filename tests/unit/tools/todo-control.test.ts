import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspaceToolCatalog } from "../../../src/tools/tool-catalog.js";
import {
	completeAgentTodoSnapshot,
	createAgentTodoSnapshot,
	parseAgentTodoListInput,
	serializeTodoControlResult,
	TODO_UPDATE_TOOL_NAME
} from "../../../src/tools/todo-control.js";
import { fitToolResultContent } from "../../../src/providers/tool-result-budget.js";

const validInput = {
	title: "Remove obsolete setting",
	items: [
		{ id: "config", text: "Remove the stored setting", status: "completed" as const },
		{ id: "rpc", text: "Remove RPC propagation", status: "in_progress" as const },
		{ id: "ui", text: "Remove the settings control", status: "pending" as const },
		{ id: "tests", text: "Update regression coverage", status: "pending" as const }
	]
};

test("Agent Todo input accepts one current item and stable unique ids", (): void => {
	assert.deepEqual(parseAgentTodoListInput(validInput), validInput);
	assert.throws((): void => {
		parseAgentTodoListInput({
			...validInput,
			items: [validInput.items[0], { ...validInput.items[1], id: "config" }]
		});
	}, /Duplicate todo id/u);
	assert.throws((): void => {
		parseAgentTodoListInput({
			...validInput,
			items: validInput.items.map((item) => ({ ...item, status: "in_progress" }))
		});
	}, /At most one todo item may be in progress/u);
});

test("Agent Todo input rejects oversized snapshots and unsupported statuses", (): void => {
	assert.throws((): void => {
		parseAgentTodoListInput({
			title: "Too many",
			items: Array.from({ length: 13 }, (_, index: number) => ({
				id: `item-${index}`,
				text: `Item ${index}`,
				status: "pending"
			}))
		});
	});
	assert.throws((): void => {
		parseAgentTodoListInput({ title: "Invalid", items: [{ id: "a", text: "A", status: "failed" }] });
	});
});

test("Agent Todo snapshots map model statuses and close remaining items deterministically", (): void => {
	const snapshot = createAgentTodoSnapshot("run-a", validInput, 4);
	assert.equal(snapshot.workflowId, "agent-loop:run-a");
	assert.equal(snapshot.source, "agent_loop");
	assert.equal(snapshot.revision, 5);
	assert.deepEqual(snapshot.phases.map((item) => item.status), ["done", "running", "pending", "pending"]);
	assert.deepEqual(snapshot.todos.map((item) => item.status), ["done", "running", "pending", "pending"]);

	const completed = completeAgentTodoSnapshot(snapshot);
	assert.equal(completed?.revision, 6);
	assert.equal(completed?.phases.every((item) => item.status === "done"), true);
	assert.equal(completed?.todos.every((item) => item.status === "done"), true);
	assert.equal(completeAgentTodoSnapshot(completed), completed);
});

test("Todo control is catalog-gated and its result does not consume tool-result characters", (): void => {
	const unavailable = createWorkspaceToolCatalog({ workspaceId: "workspace-a" });
	const available = createWorkspaceToolCatalog({
		workspaceId: "workspace-a",
		todoControl: { async execute(): Promise<Record<string, unknown>> { return { ok: true }; } },
		todoControlAvailable: true
	});
	assert.equal(unavailable.getEntry(TODO_UPDATE_TOOL_NAME), undefined);
	assert.notEqual(available.getEntry(TODO_UPDATE_TOOL_NAME), undefined);
	assert.equal(available.getDefinitionsForNames([]).some((tool) => (
		tool.type === "function" && tool.function.name === TODO_UPDATE_TOOL_NAME
	)), true);

	const content: string = serializeTodoControlResult({ ok: true, revision: 1 });
	const budgeted = fitToolResultContent(content, 100, 5000);
	assert.equal(budgeted.chars, 0);
	assert.equal(budgeted.limitReached, false);
});
