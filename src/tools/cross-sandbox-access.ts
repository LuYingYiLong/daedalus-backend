import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { getDefaultGodotExecutablePath } from "../general-settings-store.js";
import { findWorkspace, isPathInsideWorkspaceSources } from "../workspace/registry.js";
import type { WorkspaceConfig } from "../workspace/types.js";

export type ExternalAccessMode = "read" | "execute";

export type ExternalAccessTarget = {
	path: string;
	mode: ExternalAccessMode;
};

export type CrossSandboxExecutionBoundary = "sandbox_external_read" | "approved_unsandboxed";

export type CrossSandboxAuthorizationScope = {
	fingerprint: string;
	boundary: CrossSandboxExecutionBoundary;
	targets: ExternalAccessTarget[];
	networkAccess: boolean;
	sensitiveTarget: boolean;
};

export type CrossSandboxResolution =
	| { ok: true; scope?: CrossSandboxAuthorizationScope | undefined }
	| { ok: false; reason: string };

const GODOT_PROCESS_TOOL_NAMES: ReadonlySet<string> = new Set([
	"mcp_terminal_run_godot_scene_script",
	"mcp_godot_launch_editor",
	"mcp_godot_run_project",
	"mcp_godot_get_runtime_status",
	"mcp_godot_get_godot_version",
	"mcp_godot_get_uid",
	"mcp_godot_resave_resource",
	"mcp_godot_update_project_uids",
	"mcp_godot_save_scene_variant",
	"mcp_godot_load_sprite_texture",
	"mcp_godot_export_mesh_library",
]);

const SENSITIVE_PATH_SEGMENTS: ReadonlySet<string> = new Set([
	".aws",
	".azure",
	".gnupg",
	".ssh",
	"credentials",
	"secrets",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableJson).join(",")}]`;
	}
	if (value !== null && typeof value === "object") {
		const record: Record<string, unknown> = value as Record<string, unknown>;
		return `{${Object.keys(record).sort().map((key: string): string => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function getPublicArgs(args: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(args).filter(([key]: [string, unknown]): boolean => !key.startsWith("__daedalus"))
	);
}

function targetKey(value: string): string {
	return process.platform === "win32" ? value.toLowerCase() : value;
}

function isSensitivePath(value: string): boolean {
	return value.split(/[\\/]+/u).some((segment: string): boolean => SENSITIVE_PATH_SEGMENTS.has(segment.toLowerCase()));
}

export function isGodotProcessTool(toolName: string, args: Record<string, unknown>): boolean {
	if (GODOT_PROCESS_TOOL_NAMES.has(toolName)) return true;
	return (toolName === "mcp_terminal_run_safe_preset" || toolName === "mcp_terminal_run_write_preset")
		&& typeof args.presetName === "string"
		&& args.presetName.startsWith("godot.");
}

export async function resolveConfiguredGodotExecutablePath(workspaceId?: string | undefined): Promise<string | undefined> {
	const workspace: WorkspaceConfig | undefined = workspaceId === undefined ? undefined : findWorkspace(workspaceId);
	return workspace?.godotExecutablePath
		?? await getDefaultGodotExecutablePath()
		?? process.env.GODOT_EXECUTABLE_PATH;
}

function addTarget(
	targets: Map<string, ExternalAccessTarget>,
	workspace: WorkspaceConfig | undefined,
	candidate: string,
	mode: ExternalAccessMode
): string | null {
	if (!path.isAbsolute(candidate)) {
		return `External access paths must be absolute: ${candidate}`;
	}
	if (!existsSync(candidate)) {
		return `External access path does not exist: ${candidate}`;
	}
	let resolvedPath: string;
	try {
		resolvedPath = realpathSync(candidate);
	} catch (error: unknown) {
		return `External access path cannot be resolved: ${error instanceof Error ? error.message : candidate}`;
	}
	if (workspace !== undefined && isPathInsideWorkspaceSources(workspace, resolvedPath)) {
		return null;
	}
	const key: string = targetKey(resolvedPath);
	const existing: ExternalAccessTarget | undefined = targets.get(key);
	if (existing === undefined || (existing.mode === "read" && mode === "execute")) {
		targets.set(key, { path: resolvedPath, mode });
	}
	return null;
}

function parseDeclaredTargets(
	args: Record<string, unknown>,
	workspace: WorkspaceConfig | undefined,
	targets: Map<string, ExternalAccessTarget>
): string | null {
	const externalAccess: unknown = args.externalAccess;
	if (externalAccess === undefined) return null;
	if (!isRecord(externalAccess) || typeof externalAccess.reason !== "string" || externalAccess.reason.trim().length === 0) {
		return "externalAccess requires a non-empty reason and a targets array.";
	}
	if (!Array.isArray(externalAccess.targets) || externalAccess.targets.length === 0 || externalAccess.targets.length > 16) {
		return "externalAccess.targets must contain between 1 and 16 paths.";
	}
	for (const rawTarget of externalAccess.targets) {
		if (!isRecord(rawTarget) || typeof rawTarget.path !== "string" || (rawTarget.mode !== "read" && rawTarget.mode !== "execute")) {
			return "Each external access target requires an absolute path and read or execute mode.";
		}
		const error: string | null = addTarget(targets, workspace, rawTarget.path.trim(), rawTarget.mode);
		if (error !== null) return error;
	}
	return null;
}

export function createCrossSandboxFingerprint(params: {
	toolName: string;
	args: Record<string, unknown>;
	workspaceId?: string | undefined;
	boundary: CrossSandboxExecutionBoundary;
	targets: readonly ExternalAccessTarget[];
	networkAccess: boolean;
}): string {
	return createHash("sha256").update(stableJson({
		toolName: params.toolName,
		args: getPublicArgs(params.args),
		workspaceId: params.workspaceId ?? null,
		boundary: params.boundary,
		targets: params.targets,
		networkAccess: params.networkAccess,
	})).digest("hex");
}

export function resolveCrossSandboxAccess(params: {
	toolName: string;
	args: Record<string, unknown>;
	workspaceId?: string | undefined;
	sandboxAvailable: boolean;
	networkAccess?: boolean | undefined;
	godotExecutablePath?: string | undefined;
}): CrossSandboxResolution {
	const workspace: WorkspaceConfig | undefined = params.workspaceId === undefined
		? undefined
		: findWorkspace(params.workspaceId);
	const targets: Map<string, ExternalAccessTarget> = new Map();
	const declaredError: string | null = parseDeclaredTargets(params.args, workspace, targets);
	if (declaredError !== null) return { ok: false, reason: declaredError };

	const cwd: unknown = params.args.cwd;
	if (typeof cwd === "string" && cwd.trim().length > 0 && path.isAbsolute(cwd.trim())) {
		const cwdError: string | null = addTarget(targets, workspace, cwd.trim(), "read");
		if (cwdError !== null) return { ok: false, reason: cwdError };
	}

	if (isGodotProcessTool(params.toolName, params.args)) {
		const executablePath: string | undefined = params.godotExecutablePath ?? workspace?.godotExecutablePath;
		if (executablePath !== undefined && path.isAbsolute(executablePath)) {
			const executableError: string | null = addTarget(targets, workspace, path.dirname(executablePath), "execute");
			if (executableError !== null) return { ok: false, reason: executableError };
		}
	}

	const resolvedTargets: ExternalAccessTarget[] = [...targets.values()].sort(
		(left: ExternalAccessTarget, right: ExternalAccessTarget): number => targetKey(left.path).localeCompare(targetKey(right.path))
	);
	const networkAccess: boolean = params.networkAccess === true;
	if (params.sandboxAvailable && resolvedTargets.length === 0 && !networkAccess) {
		return { ok: true };
	}
	const boundary: CrossSandboxExecutionBoundary = params.sandboxAvailable
		? "sandbox_external_read"
		: "approved_unsandboxed";
	return {
		ok: true,
		scope: {
			fingerprint: createCrossSandboxFingerprint({
				toolName: params.toolName,
				args: params.args,
				workspaceId: params.workspaceId,
				boundary,
				targets: resolvedTargets,
				networkAccess,
			}),
			boundary,
			targets: resolvedTargets,
			networkAccess,
			sensitiveTarget: resolvedTargets.some((target: ExternalAccessTarget): boolean => isSensitivePath(target.path)),
		},
	};
}

export function isPathCoveredByExternalTargets(value: string, targets: readonly ExternalAccessTarget[]): boolean {
	const resolvedValue: string = path.resolve(value);
	return targets.some((target: ExternalAccessTarget): boolean => {
		const relativePath: string = path.relative(target.path, resolvedValue);
		return relativePath.length === 0 || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
	});
}
