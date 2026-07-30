import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	reconcileWorkspaceTreeOrder,
	validateWorkspaceTreeOrderUpdate,
	WorkspaceTreeOrderStore,
	type WorkspaceTreeOrderInventory
} from "../../../src/workspace/tree-order-store.js";

const BASE_INVENTORY: WorkspaceTreeOrderInventory = {
	workspaces: [{ id: "workspace-a" }, { id: "workspace-b" }],
	sessions: [
		{ id: "session-a-new", workspaceId: "workspace-a" },
		{ id: "session-b", workspaceId: "workspace-b" },
		{ id: "session-a-old", workspaceId: "workspace-a" },
		{ id: "session-pinned", workspaceId: "workspace-a", pinned: true },
		{ id: "session-recent" },
		{ id: "session-temp", workspaceId: "workspace-a", temporary: true }
	]
};

test("workspace tree order reconciles visible ids and puts new entries first", (): void => {
	const initial = reconcileWorkspaceTreeOrder({
		workspaceIds: ["workspace-b", "workspace-a", "workspace-deleted"],
		sessionIdsByWorkspace: {
			"workspace-a": ["session-a-old", "session-deleted"],
			"workspace-b": ["session-b"],
			"workspace-deleted": ["session-gone"]
		}
	}, {
		workspaces: [...BASE_INVENTORY.workspaces, { id: "workspace-c" }],
		sessions: BASE_INVENTORY.sessions
	}, "2026-07-30T00:00:00.000Z");

	assert.deepEqual(initial.workspaceIds, ["workspace-c", "workspace-b", "workspace-a"]);
	assert.deepEqual(initial.sessionIdsByWorkspace, {
		"workspace-c": [],
		"workspace-b": ["session-b"],
		"workspace-a": ["session-a-new", "session-a-old"]
	});
	assert.equal(initial.updatedAt, "2026-07-30T00:00:00.000Z");
});

test("workspace tree order rejects duplicates and cross-workspace known sessions", (): void => {
	assert.throws((): void => validateWorkspaceTreeOrderUpdate({
		workspaceIds: ["workspace-a", "workspace-a"],
		sessionIdsByWorkspace: {}
	}, BASE_INVENTORY), /duplicate_workspace/u);

	assert.throws((): void => validateWorkspaceTreeOrderUpdate({
		workspaceIds: ["workspace-a", "workspace-b"],
		sessionIdsByWorkspace: {
			"workspace-a": ["session-b"]
		}
	}, BASE_INVENTORY), /session_workspace_mismatch/u);

	assert.throws((): void => validateWorkspaceTreeOrderUpdate({
		workspaceIds: ["workspace-a", "workspace-b"],
		sessionIdsByWorkspace: {
			"workspace-a": ["session-a-old"],
			"workspace-b": ["session-a-old"]
		}
	}, BASE_INVENTORY), /duplicate_session/u);
});

test("workspace tree order store persists updates and serializes concurrent writes", async (): Promise<void> => {
	const directory: string = await mkdtemp(join(tmpdir(), "daedalus-workspace-tree-order-"));
	const filePath: string = join(directory, "workspace-tree-order.json");
	try {
		const store: WorkspaceTreeOrderStore = new WorkspaceTreeOrderStore(filePath);
		const first = await store.get(BASE_INVENTORY);
		assert.deepEqual(first.workspaceIds, ["workspace-a", "workspace-b"]);
		assert.deepEqual(first.sessionIdsByWorkspace["workspace-a"], ["session-a-new", "session-a-old"]);

		const firstWrite = store.update({
			workspaceIds: ["workspace-b", "workspace-a"],
			sessionIdsByWorkspace: {
				"workspace-a": ["session-a-old", "session-a-new"],
				"workspace-b": ["session-b"]
			}
		}, BASE_INVENTORY);
		const secondWrite = store.update({
			workspaceIds: ["workspace-a", "workspace-b"],
			sessionIdsByWorkspace: {
				"workspace-a": ["session-a-new", "session-a-old"],
				"workspace-b": ["session-b"]
			}
		}, BASE_INVENTORY);
		await Promise.all([firstWrite, secondWrite]);

		const reloaded = await new WorkspaceTreeOrderStore(filePath).get(BASE_INVENTORY);
		assert.deepEqual(reloaded.workspaceIds, ["workspace-a", "workspace-b"]);
		assert.deepEqual(reloaded.sessionIdsByWorkspace["workspace-a"], ["session-a-new", "session-a-old"]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("workspace tree order store replaces invalid schema instead of migrating it", async (): Promise<void> => {
	const directory: string = await mkdtemp(join(tmpdir(), "daedalus-workspace-tree-order-invalid-"));
	const filePath: string = join(directory, "workspace-tree-order.json");
	try {
		await writeFile(filePath, JSON.stringify({
			schemaVersion: 2,
			workspaceIds: ["legacy"],
			sessionIdsByWorkspace: {},
			updatedAt: "legacy"
		}), "utf8");

		const store: WorkspaceTreeOrderStore = new WorkspaceTreeOrderStore(filePath);
		const result = await store.get(BASE_INVENTORY);
		assert.deepEqual(result.workspaceIds, ["workspace-a", "workspace-b"]);
		const stored = JSON.parse(await readFile(filePath, "utf8")) as { schemaVersion: number; workspaceIds: string[] };
		assert.equal(stored.schemaVersion, 1);
		assert.deepEqual(stored.workspaceIds, ["workspace-a", "workspace-b"]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
