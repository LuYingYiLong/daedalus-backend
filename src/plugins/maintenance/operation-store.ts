import { randomUUID } from "node:crypto";
import { copyFile, readFile } from "node:fs/promises";
import { getDaedalusPath } from "../../app-paths.js";
import { writeJsonFileAtomic } from "../../json-file-store.js";
import { broadcastGlobalEvent } from "../../server/client-connections.js";
import type { PluginMaintenanceKind, PluginMaintenanceOperation, PluginMaintenanceStage } from "./maintenance-types.js";

type Store = { schemaVersion: 1; operations: PluginMaintenanceOperation[] };
const EMPTY: Store = { schemaVersion: 1, operations: [] };
let cache: Map<string, PluginMaintenanceOperation> | null = null;
let queue: Promise<void> = Promise.resolve();

async function load(): Promise<Map<string, PluginMaintenanceOperation>> {
	if (cache !== null) return cache;
	try {
		const parsed = JSON.parse(await readFile(getDaedalusPath("plugins.maintenance"), "utf8")) as Store;
		cache = new Map((parsed.schemaVersion === 1 && Array.isArray(parsed.operations) ? parsed.operations : EMPTY.operations).filter((item): item is PluginMaintenanceOperation => typeof item?.id === "string" && typeof item.pluginId === "string").map((item): [string, PluginMaintenanceOperation] => [item.id, item]));
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") await copyFile(getDaedalusPath("plugins.maintenance"), `${getDaedalusPath("plugins.maintenance")}.corrupt-${Date.now().toString(36)}`).catch((): void => undefined);
		cache = new Map();
	}
	return cache;
}

async function persist(): Promise<void> {
	const current = cache ?? await load();
	const snapshot: Store = { schemaVersion: 1, operations: [...current.values()].slice(-100) };
	queue = queue.then(() => writeJsonFileAtomic(getDaedalusPath("plugins.maintenance"), snapshot));
	await queue;
}

export async function createMaintenanceOperation(input: { pluginId: string; kind: PluginMaintenanceKind; expectedFingerprint?: string }): Promise<PluginMaintenanceOperation> {
	const now = new Date().toISOString();
	const operation: PluginMaintenanceOperation = { id: `plugin-op-${randomUUID()}`, pluginId: input.pluginId, kind: input.kind, stage: "preflight", status: "running", startedAt: now, updatedAt: now, ...(input.expectedFingerprint === undefined ? {} : { expectedFingerprint: input.expectedFingerprint }) };
	const operations = await load();
	operations.set(operation.id, operation);
	await persist();
	return operation;
}

export async function updateMaintenanceOperation(id: string, patch: Partial<PluginMaintenanceOperation>): Promise<PluginMaintenanceOperation> {
	const operations = await load();
	const current = operations.get(id);
	if (current === undefined) throw Object.assign(new Error("Maintenance operation was not found."), { code: "plugin_operation_not_found" });
	const next: PluginMaintenanceOperation = { ...current, ...patch, updatedAt: new Date().toISOString() };
	operations.set(id, next);
	await persist();
	broadcastGlobalEvent(`plugin-maintenance-${next.pluginId}`, "plugin.maintenance.updated", { id: next.id, pluginId: next.pluginId, kind: next.kind, stage: next.stage, status: next.status, progress: next.progress, error: next.error });
	return next;
}

export async function getMaintenanceOperation(id: string): Promise<PluginMaintenanceOperation | null> {
	return (await load()).get(id) ?? null;
}

export async function initializeMaintenanceOperationStore(): Promise<void> {
	await load();
}

export function isMaintenanceStage(value: string): value is PluginMaintenanceStage {
	return ["preflight", "staging", "static_validation", "sandbox_test", "changelog_draft", "artifact", "awaiting_confirmation", "publishing", "completed", "failed", "cancelled"].includes(value);
}
