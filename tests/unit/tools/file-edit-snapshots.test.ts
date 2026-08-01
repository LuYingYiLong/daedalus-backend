import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { McpHost } from "../../../src/mcp/mcp-host.js";

async function withTempWorkspace<T>(fn: (root: string) => Promise<T>): Promise<T> {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const previousProjectPath: string | undefined = process.env.GODOT_PROJECT_PATH;
	const appDataDir: string = await fs.mkdtemp(path.join(os.tmpdir(), "daedalus-file-edit-appdata-"));
	const root: string = await fs.mkdtemp(path.join(os.tmpdir(), "daedalus-file-edit-workspace-"));
	process.env.USERPROFILE = appDataDir;
	process.env.GODOT_PROJECT_PATH = root;
	await fs.writeFile(path.join(root, "project.godot"), "[application]\nconfig/name=\"Test\"\n", "utf8");

	try {
		return await fn(root);
	} finally {
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		if (previousProjectPath === undefined) {
			delete process.env.GODOT_PROJECT_PATH;
		} else {
			process.env.GODOT_PROJECT_PATH = previousProjectPath;
		}
		await fs.rm(appDataDir, { recursive: true, force: true });
		await fs.rm(root, { recursive: true, force: true });
	}
}

test("captures text file before and after snapshots for successful Godot writes", async (): Promise<void> => {
	await withTempWorkspace(async (root: string): Promise<void> => {
		const { createRuntimeWorkspace } = await import(`../../../src/workspace/registry.js?case=${Date.now()}-${Math.random()}`);
		const { captureFileEditBatchDraft } = await import(`../../../src/tools/file-edit-snapshots.js?case=${Date.now()}-${Math.random()}`);
		const workspace = createRuntimeWorkspace(root);
		const filePath: string = path.join(root, "scripts", "player.gd");
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, "extends Node\n\nfunc old() -> void:\n\tpass\n", "utf8");

		const host = {
			getActiveWorkspaceId: (): string => workspace.id,
			getEditorBridge: () => ({ getActiveScenePath: (): undefined => undefined })
		} as unknown as McpHost;

		const result = await captureFileEditBatchDraft(
			host,
			"mcp_godot_overwrite_text_file",
			{ relativePath: "scripts/player.gd" },
			async () => {
				await fs.writeFile(filePath, "extends Node\n\nfunc new() -> void:\n\tprint(\"ok\")\n", "utf8");
				return {
					content: JSON.stringify({ overwritten: true, path: "scripts/player.gd" }),
					rawContentLength: 52,
					truncated: false,
					reused: false
				};
			}
		);

		assert.equal(result.fileEditDraft?.workspaceId, workspace.id);
		assert.equal(result.fileEditDraft?.edits.length, 1);
		assert.equal(result.fileEditDraft?.edits[0]?.path, "scripts/player.gd");
		assert.match(result.fileEditDraft?.edits[0]?.beforeText ?? "", /func old/);
		assert.match(result.fileEditDraft?.edits[0]?.afterText ?? "", /func new/);
		assert.equal(result.fileEditDraft?.edits[0]?.undoable, true);
	});
});

test("does not create file edit drafts for reused tool executions", async (): Promise<void> => {
	await withTempWorkspace(async (root: string): Promise<void> => {
		const { createRuntimeWorkspace } = await import(`../../../src/workspace/registry.js?case=${Date.now()}-${Math.random()}`);
		const { captureFileEditBatchDraft } = await import(`../../../src/tools/file-edit-snapshots.js?case=${Date.now()}-${Math.random()}`);
		const workspace = createRuntimeWorkspace(root);
		const filePath: string = path.join(root, "scripts", "player.gd");
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, "before\n", "utf8");

		const host = {
			getActiveWorkspaceId: (): string => workspace.id,
			getEditorBridge: () => ({ getActiveScenePath: (): undefined => undefined })
		} as unknown as McpHost;

		const result = await captureFileEditBatchDraft(
			host,
			"mcp_godot_overwrite_text_file",
			{ relativePath: "scripts/player.gd" },
			async () => {
				await fs.writeFile(filePath, "after\n", "utf8");
				return {
					content: JSON.stringify({ overwritten: true, path: "scripts/player.gd" }),
					rawContentLength: 52,
					truncated: false,
					reused: true
				};
			}
		);

		assert.equal(result.fileEditDraft, undefined);
	});
});

test("captures the active scene for Editor Bridge patches without an explicit scene path", async (): Promise<void> => {
	await withTempWorkspace(async (root: string): Promise<void> => {
		const { createRuntimeWorkspace } = await import(`../../../src/workspace/registry.js?case=${Date.now()}-${Math.random()}`);
		const { captureFileEditBatchDraft } = await import(`../../../src/tools/file-edit-snapshots.js?case=${Date.now()}-${Math.random()}`);
		const workspace = createRuntimeWorkspace(root);
		const scenePath: string = path.join(root, "scenes", "Main.tscn");
		await fs.mkdir(path.dirname(scenePath), { recursive: true });
		await fs.writeFile(scenePath, "[gd_scene]\n[node name=\"Main\" type=\"Node\"]\n", "utf8");

		const host = {
			getActiveWorkspaceId: (): string => workspace.id,
			getEditorBridge: () => ({ getActiveScenePath: (): string => "res://scenes/Main.tscn" })
		} as unknown as McpHost;

		const result = await captureFileEditBatchDraft(
			host,
			"mcp_godot_editor_apply_scene_patch",
			{ operations: [{ type: "add_node", parentPath: ".", nodeType: "Node", nodeName: "Child" }] },
			async () => {
				await fs.writeFile(scenePath, "[gd_scene]\n[node name=\"Main\" type=\"Node\"]\n[node name=\"Child\" type=\"Node\" parent=\".\"]\n", "utf8");
				return {
					content: JSON.stringify({ ok: true, modified: true }),
					rawContentLength: 28,
					truncated: false,
					reused: false
				};
			}
		);

		assert.equal(result.fileEditDraft?.edits.length, 1);
		assert.equal(result.fileEditDraft?.edits[0]?.path, "scenes/Main.tscn");
		assert.match(result.fileEditDraft?.edits[0]?.afterText ?? "", /Child/u);
	});
});
