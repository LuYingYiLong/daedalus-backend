import assert from "node:assert/strict";
import test from "node:test";
import { applyWorkspaceToSession, createClientSession } from "../../../src/server/client-session.js";
import type { WorkspaceConfig } from "../../../src/workspace/types.js";

test("workspace restore updates a reused runtime", (): void => {
	const workspace: WorkspaceConfig = {
		id: "workspace-open-restore",
		name: "OpenRestore",
		kind: "godot",
		rootPath: "D:/GodotProjects/OpenRestore",
		icon: 0,
		color: 0,
		sourceFolders: [{
			id: "primary",
			path: "D:/GodotProjects/OpenRestore",
			capabilities: { git: false, godot: true }
		}],
		primarySourceFolderId: "primary",
		godotExecutablePath: "D:/Godot/Godot.exe"
	};
	const runtime = createClientSession(undefined);
	runtime.sessionId = "session-open-restore";
	runtime.activeWorkspace = undefined;
	runtime.godotProjectPath = undefined;
	runtime.godotExecutablePath = undefined;

	applyWorkspaceToSession(runtime, workspace);

	const restoredWorkspace: WorkspaceConfig | undefined = runtime.activeWorkspace as WorkspaceConfig | undefined;
	assert.equal(restoredWorkspace?.id, workspace.id);
	assert.equal(runtime.godotProjectPath, workspace.rootPath);
	assert.equal(runtime.godotExecutablePath, workspace.godotExecutablePath);
});
