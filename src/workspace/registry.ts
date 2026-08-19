import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { getDefaultWorkspaceConfigPath } from "../app-paths.js";
import { writeJsonFileAtomicSync } from "../json-file-store.js";
import type { SessionWorktreeMetadata, WorkspaceColor, WorkspaceConfig, WorkspaceIcon, WorkspaceSourceFolder } from "./types.js";
import { logger } from "../logger.js";

let configuredWorkspaceCache: WorkspaceConfig[] | null = null;
const runtimeWorkspaces: Map<string, WorkspaceConfig> = new Map();
const sessionRuntimeWorkspaces: Map<string, WorkspaceConfig> = new Map();

export type WorkspaceMetadataSource = {
	workspaceId?: string | undefined;
	workspaceName?: string | undefined;
	workspaceKind?: "godot" | undefined;
	workspaceRoot?: string | undefined;
	godotExecutablePath?: string | undefined;
	worktree?: SessionWorktreeMetadata | undefined;
};

type LegacyWorkspaceConfig = Partial<WorkspaceConfig> & {
	id?: unknown;
	name?: unknown;
	kind?: unknown;
	rootPath?: unknown;
	icon?: unknown;
	color?: unknown;
	sourceFolders?: unknown;
	primarySourceFolderId?: unknown;
	godotExecutablePath?: unknown;
};

export type WorkspaceUpdateInput = {
	name: string;
	icon: WorkspaceIcon;
	color: WorkspaceColor;
	sourceFolders: Array<{ id?: string | undefined; path: string }>;
	primarySourceFolderId: string;
};

function normalizePathForComparison(value: string): string {
	const normalized: string = resolve(value);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function createWorkspaceSourceFolderId(rootPath: string): string {
	const hash: string = createHash("sha1")
		.update(normalizePathForComparison(rootPath))
		.digest("hex")
		.slice(0, 12);
	return `source-${hash}`;
}

function detectSourceFolderCapabilities(rootPath: string): WorkspaceSourceFolder["capabilities"] {
	const projectMarkers: string[] = [
		".git",
		"package.json",
		"tsconfig.json",
		"pyproject.toml",
		"Cargo.toml",
		"go.mod",
		"project.godot"
	].filter((marker: string): boolean => existsSync(join(rootPath, marker)));
	let typecheck: "available" | "unavailable" | "unknown" = "unavailable";
	const packagePath: string = join(rootPath, "package.json");
	if (existsSync(packagePath)) {
		typecheck = "unknown";
		try {
			const packageJson: unknown = JSON.parse(readFileSync(packagePath, "utf8")) as unknown;
			const scripts: unknown = typeof packageJson === "object" && packageJson !== null
				? (packageJson as Record<string, unknown>).scripts
				: undefined;
			typecheck = typeof scripts === "object"
				&& scripts !== null
				&& typeof (scripts as Record<string, unknown>).typecheck === "string"
				? "available"
				: "unavailable";
		} catch {
			// 损坏的清单保持 unknown，避免把真实命令错误误判为“不支持”。
		}
	}
	const terminalPresets: string[] = [
		...(existsSync(join(rootPath, ".git")) ? ["git.status", "git.diff"] : []),
		...(typecheck === "available" ? ["workspace.typecheck"] : []),
		...(existsSync(join(rootPath, "project.godot")) ? ["godot.check_only"] : [])
	];
	return {
		git: existsSync(join(rootPath, ".git")),
		godot: existsSync(join(rootPath, "project.godot")),
		projectMarkers,
		typecheck,
		terminalPresets,
		workflowProfile: existsSync(join(rootPath, "project.godot")) ? "godot" : "workspace"
	};
}

function createSourceFolder(rootPath: string, id?: string | undefined): WorkspaceSourceFolder {
	const normalizedPath: string = resolve(rootPath);
	return {
		id: id?.trim() || createWorkspaceSourceFolderId(normalizedPath),
		path: normalizedPath,
		capabilities: detectSourceFolderCapabilities(normalizedPath)
	};
}

function isWorkspaceIcon(value: unknown): value is WorkspaceIcon {
	return Number.isInteger(value) && typeof value === "number" && value >= 0 && value <= 6;
}

function isWorkspaceColor(value: unknown): value is WorkspaceColor {
	return Number.isInteger(value) && typeof value === "number" && value >= 0 && value <= 7;
}

function readLegacySourceFolders(raw: LegacyWorkspaceConfig, fallbackRoot: string): WorkspaceSourceFolder[] {
	if (!Array.isArray(raw.sourceFolders)) {
		return [createSourceFolder(fallbackRoot)];
	}

	const folders: WorkspaceSourceFolder[] = [];
	const seenPaths: Set<string> = new Set();
	for (const item of raw.sourceFolders) {
		if (typeof item !== "object" || item === null) {
			continue;
		}
		const record = item as Record<string, unknown>;
		if (typeof record.path !== "string" || record.path.trim().length === 0) {
			continue;
		}
		const folder: WorkspaceSourceFolder = createSourceFolder(
			record.path,
			typeof record.id === "string" ? record.id : undefined
		);
		const comparisonPath: string = normalizePathForComparison(folder.path);
		if (seenPaths.has(comparisonPath)) {
			continue;
		}
		seenPaths.add(comparisonPath);
		folders.push(folder);
	}

	return folders.length > 0 ? folders : [createSourceFolder(fallbackRoot)];
}

export function normalizeWorkspaceConfig(rawInput: unknown): WorkspaceConfig {
	if (typeof rawInput !== "object" || rawInput === null) {
		throw new Error("Workspace config entry must be an object.");
	}
	const raw = rawInput as LegacyWorkspaceConfig;
	if (typeof raw.id !== "string" || raw.id.trim().length === 0) {
		throw new Error("Workspace config entry requires an id.");
	}
	if (typeof raw.rootPath !== "string" || raw.rootPath.trim().length === 0) {
		throw new Error(`Workspace config entry requires rootPath: ${raw.id}`);
	}

	const fallbackRoot: string = resolve(raw.rootPath);
	const sourceFolders: WorkspaceSourceFolder[] = readLegacySourceFolders(raw, fallbackRoot);
	const requestedPrimaryId: string | undefined = typeof raw.primarySourceFolderId === "string"
		? raw.primarySourceFolderId
		: undefined;
	const primary: WorkspaceSourceFolder = sourceFolders.find((folder): boolean => folder.id === requestedPrimaryId)
		?? sourceFolders[0]!;
	const nameInput: string = typeof raw.name === "string" ? raw.name.trim() : "";

	return {
		id: raw.id,
		name: nameInput || basename(primary.path) || primary.path,
		kind: "godot",
		rootPath: primary.path,
		icon: isWorkspaceIcon(raw.icon) ? raw.icon : 0,
		color: isWorkspaceColor(raw.color) ? raw.color : 0,
		sourceFolders,
		primarySourceFolderId: primary.id,
		godotExecutablePath: typeof raw.godotExecutablePath === "string" && raw.godotExecutablePath.trim().length > 0
			? raw.godotExecutablePath
			: undefined
	};
}

function canonicalizeExistingDirectory(inputPath: string): string {
	const resolvedPath: string = resolve(inputPath);
	if (!existsSync(resolvedPath) || !statSync(resolvedPath).isDirectory()) {
		throw new Error(`Source folder is not an existing directory: ${inputPath}`);
	}
	return realpathSync(resolvedPath);
}

export function updateWorkspace(workspaceId: string, input: WorkspaceUpdateInput): WorkspaceConfig {
	const existing: WorkspaceConfig | undefined = findWorkspace(workspaceId);
	if (existing === undefined) {
		throw new Error(`Workspace not found: ${workspaceId}`);
	}
	if (input.sourceFolders.length === 0) {
		throw new Error("A workspace requires at least one source folder.");
	}

	const sourceFolders: WorkspaceSourceFolder[] = [];
	const seenPaths: Set<string> = new Set();
	const seenIds: Set<string> = new Set();
	for (const source of input.sourceFolders) {
		const canonicalPath: string = canonicalizeExistingDirectory(source.path);
		const comparisonPath: string = normalizePathForComparison(canonicalPath);
		if (seenPaths.has(comparisonPath)) {
			throw new Error(`Duplicate source folder: ${source.path}`);
		}
		seenPaths.add(comparisonPath);
		const sourceFolder: WorkspaceSourceFolder = createSourceFolder(canonicalPath, source.id);
		if (!/^[A-Za-z0-9._-]+$/u.test(sourceFolder.id)) {
			throw new Error(`Invalid source folder id: ${sourceFolder.id}`);
		}
		if (seenIds.has(sourceFolder.id)) {
			throw new Error(`Duplicate source folder id: ${sourceFolder.id}`);
		}
		seenIds.add(sourceFolder.id);
		sourceFolders.push(sourceFolder);
	}

	const primary: WorkspaceSourceFolder | undefined = sourceFolders.find(
		(source): boolean => source.id === input.primarySourceFolderId
	);
	if (primary === undefined) {
		throw new Error("The primary source folder must belong to the workspace.");
	}

	const updated: WorkspaceConfig = {
		...existing,
		name: input.name.trim() || basename(primary.path) || primary.path,
		icon: input.icon,
		color: input.color,
		sourceFolders,
		primarySourceFolderId: primary.id,
		rootPath: primary.path
	};
	const configured: WorkspaceConfig[] = loadConfiguredWorkspaces().map(
		(workspace): WorkspaceConfig => workspace.id === updated.id ? updated : workspace
	);
	if (!configured.some((workspace): boolean => workspace.id === updated.id)) {
		configured.push(updated);
	}
	saveConfiguredWorkspaces(configured);
	runtimeWorkspaces.set(updated.id, updated);
	return updated;
}

export function getWorkspaceSourceFolder(
	workspace: WorkspaceConfig,
	sourceFolderId?: string | undefined
): WorkspaceSourceFolder {
	const effectiveId: string = sourceFolderId?.trim() || workspace.primarySourceFolderId;
	const folder: WorkspaceSourceFolder | undefined = workspace.sourceFolders.find(
		(item): boolean => item.id === effectiveId
	);
	if (folder === undefined) {
		throw new Error(`Source folder not found in workspace ${workspace.id}: ${effectiveId}`);
	}
	return {
		...folder,
		capabilities: detectSourceFolderCapabilities(folder.path)
	};
}

export function createSourceScopedWorkspace(
	workspace: WorkspaceConfig,
	sourceFolderId?: string | undefined
): WorkspaceConfig {
	const sourceFolder: WorkspaceSourceFolder = getWorkspaceSourceFolder(workspace, sourceFolderId);
	if (sourceFolder.id === workspace.primarySourceFolderId) {
		return workspace;
	}
	return {
		...workspace,
		id: `${workspace.id}::${sourceFolder.id}`,
		rootPath: sourceFolder.path,
		sourceFolders: [sourceFolder],
		primarySourceFolderId: sourceFolder.id
	};
}

export function findWorkspaceSourceByPath(inputPath: string): {
	workspace: WorkspaceConfig;
	sourceFolder: WorkspaceSourceFolder;
} | undefined {
	const comparisonPath: string = normalizePathForComparison(inputPath);
	for (const workspace of loadWorkspaces()) {
		const sourceFolder: WorkspaceSourceFolder | undefined = workspace.sourceFolders.find(
			(source): boolean => normalizePathForComparison(source.path) === comparisonPath
		);
		if (sourceFolder !== undefined) {
			return { workspace, sourceFolder };
		}
	}
	return undefined;
}

function getComparableExistingPath(inputPath: string): string {
	const resolvedPath: string = resolve(inputPath);
	return existsSync(resolvedPath) ? realpathSync(resolvedPath) : resolvedPath;
}

function pathIsInsideSource(sourcePath: string, candidatePath: string): boolean {
	const relativePath: string = relative(
		getComparableExistingPath(sourcePath),
		getComparableExistingPath(candidatePath)
	);
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export function findContainingWorkspaceSourceFolder(
	workspace: WorkspaceConfig,
	candidatePath: string
): WorkspaceSourceFolder | undefined {
	if (!isAbsolute(candidatePath)) {
		return undefined;
	}
	return workspace.sourceFolders
		.filter((source): boolean => pathIsInsideSource(source.path, candidatePath))
		.sort((left, right): number => right.path.length - left.path.length)[0];
}

export function isPathInsideWorkspaceSources(workspace: WorkspaceConfig, candidatePath: string): boolean {
	if (!isAbsolute(candidatePath)) {
		return true;
	}
	return findContainingWorkspaceSourceFolder(workspace, candidatePath) !== undefined;
}

function loadConfiguredWorkspaces(): WorkspaceConfig[] {
	if (configuredWorkspaceCache) {
		return configuredWorkspaceCache;
	}

	const path: string = getDefaultWorkspaceConfigPath();

	if (!existsSync(path)) {
		logger.info("workspace", "config_missing", {
			path
		});
		configuredWorkspaceCache = [];
		return configuredWorkspaceCache;
	}

	const raw: string = readFileSync(path, "utf8");
	const parsed: unknown = JSON.parse(raw) as unknown;

	if (!Array.isArray(parsed)) {
		throw new Error(`Workspace config must be a JSON array: ${path}`);
	}

	configuredWorkspaceCache = parsed.map((entry: unknown): WorkspaceConfig => normalizeWorkspaceConfig(entry));
	return configuredWorkspaceCache;
}

function saveConfiguredWorkspaces(workspaces: WorkspaceConfig[]): void {
	const configPath: string = getDefaultWorkspaceConfigPath();
	writeJsonFileAtomicSync(configPath, workspaces);
	configuredWorkspaceCache = workspaces;
}

function sameWorkspace(left: WorkspaceConfig, right: WorkspaceConfig): boolean {
	return left.id === right.id
		&& left.name === right.name
		&& left.kind === right.kind
		&& left.rootPath === right.rootPath
		&& left.icon === right.icon
		&& left.color === right.color
		&& left.primarySourceFolderId === right.primarySourceFolderId
		&& JSON.stringify(left.sourceFolders) === JSON.stringify(right.sourceFolders)
		&& left.godotExecutablePath === right.godotExecutablePath;
}

function persistRuntimeWorkspace(workspace: WorkspaceConfig): void {
	try {
		const currentWorkspaces: WorkspaceConfig[] = [...loadConfiguredWorkspaces()];
		const existingIndex: number = currentWorkspaces.findIndex((item: WorkspaceConfig): boolean => item.id === workspace.id);
		const existingWorkspace: WorkspaceConfig | undefined = existingIndex >= 0 ? currentWorkspaces[existingIndex] : undefined;
		const persistedWorkspace: WorkspaceConfig = {
			...existingWorkspace,
			...workspace,
			godotExecutablePath: workspace.godotExecutablePath ?? existingWorkspace?.godotExecutablePath
		};

		if (existingWorkspace !== undefined && sameWorkspace(existingWorkspace, persistedWorkspace)) {
			return;
		}

		if (existingIndex >= 0) {
			currentWorkspaces[existingIndex] = persistedWorkspace;
		} else {
			currentWorkspaces.push(persistedWorkspace);
		}

		saveConfiguredWorkspaces(currentWorkspaces);
		logger.info("workspace", "runtime_persisted", {
			workspaceId: persistedWorkspace.id,
			rootPath: persistedWorkspace.rootPath
		});
	} catch (error: unknown) {
		logger.warn("workspace", "runtime_persist_failed", {
			workspaceId: workspace.id,
			rootPath: workspace.rootPath,
			error: error instanceof Error ? error.message : String(error)
		});
	}
}

export function createRuntimeWorkspace(rootPath: string, godotExecutablePath?: string | undefined): WorkspaceConfig {
	const normalizedRootPath: string = resolve(rootPath);
	const hash: string = createHash("sha1").update(normalizedRootPath.toLowerCase()).digest("hex").slice(0, 10);
	const name: string = basename(normalizedRootPath) || normalizedRootPath;

	return {
		id: `runtime-${hash}`,
		name,
		kind: "godot",
		rootPath: normalizedRootPath,
		icon: 0,
		color: 0,
		sourceFolders: [createSourceFolder(normalizedRootPath)],
		primarySourceFolderId: createWorkspaceSourceFolderId(normalizedRootPath),
		godotExecutablePath
	};
}

export function upsertRuntimeWorkspace(workspace: WorkspaceConfig): WorkspaceConfig {
	const existing: WorkspaceConfig | undefined = runtimeWorkspaces.get(workspace.id);
	const next: WorkspaceConfig = normalizeWorkspaceConfig({
		...existing,
		...workspace,
		godotExecutablePath: workspace.godotExecutablePath ?? existing?.godotExecutablePath
	});
	runtimeWorkspaces.set(next.id, next);
	persistRuntimeWorkspace(next);
	return next;
}

export function registerSessionRuntimeWorkspace(workspace: WorkspaceConfig): WorkspaceConfig {
	const next: WorkspaceConfig = normalizeWorkspaceConfig(workspace);
	sessionRuntimeWorkspaces.set(next.id, next);
	return next;
}

export function unregisterSessionRuntimeWorkspace(workspaceId: string): void {
	sessionRuntimeWorkspaces.delete(workspaceId);
}

export function hydrateWorkspacesFromSessionMetadata(metadataList: WorkspaceMetadataSource[]): WorkspaceConfig[] {
	const hydrated: WorkspaceConfig[] = [];
	for (const metadata of metadataList) {
		if (metadata.worktree !== undefined) {
			continue;
		}
		if (metadata.workspaceId === undefined || metadata.workspaceRoot === undefined) {
			continue;
		}

		if (findWorkspace(metadata.workspaceId) !== undefined) {
			continue;
		}

		const fallbackName: string = basename(metadata.workspaceRoot) || metadata.workspaceRoot;
		hydrated.push(upsertRuntimeWorkspace({
			id: metadata.workspaceId,
			name: metadata.workspaceName ?? fallbackName,
			kind: metadata.workspaceKind ?? "godot",
			rootPath: metadata.workspaceRoot,
			icon: 0,
			color: 0,
			sourceFolders: [createSourceFolder(metadata.workspaceRoot)],
			primarySourceFolderId: createWorkspaceSourceFolderId(metadata.workspaceRoot),
			godotExecutablePath: metadata.godotExecutablePath
		}));
	}

	return hydrated;
}

function getEnvironmentWorkspace(): WorkspaceConfig | undefined {
	if (!process.env.GODOT_PROJECT_PATH) {
		return undefined;
	}

	return createRuntimeWorkspace(process.env.GODOT_PROJECT_PATH, process.env.GODOT_EXECUTABLE_PATH);
}

export function loadWorkspaces(): WorkspaceConfig[] {
	const byId: Map<string, WorkspaceConfig> = new Map();

	for (const workspace of loadConfiguredWorkspaces()) {
		byId.set(workspace.id, workspace);
	}

	const environmentWorkspace: WorkspaceConfig | undefined = getEnvironmentWorkspace();
	if (environmentWorkspace && !byId.has(environmentWorkspace.id)) {
		byId.set(environmentWorkspace.id, environmentWorkspace);
		persistRuntimeWorkspace(environmentWorkspace);
	}

	for (const workspace of runtimeWorkspaces.values()) {
		if (!byId.has(workspace.id)) {
			byId.set(workspace.id, workspace);
		}
	}

	return Array.from(byId.values());
}

export function findWorkspace(workspaceId: string): WorkspaceConfig | undefined {
	const sessionWorkspace: WorkspaceConfig | undefined = sessionRuntimeWorkspaces.get(workspaceId);
	if (sessionWorkspace !== undefined) {
		return sessionWorkspace;
	}
	const workspaces: WorkspaceConfig[] = loadWorkspaces();
	const direct: WorkspaceConfig | undefined = workspaces.find((workspace: WorkspaceConfig): boolean => workspace.id === workspaceId);
	if (direct !== undefined) {
		return direct;
	}
	const separatorIndex: number = workspaceId.lastIndexOf("::");
	if (separatorIndex <= 0 || separatorIndex >= workspaceId.length - 2) {
		return undefined;
	}
	const parentWorkspaceId: string = workspaceId.slice(0, separatorIndex);
	const sourceFolderId: string = workspaceId.slice(separatorIndex + 2);
	const parent: WorkspaceConfig | undefined = workspaces.find(
		(workspace: WorkspaceConfig): boolean => workspace.id === parentWorkspaceId
	);
	if (parent === undefined || !parent.sourceFolders.some((source): boolean => source.id === sourceFolderId)) {
		return undefined;
	}
	return createSourceScopedWorkspace(parent, sourceFolderId);
}

export function deleteWorkspace(workspaceId: string): WorkspaceConfig | undefined {
	const workspace: WorkspaceConfig | undefined = findWorkspace(workspaceId);
	if (workspace === undefined) {
		return undefined;
	}

	runtimeWorkspaces.delete(workspaceId);
	const configuredWorkspaces: WorkspaceConfig[] = loadConfiguredWorkspaces();
	const remainingWorkspaces: WorkspaceConfig[] = configuredWorkspaces.filter((item: WorkspaceConfig): boolean => item.id !== workspaceId);
	if (remainingWorkspaces.length !== configuredWorkspaces.length) {
		saveConfiguredWorkspaces(remainingWorkspaces);
	}

	return workspace;
}

export function getDefaultWorkspace(): WorkspaceConfig | undefined {
	const workspaces: WorkspaceConfig[] = loadWorkspaces();
	const defaultId: string | undefined = process.env.DEFAULT_WORKSPACE;

	if (defaultId) {
		const found: WorkspaceConfig | undefined = workspaces.find((w: WorkspaceConfig): boolean => w.id === defaultId);
		if (found) {
			return found;
		}
	}

	return workspaces[0];
}
