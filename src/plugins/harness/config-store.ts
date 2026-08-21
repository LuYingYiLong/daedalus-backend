import { createHash } from "node:crypto";
import { readJsonFile, writeJsonFileAtomic } from "../../json-file-store.js";
import { getDaedalusPath } from "../../app-paths.js";
import { updatePluginProfiles, updatePluginState, updatePluginTrust } from "../store.js";
import type { HarnessRuntimeConfig, PluginRecord } from "../types.js";
import { HARNESS_BRIDGE_PROTOCOL_VERSION } from "./limits.js";

type StoredHarnessConfig = Omit<HarnessRuntimeConfig, "revision">;

const EMPTY_CONFIG: StoredHarnessConfig = {
	enabled: false,
	executablePath: null,
	sourceRoot: null,
	launchMode: "installed",
	bridgeProtocolVersion: HARNESS_BRIDGE_PROTOCOL_VERSION,
	network: "disabled",
	updatedAt: new Date(0).toISOString()
};

let writeQueue: Promise<void> = Promise.resolve();

function revisionOf(config: StoredHarnessConfig): string {
	return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

function normalize(value: unknown): StoredHarnessConfig {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return structuredClone(EMPTY_CONFIG);
	const config = value as Partial<StoredHarnessConfig>;
	return {
		enabled: config.enabled === true,
		executablePath: typeof config.executablePath === "string" && config.executablePath.trim().length > 0 ? config.executablePath.trim() : null,
		sourceRoot: typeof config.sourceRoot === "string" && config.sourceRoot.trim().length > 0 ? config.sourceRoot.trim() : null,
		launchMode: config.launchMode === "source" ? "source" : "installed",
		bridgeProtocolVersion: HARNESS_BRIDGE_PROTOCOL_VERSION,
		network: "disabled",
		updatedAt: typeof config.updatedAt === "string" ? config.updatedAt : EMPTY_CONFIG.updatedAt
	};
}

export async function readHarnessRuntimeConfig(): Promise<HarnessRuntimeConfig> {
	const stored: StoredHarnessConfig = normalize(await readJsonFile<unknown>(getDaedalusPath("plugins.harnessConfig")));
	return { ...stored, revision: revisionOf(stored) };
}

export async function updateHarnessRuntimeConfig(
	input: Omit<HarnessRuntimeConfig, "revision" | "updatedAt" | "bridgeProtocolVersion" | "network">,
	expectedRevision: string
): Promise<{ config: HarnessRuntimeConfig; changed: boolean }> {
	let result!: { config: HarnessRuntimeConfig; changed: boolean };
	const operation = writeQueue.then(async (): Promise<void> => {
		const current = await readHarnessRuntimeConfig();
		if (current.revision !== expectedRevision) {
			throw Object.assign(new Error("Harness runtime configuration changed externally. Reload it before saving."), { code: "plugin_harness_revision_conflict" });
		}
		const nextStored: StoredHarnessConfig = normalize({
			enabled: input.enabled,
			executablePath: input.executablePath,
			sourceRoot: input.sourceRoot,
			launchMode: input.launchMode,
			updatedAt: new Date().toISOString()
		});
		const changed: boolean = current.enabled !== nextStored.enabled || current.executablePath !== nextStored.executablePath || current.sourceRoot !== nextStored.sourceRoot || current.launchMode !== nextStored.launchMode;
		await writeJsonFileAtomic(getDaedalusPath("plugins.harnessConfig"), nextStored);
		result = { config: { ...nextStored, revision: revisionOf(nextStored) }, changed };
	});
	writeQueue = operation.catch((): void => undefined);
	await operation;
	return result;
}

export async function invalidateHarnessPluginTrust(pluginId?: string): Promise<void> {
	const updatedAt: string = new Date().toISOString();
	const affected: PluginRecord[] = await updatePluginState((records): PluginRecord[] => records.map((record): PluginRecord => {
		if (!record.compatibility.harnessBundle || pluginId !== undefined && record.id !== pluginId) return record;
		const { harnessRuntimeFingerprint: _fingerprint, ...rest } = record;
		return { ...rest, trust: "review_required", enabled: false, updatedAt };
	}));
	const affectedIds = new Set(affected.filter((record): boolean => record.compatibility.harnessBundle && (pluginId === undefined || record.id === pluginId)).map((record): string => record.id));
	await updatePluginTrust((entries): typeof entries => {
		const next = { ...entries };
		for (const record of affected) {
			if (affectedIds.has(record.id)) next[record.id] = { fingerprint: record.fingerprint, status: "review_required", updatedAt };
		}
		return next;
	});
	await updatePluginProfiles((profiles) => profiles.map((profile) => ({ ...profile, pluginIds: profile.pluginIds.filter((id): boolean => !affectedIds.has(id)), updatedAt })));
}
