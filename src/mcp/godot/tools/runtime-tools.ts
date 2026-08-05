import { readdir } from "node:fs/promises";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { terminalJobStore } from "../../terminal/job-store.js";
import { startCommandJob } from "../../terminal/process-runner.js";
import {
	BACKEND_DIR,
	DEFAULT_JOB_TIMEOUT_MS,
	GODOT_EXECUTABLE,
	normalizeTimeoutMs,
	normalizeWakeAfterMs
} from "../../terminal/presets.js";
import type { CommandPreset, TerminalJobRecord } from "../../terminal/types.js";
import {
	asJsonTextResult,
	isPathInsideRoot,
	projectRoot,
	redactSensitivePaths
} from "../context.js";
import { inspectGodotExecutable, type GodotExecutableAvailability } from "../../../godot-executable.js";

const GODOT_RUNTIME_TAIL_LINES: number = 200;
const PROJECT_DISCOVERY_LIMIT: number = 100;

let activeRuntimeJobId: string | null = null;
let cachedExecutableAvailability: { value: GodotExecutableAvailability; expiresAt: number } | null = null;

async function getExecutableAvailability(): Promise<GodotExecutableAvailability> {
	if (cachedExecutableAvailability !== null && cachedExecutableAvailability.expiresAt > Date.now()) {
		return cachedExecutableAvailability.value;
	}
	const value: GodotExecutableAvailability = await inspectGodotExecutable(GODOT_EXECUTABLE);
	cachedExecutableAvailability = { value, expiresAt: Date.now() + 5_000 };
	return value;
}

function createRuntimePreset(name: string, description: string, command: string[], risk: "read" | "verify" | "write"): CommandPreset {
	return {
		name,
		description,
		command,
		workingDirectory: projectRoot,
		risk,
		requiresGodotProject: true,
		defaultTimeoutMs: DEFAULT_JOB_TIMEOUT_MS
	};
}

export function toRuntimeResPath(resourcePath: string | undefined): string | undefined {
	const trimmedPath: string = resourcePath?.trim() ?? "";
	if (trimmedPath.length === 0) {
		return undefined;
	}

	if (trimmedPath.startsWith("res://")) {
		const absolutePath: string = path.resolve(projectRoot, trimmedPath.slice("res://".length));
		if (!isPathInsideRoot(absolutePath, projectRoot)) {
			throw new Error(`res:// path traversal denied: ${resourcePath}`);
		}
		return `res://${path.relative(projectRoot, absolutePath).replaceAll(path.sep, "/")}`;
	}

	const absolutePath: string = path.isAbsolute(trimmedPath)
		? path.resolve(trimmedPath)
		: path.resolve(projectRoot, trimmedPath);
	if (!isPathInsideRoot(absolutePath, projectRoot)) {
		throw new Error(`Scene path is outside Godot project: ${resourcePath}`);
	}

	return `res://${path.relative(projectRoot, absolutePath).replaceAll(path.sep, "/")}`;
}

async function getActiveRuntimeJob(): Promise<TerminalJobRecord | null> {
	if (activeRuntimeJobId === null) {
		return null;
	}

	const record: TerminalJobRecord | null = await terminalJobStore.get(activeRuntimeJobId);
	if (record === null || record.status !== "running") {
		activeRuntimeJobId = null;
	}
	return record;
}

function createJobResult(record: TerminalJobRecord): Record<string, unknown> {
	return {
		preset: record.preset,
		ok: record.status === "running",
		status: record.status,
		jobId: record.jobId,
		pid: record.pid ?? null,
		command: record.command,
		commandLine: record.commandLine,
		cwd: record.cwd,
		startedAt: record.startedAt,
		timeoutAt: record.timeoutAt ?? null,
		godotProjectPath: record.godotProjectPath ?? projectRoot,
		godotExecutablePath: record.godotExecutablePath ?? GODOT_EXECUTABLE,
		stdoutTail: redactSensitivePaths(record.stdoutTail, false),
		stderrTail: redactSensitivePaths(record.stderrTail, false),
		durationMs: record.durationMs,
		truncated: record.truncated
	};
}

function createRuntimeStatusJob(record: TerminalJobRecord | null): Record<string, unknown> | null {
	if (record === null) {
		return null;
	}

	return {
		preset: record.preset,
		status: record.status,
		jobId: record.jobId,
		pid: record.pid ?? null,
		startedAt: record.startedAt,
		updatedAt: record.updatedAt,
		timeoutAt: record.timeoutAt ?? null,
		durationMs: record.durationMs,
		exitCode: record.exitCode ?? null
	};
}

async function startRuntimeJob(params: {
	name: string;
	description: string;
	command: string[];
	timeoutMs?: number | undefined;
	wakeAfterMs?: number | undefined;
}): Promise<Record<string, unknown>> {
	const availability: GodotExecutableAvailability = await getExecutableAvailability();
	if (availability.status !== "ready") {
		return {
			ok: false,
			code: "godot_executable_unavailable",
			environmentIssue: true,
			applicabilityCode: "godot_runtime_unavailable",
			error: availability.error,
			godotExecutablePath: GODOT_EXECUTABLE
		};
	}
	const existing: TerminalJobRecord | null = await getActiveRuntimeJob();
	if (existing !== null) {
		return {
			ok: false,
			error: "A Godot runtime job is already running. Stop it before starting another runtime job.",
			active: createJobResult(existing)
		};
	}

	const preset: CommandPreset = createRuntimePreset(params.name, params.description, params.command, "write");
	const record: TerminalJobRecord = startCommandJob({
		preset,
		command: params.command,
		cwd: projectRoot,
		timeoutMs: normalizeTimeoutMs(params.timeoutMs, preset, DEFAULT_JOB_TIMEOUT_MS),
		wakeAfterMs: normalizeWakeAfterMs(params.wakeAfterMs),
		tailLines: GODOT_RUNTIME_TAIL_LINES,
		godotProjectPath: projectRoot,
		godotExecutablePath: GODOT_EXECUTABLE
	});
	activeRuntimeJobId = record.jobId;
	return createJobResult(record);
}

export function buildLaunchEditorCommand(): string[] {
	return [GODOT_EXECUTABLE, "--path", projectRoot, "--editor"];
}

export function buildRunProjectCommand(scenePath: string | undefined, debug: boolean): string[] {
	const command: string[] = [GODOT_EXECUTABLE, "--path", projectRoot];
	if (debug) {
		command.push("--debug");
	}
	const resPath: string | undefined = toRuntimeResPath(scenePath);
	if (resPath !== undefined) {
		command.push(resPath);
	}
	return command;
}

async function findProjects(directory: string, recursive: boolean): Promise<Array<Record<string, unknown>>> {
	const requestedPath: string = path.resolve(directory);
	const allowedRoots: string[] = [projectRoot, BACKEND_DIR].map((rootPath: string): string => path.resolve(rootPath));
	if (!allowedRoots.some((rootPath: string): boolean => isPathInsideRoot(requestedPath, rootPath))) {
		throw new Error(`Project discovery directory is outside allowed roots: ${requestedPath}`);
	}

	const projects: Array<Record<string, unknown>> = [];
	const queue: string[] = [requestedPath];
	while (queue.length > 0 && projects.length < PROJECT_DISCOVERY_LIMIT) {
		const currentPath: string = queue.shift()!;
		const entries = await readdir(currentPath, { withFileTypes: true });
		if (entries.some((entry): boolean => entry.isFile() && entry.name === "project.godot")) {
			projects.push({
				path: currentPath,
				current: path.resolve(currentPath) === path.resolve(projectRoot)
			});
			if (!recursive) {
				continue;
			}
		}

		if (recursive) {
			for (const entry of entries) {
				if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
					queue.push(path.join(currentPath, entry.name));
				}
			}
		}
	}

	return projects;
}

export function registerRuntimeTools(server: McpServer): void {
	server.registerTool(
		"get_runtime_status",
		{
			title: "Get Godot Runtime Status",
			description: "返回当前 Godot 可执行文件、项目路径和 active runtime job 状态。",
			inputSchema: z.object({})
		},
		async () => {
			const availability: GodotExecutableAvailability = await getExecutableAvailability();
			return asJsonTextResult({
				ok: availability.status === "ready",
				godotExecutablePath: GODOT_EXECUTABLE,
				godotExecutableStatus: availability.status,
				godotExecutableVersion: availability.version,
				error: availability.error,
				environmentIssue: availability.status !== "ready",
				applicabilityCode: availability.status !== "ready" ? "godot_runtime_unavailable" : undefined,
				godotProjectPath: projectRoot,
				capabilities: {
					runtimeLifecycle: availability.status === "ready",
					debugOutputTail: true,
					headlessOperations: availability.status === "ready",
					projectDiscovery: true
				},
				activeJob: createRuntimeStatusJob(await getActiveRuntimeJob())
			});
		}
	);

	server.registerTool(
		"get_godot_version",
		{
			title: "Get Godot Version",
			description: "调用 Godot --version，确认当前可执行文件版本。",
			inputSchema: z.object({})
		},
		async () => {
			const result: GodotExecutableAvailability = await getExecutableAvailability();
			return asJsonTextResult({
				ok: result.status === "ready",
				version: result.version ?? "",
				error: result.error,
				environmentIssue: result.status !== "ready",
				applicabilityCode: result.status !== "ready" ? "godot_runtime_unavailable" : undefined,
				godotExecutablePath: GODOT_EXECUTABLE
			});
		}
	);

	server.registerTool(
		"launch_editor",
		{
			title: "Launch Godot Editor",
			description: "启动当前项目的 Godot 编辑器，作为可查询/可取消的 runtime job。",
			inputSchema: z.object({
				wakeAfterMs: z.number().int().positive().optional(),
				timeoutMs: z.number().int().positive().optional()
			})
		},
		async ({ wakeAfterMs, timeoutMs }) => asJsonTextResult(await startRuntimeJob({
			name: "godot.launch_editor",
			description: "Launch Godot editor",
			command: buildLaunchEditorCommand(),
			wakeAfterMs,
			timeoutMs
		}))
	);

	server.registerTool(
		"run_project",
		{
			title: "Run Godot Project",
			description: "运行当前 Godot 项目，可指定场景路径，作为可查询/可取消的 runtime job。",
			inputSchema: z.object({
				scenePath: z.string().optional(),
				debug: z.boolean().optional(),
				wakeAfterMs: z.number().int().positive().optional(),
				timeoutMs: z.number().int().positive().optional()
			})
		},
		async ({ scenePath, debug, wakeAfterMs, timeoutMs }) => {
			const command: string[] = buildRunProjectCommand(scenePath, debug ?? true);
			return asJsonTextResult(await startRuntimeJob({
				name: "godot.run_project",
				description: "Run Godot project",
				command,
				wakeAfterMs,
				timeoutMs
			}));
		}
	);

	server.registerTool(
		"stop_project",
		{
			title: "Stop Godot Project",
			description: "停止当前 active Godot runtime job，或停止传入的 runtime jobId。",
			inputSchema: z.object({
				jobId: z.string().optional()
			})
		},
		async ({ jobId }) => {
			const targetJobId: string | null = jobId ?? activeRuntimeJobId;
			if (targetJobId === null) {
				return asJsonTextResult({ ok: true, status: "missing", message: "No active Godot runtime job." });
			}
			const record: TerminalJobRecord = await terminalJobStore.cancel(targetJobId);
			if (activeRuntimeJobId === targetJobId) {
				activeRuntimeJobId = null;
			}
			return asJsonTextResult(createJobResult(record));
		}
	);

	server.registerTool(
		"get_debug_output",
		{
			title: "Get Godot Debug Output",
			description: "读取当前或指定 Godot runtime job 的 stdout/stderr tail。默认脱敏本机路径。",
			inputSchema: z.object({
				jobId: z.string().optional(),
				raw: z.boolean().optional()
			})
		},
		async ({ jobId, raw }) => {
			const targetJobId: string | null = jobId ?? activeRuntimeJobId;
			if (targetJobId === null) {
				return asJsonTextResult({ ok: false, status: "missing", error: "No active Godot runtime job." });
			}
			const record: TerminalJobRecord | null = await terminalJobStore.get(targetJobId);
			if (record === null) {
				return asJsonTextResult({ ok: false, status: "missing", jobId: targetJobId, error: `Godot runtime job not found: ${targetJobId}` });
			}
			return asJsonTextResult({
				ok: record.status === "completed",
				status: record.status,
				jobId: targetJobId,
				stdoutTail: redactSensitivePaths(record.stdoutTail, raw === true),
				stderrTail: redactSensitivePaths(record.stderrTail, raw === true),
				durationMs: record.durationMs,
				exitCode: record.exitCode ?? null,
				truncated: record.truncated
			});
		}
	);

	server.registerTool(
		"list_projects",
		{
			title: "List Godot Projects",
			description: "在允许根目录内查找包含 project.godot 的目录，不扫描未授权位置。",
			inputSchema: z.object({
				directory: z.string().min(1),
				recursive: z.boolean().optional()
			})
		},
		async ({ directory, recursive }) => {
			return asJsonTextResult({
				ok: true,
				directory: path.resolve(directory),
				recursive: recursive === true,
				projects: await findProjects(directory, recursive === true)
			});
		}
	);
}
