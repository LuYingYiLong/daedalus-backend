import { copyFile, readFile } from "node:fs/promises";
import { getDaedalusPath } from "../../app-paths.js";
import { writeJsonFileAtomic } from "../../json-file-store.js";
import { boundPluginDiagnostics } from "../development/diagnostics.js";
import type { PluginDevelopmentTestResult } from "../development/types.js";
import type { PluginDevelopmentRunRecord } from "./maintenance-types.js";

type Store = { schemaVersion: 1; runs: PluginDevelopmentRunRecord[] };
const EMPTY: Store = { schemaVersion: 1, runs: [] };
let cache: PluginDevelopmentRunRecord[] | null = null;
let queue: Promise<void> = Promise.resolve();

async function load(): Promise<PluginDevelopmentRunRecord[]> {
	if (cache !== null) return cache;
	try {
		const parsed = JSON.parse(await readFile(getDaedalusPath("plugins.developmentRuns"), "utf8")) as Store;
		cache = parsed.schemaVersion === 1 && Array.isArray(parsed.runs) ? parsed.runs.filter((item): item is PluginDevelopmentRunRecord => typeof item?.runId === "string" && typeof item.pluginId === "string") : [];
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			await copyFile(getDaedalusPath("plugins.developmentRuns"), `${getDaedalusPath("plugins.developmentRuns")}.corrupt-${Date.now().toString(36)}`).catch((): void => undefined);
		}
		cache = [];
	}
	return cache;
}

async function persist(): Promise<void> {
	const runs = cache ?? await load();
	queue = queue.then(() => writeJsonFileAtomic(getDaedalusPath("plugins.developmentRuns"), { schemaVersion: 1, runs: runs.slice(-100) } satisfies Store));
	await queue;
}

export async function recordPluginDevelopmentRun(input: { pluginId: string; revision: string; trigger: PluginDevelopmentRunRecord["trigger"]; result: PluginDevelopmentTestResult }): Promise<PluginDevelopmentRunRecord> {
	const record: PluginDevelopmentRunRecord = { runId: input.result.runId, pluginId: input.pluginId, revision: input.revision, trigger: input.trigger, result: { ...input.result, diagnostics: boundPluginDiagnostics(input.result.diagnostics) }, diagnostics: boundPluginDiagnostics(input.result.diagnostics), createdAt: new Date().toISOString() };
	const runs = await load();
	const otherRuns = runs.filter((item): boolean => item.pluginId !== input.pluginId);
	const pluginRuns = runs.filter((item): boolean => item.pluginId === input.pluginId).slice(-19);
	cache = [...otherRuns, ...pluginRuns, record].sort((left, right): number => Date.parse(left.createdAt) - Date.parse(right.createdAt)).slice(-100);
	await persist();
	return record;
}

export async function listPluginDevelopmentRuns(pluginId?: string, limit: number = 20): Promise<PluginDevelopmentRunRecord[]> {
	const runs = await load();
	return runs.filter((item): boolean => pluginId === undefined || item.pluginId === pluginId).slice(-Math.min(100, Math.max(1, limit))).reverse();
}

export async function getPluginDevelopmentRun(runId: string): Promise<PluginDevelopmentRunRecord | null> {
	return (await load()).find((item): boolean => item.runId === runId) ?? null;
}

export async function initializePluginDevelopmentRunStore(): Promise<void> {
	await load();
}
