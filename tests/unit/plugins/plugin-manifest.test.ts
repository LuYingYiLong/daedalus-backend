import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { analyzePluginDirectory } from "../../../src/plugins/manifest.js";

const fixturePath: string = fileURLToPath(new URL("../../fixtures/native-plugin", import.meta.url));

async function withPackage(packageJson: Record<string, unknown>, patchText?: string): Promise<{ root: string; dispose: () => Promise<void> }> {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-plugin-test-"));
	await writeFile(join(root, "package.json"), `${JSON.stringify(packageJson)}\n`, "utf8");
	if (typeof packageJson.main === "string") await writeFile(join(root, packageJson.main), "export const value = 1;\n", "utf8");
	if (patchText !== undefined) await writeFile(join(root, "cordis.patch.yml"), patchText, "utf8");
	return { root, dispose: async (): Promise<void> => { await rm(root, { recursive: true, force: true }); } };
}

test("plugin scanner rejects removed third-party runtime manifests", async (): Promise<void> => {
	const fixture = await withPackage({
		name: "legacy-plugin",
		version: "1.2.3",
		dsh: { bundle: { patch: "./cordis.patch.yml" } }
	}, "- insert:\n    - id: legacy\n      name: legacy-plugin\n");
	try {
		await assert.rejects((): Promise<unknown> => analyzePluginDirectory(fixture.root), (error: unknown): boolean => {
			return typeof error === "object" && error !== null && "code" in error && error.code === "plugin_legacy_manifest_unsupported";
		});
	} finally {
		await fixture.dispose();
	}
});

test("plugin manifest rejects malformed package metadata", async (): Promise<void> => {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-plugin-test-"));
	await mkdir(join(root, "nested"));
	await writeFile(join(root, "package.json"), JSON.stringify({ name: "missing-version" }), "utf8");
	try {
		await assert.rejects((): Promise<unknown> => analyzePluginDirectory(root), /requires name and version/u);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("native plugin fixture exposes a validated runtime entry without executing it", async (): Promise<void> => {
	const result = await analyzePluginDirectory(fixturePath);
	assert.equal(result.packageName, "daedalus-fixture-native-plugin");
	assert.equal(result.compatibility.classification, "native");
	assert.deepEqual(result.nativePlugin, {
		apiVersion: 1,
		entry: "./index.js",
		capabilities: ["tools", "skills", "hooks", "mcp"],
	});
	assert.match(result.presentation?.readme ?? "", /safe local fixture/u);
	assert.match(result.presentation?.changelog ?? "", /1\.0\.0/u);
	assert.equal(result.presentation?.description, "A safe fixture for testing the native plugin runtime.");
	assert.equal(result.presentation?.iconDataUrl, undefined);
});

test("plugin manifest exposes a bounded PNG icon as a data URL", async (): Promise<void> => {
	const fixture = await withPackage({ name: "icon-plugin", version: "1.0.0" });
	try {
		await writeFile(join(fixture.root, "icon.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
		const result = await analyzePluginDirectory(fixture.root);
		assert.match(result.presentation?.iconDataUrl ?? "", /^data:image\/png;base64,/u);
	} finally {
		await fixture.dispose();
	}
});
