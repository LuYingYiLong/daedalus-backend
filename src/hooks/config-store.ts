import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { getGlobalHooksConfigPath, getHookDataRoot } from "../app-paths.js";
import type { WorkspaceConfig, WorkspaceSourceFolder } from "../workspace/types.js";
import { formatHookValidationError, parseHooksConfigText } from "./schema.js";
import { getHookTrustStatuses } from "./trust-store.js";
import type {
	HookCommandHandler,
	HookConfigDocument,
	HookConfigSource,
	HookEventName,
	HookHandlerSummary,
	HookMatcherGroup,
	HooksConfig
} from "./types.js";

const EMPTY_HOOKS_CONFIG_TEXT: string = `${JSON.stringify({ description: "Daedalus lifecycle hooks", hooks: {} }, null, 2)}\n`;

function hashText(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function normalizePathForId(value: string): string {
	const normalized: string = resolve(value);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function createGlobalHookSource(): HookConfigSource {
	return {
		id: "global",
		scope: "global",
		path: getGlobalHooksConfigPath(),
		displayName: "Global",
		rootPath: getHookDataRoot()
	};
}

export function createSourceHookSource(workspace: WorkspaceConfig, source: WorkspaceSourceFolder): HookConfigSource {
	return {
		id: `source:${workspace.id}:${source.id}`,
		scope: "source",
		path: join(source.path, ".daedalus", "hooks.json"),
		workspaceId: workspace.id,
		sourceFolderId: source.id,
		displayName: basename(source.path) || source.path,
		rootPath: source.path
	};
}

export function listHookConfigSources(workspace?: WorkspaceConfig | undefined): HookConfigSource[] {
	return [
		createGlobalHookSource(),
		...(workspace?.sourceFolders.map((source: WorkspaceSourceFolder): HookConfigSource => createSourceHookSource(workspace, source)) ?? [])
	];
}

export function resolveHookConfigSource(params: {
	scope: "global" | "source";
	workspace?: WorkspaceConfig | undefined;
	sourceFolderId?: string | undefined;
}): HookConfigSource {
	if (params.scope === "global") return createGlobalHookSource();
	if (params.workspace === undefined || params.sourceFolderId === undefined) {
		throw new Error("workspaceId and sourceFolderId are required for a source hook configuration.");
	}
	const source: WorkspaceSourceFolder | undefined = params.workspace.sourceFolders.find(
		(candidate: WorkspaceSourceFolder): boolean => candidate.id === params.sourceFolderId
	);
	if (source === undefined) throw new Error(`Source folder not found: ${params.sourceFolderId}`);
	return createSourceHookSource(params.workspace, source);
}

async function readOptionalText(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

function tokenizeCommand(command: string): string[] {
	const values: string[] = [];
	const pattern: RegExp = /"([^"]+)"|'([^']+)'|([^\s]+)/gu;
	for (const match of command.matchAll(pattern)) {
		values.push(match[1] ?? match[2] ?? match[3] ?? "");
	}
	return values.filter((value: string): boolean => value.length > 0);
}

async function hashStaticScript(command: string, source: HookConfigSource): Promise<string> {
	const extensionPattern: RegExp = /\.(?:c?js|mjs|ts|py|ps1|sh|rb)$/iu;
	for (const token of tokenizeCommand(command).slice(0, 8)) {
		if (!extensionPattern.test(token) || token.includes("$(") || token.includes("${")) continue;
		const candidate: string = isAbsolute(token) ? resolve(token) : resolve(source.rootPath, token);
		try {
			const info = await stat(candidate);
			if (!info.isFile() || info.size > 4 * 1024 * 1024) continue;
			return hashText(`${normalizePathForId(candidate)}\0${await readFile(candidate)}`);
		} catch {
			continue;
		}
	}
	return "none";
}

export async function createHookHandlerFingerprint(params: {
	source: HookConfigSource;
	revision: string;
	event: HookEventName;
	matcher: string;
	index: number;
	handlerIndex: number;
	handler: HookCommandHandler;
}): Promise<string> {
	const effectiveCommand: string = process.platform === "win32"
		? params.handler.commandWindows ?? params.handler.command
		: params.handler.command;
	const scriptHash: string = await hashStaticScript(effectiveCommand, params.source);
	return hashText(JSON.stringify({
		sourcePath: normalizePathForId(params.source.path),
		configRevision: params.revision,
		event: params.event,
		matcher: params.matcher,
		index: params.index,
		handlerIndex: params.handlerIndex,
		handler: params.handler,
		scriptHash
	}));
}

async function createSummaries(source: HookConfigSource, config: HooksConfig, revision: string): Promise<HookHandlerSummary[]> {
	const pending: Array<Omit<HookHandlerSummary, "fingerprint" | "trust"> & { handler: HookCommandHandler }> = [];
	for (const [eventName, groups] of Object.entries(config.hooks) as Array<[HookEventName, HookMatcherGroup[] | undefined]>) {
		for (const [index, group] of (groups ?? []).entries()) {
			for (const [handlerIndex, handler] of group.hooks.entries()) {
				pending.push({
					event: eventName,
					matcher: group.matcher ?? "",
					index,
					handlerIndex,
					command: handler.command,
					commandWindows: handler.commandWindows,
					statusMessage: handler.statusMessage,
					async: handler.async === true,
					failurePolicy: handler.failurePolicy ?? "continue",
					handler
				});
			}
		}
	}
	const fingerprints: string[] = await Promise.all(pending.map(async (item): Promise<string> => (
		await createHookHandlerFingerprint({ source, revision, ...item })
	)));
	const statuses = await getHookTrustStatuses(fingerprints);
	return pending.map((item, index): HookHandlerSummary => {
		const { handler: _handler, ...summary } = item;
		const fingerprint: string = fingerprints[index]!;
		return { ...summary, fingerprint, trust: statuses.get(fingerprint) ?? "review_required" };
	});
}

export async function readHookConfigDocument(source: HookConfigSource): Promise<HookConfigDocument> {
	const raw: string | null = await readOptionalText(source.path);
	const exists: boolean = raw !== null;
	const content: string = raw ?? EMPTY_HOOKS_CONFIG_TEXT;
	const revision: string = hashText(raw ?? "");
	try {
		const config: HooksConfig = parseHooksConfigText(content);
		return {
			source,
			exists,
			content,
			revision,
			valid: true,
			errors: [],
			description: config.description,
			handlers: await createSummaries(source, config, revision)
		};
	} catch (error: unknown) {
		return { source, exists, content, revision, valid: false, errors: formatHookValidationError(error), handlers: [] };
	}
}

export async function writeHookConfigDocument(params: {
	source: HookConfigSource;
	content: string;
	expectedRevision: string;
}): Promise<HookConfigDocument> {
	parseHooksConfigText(params.content);
	const current: string | null = await readOptionalText(params.source.path);
	const currentRevision: string = hashText(current ?? "");
	if (currentRevision !== params.expectedRevision) {
		const error: Error & { code?: string } = new Error("hooks_config_conflict: The hooks configuration changed on disk. Reload it before saving.");
		error.code = "hooks_config_conflict";
		throw error;
	}
	await mkdir(dirname(params.source.path), { recursive: true });
	const tempPath: string = `${params.source.path}.${process.pid}.${Date.now().toString(36)}.tmp`;
	try {
		await writeFile(tempPath, params.content.endsWith("\n") ? params.content : `${params.content}\n`, "utf8");
		await rename(tempPath, params.source.path).catch(async (error: unknown): Promise<void> => {
			if (process.platform !== "win32" || !["EPERM", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
			await rm(params.source.path, { force: true });
			await rename(tempPath, params.source.path);
		});
	} finally {
		await rm(tempPath, { force: true }).catch((): void => undefined);
	}
	return await readHookConfigDocument(params.source);
}

export async function hookConfigFileExists(source: HookConfigSource): Promise<boolean> {
	try {
		await access(source.path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}
