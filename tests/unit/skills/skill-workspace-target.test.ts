import assert from "node:assert/strict";
import test from "node:test";
import { resolveSkillWorkspaceTarget } from "../../../src/skills/workspace-target.js";
import type { WorkspaceConfig } from "../../../src/workspace/types.js";

function createWorkspace(): WorkspaceConfig {
	return {
		id: "workspace-a",
		name: "Workspace A",
		kind: "godot",
		rootPath: "D:/Projects/app",
		icon: 0,
		color: 0,
		primarySourceFolderId: "frontend",
		sourceFolders: [
			{ id: "frontend", path: "D:/Projects/app", capabilities: { git: true, godot: false } },
			{ id: "backend", path: "D:/Projects/api", capabilities: { git: true, godot: false } }
		]
	};
}

test("skill target without workspace resolves only to the global skill workspace", (): void => {
	assert.equal(resolveSkillWorkspaceTarget({}).id, "studio:global");
	assert.throws((): unknown => resolveSkillWorkspaceTarget({ sourceFolderId: "frontend" }), /requires workspaceId/);
});

test("project skill targets require an exact source in multi-source workspaces", (): void => {
	const workspace: WorkspaceConfig = createWorkspace();
	const lookupWorkspace = (workspaceId: string): WorkspaceConfig | undefined => workspaceId === workspace.id ? workspace : undefined;
	assert.throws(
		(): unknown => resolveSkillWorkspaceTarget({ workspaceId: workspace.id }, { sourceScoped: true, lookupWorkspace }),
		/sourceFolderId is required/
	);
	const target = resolveSkillWorkspaceTarget(
		{ workspaceId: workspace.id, sourceFolderId: "backend" },
		{ sourceScoped: true, lookupWorkspace }
	);
	assert.equal(target.id, workspace.id);
	assert.equal(target.rootPath, "D:/Projects/api");
	assert.deepEqual(target.sourceFolders, [{ id: "backend", rootPath: "D:/Projects/api" }]);
	assert.throws(
		(): unknown => resolveSkillWorkspaceTarget(
			{ workspaceId: workspace.id, sourceFolderId: "missing" },
			{ sourceScoped: true, lookupWorkspace }
		),
		/Source folder not found/
	);
});
