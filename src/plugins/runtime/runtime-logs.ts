import { randomUUID } from "node:crypto";
import type { PluginRuntimeLog } from "../types.js";
import { MAX_PLUGIN_LOGS } from "./runtime-limits.js";

const records: PluginRuntimeLog[] = [];

export function addPluginRuntimeLog(record: Omit<PluginRuntimeLog, "id" | "createdAt">): void {
	records.unshift({ ...record, id: randomUUID(), createdAt: new Date().toISOString() });
	if (records.length > MAX_PLUGIN_LOGS) records.length = MAX_PLUGIN_LOGS;
}

export function listPluginRuntimeLogs(pluginId?: string, limit: number = MAX_PLUGIN_LOGS): PluginRuntimeLog[] {
	return records.filter((record): boolean => pluginId === undefined || record.pluginId === pluginId).slice(0, Math.max(1, Math.min(MAX_PLUGIN_LOGS, limit))).map((record): PluginRuntimeLog => structuredClone(record));
}

export function clearPluginRuntimeLogs(pluginId?: string): void {
	if (pluginId === undefined) records.length = 0;
	else {
		for (let index = records.length - 1; index >= 0; index -= 1) if (records[index]!.pluginId === pluginId) records.splice(index, 1);
	}
}
