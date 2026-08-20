import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzePluginDirectory } from "../../../src/plugins/manifest.js";

async function withPackage(packageJson: Record<string, unknown>, patchText?: string): Promise<{ root: string; dispose: () => Promise<void> }> {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-plugin-test-"));
	await writeFile(join(root, "package.json"), `${JSON.stringify(packageJson)}\n`, "utf8");
	if (typeof packageJson.main === "string") await writeFile(join(root, packageJson.main), "export const value = 1;\n", "utf8");
	if (patchText !== undefined) await writeFile(join(root, "cordis.patch.yml"), patchText, "utf8");
	return { root, dispose: async (): Promise<void> => { await rm(root, { recursive: true, force: true }); } };
}

test("plugin manifest identifies a native Harness bundle without executing it", async (): Promise<void> => {
	const fixture = await withPackage({
		name: "dsh-example-plugin",
		version: "1.2.3",
		main: "index.js",
		dsh: { bundle: { patch: "./cordis.patch.yml" } },
		daedalus: { plugin: { entry: "./index.js" } }
	}, "- insert:\n    - id: example\n      name: dsh-example-plugin\n");
	try {
		const result = await analyzePluginDirectory(fixture.root);
		assert.equal(result.packageName, "dsh-example-plugin");
		assert.equal(result.compatibility.classification, "both");
		assert.equal(result.compatibility.harnessBundle, true);
		assert.equal(result.compatibility.patchExists, true);
		assert.deepEqual(result.compatibility.unsupportedFeatures, []);
	} finally {
		await fixture.dispose();
	}
});

test("plugin manifest marks dynamic Cordis patch expressions unsupported", async (): Promise<void> => {
	const fixture = await withPackage({
		name: "unsafe-plugin",
		version: "0.1.0",
		dsh: { bundle: { patch: "./cordis.patch.yml" } }
	}, "- insert:\n    - id: unsafe\n      config: !!js ctx.secret\n");
	try {
		const result = await analyzePluginDirectory(fixture.root);
		assert.equal(result.compatibility.classification, "unsupported");
		assert.match(result.compatibility.unsupportedFeatures.join("\n"), /!!js/u);
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
