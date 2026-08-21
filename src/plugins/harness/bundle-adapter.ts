import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getDaedalusPath } from "../../app-paths.js";
import type { HarnessBundleSummary, PluginRecord } from "../types.js";
import { createSanitizedHarnessPatch, parseHarnessBundlePatch } from "./patch-parser.js";
import { HARNESS_BRIDGE_MODULE_SOURCE } from "./bridge-bootstrap.js";

export type PreparedHarnessBundle = {
	runtimeRoot: string;
	pluginPatchPath: string;
	bridgePatchPath: string;
	harnessHome: string;
	summary: HarnessBundleSummary;
	cleanup: () => Promise<void>;
};

function safeSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 160);
}

export async function prepareHarnessBundle(record: PluginRecord, sessionId: string): Promise<PreparedHarnessBundle> {
	const patchPath: string | undefined = record.compatibility.patchPath;
	if (patchPath === undefined || !record.compatibility.patchExists) throw Object.assign(new Error("Harness Bundle does not contain a readable patch."), { code: "plugin_harness_patch_missing" });
	const summary: HarnessBundleSummary = await parseHarnessBundlePatch(record.packageRoot, patchPath);
	const runtimeRoot: string = join(getDaedalusPath("plugins.harnessRuntime"), safeSegment(record.id), safeSegment(sessionId));
	await rm(runtimeRoot, { recursive: true, force: true });
	await mkdir(runtimeRoot, { recursive: true });
	const bridgeModulePath: string = join(runtimeRoot, "daedalus-harness-bridge.mjs");
	const bridgePatchPath: string = join(runtimeRoot, "daedalus-bridge.patch.yml");
	const pluginPatchPath: string = join(runtimeRoot, "plugin.patch.yml");
	const profileRoot: string = join(runtimeRoot, "profiles", "daedalus");
	const packageLink: string = join(profileRoot, "node_modules", ...record.packageName.split("/"));
	await mkdir(dirname(packageLink), { recursive: true });
	await symlink(record.packageRoot, packageLink, process.platform === "win32" ? "junction" : "dir");
	await writeFile(join(profileRoot, "package.json"), `${JSON.stringify({
		name: "daedalus-harness-sidecar-profile",
		private: true,
		dependencies: { [record.packageName]: `file:${record.packageRoot}` },
		dsh: { profile: { bundles: [] } }
	}, null, 2)}\n`, "utf8");
	await writeFile(join(profileRoot, "cordis.patch.yml"), "[]\n", "utf8");
	await writeFile(bridgeModulePath, HARNESS_BRIDGE_MODULE_SOURCE, "utf8");
	await writeFile(bridgePatchPath, [
		"- insert:",
		"    - id: daedalus-harness-bridge",
		`      name: ${JSON.stringify(bridgeModulePath.replace(/\\/g, "/"))}`,
		""
	].join("\n"), "utf8");
	await writeFile(pluginPatchPath, await createSanitizedHarnessPatch(record.packageRoot, patchPath, summary), "utf8");
	return {
		runtimeRoot,
		pluginPatchPath,
		bridgePatchPath,
		harnessHome: runtimeRoot,
		summary,
		cleanup: async (): Promise<void> => { await rm(runtimeRoot, { recursive: true, force: true }); }
	};
}

export function createHarnessLaunchArgs(baseArgs: readonly string[], prepared: PreparedHarnessBundle): string[] {
	return [...baseArgs, "--profile", "daedalus", "--patch", prepared.bridgePatchPath, "--patch", prepared.pluginPatchPath];
}
