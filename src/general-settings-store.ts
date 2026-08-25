import { getGeneralSettingsConfigPath } from "./app-paths.js";
import { readJsonFile, writeJsonFileAtomic } from "./json-file-store.js";
import { inspectGodotExecutable, type GodotExecutableAvailability } from "./godot-executable.js";

export type GeneralSettings = {
	schemaVersion: 4;
	nextStepHintsEnabled: boolean;
	autoCompactActivityDetails: boolean;
	godotExecutablePath: string | null;
	godotExecutableVersion: string | null;
	godotExecutableStatus: "unconfigured" | "ready" | "unavailable";
	godotExecutableError: string | null;
	updatedAt: string;
};

export type GeneralSettingsPatch = {
	nextStepHintsEnabled?: boolean | undefined;
	autoCompactActivityDetails?: boolean | undefined;
	godotExecutablePath?: string | null | undefined;
};

export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
	schemaVersion: 4,
	nextStepHintsEnabled: false,
	autoCompactActivityDetails: true,
	godotExecutablePath: null,
	godotExecutableVersion: null,
	godotExecutableStatus: "unconfigured",
	godotExecutableError: null,
	updatedAt: ""
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getPersistedSettings(settings: GeneralSettings): Record<string, unknown> {
	return {
		schemaVersion: settings.schemaVersion,
		nextStepHintsEnabled: settings.nextStepHintsEnabled,
		autoCompactActivityDetails: settings.autoCompactActivityDetails,
		godotExecutablePath: settings.godotExecutablePath,
		godotExecutableVersion: settings.godotExecutableVersion,
		updatedAt: settings.updatedAt
	};
}

export function normalizeGeneralSettings(value: unknown): GeneralSettings {
	if (!isRecord(value) || (value.schemaVersion !== 3 && value.schemaVersion !== 4)) {
		return { ...DEFAULT_GENERAL_SETTINGS };
	}

	const godotExecutablePath: string | null = typeof value.godotExecutablePath === "string"
		? value.godotExecutablePath.trim() || null
		: null;
	return {
		schemaVersion: 4,
		nextStepHintsEnabled: typeof value.nextStepHintsEnabled === "boolean"
			? value.nextStepHintsEnabled
			: DEFAULT_GENERAL_SETTINGS.nextStepHintsEnabled,
		autoCompactActivityDetails: typeof value.autoCompactActivityDetails === "boolean"
			? value.autoCompactActivityDetails
			: DEFAULT_GENERAL_SETTINGS.autoCompactActivityDetails,
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
	const rawSettings: unknown = await readJsonFile<unknown>(getGeneralSettingsConfigPath());
	const settings: GeneralSettings = normalizeGeneralSettings(rawSettings);
	if (isRecord(rawSettings) && rawSettings.schemaVersion === 3) {
		await writeJsonFileAtomic(getGeneralSettingsConfigPath(), getPersistedSettings(settings));
	}
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
		schemaVersion: 4,
		nextStepHintsEnabled: patch.nextStepHintsEnabled ?? current.nextStepHintsEnabled,
		autoCompactActivityDetails: patch.autoCompactActivityDetails ?? current.autoCompactActivityDetails,
		godotExecutablePath,
		godotExecutableVersion,
		godotExecutableStatus: godotExecutablePath === null ? "unconfigured" : "ready",
		godotExecutableError: null,
		updatedAt: new Date().toISOString()
	};
	await writeJsonFileAtomic(getGeneralSettingsConfigPath(), getPersistedSettings(settings));
	return settings;
}

export async function getDefaultGodotExecutablePath(): Promise<string | undefined> {
	const settings: GeneralSettings = normalizeGeneralSettings(await readJsonFile<unknown>(getGeneralSettingsConfigPath()));
	return settings.godotExecutablePath ?? undefined;
}
