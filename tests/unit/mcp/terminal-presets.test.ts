import assert from "node:assert/strict";
import test from "node:test";
import {
	findPreset,
	materializePreset
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
