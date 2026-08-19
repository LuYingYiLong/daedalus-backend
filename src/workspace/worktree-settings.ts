import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { getWorktreeSettingsConfigPath, getWorktreesRoot } from "../app-paths.js";

export type WorktreeSettings = {
	rootDirectory: string;
	fetchBeforeCreate: boolean;
	autoDeleteManaged: boolean;
	autoDeleteLimit: number;
};

const DEFAULT_AUTO_DELETE_LIMIT = 10;

export function getDefaultWorktreeSettings(): WorktreeSettings {
	return { rootDirectory: getWorktreesRoot(), fetchBeforeCreate: false, autoDeleteManaged: false, autoDeleteLimit: DEFAULT_AUTO_DELETE_LIMIT };
}

function normalize(value: unknown): WorktreeSettings {
	const defaults = getDefaultWorktreeSettings();
	if (typeof value !== "object" || value === null || Array.isArray(value)) return defaults;
	const input = value as Record<string, unknown>;
	const rootDirectory = typeof input.rootDirectory === "string" && input.rootDirectory.trim().length > 0 ? resolve(input.rootDirectory.trim()) : defaults.rootDirectory;
	return {
		rootDirectory,
		fetchBeforeCreate: input.fetchBeforeCreate === true,
		autoDeleteManaged: input.autoDeleteManaged === true,
		autoDeleteLimit: typeof input.autoDeleteLimit === "number" && Number.isInteger(input.autoDeleteLimit) ? Math.min(100, Math.max(1, input.autoDeleteLimit)) : defaults.autoDeleteLimit
	};
}

export async function readWorktreeSettings(): Promise<WorktreeSettings> {
	try { return normalize(JSON.parse(await readFile(getWorktreeSettingsConfigPath(), "utf8")) as unknown); }
	catch { return getDefaultWorktreeSettings(); }
}

export async function updateWorktreeSettings(patch: { rootDirectory?: string | null | undefined; fetchBeforeCreate?: boolean | undefined; autoDeleteManaged?: boolean | undefined; autoDeleteLimit?: number | undefined }): Promise<WorktreeSettings> {
	const current = await readWorktreeSettings();
	const next = normalize({
		...current,
		...(patch.rootDirectory === undefined ? {} : { rootDirectory: patch.rootDirectory }),
		...(patch.fetchBeforeCreate === undefined ? {} : { fetchBeforeCreate: patch.fetchBeforeCreate }),
		...(patch.autoDeleteManaged === undefined ? {} : { autoDeleteManaged: patch.autoDeleteManaged }),
		...(patch.autoDeleteLimit === undefined ? {} : { autoDeleteLimit: patch.autoDeleteLimit })
	});
	const path = getWorktreeSettingsConfigPath();
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	await rename(temporaryPath, path);
	return next;
}
