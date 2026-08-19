import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { getEnvironmentTrustConfigPath } from "../app-paths.js";
import { readJsonFile, writeJsonFileAtomic } from "../json-file-store.js";
import type {
	LocalEnvironmentAction,
	LocalEnvironmentConfig,
	LocalEnvironmentProfile,
	PlatformScripts,
	WorkspaceConfig,
	WorkspaceSourceFolder
} from "./types.js";

const MAX_CONFIG_BYTES: number = 256 * 1024;
const ID_PATTERN: RegExp = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SCRIPT_MAX_LENGTH: number = 32_768;

const platformScriptsSchema = z.object({
	default: z.string().max(SCRIPT_MAX_LENGTH).optional(),
	windows: z.string().max(SCRIPT_MAX_LENGTH).optional(),
	macos: z.string().max(SCRIPT_MAX_LENGTH).optional(),
	linux: z.string().max(SCRIPT_MAX_LENGTH).optional()
}).strict().refine((value): boolean => Object.values(value).some((script): boolean => typeof script === "string" && script.trim().length > 0), {
	message: "At least one platform script is required."
});

const actionSchema = z.object({
	id: z.string().regex(ID_PATTERN),
	name: z.string().trim().min(1).max(100),
	icon: z.string().trim().min(1).max(64).optional(),
	scripts: platformScriptsSchema,
	network: z.boolean().optional()
}).strict();

const profileSchema = z.object({
	id: z.string().regex(ID_PATTERN),
	name: z.string().trim().min(1).max(100),
	description: z.string().max(1000).optional(),
	setup: z.object({
		scripts: platformScriptsSchema,
		timeoutSeconds: z.number().int().min(1).max(3600).optional(),
		network: z.boolean().optional()
	}).strict().optional(),
	actions: z.array(actionSchema).max(30)
}).strict();

const configSchema: z.ZodType<LocalEnvironmentConfig> = z.object({
	version: z.literal(1),
	defaultEnvironmentId: z.string().regex(ID_PATTERN).nullable().optional(),
	environments: z.array(profileSchema).max(20)
}).strict().superRefine((value, context): void => {
	const ids: Set<string> = new Set();
	for (const [index, profile] of value.environments.entries()) {
		if (ids.has(profile.id)) context.addIssue({ code: "custom", path: ["environments", index, "id"], message: "Environment ids must be unique." });
		ids.add(profile.id);
		const actionIds: Set<string> = new Set();
		for (const [actionIndex, action] of profile.actions.entries()) {
			if (actionIds.has(action.id)) context.addIssue({ code: "custom", path: ["environments", index, "actions", actionIndex, "id"], message: "Action ids must be unique within an environment." });
			actionIds.add(action.id);
		}
	}
	if (value.defaultEnvironmentId != null && !ids.has(value.defaultEnvironmentId)) {
		context.addIssue({ code: "custom", path: ["defaultEnvironmentId"], message: "The default environment must reference an existing environment." });
	}
});

export type EnvironmentTrustStatus = "trusted" | "network-approved" | "disabled" | "review-required";

type EnvironmentTrustStore = {
	schemaVersion: 1;
	entries: Record<string, { status: Exclude<EnvironmentTrustStatus, "review-required">; updatedAt: string }>;
};

export type LocalEnvironmentConfigDocument = {
	workspaceId: string;
	sourceFolderId: string;
	path: string;
	exists: boolean;
	content: string;
	revision: string;
	config: LocalEnvironmentConfig;
	profiles: Array<LocalEnvironmentProfile & { fingerprint: string; trust: EnvironmentTrustStatus; resolvedSetupScript: string | null }>;
};

const EMPTY_CONFIG: LocalEnvironmentConfig = { version: 1, defaultEnvironmentId: null, environments: [] };

function hash(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function getConfigPath(source: WorkspaceSourceFolder): string {
	return join(source.path, ".daedalus", "environments.json");
}

function selectSource(workspace: WorkspaceConfig, sourceFolderId: string): WorkspaceSourceFolder {
	const source: WorkspaceSourceFolder | undefined = workspace.sourceFolders.find((candidate): boolean => candidate.id === sourceFolderId);
	if (source === undefined) throw Object.assign(new Error(`Source folder not found: ${sourceFolderId}`), { code: "environment_source_not_found" });
	return source;
}

export function resolvePlatformScript(scripts: PlatformScripts, platform: NodeJS.Platform = process.platform): string | null {
	const selected: string | undefined = platform === "win32"
		? scripts.windows ?? scripts.default
		: platform === "darwin"
			? scripts.macos ?? scripts.default
			: platform === "linux"
				? scripts.linux ?? scripts.default
				: scripts.default;
	return selected?.trim() ? selected : null;
}

function tokenizeCommand(command: string): string[] {
	return [...command.matchAll(/"([^"]+)"|'([^']+)'|([^\s]+)/gu)]
		.map((match): string => match[1] ?? match[2] ?? match[3] ?? "")
		.filter(Boolean);
}

async function hashStaticEntry(script: string, sourceRoot: string): Promise<string> {
	for (const token of tokenizeCommand(script).slice(0, 8)) {
		if (!/\.(?:c?js|mjs|ts|py|ps1|sh|rb)$/iu.test(token) || token.includes("$(") || token.includes("${")) continue;
		const candidate: string = isAbsolute(token) ? resolve(token) : resolve(sourceRoot, token);
		try {
			const info = await stat(candidate);
			if (!info.isFile() || info.size > 4 * 1024 * 1024) continue;
			return hash(`${resolve(candidate)}\0${await readFile(candidate)}`);
		} catch {
			continue;
		}
	}
	return "none";
}

export async function createEnvironmentFingerprint(params: {
	sourcePath: string;
	revision: string;
	profile: LocalEnvironmentProfile;
}): Promise<string> {
	const setupScript: string = params.profile.setup === undefined ? "" : resolvePlatformScript(params.profile.setup.scripts) ?? "";
	const actionScripts: string[] = params.profile.actions.map((action): string => resolvePlatformScript(action.scripts) ?? "");
	const scriptHashes: string[] = await Promise.all([setupScript, ...actionScripts].map(async (script): Promise<string> => hashStaticEntry(script, params.sourcePath)));
	return hash(JSON.stringify({
		sourcePath: resolve(params.sourcePath),
		revision: params.revision,
		profile: params.profile,
		resolvedScripts: [setupScript, ...actionScripts],
		scriptHashes
	}));
}

export function parseLocalEnvironmentConfig(content: string): LocalEnvironmentConfig {
	if (Buffer.byteLength(content, "utf8") > MAX_CONFIG_BYTES) throw Object.assign(new Error("Environment configuration exceeds 256 KiB."), { code: "environment_config_too_large" });
	let value: unknown;
	try { value = JSON.parse(content) as unknown; } catch (error: unknown) {
		throw Object.assign(new Error(`Invalid environment JSON: ${error instanceof Error ? error.message : "parse error"}`), { code: "environment_config_invalid" });
	}
	const result = configSchema.safeParse(value);
	if (!result.success) throw Object.assign(new Error(result.error.issues.map((issue): string => `${issue.path.join(".")}: ${issue.message}`).join("\n")), { code: "environment_config_invalid" });
	return result.data;
}

async function readTrustStore(): Promise<EnvironmentTrustStore> {
	const raw = await readJsonFile<unknown>(getEnvironmentTrustConfigPath());
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { schemaVersion: 1, entries: {} };
	const record = raw as Record<string, unknown>;
	if (record.schemaVersion !== 1 || record.entries === null || typeof record.entries !== "object" || Array.isArray(record.entries)) return { schemaVersion: 1, entries: {} };
	const entries: EnvironmentTrustStore["entries"] = {};
	for (const [fingerprint, value] of Object.entries(record.entries as Record<string, unknown>)) {
		if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
		const item = value as Record<string, unknown>;
		if ((item.status === "trusted" || item.status === "network-approved" || item.status === "disabled") && typeof item.updatedAt === "string") {
			entries[fingerprint] = { status: item.status, updatedAt: item.updatedAt };
		}
	}
	return { schemaVersion: 1, entries };
}

export async function updateEnvironmentTrust(fingerprint: string, status: Exclude<EnvironmentTrustStatus, "review-required">): Promise<void> {
	const store: EnvironmentTrustStore = await readTrustStore();
	store.entries[fingerprint] = { status, updatedAt: new Date().toISOString() };
	await writeJsonFileAtomic(getEnvironmentTrustConfigPath(), store);
}

export async function readLocalEnvironmentConfig(workspace: WorkspaceConfig, sourceFolderId: string): Promise<LocalEnvironmentConfigDocument> {
	const source: WorkspaceSourceFolder = selectSource(workspace, sourceFolderId);
	const path: string = getConfigPath(source);
	let raw: string | null = null;
	try { raw = await readFile(path, "utf8"); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	const content: string = raw ?? `${JSON.stringify(EMPTY_CONFIG, null, 2)}\n`;
	const config: LocalEnvironmentConfig = parseLocalEnvironmentConfig(content);
	const revision: string = hash(raw ?? "");
	const trustStore: EnvironmentTrustStore = await readTrustStore();
	const profiles = await Promise.all(config.environments.map(async (profile): Promise<LocalEnvironmentConfigDocument["profiles"][number]> => {
		const fingerprint: string = await createEnvironmentFingerprint({ sourcePath: source.path, revision, profile });
		return {
			...profile,
			fingerprint,
			trust: trustStore.entries[fingerprint]?.status ?? "review-required",
			resolvedSetupScript: profile.setup === undefined ? null : resolvePlatformScript(profile.setup.scripts)
		};
	}));
	return { workspaceId: workspace.id, sourceFolderId, path, exists: raw !== null, content, revision, config, profiles };
}

export async function writeLocalEnvironmentConfig(params: {
	workspace: WorkspaceConfig;
	sourceFolderId: string;
	content: string;
	expectedRevision: string;
}): Promise<LocalEnvironmentConfigDocument> {
	parseLocalEnvironmentConfig(params.content);
	const current: LocalEnvironmentConfigDocument = await readLocalEnvironmentConfig(params.workspace, params.sourceFolderId);
	if (current.revision !== params.expectedRevision) throw Object.assign(new Error("The environment configuration changed on disk. Reload before saving."), { code: "environment_config_conflict" });
	const source: WorkspaceSourceFolder = selectSource(params.workspace, params.sourceFolderId);
	await writeJsonFileAtomic(getConfigPath(source), JSON.parse(params.content) as unknown);
	return await readLocalEnvironmentConfig(params.workspace, params.sourceFolderId);
}

export async function listEnvironmentActions(params: { workspace: WorkspaceConfig; sourceFolderId: string; environmentId?: string | undefined }): Promise<Array<LocalEnvironmentAction & { fingerprint: string; trust: EnvironmentTrustStatus; script: string }>> {
	const document: LocalEnvironmentConfigDocument = await readLocalEnvironmentConfig(params.workspace, params.sourceFolderId);
	const profile = document.profiles.find((candidate): boolean => candidate.id === (params.environmentId ?? document.config.defaultEnvironmentId));
	if (profile === undefined) return [];
	return profile.actions.flatMap((action): Array<LocalEnvironmentAction & { fingerprint: string; trust: EnvironmentTrustStatus; script: string }> => {
		const script: string | null = resolvePlatformScript(action.scripts);
		return script === null ? [] : [{ ...action, fingerprint: profile.fingerprint, trust: profile.trust, script }];
	});
}
