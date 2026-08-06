import * as path from "node:path";
import type { CommandPreset } from "./types.js";

export const COMMAND_TIMEOUT_MS: number = 30_000;
export const GODOT_COMMAND_TIMEOUT_MS: number = 120_000;
export const DEFAULT_JOB_TIMEOUT_MS: number = 30 * 60 * 1000;
export const MIN_JOB_TIMEOUT_MS: number = 1_000;
export const MAX_JOB_TIMEOUT_MS: number = 12 * 60 * 60 * 1000;
export const MIN_WAKE_AFTER_MS: number = 1_000;
export const MAX_WAKE_AFTER_MS: number = 24 * 60 * 60 * 1000;

export function resolveDefaultCommandTimeoutMs(commandLine: string | undefined): number {
	if (
		typeof commandLine === "string"
		&& /(?:^|[\\/\s"'])godot(?:[^\r\n]*)(?:--import|--headless|--editor|--script)(?:\s|$)/iu.test(commandLine)
	) {
		return GODOT_COMMAND_TIMEOUT_MS;
	}
	return COMMAND_TIMEOUT_MS;
}

export const BACKEND_DIR: string = process.env.BACKEND_DIR ?? process.cwd();
export const GODOT_EXECUTABLE: string = process.env.GODOT_EXECUTABLE_PATH ?? "godot";
export const GODOT_PROJECT: string = process.env.GODOT_PROJECT_PATH ?? "";

export type TerminalPresetContext = {
	backendDir?: string | undefined;
	workspaceRoot?: string | undefined;
	godotProjectPath?: string | undefined;
	godotExecutablePath?: string | undefined;
};

type ResolvedTerminalPresetContext = {
	backendDir: string;
	workspaceRoot: string;
	godotProjectPath: string;
	godotExecutablePath: string;
};

const NPM_TYPECHECK_COMMAND: string[] = process.platform === "win32"
	? ["cmd.exe", "/d", "/s", "/c", "npm", "run", "typecheck"]
	: ["npm", "run", "typecheck"];

function resolveContext(context?: TerminalPresetContext | undefined): ResolvedTerminalPresetContext {
	return {
		backendDir: context?.backendDir ?? BACKEND_DIR,
		workspaceRoot: context?.workspaceRoot ?? "",
		godotProjectPath: context?.godotProjectPath ?? GODOT_PROJECT,
		godotExecutablePath: context?.godotExecutablePath ?? GODOT_EXECUTABLE
	};
}

export function createAllowedWorkingRoots(context?: TerminalPresetContext | undefined): string[] {
	const resolvedContext = resolveContext(context);
	return [
		path.resolve(resolvedContext.backendDir),
		...(resolvedContext.workspaceRoot.length > 0 ? [path.resolve(resolvedContext.workspaceRoot)] : []),
		...(resolvedContext.godotProjectPath.length > 0 ? [path.resolve(resolvedContext.godotProjectPath)] : [])
	];
}

export const ALLOWED_WORKING_ROOTS: string[] = createAllowedWorkingRoots();

const WORKSPACE_PRESET_NAMES: ReadonlySet<string> = new Set([
	"workspace.typecheck",
	"git.status",
	"git.diff",
	"git.init"
]);

export function presetRequiresWorkspaceSource(presetName: string): boolean {
	return WORKSPACE_PRESET_NAMES.has(presetName) || presetName.startsWith("godot.");
}

export const COMMAND_PRESETS: CommandPreset[] = [
	{
		name: "backend.typecheck",
		description: "运行后端 TypeScript 类型检查 (tsc --noEmit)",
		command: NPM_TYPECHECK_COMMAND,
		workingDirectory: BACKEND_DIR,
		risk: "verify"
	},
	{
		name: "workspace.typecheck",
		description: "在当前 workspace 运行 TypeScript 类型检查 (npm run typecheck)。适用于前端、Electron、Node/TypeScript 仓库。",
		command: NPM_TYPECHECK_COMMAND,
		workingDirectory: BACKEND_DIR,
		risk: "verify"
	},
	{
		name: "git.status",
		description: "显示 Git 工作区状态 (只读)",
		command: ["git", "status", "--short"],
		workingDirectory: BACKEND_DIR,
		risk: "read"
	},
	{
		name: "git.diff",
		description: "显示 Git 工作区差异 (只读)",
		command: ["git", "diff", "--stat"],
		workingDirectory: BACKEND_DIR,
		risk: "read"
	},
	{
		name: "git.init",
		description: "初始化 Git 仓库",
		command: ["git", "init"],
		workingDirectory: BACKEND_DIR,
		risk: "write"
	},
	{
		name: "godot.check_only",
		description: "运行 Godot 语法检查 (只读)。可传 resourcePath 精确检查 .gd 脚本或加载 .tscn 场景。",
		command: [GODOT_EXECUTABLE, "--headless", "--disable-crash-handler", "--path", GODOT_PROJECT, "--check-only", "--quit"],
		workingDirectory: GODOT_PROJECT || BACKEND_DIR,
		risk: "verify",
		requiresGodotProject: true,
		resourcePathMode: "optional",
		defaultTimeoutMs: DEFAULT_JOB_TIMEOUT_MS
	},
	{
		name: "godot.validate_scene",
		description: "验证指定场景文件的语法正确性 (只读)。必须传 resourcePath，例如 scenes/main.tscn。",
		command: [GODOT_EXECUTABLE, "--headless", "--disable-crash-handler", "--path", GODOT_PROJECT, "--check-only", "--quit"],
		workingDirectory: GODOT_PROJECT || BACKEND_DIR,
		risk: "verify",
		requiresGodotProject: true,
		resourcePathMode: "required",
		defaultTimeoutMs: DEFAULT_JOB_TIMEOUT_MS
	}
];

export function isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
	const relativePath: string = path.relative(rootPath, candidatePath);
	return relativePath.length === 0 || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

export function findPreset(name: string): CommandPreset {
	const preset: CommandPreset | undefined = COMMAND_PRESETS.find((item: CommandPreset): boolean => item.name === name);

	if (!preset) {
		throw new Error(`Unknown preset: ${name}. Available: ${COMMAND_PRESETS.map((item: CommandPreset): string => item.name).join(", ")}`);
	}

	return preset;
}

export function materializePreset(preset: CommandPreset, context?: TerminalPresetContext | undefined): CommandPreset {
	const resolvedContext = resolveContext(context);
	if (WORKSPACE_PRESET_NAMES.has(preset.name)) {
		return {
			...preset,
			workingDirectory: resolvedContext.workspaceRoot || resolvedContext.backendDir
		};
	}

	if (preset.requiresGodotProject !== true) {
		return preset;
	}

	return {
		...preset,
		command: [
			resolvedContext.godotExecutablePath,
			"--headless",
			"--disable-crash-handler",
			"--path", resolvedContext.godotProjectPath,
			"--check-only",
			"--quit"
		],
		workingDirectory: resolvedContext.godotProjectPath || resolvedContext.backendDir
	};
}

export function resolveWorkingDirectory(workingDirectory: string | undefined, preset: CommandPreset, context?: TerminalPresetContext | undefined): string {
	const requestedPath: string = workingDirectory ?? preset.workingDirectory;
	const resolvedPath: string = path.resolve(requestedPath);

	for (const allowedRoot of createAllowedWorkingRoots(context)) {
		if (isPathInsideRoot(resolvedPath, allowedRoot)) {
			return resolvedPath;
		}
	}

	throw new Error(`Working directory is outside allowed roots: ${resolvedPath}`);
}

function toProjectRelativePath(resourcePath: string, context?: TerminalPresetContext | undefined): string {
	const trimmedPath: string = resourcePath.trim();
	if (trimmedPath.length === 0) {
		throw new Error("resourcePath cannot be empty");
	}

	const resolvedContext = resolveContext(context);
	const godotProject: string = resolvedContext.godotProjectPath;
	if (godotProject.length === 0) {
		throw new Error("Cannot resolve resourcePath without GODOT_PROJECT_PATH");
	}

	const projectRoot: string = path.resolve(godotProject);
	if (trimmedPath.startsWith("res://")) {
		const relativePath: string = trimmedPath.slice("res://".length).replaceAll("\\", "/");
		const absolutePath: string = path.resolve(projectRoot, relativePath);
		if (!isPathInsideRoot(absolutePath, projectRoot)) {
			throw new Error(`resourcePath is outside the Godot project: ${trimmedPath}`);
		}

		return path.relative(projectRoot, absolutePath).replaceAll(path.sep, "/");
	}

	if (path.isAbsolute(trimmedPath)) {
		const absolutePath: string = path.resolve(trimmedPath);
		if (!isPathInsideRoot(absolutePath, projectRoot)) {
			throw new Error(`resourcePath is outside the Godot project: ${absolutePath}`);
		}

		return path.relative(projectRoot, absolutePath).replaceAll(path.sep, "/");
	}

	const relativePath: string = trimmedPath.replaceAll("\\", "/");
	const absolutePath: string = path.resolve(projectRoot, relativePath);
	if (!isPathInsideRoot(absolutePath, projectRoot)) {
		throw new Error(`resourcePath is outside the Godot project: ${trimmedPath}`);
	}

	return path.relative(projectRoot, absolutePath).replaceAll(path.sep, "/");
}

function toResPath(relativePath: string): string {
	return `res://${relativePath.replace(/^\/+/u, "")}`;
}

export function createGodotResourceCommand(preset: CommandPreset, resourcePath: string | undefined, context?: TerminalPresetContext | undefined): string[] {
	if (!preset.requiresGodotProject) {
		return preset.command;
	}

	const resolvedContext = resolveContext(context);
	const godotProject: string = resolvedContext.godotProjectPath;
	const godotExecutable: string = resolvedContext.godotExecutablePath;
	if (godotProject.length === 0) {
		return preset.command;
	}

	const trimmedResourcePath: string = resourcePath?.trim() ?? "";
	if (preset.resourcePathMode === "required" && trimmedResourcePath.length === 0) {
		throw new Error(`Preset '${preset.name}' requires resourcePath`);
	}

	if (trimmedResourcePath.length === 0) {
		return preset.command;
	}

	const relativePath: string = toProjectRelativePath(trimmedResourcePath, context);
	const extension: string = path.extname(relativePath).toLowerCase();
	const resPath: string = toResPath(relativePath);

	if (extension === ".gd") {
		return [
			godotExecutable,
			"--headless",
			"--disable-crash-handler",
			"--path", godotProject,
			"--script", resPath,
			"--check-only"
		];
	}

	if (extension === ".tscn" || extension === ".scn") {
		return [
			godotExecutable,
			"--headless",
			"--disable-crash-handler",
			"--path", godotProject,
			resPath,
			"--quit-after", "1"
		];
	}

	throw new Error(`Unsupported Godot resourcePath extension for '${preset.name}': ${extension || "(none)"}. Use a .gd or .tscn file.`);
}

export function describePresetCommand(command: string[]): string {
	return command.map((part: string): string => {
		if (!/[\s"]/u.test(part)) {
			return part;
		}

		return `"${part.replaceAll("\"", "\\\"")}"`;
	}).join(" ");
}

export function normalizeTimeoutMs(timeoutMs: number | undefined, preset: CommandPreset, fallbackMs: number): number {
	const candidate: number = timeoutMs ?? preset.defaultTimeoutMs ?? fallbackMs;
	if (!Number.isFinite(candidate)) {
		return fallbackMs;
	}

	return Math.max(MIN_JOB_TIMEOUT_MS, Math.min(MAX_JOB_TIMEOUT_MS, Math.floor(candidate)));
}

export function normalizeWakeAfterMs(wakeAfterMs: number | undefined): number | undefined {
	if (wakeAfterMs === undefined) {
		return undefined;
	}
	if (!Number.isFinite(wakeAfterMs)) {
		return undefined;
	}

	return Math.max(MIN_WAKE_AFTER_MS, Math.min(MAX_WAKE_AFTER_MS, Math.floor(wakeAfterMs)));
}
