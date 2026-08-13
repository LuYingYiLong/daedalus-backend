import { getGeneralSettingsConfigPath } from "./app-paths.js";
import { readJsonFile, writeJsonFileAtomic } from "./json-file-store.js";
import { inspectGodotExecutable, type GodotExecutableAvailability } from "./godot-executable.js";

export type GeneralSettings = {
	schemaVersion: 2;
	nextStepHintsEnabled: boolean;
	godotExecutablePath: string | null;
	godotExecutableVersion: string | null;
	godotExecutableStatus: "unconfigured" | "ready" | "unavailable";
	godotExecutableError: string | null;
	updatedAt: string;
};

export type GeneralSettingsPatch = {
	nextStepHintsEnabled?: boolean | undefined;
	godotExecutablePath?: string | null | undefined;
};

export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
	schemaVersion: 2,
	nextStepHintsEnabled: false,
	godotExecutablePath: null,
	godotExecutableVersion: null,
	godotExecutableStatus: "unconfigured",
	godotExecutableError: null,
	updatedAt: ""
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeGeneralSettings(value: unknown): GeneralSettings {
	if (!isRecord(value) || value.schemaVersion !== 2) {
		return { ...DEFAULT_GENERAL_SETTINGS };
	}

	const godotExecutablePath: string | null = typeof value.godotExecutablePath === "string"
		? value.godotExecutablePath.trim() || null
		: null;
	return {
		schemaVersion: 2,
		nextStepHintsEnabled: typeof value.nextStepHintsEnabled === "boolean"
			? value.nextStepHintsEnabled
			: DEFAULT_GENERAL_SETTINGS.nextStepHintsEnabled,
		godotExecutablePath,
		godotExecutableVersion: typeof value.godotExecutableVersion === "string"
			? value.godotExecutableVersion
			: null,
		godotExecutableStatus: godotExecutablePath === null ? "unconfigured" : "unavailable",
		godotExecutableError: null,
		updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : ""
	};
}

export async function getGeneralSettings(): Promise<GeneralSettings> {
	const settings: GeneralSettings = normalizeGeneralSettings(await readJsonFile<unknown>(getGeneralSettingsConfigPath()));
	if (settings.godotExecutablePath === null) {
		return settings;
	}
	const availability: GodotExecutableAvailability = await inspectGodotExecutable(settings.godotExecutablePath, {
		requireAbsoluteFile: true
	});
	return {
		...settings,
		godotExecutableVersion: availability.version,
		godotExecutableStatus: availability.status,
		godotExecutableError: availability.error
	};
}

export async function updateGeneralSettings(patch: GeneralSettingsPatch): Promise<GeneralSettings> {
	const current: GeneralSettings = normalizeGeneralSettings(await readJsonFile<unknown>(getGeneralSettingsConfigPath()));
	let godotExecutablePath: string | null = current.godotExecutablePath;
	let godotExecutableVersion: string | null = current.godotExecutableVersion;
	if (patch.godotExecutablePath !== undefined) {
		godotExecutablePath = patch.godotExecutablePath?.trim() || null;
		godotExecutableVersion = null;
		if (godotExecutablePath !== null) {
			const availability: GodotExecutableAvailability = await inspectGodotExecutable(godotExecutablePath, {
				requireAbsoluteFile: true
			});
			if (availability.status !== "ready") {
				throw new Error(availability.error ?? "Godot executable is unavailable.");
			}
			godotExecutableVersion = availability.version;
		}
	}
	const settings: GeneralSettings = {
		schemaVersion: 2,
		nextStepHintsEnabled: patch.nextStepHintsEnabled ?? current.nextStepHintsEnabled,
		godotExecutablePath,
		godotExecutableVersion,
		godotExecutableStatus: godotExecutablePath === null ? "unconfigured" : "ready",
		godotExecutableError: null,
		updatedAt: new Date().toISOString()
	};
	await writeJsonFileAtomic(getGeneralSettingsConfigPath(), {
		schemaVersion: settings.schemaVersion,
		nextStepHintsEnabled: settings.nextStepHintsEnabled,
		godotExecutablePath: settings.godotExecutablePath,
		godotExecutableVersion: settings.godotExecutableVersion,
		updatedAt: settings.updatedAt
	});
	return settings;
}

export async function getDefaultGodotExecutablePath(): Promise<string | undefined> {
	const settings: GeneralSettings = normalizeGeneralSettings(await readJsonFile<unknown>(getGeneralSettingsConfigPath()));
	return settings.godotExecutablePath ?? undefined;
}
