import { readJsonFile, writeJsonFileAtomic } from "../../json-file-store.js";
import { getDaedalusPath } from "../../app-paths.js";
import type { PluginIsolationState } from "../types.js";
import { PLUGIN_FAILURE_THRESHOLD, PLUGIN_FAILURE_WINDOW_MS } from "./runtime-limits.js";

type StoredEntry = PluginIsolationState & { pluginId: string; sessionId: string };
type StoredDocument = { schemaVersion: 1; entries: StoredEntry[] };

const EMPTY: StoredDocument = { schemaVersion: 1, entries: [] };
let writeQueue: Promise<void> = Promise.resolve();

function key(pluginId: string, sessionId: string): string { return `${pluginId}\0${sessionId}`; }

async function readEntries(): Promise<StoredEntry[]> {
	const value = await readJsonFile<unknown>(getDaedalusPath("plugins.quarantine"));
	if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
	const entries = (value as { schemaVersion?: unknown; entries?: unknown }).entries;
	if ((value as { schemaVersion?: unknown }).schemaVersion !== 1 || !Array.isArray(entries)) return [];
	return entries.filter((entry): entry is StoredEntry => {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
		const item = entry as Record<string, unknown>;
		return typeof item.pluginId === "string" && typeof item.sessionId === "string" && (item.status === "none" || item.status === "quarantined") && typeof item.failureCount === "number" && typeof item.updatedAt === "string";
	});
}

async function writeEntriesUnlocked(entries: StoredEntry[]): Promise<void> {
	await writeJsonFileAtomic(getDaedalusPath("plugins.quarantine"), { ...EMPTY, entries });
}

export async function getPluginIsolation(pluginId: string, sessionId: string): Promise<PluginIsolationState | undefined> {
	const entry = (await readEntries()).find((candidate): boolean => key(candidate.pluginId, candidate.sessionId) === key(pluginId, sessionId));
	return entry === undefined ? undefined : structuredClone(entry);
}

export async function recordPluginFailure(pluginId: string, sessionId: string, reason: string): Promise<PluginIsolationState> {
	let result!: PluginIsolationState;
	const operation = writeQueue.then(async (): Promise<void> => {
		const now = new Date();
		const entries = await readEntries();
		const current = entries.find((entry): boolean => key(entry.pluginId, entry.sessionId) === key(pluginId, sessionId));
		const windowStartedAt = current?.windowStartedAt !== undefined && now.getTime() - Date.parse(current.windowStartedAt) <= PLUGIN_FAILURE_WINDOW_MS ? current.windowStartedAt : now.toISOString();
		const failureCount = (current?.windowStartedAt === windowStartedAt ? current.failureCount : 0) + 1;
		result = { status: failureCount >= PLUGIN_FAILURE_THRESHOLD ? "quarantined" : "none", reason, failureCount, windowStartedAt, lastFailureAt: now.toISOString(), updatedAt: now.toISOString() };
		const next = entries.filter((entry): boolean => key(entry.pluginId, entry.sessionId) !== key(pluginId, sessionId));
		next.push({ pluginId, sessionId, ...result });
		await writeEntriesUnlocked(next);
	});
	writeQueue = operation.catch((): void => undefined);
	await operation;
	return result;
}

export async function clearPluginQuarantine(pluginId: string, sessionId?: string): Promise<void> {
	const operation = writeQueue.then(async (): Promise<void> => {
		const entries = await readEntries();
		await writeEntriesUnlocked(entries.filter((entry): boolean => entry.pluginId !== pluginId || sessionId !== undefined && entry.sessionId !== sessionId));
	});
	writeQueue = operation.catch((): void => undefined);
	await operation;
}

export async function listPluginQuarantines(pluginId?: string): Promise<StoredEntry[]> {
	return (await readEntries()).filter((entry): boolean => pluginId === undefined || entry.pluginId === pluginId).map((entry): StoredEntry => structuredClone(entry));
}
