import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";
import {
	findPreset,
	materializePreset,
	resolveWorkingDirectory
} from "../../../src/mcp/terminal/presets.js";

const backendDir: string = "C:\\repos\\daedalus-backend";
const workspaceRoot: string = "C:\\projects\\game";

test("workspace-scoped terminal presets use the active workspace root", (): void => {
	for (const presetName of ["workspace.typecheck", "git.status", "git.diff", "git.init"]) {
		const preset = materializePreset(findPreset(presetName), {
			backendDir,
			workspaceRoot
		});
		assert.equal(preset.workingDirectory, workspaceRoot, presetName);
	}
});

test("workspace-scoped terminal presets fall back to the backend without a workspace", (): void => {
	for (const presetName of ["workspace.typecheck", "git.status", "git.diff", "git.init"]) {
		const preset = materializePreset(findPreset(presetName), {
			backendDir,
			workspaceRoot: ""
		});
		assert.equal(preset.workingDirectory, backendDir, presetName);
	}
});

test("backend typecheck remains bound to the backend directory", (): void => {
	const preset = materializePreset(findPreset("backend.typecheck"), {
		backendDir,
		workspaceRoot
	});
	assert.equal(preset.workingDirectory, findPreset("backend.typecheck").workingDirectory);
});

test("preset working directory overrides stay inside that preset's own root", (): void => {
	const localBackend: string = path.resolve("backend-root");
	const localWorkspace: string = path.resolve("workspace-root");
	const workspacePreset = materializePreset(findPreset("workspace.typecheck"), {
		backendDir: localBackend,
		workspaceRoot: localWorkspace
	});
	assert.throws((): void => {
		resolveWorkingDirectory(localBackend, workspacePreset, {
			backendDir: localBackend,
			workspaceRoot: localWorkspace
		});
	}, /outside the preset root/u);
	assert.equal(
		resolveWorkingDirectory(path.join(localWorkspace, "packages", "app"), workspacePreset, {
			backendDir: localBackend,
			workspaceRoot: localWorkspace
		}),
		path.join(localWorkspace, "packages", "app")
	);
});
