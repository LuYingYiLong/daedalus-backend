import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { resolvePresetApplicability } from "../../../src/mcp/terminal/applicability.js";

async function withTempDirectory(callback: (directory: string) => Promise<void>): Promise<void> {
	const directory: string = await mkdtemp(join(tmpdir(), "tool-applicability-"));
	try {
		await callback(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("Git applicability detects a repository in a parent directory", async (): Promise<void> => {
	await withTempDirectory(async (directory: string): Promise<void> => {
		await mkdir(join(directory, ".git"));
		const nested: string = join(directory, "src");
		await mkdir(nested);
		assert.deepEqual(resolvePresetApplicability({ presetName: "git.status", workingDirectory: nested }), { applicable: true });
	});
});

test("Git applicability reports a missing repository", async (): Promise<void> => {
	await withTempDirectory(async (directory: string): Promise<void> => {
		const result = resolvePresetApplicability({ presetName: "git.diff", workingDirectory: directory });
		assert.equal(result.applicable, false);
		if (!result.applicable) assert.equal(result.applicabilityCode, "git_repository_missing");
	});
});

test("typecheck applicability distinguishes manifest, script, valid and malformed package files", async (): Promise<void> => {
	await withTempDirectory(async (directory: string): Promise<void> => {
		const missingManifest = resolvePresetApplicability({ presetName: "workspace.typecheck", workingDirectory: directory });
		assert.equal(missingManifest.applicable, false);
		if (!missingManifest.applicable) assert.equal(missingManifest.applicabilityCode, "package_manifest_missing");

		await writeFile(join(directory, "package.json"), JSON.stringify({ scripts: { test: "node test.js" } }), "utf8");
		const missingScript = resolvePresetApplicability({ presetName: "workspace.typecheck", workingDirectory: directory });
		assert.equal(missingScript.applicable, false);
		if (!missingScript.applicable) assert.equal(missingScript.applicabilityCode, "typecheck_script_missing");

		await writeFile(join(directory, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc --noEmit" } }), "utf8");
		assert.deepEqual(resolvePresetApplicability({ presetName: "workspace.typecheck", workingDirectory: directory }), { applicable: true });

		await writeFile(join(directory, "package.json"), "{ malformed", "utf8");
		assert.deepEqual(resolvePresetApplicability({ presetName: "workspace.typecheck", workingDirectory: directory }), { applicable: true });
	});
});

test("Godot applicability reports a missing project without running a command", (): void => {
	const result = resolvePresetApplicability({
		presetName: "godot.check_only",
		workingDirectory: tmpdir(),
		requiresGodotProject: true,
		godotProjectPath: ""
	});
	assert.equal(result.applicable, false);
	if (!result.applicable) assert.equal(result.applicabilityCode, "godot_project_missing");
});
