import { cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { getDaedalusPath } from "../app-paths.js";
import { writeJsonFileAtomic } from "../json-file-store.js";
import { analyzePluginDirectory, isPathInside } from "./manifest.js";
import type { PluginRecord, PluginVersionRecord } from "./types.js";

function safe(value: string): string { return value.replace(/[^a-zA-Z0-9._-]/gu, "_").slice(0, 180); }
function root(pluginId: string): string { return join(getDaedalusPath("plugins.versions"), safe(pluginId)); }

export async function archivePluginVersion(record: PluginRecord): Promise<void> {
	const packagesRoot = resolve(getDaedalusPath("plugins.packages"));
	const packageRoot = resolve(record.packageRoot);
	if (!isPathInside(packagesRoot, packageRoot) || packageRoot === packagesRoot) throw Object.assign(new Error("Plugin version source is outside managed storage."), { code: "plugin_path_escape" });
	await analyzePluginDirectory(packageRoot);
	const versionRoot = join(root(record.id), safe(record.fingerprint));
	await mkdir(versionRoot, { recursive: true });
	await cp(record.packageRoot, join(versionRoot, "package"), { recursive: true, force: true, errorOnExist: false, dereference: false, filter: (source): boolean => basename(source) !== "node_modules" && basename(source) !== ".git" });
	const snapshot: PluginVersionRecord & { record: PluginRecord } = {
		fingerprint: record.fingerprint,
		packageRoot: join(versionRoot, "package"),
		packageName: record.packageName,
		version: record.version,
		contentHash: record.contentHash,
		manifestHash: record.manifestHash,
		installedAt: record.installedAt,
		updatedAt: new Date().toISOString(),
		record
	};
	await writeJsonFileAtomic(join(versionRoot, "record.json"), snapshot);
	const versions = await listPluginVersions(record.id);
	versions.sort((left, right): number => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
	for (const version of versions.slice(1)) {
		const versionDirectory = resolve(join(root(record.id), safe(version.fingerprint)));
		if (isPathInside(root(record.id), versionDirectory)) await rm(versionDirectory, { recursive: true, force: true });
	}
}

export async function listPluginVersions(pluginId: string): Promise<PluginVersionRecord[]> {
	const result: PluginVersionRecord[] = [];
	try {
		for (const entry of await readdir(root(pluginId), { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			try {
				const value = JSON.parse(await readFile(join(root(pluginId), entry.name, "record.json"), "utf8")) as PluginVersionRecord;
				const packageRoot = typeof value.packageRoot === "string" ? resolve(value.packageRoot) : "";
				if (typeof value.fingerprint === "string" && typeof value.packageRoot === "string" && isPathInside(root(pluginId), packageRoot) && await stat(packageRoot).then((info): boolean => info.isDirectory()).catch((): boolean => false)) result.push(value);
			} catch { /* Ignore incomplete version snapshots. */ }
		}
	} catch { /* No version directory yet. */ }
	return result.sort((left, right): number => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

export async function getPluginVersion(pluginId: string, fingerprint: string): Promise<(PluginVersionRecord & { record: PluginRecord }) | undefined> {
	try {
		const value = JSON.parse(await readFile(join(root(pluginId), safe(fingerprint), "record.json"), "utf8")) as PluginVersionRecord & { record?: PluginRecord };
		const packageRoot = typeof value.packageRoot === "string" ? resolve(value.packageRoot) : "";
		if (value.fingerprint !== fingerprint || value.record === undefined || !isPathInside(root(pluginId), packageRoot) || !await stat(packageRoot).then((info): boolean => info.isDirectory()).catch((): boolean => false)) return undefined;
		return value as PluginVersionRecord & { record: PluginRecord };
	} catch {
		return undefined;
	}
}
