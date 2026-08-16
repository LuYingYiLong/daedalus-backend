import { getGeneralSettingsConfigPath } from "./app-paths.js";
import { readJsonFile, writeJsonFileAtomic } from "./json-file-store.js";
import { inspectGodotExecutable, type GodotExecutableAvailability } from "./godot-executable.js";

export type GeneralSettings = {
	schemaVersion: 2;
	nextStepHintsEnabled: boolean;
	fontFamily: string;
	fontFamilyCode: string;
	godotExecutablePath: string | null;
	godotExecutableVersion: string | null;
	godotExecutableStatus: "unconfigured" | "ready" | "unavailable";
	godotExecutableError: string | null;
	updatedAt: string;
};

export type GeneralSettingsPatch = {
	nextStepHintsEnabled?: boolean | undefined;
	fontFamily?: string | undefined;
	fontFamilyCode?: string | undefined;
	godotExecutablePath?: string | null | undefined;
};

export const DEFAULT_FONT_FAMILY: string = '"Mona Sans", "Wen Yuan Sans SC", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
export const DEFAULT_FONT_FAMILY_CODE: string = '"Fira Code", "Cascadia Code", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier, "Mona Sans", "Wen Yuan Sans SC", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", monospace';
const MAX_FONT_FAMILY_LENGTH: number = 512;

export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
	schemaVersion: 2,
	nextStepHintsEnabled: false,
	fontFamily: DEFAULT_FONT_FAMILY,
	fontFamilyCode: DEFAULT_FONT_FAMILY_CODE,
	godotExecutablePath: null,
	godotExecutableVersion: null,
	godotExecutableStatus: "unconfigured",
	godotExecutableError: null,
	updatedAt: ""
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeFontFamily(value: string): boolean {
	return value.length <= MAX_FONT_FAMILY_LENGTH
		&& !/[\u0000-\u001f\u007f;{}<>]/u.test(value)
		&& !/(?:url|expression)\s*\(/iu.test(value);
}

function normalizeStoredFontFamily(value: unknown, fallback: string): string {
	if (typeof value !== "string") {
		return fallback;
	}
	const normalized: string = value.trim();
	return normalized.length > 0 && isSafeFontFamily(normalized) ? normalized : fallback;
}

function normalizeFontFamilyPatch(value: string, fallback: string, fieldName: string): string {
	const normalized: string = value.trim();
	if (normalized.length === 0) {
		return fallback;
	}
	if (!isSafeFontFamily(normalized)) {
		throw new Error(`${fieldName} contains invalid CSS font-family syntax.`);
	}
	return normalized;
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
		fontFamily: normalizeStoredFontFamily(value.fontFamily, DEFAULT_GENERAL_SETTINGS.fontFamily),
		fontFamilyCode: normalizeStoredFontFamily(value.fontFamilyCode, DEFAULT_GENERAL_SETTINGS.fontFamilyCode),
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
	const fontFamily: string = patch.fontFamily === undefined
		? current.fontFamily
		: normalizeFontFamilyPatch(patch.fontFamily, DEFAULT_GENERAL_SETTINGS.fontFamily, "fontFamily");
	const fontFamilyCode: string = patch.fontFamilyCode === undefined
		? current.fontFamilyCode
		: normalizeFontFamilyPatch(patch.fontFamilyCode, DEFAULT_GENERAL_SETTINGS.fontFamilyCode, "fontFamilyCode");
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
		fontFamily,
		fontFamilyCode,
		godotExecutablePath,
		godotExecutableVersion,
		godotExecutableStatus: godotExecutablePath === null ? "unconfigured" : "ready",
		godotExecutableError: null,
		updatedAt: new Date().toISOString()
	};
	await writeJsonFileAtomic(getGeneralSettingsConfigPath(), {
		schemaVersion: settings.schemaVersion,
		nextStepHintsEnabled: settings.nextStepHintsEnabled,
		fontFamily: settings.fontFamily,
		fontFamilyCode: settings.fontFamilyCode,
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
