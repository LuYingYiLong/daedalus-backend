import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	reconcileFlowTreeOrder,
	validateFlowTreeOrderUpdate,
	FlowTreeOrderStore,
	type FlowTreeOrderInventory,
	type FlowTreeOrderUpdate,
} from "../../../src/session/flow-tree-order-store.js";

const inventory: FlowTreeOrderInventory = {
	workspaces: [{ id: "workspace-a" }],
	flows: [
		{ id: "flow-pinned", workspaceId: "workspace-a", pinned: true },
		{ id: "flow-project", workspaceId: "workspace-a", pinned: false },
		{ id: "flow-recent", workspaceId: null, pinned: false },
	],
};

function baseOrder(): FlowTreeOrderUpdate {
	return {
		pinnedFlowIds: ["flow-pinned"],
		recentFlowIds: ["flow-recent"],
		flowIdsByWorkspace: { "workspace-a": ["flow-project"] },
		expandedSectionKeys: ["pinned", "projects", "recent"],
		expandedWorkspaceIds: ["workspace-a"],
	};
}

test("Flow tree order reconciles new flows into their derived buckets", (): void => {
	const result = reconcileFlowTreeOrder(baseOrder(), inventory, "2026-09-16T00:00:00.000Z");
	assert.deepEqual(result.pinnedFlowIds, ["flow-pinned"]);
	assert.deepEqual(result.recentFlowIds, ["flow-recent"]);
	assert.deepEqual(result.flowIdsByWorkspace, { "workspace-a": ["flow-project"] });
});

test("Flow tree order keeps newly discovered flows ahead of saved entries", (): void => {
	const preferences: FlowTreeOrderUpdate = {
		...baseOrder(),
		recentFlowIds: ["flow-recent"],
	};
	const result = reconcileFlowTreeOrder(preferences, {
		flows: [
			{ id: "flow-new", workspaceId: null, pinned: false },
			...inventory.flows,
		],
	}, "2026-09-16T00:00:00.000Z");
	assert.deepEqual(result.recentFlowIds, ["flow-new", "flow-recent"]);
});

test("Flow tree order preserves expanded empty workspaces", (): void => {
	const result = reconcileFlowTreeOrder({
		...baseOrder(),
		expandedWorkspaceIds: ["workspace-a", "workspace-empty"],
	}, {
		workspaces: [{ id: "workspace-a" }, { id: "workspace-empty" }],
		flows: inventory.flows,
	}, "2026-09-16T00:00:00.000Z");
	assert.deepEqual(result.flowIdsByWorkspace, { "workspace-a": ["flow-project"], "workspace-empty": [] });
	assert.deepEqual(result.expandedWorkspaceIds, ["workspace-a", "workspace-empty"]);
});

test("Flow tree order accepts moving an unbound recent Flow to pinned", (): void => {
	const update: FlowTreeOrderUpdate = {
		...baseOrder(),
		pinnedFlowIds: ["flow-recent", "flow-pinned"],
		recentFlowIds: [],
	};
	assert.doesNotThrow((): void => validateFlowTreeOrderUpdate(update, inventory));
});

test("Flow tree order rejects workspace-bound Flow in recent", (): void => {
	const update: FlowTreeOrderUpdate = {
		...baseOrder(),
		recentFlowIds: ["flow-project"],
		flowIdsByWorkspace: { "workspace-a": [] },
	};
	assert.throws(() => validateFlowTreeOrderUpdate(update, inventory), { message: "flow_tree_order_recent_workspace_mismatch" });
});

test("Flow tree order store persists updates and replaces invalid snapshots", async (): Promise<void> => {
	const directory: string = await mkdtemp(join(tmpdir(), "daedalus-flow-tree-order-"));
	const filePath: string = join(directory, "flow-tree-order.json");
	try {
		const store: FlowTreeOrderStore = new FlowTreeOrderStore(filePath);
		const first = await store.get(inventory);
		assert.deepEqual(first.recentFlowIds, ["flow-recent"]);
		await store.update({
			...baseOrder(),
			expandedSectionKeys: ["projects"],
			expandedWorkspaceIds: [],
		}, inventory);
		const reloaded = await new FlowTreeOrderStore(filePath).get(inventory);
		assert.deepEqual(reloaded.expandedSectionKeys, ["projects"]);
		assert.deepEqual(reloaded.expandedWorkspaceIds, []);

		await writeFile(filePath, JSON.stringify({ schemaVersion: 0 }), "utf8");
		const replaced = await new FlowTreeOrderStore(filePath).get(inventory);
		assert.deepEqual(replaced.pinnedFlowIds, ["flow-pinned"]);
		assert.equal((JSON.parse(await readFile(filePath, "utf8")) as { schemaVersion: number }).schemaVersion, 1);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
