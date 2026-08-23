import { copyFile, readFile } from "node:fs/promises";
import { getDaedalusPath } from "../../app-paths.js";
import { writeJsonFileAtomic } from "../../json-file-store.js";
import { broadcastGlobalEvent } from "../../server/client-connections.js";
import type { PluginDevelopmentDiagnostic, PluginDevelopmentStatus, PluginDevelopmentTestResult } from "./types.js";
import { boundPluginDiagnostics } from "./diagnostics.js";

type StatusStore = { schemaVersion: 1; statuses: PluginDevelopmentStatus[] };
const EMPTY: StatusStore = { schemaVersion: 1, statuses: [] };
let cached: Map<string, PluginDevelopmentStatus> | null = null;
let writeQueue: Promise<void> = Promise.resolve();

function normalizeStatus(value: unknown): PluginDevelopmentStatus | null {
	if (typeof value !== "object" || value === null) return null;
	const item = value as Record<string, unknown>;
	if (typeof item.slug !== "string" || typeof item.revision !== "string" || typeof item.updatedAt !== "string") return null;
	const phases = ["idle", "preparing", "validating", "awaiting_install", "awaiting_trust", "testing", "passed", "failed", "exhausted", "cancelled", "interrupted"] as const;
	const phase = phases.includes(item.phase as typeof phases[number]) ? item.phase as typeof phases[number] : "idle";
	const staticAttempt = typeof item.staticAttempt === "number" ? Math.max(0, Math.min(3, Math.trunc(item.staticAttempt))) : 0;
	const runtimeAttempt = typeof item.runtimeAttempt === "number" ? Math.max(0, Math.min(3, Math.trunc(item.runtimeAttempt))) : 0;
	return {
		slug: item.slug,
		revision: item.revision,
		phase,
		staticAttempt,
		runtimeAttempt,
		staticAttemptsRemaining: Math.max(0, 3 - staticAttempt),
		runtimeAttemptsRemaining: Math.max(0, 3 - runtimeAttempt),
		lastDiagnostics: Array.isArray(item.lastDiagnostics) ? boundPluginDiagnostics(item.lastDiagnostics.filter((entry): entry is PluginDevelopmentDiagnostic => typeof entry === "object" && entry !== null && typeof (entry as Record<string, unknown>).code === "string" && typeof (entry as Record<string, unknown>).message === "string")) : [],
		...(item.lastTest !== undefined ? { lastTest: item.lastTest as PluginDevelopmentTestResult } : {}),
		updatedAt: item.updatedAt
	};
}

async function load(): Promise<Map<string, PluginDevelopmentStatus>> {
	if (cached !== null) return cached;
	try {
		const parsed: unknown = JSON.parse(await readFile(getDaedalusPath("plugins.developmentStatus"), "utf8"));
		const store = typeof parsed === "object" && parsed !== null && (parsed as Record<string, unknown>).schemaVersion === 1 && Array.isArray((parsed as Record<string, unknown>).statuses) ? parsed as StatusStore : EMPTY;
		cached = new Map(store.statuses.map((status) => [status.slug, normalizeStatus(status)]).filter((entry): entry is [string, PluginDevelopmentStatus] => entry[1] !== null));
		for (const [slug, status] of cached) if (["preparing", "validating", "testing"].includes(status.phase)) cached.set(slug, { ...status, phase: "interrupted", updatedAt: new Date().toISOString() });
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			await copyFile(getDaedalusPath("plugins.developmentStatus"), `${getDaedalusPath("plugins.developmentStatus")}.corrupt-${Date.now().toString(36)}`).catch((): void => undefined);
		}
		cached = new Map();
	}
	return cached;
}

async function persist(): Promise<void> {
	const current = cached ?? await load();
	const snapshot: StatusStore = { schemaVersion: 1, statuses: [...current.values()].slice(-100) };
	writeQueue = writeQueue.then(() => writeJsonFileAtomic(getDaedalusPath("plugins.developmentStatus"), snapshot));
	await writeQueue;
}

export async function updatePluginDevelopmentStatus(slug: string, patch: Partial<PluginDevelopmentStatus> & { revision?: string; lastDiagnostics?: PluginDevelopmentDiagnostic[]; lastTest?: PluginDevelopmentTestResult }): Promise<PluginDevelopmentStatus> {
	const statuses = await load();
	const previous = statuses.get(slug);
	const next: PluginDevelopmentStatus = {
		slug,
		revision: patch.revision ?? previous?.revision ?? "",
		phase: patch.phase ?? previous?.phase ?? "idle",
		staticAttempt: patch.staticAttempt ?? previous?.staticAttempt ?? 0,
		runtimeAttempt: patch.runtimeAttempt ?? previous?.runtimeAttempt ?? 0,
		staticAttemptsRemaining: Math.max(0, 3 - (patch.staticAttempt ?? previous?.staticAttempt ?? 0)),
		runtimeAttemptsRemaining: Math.max(0, 3 - (patch.runtimeAttempt ?? previous?.runtimeAttempt ?? 0)),
		lastDiagnostics: boundPluginDiagnostics(patch.lastDiagnostics ?? previous?.lastDiagnostics ?? []),
		...(patch.lastTest === undefined ? previous?.lastTest === undefined ? {} : { lastTest: previous.lastTest } : { lastTest: patch.lastTest }),
		updatedAt: new Date().toISOString()
	};
	statuses.set(slug, next);
	await persist();
	broadcastGlobalEvent(`plugin-development-${slug}`, "plugin.development.updated", { slug, revision: next.revision, phase: next.phase, staticAttempt: next.staticAttempt, runtimeAttempt: next.runtimeAttempt, staticAttemptsRemaining: next.staticAttemptsRemaining, runtimeAttemptsRemaining: next.runtimeAttemptsRemaining, diagnosticCount: next.lastDiagnostics.length, lastError: next.lastDiagnostics.find((item) => item.severity === "error")?.message });
	return next;
}

export async function getPluginDevelopmentStatus(slug: string): Promise<PluginDevelopmentStatus | null> {
	return (await load()).get(slug) ?? null;
}

export async function listPluginDevelopmentStatuses(): Promise<PluginDevelopmentStatus[]> {
	return [...(await load()).values()];
}

export async function initializePluginDevelopmentStatusStore(): Promise<void> {
	await load();
	await persist();
}
