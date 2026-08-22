import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getDaedalusPath } from "../app-paths.js";
import { writeJsonFileAtomic } from "../json-file-store.js";
import type { PluginProfile, PluginRecord, PluginTrustStatus } from "./types.js";

type PluginStoreDocument = {
	schemaVersion: 1;
	plugins: PluginRecord[];
};

type PluginProfileStoreDocument = {
	schemaVersion: 1;
	profiles: PluginProfile[];
};

type PluginTrustStoreDocument = {
	schemaVersion: 1;
	entries: Record<string, { fingerprint: string; status: PluginTrustStatus; updatedAt: string }>;
};

const EMPTY_PLUGIN_STORE: PluginStoreDocument = { schemaVersion: 1, plugins: [] };
const EMPTY_PROFILE_STORE: PluginProfileStoreDocument = {
	schemaVersion: 1,
	profiles: [{ id: "default", name: "Default", pluginIds: [], active: true, updatedAt: new Date(0).toISOString() }]
};
const EMPTY_TRUST_STORE: PluginTrustStoreDocument = { schemaVersion: 1, entries: {} };

let writeQueue: Promise<void> = Promise.resolve();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isPluginRecord(value: unknown): value is PluginRecord {
	if (!isRecord(value)) return false;
	return typeof value.id === "string" && typeof value.packageName === "string" && typeof value.version === "string" &&
		typeof value.packageRoot === "string" && typeof value.contentHash === "string" && typeof value.manifestHash === "string" &&
		typeof value.fingerprint === "string" && typeof value.installedAt === "string" && typeof value.updatedAt === "string" &&
		(value.trust === "review_required" || value.trust === "trusted" || value.trust === "disabled") && typeof value.enabled === "boolean" &&
		isRecord(value.source) && typeof value.source.type === "string";
}

async function readDocument<T>(path: string, fallback: T): Promise<T> {
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		return value as T;
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(fallback);
		// A damaged settings file must never prevent the backend from starting.
		// Preserve it for diagnostics and continue with a safe empty document.
		try { await rename(path, `${path}.corrupt-${Date.now()}`); } catch { /* Keep the fallback usable even when the backup cannot be made. */ }
		return structuredClone(fallback);
	}
}

function normalizePlugins(value: PluginStoreDocument): PluginStoreDocument {
	if (value.schemaVersion !== 1 || !Array.isArray(value.plugins)) return structuredClone(EMPTY_PLUGIN_STORE);
	return { schemaVersion: 1, plugins: value.plugins.filter(isPluginRecord) };
}

function normalizeProfiles(value: PluginProfileStoreDocument): PluginProfileStoreDocument {
	if (value.schemaVersion !== 1 || !Array.isArray(value.profiles)) return structuredClone(EMPTY_PROFILE_STORE);
	const profiles: PluginProfile[] = value.profiles.filter((profile): profile is PluginProfile => typeof profile?.id === "string" && typeof profile.name === "string" && Array.isArray(profile.pluginIds) && profile.pluginIds.every((pluginId): pluginId is string => typeof pluginId === "string") && typeof profile.active === "boolean" && typeof profile.updatedAt === "string");
	if (!profiles.some((profile): boolean => profile.active)) {
		profiles[0] = profiles[0] ?? structuredClone(EMPTY_PROFILE_STORE.profiles[0]!);
		profiles[0].active = true;
	}
	return { schemaVersion: 1, profiles };
}

function normalizeTrust(value: PluginTrustStoreDocument): PluginTrustStoreDocument {
	if (value.schemaVersion !== 1 || typeof value.entries !== "object" || value.entries === null) return structuredClone(EMPTY_TRUST_STORE);
	return value;
}

export async function readPluginRecords(): Promise<PluginRecord[]> {
	return (await readDocument(getDaedalusPath("plugins.records"), EMPTY_PLUGIN_STORE).then(normalizePlugins)).plugins;
}

export async function readPluginProfiles(): Promise<PluginProfile[]> {
	const profiles = (await readDocument(getDaedalusPath("plugins.profiles"), EMPTY_PROFILE_STORE).then(normalizeProfiles)).profiles;
	const installed = new Set((await readPluginRecords()).map((record): string => record.id));
	return profiles.map((profile): PluginProfile => ({ ...profile, pluginIds: profile.pluginIds.filter((pluginId): boolean => installed.has(pluginId)) }));
}

export async function readPluginTrust(): Promise<PluginTrustStoreDocument["entries"]> {
	return (await readDocument(getDaedalusPath("plugins.trust"), EMPTY_TRUST_STORE).then(normalizeTrust)).entries;
}

export async function updatePluginState(mutator: (records: PluginRecord[]) => PluginRecord[]): Promise<PluginRecord[]> {
	const operation: Promise<PluginRecord[]> = writeQueue.then(async (): Promise<PluginRecord[]> => {
		const records: PluginRecord[] = mutator(await readPluginRecords());
		await writeJsonFileAtomic(getDaedalusPath("plugins.records"), { schemaVersion: 1, plugins: records } satisfies PluginStoreDocument);
		return records;
	});
	writeQueue = operation.then((): void => undefined, (): void => undefined);
	return await operation;
}

export async function updatePluginProfiles(mutator: (profiles: PluginProfile[]) => PluginProfile[]): Promise<PluginProfile[]> {
	const operation: Promise<PluginProfile[]> = writeQueue.then(async (): Promise<PluginProfile[]> => {
		const profiles: PluginProfile[] = mutator(await readPluginProfiles());
		await writeJsonFileAtomic(getDaedalusPath("plugins.profiles"), { schemaVersion: 1, profiles } satisfies PluginProfileStoreDocument);
		return profiles;
	});
	writeQueue = operation.then((): void => undefined, (): void => undefined);
	return await operation;
}

export async function updatePluginTrust(mutator: (entries: PluginTrustStoreDocument["entries"]) => PluginTrustStoreDocument["entries"]): Promise<PluginTrustStoreDocument["entries"]> {
	const operation: Promise<PluginTrustStoreDocument["entries"]> = writeQueue.then(async (): Promise<PluginTrustStoreDocument["entries"]> => {
		const entries = mutator(await readPluginTrust());
		await writeJsonFileAtomic(getDaedalusPath("plugins.trust"), { schemaVersion: 1, entries } satisfies PluginTrustStoreDocument);
		return entries;
	});
	writeQueue = operation.then((): void => undefined, (): void => undefined);
	return await operation;
}

export async function appendPluginAudit(event: Record<string, unknown>): Promise<void> {
	const safeEvent: Record<string, unknown> = {
		...event,
		at: typeof event.at === "string" ? event.at : new Date().toISOString()
	};
	await mkdir(dirname(getDaedalusPath("plugins.audit")), { recursive: true });
	const auditPath = getDaedalusPath("plugins.audit");
	await appendFile(auditPath, `${JSON.stringify(safeEvent)}\n`, "utf8");
	try {
		const info = await stat(auditPath);
		if (info.size > 2 * 1024 * 1024 || (await readFile(auditPath, "utf8")).split(/\r?\n/u).filter(Boolean).length > 5000) {
			const lines = (await readFile(auditPath, "utf8")).split(/\r?\n/u).filter(Boolean).slice(-5000);
			let kept = lines.join("\n") + "\n";
			while (Buffer.byteLength(kept, "utf8") > 2 * 1024 * 1024 && lines.length > 1) {
				lines.shift();
				kept = lines.join("\n") + "\n";
			}
			await writeFile(auditPath, kept, "utf8");
		}
	} catch {
		// 审计日志裁剪失败不影响插件操作，下一次写入继续尝试
	}
}

export function getActivePluginProfile(profiles: readonly PluginProfile[]): PluginProfile {
	return profiles.find((profile): boolean => profile.active) ?? profiles[0] ?? {
		id: "default",
		name: "Default",
		pluginIds: [],
		active: true,
		updatedAt: new Date(0).toISOString()
	};
}
