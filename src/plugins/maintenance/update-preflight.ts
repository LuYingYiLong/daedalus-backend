import { readFile } from "node:fs/promises";
import type { PluginRecord, PluginSource } from "../types.js";
import { computePluginFingerprint, scanPluginSource } from "../manager.js";
import type { PluginUpdatePreview } from "./maintenance-types.js";

function semver(value: string): [number, number, number, string] | null {
	const match = value.match(/^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u);
	return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? ""];
}

export function isVersionUpgrade(current: string, next: string): boolean {
	const left = semver(current);
	const right = semver(next);
	if (left === null || right === null) return false;
	for (let index = 0; index < 3; index += 1) {
		if (right[index]! !== left[index]!) return right[index]! > left[index]!;
	}
	if (left[3] === right[3]) return false;
	return left[3].length > 0 && right[3].length === 0;
}

export async function previewPluginUpdate(input: { plugin: PluginRecord; expectedFingerprint: string; source: PluginSource }): Promise<PluginUpdatePreview> {
	if (input.plugin.fingerprint !== input.expectedFingerprint) throw Object.assign(new Error("Plugin fingerprint is stale."), { code: "plugin_fingerprint_stale" });
	const scan = await scanPluginSource(input.source);
	const blockers: string[] = [];
	const warnings = [...scan.compatibility.warnings];
	if (scan.packageName !== input.plugin.packageName) blockers.push("The package name must remain unchanged.");
	if (!isVersionUpgrade(input.plugin.version, scan.version)) blockers.push("The candidate version must be a valid version greater than the installed version.");
	if (scan.compatibility.classification === "unsupported") blockers.push("The candidate plugin contains unsupported declarations.");
	const testRequired = scan.packageRoot === undefined ? false : await readFile(`${scan.packageRoot}/tests/daedalus.plugin-tests.json`, "utf8").then(() => true).catch(() => false);
	if (testRequired) warnings.push("A sandbox test plan was found; run it before applying the update.");
	return { pluginId: input.plugin.id, expectedFingerprint: input.expectedFingerprint, source: input.source, packageName: scan.packageName, currentVersion: input.plugin.version, nextVersion: scan.version, contentHash: scan.contentHash, fingerprint: computePluginFingerprint(scan, input.source), testRequired, warnings, blockers };
}
