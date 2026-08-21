import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { getDaedalusPath } from "../../../src/app-paths.js";
import { getPluginCatalog, installPlugin, removePlugin, updateActivePluginProfile, updatePluginTrustStatus } from "../../../src/plugins/manager.js";

test("plugin manager installs, trusts, profiles, and removes a local package without executing code", async (): Promise<void> => {
	const originalProfile: string | undefined = process.env.USERPROFILE;
	const profileRoot: string = await mkdtemp(join(tmpdir(), "daedalus-plugin-manager-"));
	const packageRoot: string = join(profileRoot, "fixture-plugin");
	await mkdir(packageRoot, { recursive: true });
	await writeFile(join(packageRoot, "package.json"), JSON.stringify({
		name: "fixture-plugin",
		version: "1.0.0",
		prepare: "node should-not-run.js",
		daedalus: { plugin: { entry: "./index.js" } }
	}), "utf8");
	await writeFile(join(packageRoot, "index.js"), "export const value = 1;\n", "utf8");
	await writeFile(join(packageRoot, "README.md"), "# Fixture plugin\n\nThis README is loaded from the managed package.\n", "utf8");
	try {
		process.env.USERPROFILE = profileRoot;
		const installed = await installPlugin({ type: "local", path: packageRoot });
		assert.equal(installed.trust, "review_required");
		const recordsPath: string = getDaedalusPath("plugins.records");
		const stored = JSON.parse(await readFile(recordsPath, "utf8")) as { plugins: Array<Record<string, unknown>> };
		delete stored.plugins[0]!.presentation;
		await writeFile(recordsPath, JSON.stringify(stored), "utf8");
		const hydratedCatalog = await getPluginCatalog();
		assert.equal(hydratedCatalog.plugins.length, 1);
		assert.match(hydratedCatalog.plugins[0]?.presentation?.readme ?? "", /managed package/u);
		const trusted = await updatePluginTrustStatus(installed.id, installed.fingerprint, "trusted");
		assert.equal(trusted.trust, "trusted");
		const catalog = await updateActivePluginProfile([installed.id]);
		assert.deepEqual(catalog.activeProfile.pluginIds, [installed.id]);
		assert.equal(catalog.plugins[0]?.enabled, true);
		assert.equal((await readFile(getDaedalusPath("plugins.audit"), "utf8")).includes('"action":"install"'), true);
		await removePlugin(installed.id);
		assert.equal((await getPluginCatalog()).plugins.length, 0);
	} finally {
		if (originalProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalProfile;
		await rm(profileRoot, { recursive: true, force: true });
	}
});
