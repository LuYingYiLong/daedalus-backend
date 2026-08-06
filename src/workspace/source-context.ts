import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { WorkspaceConfig, WorkspaceSourceFolder } from "./types.js";
import { getWorkspaceSourceFolder } from "./registry.js";

export type WorkspaceScope = "primary" | "source" | "all";

export type WorkspaceFileRef = {
	workspaceId: string;
	sourceFolderId: string;
	relativePath: string;
};

export type WorkspaceSourceDescriptor = {
	sourceFolderId: string;
	sourceName: string;
	capabilities: WorkspaceSourceFolder["capabilities"];
};

export type WorkspaceSourceOperation = "list" | "search" | "read" | "write" | "terminal" | "godot";

export type WorkspaceSourceSelection =
	| { kind: "source"; workspace: WorkspaceConfig; source: WorkspaceSourceFolder }
	| { kind: "all"; workspace: WorkspaceConfig; sources: WorkspaceSourceFolder[] };

export type WorkspaceSourceErrorCode =
	| "ambiguous_source"
	| "source_required"
	| "source_boundary"
	| "source_not_found"
	| "source_unavailable"
	| "invalid_scope";

export class WorkspaceSourceResolutionError extends Error {
	public readonly code: WorkspaceSourceErrorCode;
	public readonly workspaceId: string;
	public readonly candidates: WorkspaceSourceDescriptor[];

	public constructor(
		code: WorkspaceSourceErrorCode,
		workspace: WorkspaceConfig,
		message: string,
		candidates: WorkspaceSourceDescriptor[] = []
	) {
		super(message);
		this.name = "WorkspaceSourceResolutionError";
		this.code = code;
		this.workspaceId = workspace.id;
		this.candidates = candidates;
	}
}

function sourceName(source: WorkspaceSourceFolder): string {
	return basename(source.path) || source.id;
}

export function describeWorkspaceSource(source: WorkspaceSourceFolder): WorkspaceSourceDescriptor {
	return {
		sourceFolderId: source.id,
		sourceName: sourceName(source),
		capabilities: source.capabilities
	};
}

export function createWorkspaceFileRef(
	workspace: WorkspaceConfig,
	sourceFolderId: string,
	relativePath: string
): WorkspaceFileRef {
	return {
		workspaceId: workspace.id,
		sourceFolderId,
		relativePath: relativePath.replaceAll("\\", "/")
	};
}

export function formatWorkspaceFileRef(ref: WorkspaceFileRef): string {
	return `${ref.sourceFolderId}:${ref.relativePath}`;
}

function normalizeScope(value: unknown): WorkspaceScope | undefined {
	if (value === "primary" || value === "source" || value === "all") {
		return value;
	}
	return undefined;
}

function normalizeRelativePath(inputPath: string): string {
	const normalized: string = inputPath.trim().replaceAll("\\", "/");
	if (normalized.length === 0 || isAbsolute(normalized) || /^[A-Za-z]:\//u.test(normalized)) {
		throw new Error("Workspace relative path is required");
	}
	const segments: string[] = normalized.split("/").filter((segment: string): boolean => segment.length > 0);
	if (segments.some((segment: string): boolean => segment === "." || segment === "..")) {
		throw new Error("Workspace relative path cannot escape its source folder");
	}
	return segments.join("/");
}

function assertSourceAvailable(workspace: WorkspaceConfig, source: WorkspaceSourceFolder): void {
	try {
		if (!isWorkspaceSourceAvailable(source)) {
			throw new WorkspaceSourceResolutionError(
				"source_unavailable",
				workspace,
				`Source folder is unavailable: ${source.id}`,
				[describeWorkspaceSource(source)]
			);
		}
	} catch (error: unknown) {
		if (error instanceof WorkspaceSourceResolutionError) throw error;
		throw new WorkspaceSourceResolutionError(
			"source_unavailable",
			workspace,
			`Source folder is unavailable: ${source.id}`,
			[describeWorkspaceSource(source)]
		);
	}
}

export function isWorkspaceSourceAvailable(source: WorkspaceSourceFolder): boolean {
	try {
		return existsSync(source.path) && statSync(source.path).isDirectory();
	} catch {
		return false;
	}
}

function getSourceById(workspace: WorkspaceConfig, sourceFolderId: string): WorkspaceSourceFolder {
	const source: WorkspaceSourceFolder | undefined = workspace.sourceFolders.find(
		(item): boolean => item.id === sourceFolderId
	);
	if (source === undefined) {
		throw new WorkspaceSourceResolutionError(
			"source_not_found",
			workspace,
			`Source folder not found in workspace ${workspace.id}: ${sourceFolderId}`
		);
	}
	assertSourceAvailable(workspace, source);
	return source;
}

function getPrimarySource(workspace: WorkspaceConfig): WorkspaceSourceFolder {
	return getSourceById(workspace, workspace.primarySourceFolderId);
}

function assertAllScopeAllowed(workspace: WorkspaceConfig, operation: WorkspaceSourceOperation): void {
	if (operation !== "list" && operation !== "search") {
		throw new WorkspaceSourceResolutionError(
			"invalid_scope",
			workspace,
			`Scope all is only valid for workspace listing and search operations.`
		);
	}
}

export function resolveWorkspaceSources(
	workspace: WorkspaceConfig,
	input: {
		sourceFolderId?: string | undefined;
		scope?: WorkspaceScope | undefined;
		operation: WorkspaceSourceOperation;
	}
): WorkspaceSourceSelection {
	const scope: WorkspaceScope | undefined = normalizeScope(input.scope);
	if (input.scope !== undefined && scope === undefined) {
		throw new WorkspaceSourceResolutionError("invalid_scope", workspace, `Unsupported workspace scope: ${String(input.scope)}`);
	}
	const sourceFolderId: string | undefined = input.sourceFolderId?.trim() || undefined;
	if (scope === "all") {
		if (sourceFolderId !== undefined) {
			throw new WorkspaceSourceResolutionError("invalid_scope", workspace, "A source folder cannot be combined with scope all.");
		}
		assertAllScopeAllowed(workspace, input.operation);
		const sources: WorkspaceSourceFolder[] = workspace.sourceFolders.map((source): WorkspaceSourceFolder =>
			getWorkspaceSourceFolder(workspace, source.id)
		);
		return { kind: "all", workspace, sources };
	}
	if (scope === "source" && sourceFolderId === undefined) {
		throw new WorkspaceSourceResolutionError("source_required", workspace, "scope source requires sourceFolderId.");
	}
	if (sourceFolderId !== undefined) {
		return { kind: "source", workspace, source: getSourceById(workspace, sourceFolderId) };
	}
	if (scope === "primary" || workspace.sourceFolders.length === 1) {
		return { kind: "source", workspace, source: getPrimarySource(workspace) };
	}
	if (input.operation === "list" || input.operation === "search") {
		const sources: WorkspaceSourceFolder[] = workspace.sourceFolders.map((source): WorkspaceSourceFolder =>
			getWorkspaceSourceFolder(workspace, source.id)
		);
		return { kind: "all", workspace, sources };
	}
	throw new WorkspaceSourceResolutionError(
		"source_required",
		workspace,
		`sourceFolderId is required for ${input.operation} operations in a multi-source workspace.`,
		workspace.sourceFolders.map(describeWorkspaceSource)
	);
}

function isPathInsideSource(source: WorkspaceSourceFolder, candidatePath: string): boolean {
	const relativePath: string = relative(resolve(source.path), resolve(candidatePath));
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function terminalPathMatchesSource(source: WorkspaceSourceFolder, pathHint: string): boolean {
	const trimmedHint: string = pathHint.trim();
	if (trimmedHint.length === 0) return false;
	if (isAbsolute(trimmedHint)) {
		return isPathInsideSource(source, trimmedHint);
	}

	const candidatePath: string = resolve(source.path, trimmedHint);
	if (!isPathInsideSource(source, candidatePath)) return false;
	try {
		return existsSync(candidatePath) && statSync(candidatePath).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Resolve a terminal source without falling back to primary in a multi-source workspace.
 * A missing source id may only be completed from a unique, structural cwd or preset match.
 */
export function resolveWorkspaceTerminalSource(
	workspace: WorkspaceConfig,
	input: {
		sourceFolderId?: string | undefined;
		pathHint?: string | undefined;
		presetName?: string | undefined;
	}
): WorkspaceSourceSelection {
	const explicitSourceFolderId: string | undefined = input.sourceFolderId?.trim() || undefined;
	if (explicitSourceFolderId !== undefined || workspace.sourceFolders.length === 1) {
		return resolveWorkspaceSources(workspace, {
			sourceFolderId: explicitSourceFolderId,
			operation: "terminal"
		});
	}

	const pathMatches: WorkspaceSourceFolder[] = input.pathHint?.trim()
		? workspace.sourceFolders.filter((source): boolean => terminalPathMatchesSource(source, input.pathHint!))
		: [];
	const presetMatches: WorkspaceSourceFolder[] = input.presetName?.trim()
		? workspace.sourceFolders.filter((source): boolean => source.capabilities.terminalPresets?.includes(input.presetName!.trim()) === true)
		: [];

	if (pathMatches.length === 1) {
		const pathSource: WorkspaceSourceFolder = pathMatches[0]!;
		if (presetMatches.length === 1 && presetMatches[0]!.id !== pathSource.id) {
			throw new WorkspaceSourceResolutionError(
				"source_boundary",
				workspace,
				`The terminal cwd and preset identify different source folders: ${pathSource.id} vs ${presetMatches[0]!.id}.`,
				[pathSource, presetMatches[0]!].map(describeWorkspaceSource)
			);
		}
		assertSourceAvailable(workspace, pathSource);
		return { kind: "source", workspace, source: pathSource };
	}

	if (presetMatches.length === 1 && (pathMatches.length === 0 || pathMatches.some((source): boolean => source.id === presetMatches[0]!.id))) {
		assertSourceAvailable(workspace, presetMatches[0]!);
		return { kind: "source", workspace, source: presetMatches[0]! };
	}

	return resolveWorkspaceSources(workspace, { operation: "terminal" });
}

export function resolveWorkspaceReadSource(
	workspace: WorkspaceConfig,
	relativePath: string,
	input: { sourceFolderId?: string | undefined; scope?: WorkspaceScope | undefined }
): { workspace: WorkspaceConfig; source: WorkspaceSourceFolder; relativePath: string; autoSelected: boolean } {
	const normalizedPath: string = normalizeRelativePath(relativePath);
	if (input.scope === "all") {
		throw new WorkspaceSourceResolutionError("invalid_scope", workspace, "scope all cannot be used to read one text file.");
	}
	if (input.sourceFolderId !== undefined || input.scope === "primary" || workspace.sourceFolders.length === 1) {
		const selection = resolveWorkspaceSources(workspace, { ...input, operation: "read" });
		if (selection.kind !== "source") {
			throw new WorkspaceSourceResolutionError("invalid_scope", workspace, "A file read requires one source folder.");
		}
		return { workspace, source: selection.source, relativePath: normalizedPath, autoSelected: false };
	}

	const matches: WorkspaceSourceFolder[] = workspace.sourceFolders.filter((source): boolean => {
		assertSourceAvailable(workspace, source);
		const candidatePath: string = resolve(source.path, normalizedPath);
		const candidateRelative: string = relative(source.path, candidatePath);
		if (candidateRelative.startsWith("..") || isAbsolute(candidateRelative)) return false;
		try {
			return existsSync(candidatePath) && statSync(candidatePath).isFile();
		} catch {
			return false;
		}
	});
	if (matches.length === 1) {
		return { workspace, source: matches[0]!, relativePath: normalizedPath, autoSelected: true };
	}
	const candidates: WorkspaceSourceDescriptor[] = matches.map(describeWorkspaceSource);
	if (matches.length > 1) {
		throw new WorkspaceSourceResolutionError(
			"ambiguous_source",
			workspace,
			`The file exists in multiple source folders: ${normalizedPath}`,
			candidates
		);
	}
	throw new WorkspaceSourceResolutionError(
		"source_required",
		workspace,
		`No unique source folder contains: ${normalizedPath}`,
		workspace.sourceFolders.map(describeWorkspaceSource)
	);
}

export function readWorkspaceSourceManifest(source: WorkspaceSourceFolder): Record<string, unknown> {
	const packagePath: string = join(source.path, "package.json");
	if (!existsSync(packagePath)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(packagePath, "utf8")) as unknown;
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: {};
	} catch {
		return {};
	}
}
