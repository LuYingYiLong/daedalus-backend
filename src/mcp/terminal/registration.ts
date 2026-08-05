import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { terminalJobStore } from "./job-store.js";
import { runCommandInvocationWait, runCommandWait, startCommandInvocationJob, startCommandJob, type TerminalOutputListener } from "./process-runner.js";
import { serializeTerminalMcpProgress, type TerminalOutputStream } from "./progress.js";
import { sanitizeTerminalDisplayText } from "./display-output.js";
import { createSandboxInvocation } from "./sandbox-runner.js";
import {
	BACKEND_DIR,
	COMMAND_PRESETS,
	COMMAND_TIMEOUT_MS,
	DEFAULT_JOB_TIMEOUT_MS,
	GODOT_EXECUTABLE,
	GODOT_PROJECT,
	createAllowedWorkingRoots,
	createGodotResourceCommand,
	describePresetCommand,
	findPreset,
	isPathInsideRoot,
	materializePreset,
	normalizeTimeoutMs,
	normalizeWakeAfterMs,
	resolveDefaultCommandTimeoutMs,
	resolveWorkingDirectory
} from "./presets.js";
import { findWorkspace, getWorkspaceSourceFolder } from "../../workspace/registry.js";
import type { WorkspaceConfig } from "../../workspace/types.js";
import type { CommandPreset, CommandRunInput, PresetRunInput, TerminalCommandResult, TerminalJobRecord } from "./types.js";
import { logger } from "../../logger.js";
import { consumeTerminalCommandAuthorization, type TerminalCommandAuthorization } from "./authorization.js";
import { resolvePresetApplicability } from "./applicability.js";
import type { ToolApplicabilityCode } from "../../tools/tool-applicability.js";

const TERMINAL_PROGRESS_FLUSH_MS: number = 80;
const MAX_TERMINAL_PROGRESS_BATCH_CHARS: number = 8192;
const MAX_TERMINAL_PROGRESS_PENDING_CHARS: number = 64 * 1024;

type TerminalProgressExtra = {
	_meta?: { progressToken?: string | number | undefined } | undefined;
	signal?: AbortSignal | undefined;
	sendNotification: (notification: {
		method: "notifications/progress";
		params: {
			progressToken: string | number;
			progress: number;
			message: string;
		};
	}) => Promise<void>;
};

export type TerminalProgressReporter = {
	onOutput?: TerminalOutputListener | undefined;
	close: () => Promise<void>;
};

export function createTerminalProgressReporter(extra: TerminalProgressExtra): TerminalProgressReporter {
	const progressToken: string | number | undefined = extra._meta?.progressToken;
	if (progressToken === undefined) {
		return { close: async (): Promise<void> => undefined };
	}

	const buffers: Record<TerminalOutputStream, string> = { stdout: "", stderr: "" };
	const omittedChars: Record<TerminalOutputStream, number> = { stdout: 0, stderr: 0 };
	const discardUntilLineBoundary: Record<TerminalOutputStream, boolean> = { stdout: false, stderr: false };
	let sequence: number = 0;
	let timer: NodeJS.Timeout | null = null;
	let sendQueue: Promise<void> = Promise.resolve();

	const flushStream = (stream: TerminalOutputStream, final: boolean = false): void => {
		const bufferedText: string = buffers[stream];
		if (bufferedText.length === 0 || discardUntilLineBoundary[stream]) {
			return;
		}
		const lastLineFeed: number = bufferedText.lastIndexOf("\n");
		const lastCarriageReturn: number = bufferedText.lastIndexOf("\r");
		const boundary: number = Math.max(lastLineFeed, lastCarriageReturn);
		if (!final && boundary < 0) {
			if (bufferedText.length > MAX_TERMINAL_PROGRESS_PENDING_CHARS) {
				omittedChars[stream] += bufferedText.length;
				buffers[stream] = "";
				discardUntilLineBoundary[stream] = true;
			}
			return;
		}

		const consumedChars: number = final ? bufferedText.length : boundary + 1;
		const sanitizedText: string = sanitizeTerminalDisplayText(bufferedText.slice(0, consumedChars));
		buffers[stream] = bufferedText.slice(consumedChars);
		if (sanitizedText.length === 0) {
			return;
		}
		const overflow: number = Math.max(0, sanitizedText.length - MAX_TERMINAL_PROGRESS_BATCH_CHARS);
		const text: string = overflow === 0 ? sanitizedText : sanitizedText.slice(-MAX_TERMINAL_PROGRESS_BATCH_CHARS);
		omittedChars[stream] += overflow;
		sequence += 1;
		const message: string = serializeTerminalMcpProgress({
			version: 1,
			kind: "terminal_output",
			stream,
			sequence,
			text,
			omittedChars: omittedChars[stream]
		});
		sendQueue = sendQueue.then(
			(): Promise<void> => extra.sendNotification({
				method: "notifications/progress",
				params: { progressToken, progress: sequence, message }
			}),
			(): Promise<void> => extra.sendNotification({
				method: "notifications/progress",
				params: { progressToken, progress: sequence, message }
			})
		).catch((): void => undefined);
	};

	const flush = (final: boolean = false): void => {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
		flushStream("stdout", final);
		flushStream("stderr", final);
	};

	const scheduleFlush = (): void => {
		if (timer !== null) {
			return;
		}
		timer = setTimeout(flush, TERMINAL_PROGRESS_FLUSH_MS);
		timer.unref();
	};

	return {
		onOutput: (stream: TerminalOutputStream, text: string): void => {
			if (discardUntilLineBoundary[stream]) {
				const lineFeed: number = text.indexOf("\n");
				const carriageReturn: number = text.indexOf("\r");
				const boundaries: number[] = [lineFeed, carriageReturn].filter((index: number): boolean => index >= 0);
				const boundary: number | undefined = boundaries.length === 0 ? undefined : Math.min(...boundaries);
				if (boundary === undefined) {
					omittedChars[stream] += text.length;
					return;
				}
				omittedChars[stream] += boundary + 1;
				discardUntilLineBoundary[stream] = false;
				text = text.slice(boundary + 1);
			}
			buffers[stream] += text;
			if (buffers[stream].length > MAX_TERMINAL_PROGRESS_PENDING_CHARS) {
				flush();
				return;
			}
			scheduleFlush();
		},
		close: async (): Promise<void> => {
			if (discardUntilLineBoundary.stdout) {
				omittedChars.stdout += buffers.stdout.length;
				buffers.stdout = "";
			}
			if (discardUntilLineBoundary.stderr) {
				omittedChars.stderr += buffers.stderr.length;
				buffers.stderr = "";
			}
			flush(true);
			await sendQueue;
		}
	};
}

function asJsonTextResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
	return {
		content: [{
			type: "text",
			text: JSON.stringify(value, null, 2)
		}]
	};
}

function createMissingGodotProjectResult(presetName: string, context?: { godotProjectPath?: string | undefined; godotExecutablePath?: string | undefined }): { content: Array<{ type: "text"; text: string }> } {
	return asJsonTextResult({
		preset: presetName,
		ok: false,
		validationStatus: "not_applicable",
		environmentIssue: true,
		applicabilityCode: "godot_project_missing",
		notApplicableReason: `${presetName} is not applicable because no Godot project is configured for this workspace.`,
		error: "GODOT_PROJECT_PATH is not configured for the terminal MCP server. Configure the Godot project path in the client and restart or reconnect the backend workspace before running Godot presets.",
		godotProjectPath: (context?.godotProjectPath ?? GODOT_PROJECT) || null,
		godotExecutablePath: context?.godotExecutablePath ?? GODOT_EXECUTABLE
	});
}

function parseJsonObjectsFromOutput(output: string): unknown[] {
	const lines: string[] = output
		.split(/\r?\n/)
		.map((line: string): string => line.trim())
		.filter((line: string): boolean => line.startsWith("{") && line.endsWith("}"));
	const values: unknown[] = [];

	for (const line of lines) {
		try {
			values.push(JSON.parse(line));
		} catch {
			continue;
		}
	}

	return values;
}

function selectGodotOperationResult(values: unknown[]): unknown {
	const objectValues: Array<Record<string, unknown>> = values.filter(
		(value: unknown): value is Record<string, unknown> =>
			typeof value === "object" && value !== null && !Array.isArray(value)
	);

	const changedValue: Record<string, unknown> | undefined = objectValues.find(
		(value: Record<string, unknown>): boolean =>
			value.ok === true && (value.created === true || value.modified === true)
	);
	if (changedValue !== undefined) {
		return changedValue;
	}

	const okValue: Record<string, unknown> | undefined = objectValues.find(
		(value: Record<string, unknown>): boolean => value.ok === true
	);
	if (okValue !== undefined) {
		return okValue;
	}

	return objectValues.at(-1) ?? null;
}

function createJobStartedResult(record: TerminalJobRecord): Record<string, unknown> {
	return {
		preset: record.preset,
		ok: undefined,
		status: record.status,
		jobId: record.jobId,
		command: record.command,
		commandLine: record.commandLine,
		cwd: record.cwd,
		pid: record.pid ?? null,
		startedAt: record.startedAt,
		timeoutAt: record.timeoutAt ?? null,
		wakeAfterMs: record.wakeAfterMs,
		nextWakeAt: record.nextWakeAt,
		resourcePath: record.resourcePath ?? null,
		godotProjectPath: record.godotProjectPath,
		godotExecutablePath: record.godotExecutablePath,
		stdoutTail: record.stdoutTail,
		stderrTail: record.stderrTail,
		durationMs: record.durationMs,
		truncated: record.truncated
	};
}

type TerminalInternalInput = {
	__daedalusWorkspaceId?: string | undefined;
	__daedalusSourceFolderId?: string | undefined;
	__daedalusApprovalMode?: "manual" | "auto-safe" | "full-trust" | undefined;
	__daedalusConsentText?: string | undefined;
	__daedalusCommandAuthorization?: TerminalCommandAuthorization | undefined;
};

function resolveTerminalContext(input: TerminalInternalInput): {
	workspaceId?: string | undefined;
	workspace?: WorkspaceConfig | undefined;
	workspaceRoot: string;
	godotProjectPath: string;
	godotExecutablePath: string;
} {
	const workspaceId: string | undefined = input.__daedalusWorkspaceId;
	const workspace: WorkspaceConfig | undefined = workspaceId === undefined
		? undefined
		: findWorkspace(workspaceId);

	if (workspaceId !== undefined && workspace === undefined) {
		return {
			workspaceId,
			workspaceRoot: "",
			godotProjectPath: "",
			godotExecutablePath: GODOT_EXECUTABLE
		};
	}

	const workspaceRoot: string = workspace === undefined
		? ""
		: getWorkspaceSourceFolder(workspace, input.__daedalusSourceFolderId).path;
	const workspaceHasGodotProject: boolean = workspaceRoot.length > 0 && fs.existsSync(path.join(workspaceRoot, "project.godot"));
	const workspaceGodotProjectPath: string = workspace === undefined
		? GODOT_PROJECT
		: (workspaceHasGodotProject ? workspaceRoot : "");

	return {
		workspaceId,
		workspace,
		workspaceRoot: workspaceRoot || GODOT_PROJECT,
		godotProjectPath: workspaceGodotProjectPath,
		godotExecutablePath: workspace?.godotExecutablePath ?? GODOT_EXECUTABLE
	};
}

function createNotApplicablePresetResult(
	presetName: string,
	applicabilityCode: ToolApplicabilityCode,
	reason: string,
	cwd: string
): Record<string, unknown> {
	return {
		preset: presetName,
		status: "not_applicable",
		validationStatus: "not_applicable",
		environmentIssue: true,
		applicabilityCode,
		notApplicableReason: reason,
		summary: reason,
		cwd
	};
}

function annotateTerminalApplicability(result: Record<string, unknown>): Record<string, unknown> {
	if (String(result.preset ?? "").startsWith("godot.") && result.status === "spawn_error") {
		return {
			...result,
			validationStatus: "failed",
			environmentIssue: true,
			applicabilityCode: "godot_runtime_unavailable"
		};
	}
	return result;
}

function createCommandLineEnv(inputEnv: Record<string, string> | undefined, trusted: boolean): Record<string, string> | undefined {
	if (trusted) {
		return {
			...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
			...(inputEnv ?? {})
		};
	}

	return inputEnv;
}

function resolveCommandCwd(input: CommandRunInput & TerminalInternalInput, context: ReturnType<typeof resolveTerminalContext>, allowOutsideWorkspace: boolean): string {
	const workspaceRoot: string = context.workspaceRoot;
	if (workspaceRoot.length === 0) {
		throw new Error("Workspace is not selected for terminal command execution.");
	}

	const requestedCwd: string = input.cwd?.trim() ?? "";
	if (requestedCwd.length === 0) {
		return path.resolve(workspaceRoot);
	}

	const resolvedCwd: string = path.isAbsolute(requestedCwd)
		? path.resolve(requestedCwd)
		: path.resolve(workspaceRoot, requestedCwd);
	if (!allowOutsideWorkspace && !isPathInsideRoot(resolvedCwd, path.resolve(workspaceRoot))) {
		throw new Error(`Terminal cwd is outside the active workspace: ${resolvedCwd}`);
	}

	return resolvedCwd;
}

async function runCommand(
	input: CommandRunInput & TerminalInternalInput,
	onOutput?: TerminalOutputListener | undefined,
	signal?: AbortSignal | undefined
): Promise<Record<string, unknown>> {
	const context = resolveTerminalContext(input);
	const trusted: boolean = input.__daedalusApprovalMode === "full-trust";
	const workspaceRoot: string = context.workspaceRoot;
	const hasCrossWorkspaceConsent: boolean = typeof input.__daedalusConsentText === "string" && input.__daedalusConsentText.startsWith("ALLOW CROSS-WORKSPACE: ");
	const startedAtMs: number = Date.now();

	if (input.commandLine.trim().length === 0) {
		return { ok: false, error: "commandLine cannot be empty" };
	}
	if (workspaceRoot.length === 0) {
		return { ok: false, error: "Workspace is not selected for terminal command execution." };
	}

	let cwd: string;
	try {
		cwd = resolveCommandCwd(input, context, trusted || hasCrossWorkspaceConsent);
	} catch (error: unknown) {
		return { ok: false, error: error instanceof Error ? error.message : "Invalid terminal cwd" };
	}
	const activeWorkspaceRoot: string = path.resolve(workspaceRoot);
	const sandboxWorkspaceRoot: string = !trusted && hasCrossWorkspaceConsent && !isPathInsideRoot(cwd, activeWorkspaceRoot)
		? cwd
		: activeWorkspaceRoot;

	const timeoutMs: number = normalizeTimeoutMs(input.timeoutMs, {
		name: "terminal.command",
		description: "Run workspace command",
		command: [input.commandLine],
		workingDirectory: cwd,
		risk: "verify"
	}, input.executionMode === "job" ? DEFAULT_JOB_TIMEOUT_MS : resolveDefaultCommandTimeoutMs(input.commandLine));
	const wakeAfterMs: number | undefined = normalizeWakeAfterMs(input.wakeAfterMs);
	const commonInvocation = {
		commandLine: input.commandLine,
		sandboxMode: trusted ? "full-trust" as const : "os-sandbox" as const,
		workspaceId: context.workspace?.id ?? context.workspaceId,
		workspaceRoot: sandboxWorkspaceRoot,
		trusted,
		consentText: input.__daedalusConsentText
	};
	const executableInvocation = trusted
		? {
			...commonInvocation,
			command: input.commandLine,
			args: [],
			shell: true,
			env: createCommandLineEnv(input.env, true)
		}
		: (() => {
			const sandboxInvocation = createSandboxInvocation({
			commandLine: input.commandLine,
			cwd,
			workspaceRoot: sandboxWorkspaceRoot,
			env: createCommandLineEnv(input.env, false)
			});
			if (sandboxInvocation.available === false) {
				const directAuthorization = consumeTerminalCommandAuthorization(
					input.__daedalusCommandAuthorization,
					input as unknown as Record<string, unknown>,
					context.workspace?.id ?? context.workspaceId
				);
				if (directAuthorization.allowed) {
					return {
						...commonInvocation,
						command: input.commandLine,
						args: [],
						shell: true,
						env: createCommandLineEnv(input.env, false),
						sandboxMode: "approved-unsandboxed" as const,
						authorizationSource: directAuthorization.source
					};
				}
				return {
					ok: false,
					error: sandboxInvocation.error,
					code: "sandbox_unavailable",
					sandboxMode: sandboxInvocation.sandboxMode,
					workspaceId: context.workspace?.id ?? context.workspaceId,
					workspaceRoot: sandboxWorkspaceRoot,
					cwd
				} as const;
			}
			return {
			...commonInvocation,
				command: sandboxInvocation.command,
				args: sandboxInvocation.args,
				env: sandboxInvocation.env
			};
		})();

	if ("ok" in executableInvocation && executableInvocation.ok === false) {
		return executableInvocation;
	}

	if (input.executionMode === "job") {
		const record: TerminalJobRecord = startCommandInvocationJob({
			presetName: "terminal.command",
			invocation: executableInvocation,
			cwd,
			timeoutMs,
			wakeAfterMs,
			tailLines: input.tailLines
		});
		logger.info("terminal", "command_job_started", {
			jobId: record.jobId,
			cwd,
			workspaceId: context.workspace?.id ?? context.workspaceId,
			trusted,
			sandboxMode: executableInvocation.sandboxMode,
			durationMs: Date.now() - startedAtMs
		});
		return annotateTerminalApplicability(createJobStartedResult(record));
	}

	const result: TerminalCommandResult = await runCommandInvocationWait({
		presetName: "terminal.command",
		invocation: executableInvocation,
		cwd,
		timeoutMs,
		onOutput,
		signal
	});
	logger.info("terminal", "command_finished", {
		cwd,
		workspaceId: context.workspace?.id ?? context.workspaceId,
		trusted,
		sandboxMode: executableInvocation.sandboxMode,
		ok: result.ok,
		exitCode: result.exitCode,
		durationMs: result.durationMs
	});
	return {
		...result,
		executionMode: result.sandboxMode === "approved-unsandboxed" ? "approved_unsandboxed" : "sandboxed"
	} as unknown as Record<string, unknown>;
}

async function runPreset(input: PresetRunInput, allowedRisks: readonly string[]): Promise<Record<string, unknown>> {
	const context = resolveTerminalContext(input as PresetRunInput & TerminalInternalInput);
	const preset: CommandPreset = materializePreset(findPreset(input.presetName), {
		workspaceRoot: context.workspaceRoot,
		godotProjectPath: context.godotProjectPath,
		godotExecutablePath: context.godotExecutablePath
	});
	const startedAtMs: number = Date.now();

	if (!allowedRisks.includes(preset.risk)) {
		logger.warn("terminal", "preset_risk_rejected", {
			preset: input.presetName,
			risk: preset.risk,
			allowedRisks,
			executionMode: input.executionMode ?? "wait"
		});
		return {
			preset: input.presetName,
			ok: false,
			error: `Preset '${input.presetName}' has risk '${preset.risk}', not allowed by this tool.`,
			requiredRisk: preset.risk
		};
	}

	let cwd: string;
	try {
		cwd = resolveWorkingDirectory(input.workingDirectory, preset, {
			workspaceRoot: context.workspaceRoot,
			godotProjectPath: context.godotProjectPath,
			godotExecutablePath: context.godotExecutablePath
		});
	} catch (error: unknown) {
		logger.warn("terminal", "working_directory_rejected", {
			preset: input.presetName,
			workingDirectory: input.workingDirectory,
			error: error instanceof Error ? error.message : "Invalid working directory"
		});
		return {
			preset: input.presetName,
			ok: false,
			error: error instanceof Error ? error.message : "Invalid working directory"
		};
	}

	const applicability = resolvePresetApplicability({
		presetName: input.presetName,
		workingDirectory: cwd,
		requiresGodotProject: preset.requiresGodotProject,
		godotProjectPath: context.godotProjectPath
	});
	if (!applicability.applicable) {
		logger.info("terminal", "preset_not_applicable", {
			preset: input.presetName,
			cwd,
			workspaceId: context.workspace?.id ?? context.workspaceId,
			applicabilityCode: applicability.applicabilityCode,
			reason: applicability.notApplicableReason
		});
		return createNotApplicablePresetResult(input.presetName, applicability.applicabilityCode, applicability.notApplicableReason, cwd);
	}

	let command: string[];
	try {
		command = createGodotResourceCommand(preset, input.resourcePath, {
			workspaceRoot: context.workspaceRoot,
			godotProjectPath: context.godotProjectPath,
			godotExecutablePath: context.godotExecutablePath
		});
	} catch (error: unknown) {
		logger.warn("terminal", "preset_arguments_invalid", {
			preset: input.presetName,
			resourcePath: input.resourcePath,
			error: error instanceof Error ? error.message : "Invalid preset arguments"
		});
		return {
			preset: input.presetName,
			ok: false,
			error: error instanceof Error ? error.message : "Invalid preset arguments",
			resourcePath: input.resourcePath ?? null,
			godotProjectPath: preset.requiresGodotProject ? context.godotProjectPath || null : undefined,
			godotExecutablePath: preset.requiresGodotProject ? context.godotExecutablePath : undefined
		};
	}

	if (input.executionMode === "job") {
		const wakeAfterMs: number | undefined = normalizeWakeAfterMs(input.wakeAfterMs);
		const record: TerminalJobRecord = startCommandJob({
			preset,
			command,
			cwd,
			timeoutMs: normalizeTimeoutMs(input.timeoutMs, preset, DEFAULT_JOB_TIMEOUT_MS),
			wakeAfterMs,
			tailLines: input.tailLines,
			resourcePath: input.resourcePath ?? null,
			godotProjectPath: preset.requiresGodotProject ? context.godotProjectPath || null : undefined,
			godotExecutablePath: preset.requiresGodotProject ? context.godotExecutablePath : undefined
		});
		logger.info("terminal", "job_started", {
			preset: input.presetName,
			risk: preset.risk,
			jobId: record.jobId,
			pid: record.pid,
			cwd,
			resourcePath: input.resourcePath,
			timeoutMs: record.timeoutAt,
			wakeAfterMs,
			durationMs: Date.now() - startedAtMs
		});
		return createJobStartedResult(record);
	}

	logger.info("terminal", "preset_started", {
		preset: input.presetName,
		risk: preset.risk,
		cwd,
		resourcePath: input.resourcePath,
		timeoutMs: normalizeTimeoutMs(input.timeoutMs, preset, COMMAND_TIMEOUT_MS)
	});
	const timeoutMs: number = normalizeTimeoutMs(input.timeoutMs, preset, COMMAND_TIMEOUT_MS);
	const result: TerminalCommandResult = await runCommandWait({
		preset,
		command,
		cwd,
		timeoutMs,
		resourcePath: input.resourcePath ?? null,
		godotProjectPath: preset.requiresGodotProject ? context.godotProjectPath || null : undefined,
		godotExecutablePath: preset.requiresGodotProject ? context.godotExecutablePath : undefined
	});
	logger.info("terminal", "preset_finished", {
		preset: input.presetName,
		risk: preset.risk,
		cwd,
		resourcePath: input.resourcePath,
		ok: result.ok,
		exitCode: result.exitCode,
		durationMs: result.durationMs,
		totalDurationMs: Date.now() - startedAtMs,
		stdoutChars: result.stdout.length,
		stderrChars: result.stderr.length,
		truncated: result.truncated
	});
	return annotateTerminalApplicability(result as unknown as Record<string, unknown>);
}

const presetRunSchema = z.object({
	presetName: z.string().min(1).describe("预设名称"),
	resourcePath: z.string().optional().describe("Godot 资源路径，可用 res://、项目相对路径或项目内绝对路径。"),
	workingDirectory: z.string().optional().describe("覆盖默认工作目录"),
	executionMode: z.enum(["wait", "job"]).optional().describe("wait 为默认同步等待；job 为长任务，立即返回 jobId。"),
	wakeAfterMs: z.number().int().positive().optional().describe("job 模式下请求 backend 在指定毫秒后唤醒 AI。"),
	timeoutMs: z.number().int().positive().optional().describe("命令超时毫秒。wait 默认 30000，job 默认 30 分钟。"),
	tailLines: z.number().int().positive().optional().describe("job tail 行数。")
}).passthrough();

const commandRunSchema = z.object({
	commandLine: z.string().min(1).describe("要运行的命令行"),
	cwd: z.string().optional().describe("workspace 相对工作目录；Full Trust 下可传绝对路径"),
	env: z.record(z.string(), z.string()).optional().describe("附加环境变量"),
	executionMode: z.enum(["wait", "job"]).optional().describe("wait 为默认同步等待；job 为长任务"),
	wakeAfterMs: z.number().int().positive().optional().describe("job 模式下请求 backend 在指定毫秒后唤醒 AI。"),
	timeoutMs: z.number().int().positive().optional().describe("命令超时毫秒。wait 默认 30000，job 默认 30 分钟。"),
	tailLines: z.number().int().positive().optional().describe("job tail 行数。"),
	reason: z.string().optional().describe("为什么需要运行该命令。")
}).passthrough();

export function registerTerminalTools(server: McpServer): void {
	server.registerTool(
		"get_terminal_capabilities",
		{
			title: "Get Terminal Capabilities",
			description: "返回当前终端 MCP 支持的所有预设命令列表及其风险等级。",
			inputSchema: z.object({}).passthrough()
		},
		async (input: TerminalInternalInput) => {
			const context = resolveTerminalContext(input);
			return asJsonTextResult({
				commandRunner: {
					sandboxModes: ["os-sandbox", "full-trust"],
					normalModeRequiresSandbox: true,
					windowsSandboxHelper: process.env.DAEDALUS_WINDOWS_SANDBOX_HELPER ?? null
				},
				presets: COMMAND_PRESETS.map((preset: CommandPreset) => ({
					name: preset.name,
					description: preset.description,
					workingDirectory: materializePreset(preset, {
						workspaceRoot: context.workspaceRoot,
						godotProjectPath: context.godotProjectPath,
						godotExecutablePath: context.godotExecutablePath
					}).workingDirectory,
					risk: preset.risk,
					resourcePathMode: preset.resourcePathMode ?? "none",
					godotProjectPath: preset.requiresGodotProject ? context.godotProjectPath || null : undefined,
					godotExecutablePath: preset.requiresGodotProject ? context.godotExecutablePath : undefined,
					command: preset.requiresGodotProject
						? describePresetCommand(materializePreset(preset, {
							workspaceRoot: context.workspaceRoot,
							godotProjectPath: context.godotProjectPath,
							godotExecutablePath: context.godotExecutablePath
						}).command)
						: undefined,
					defaultTimeoutMs: preset.defaultTimeoutMs ?? COMMAND_TIMEOUT_MS
				}))
			});
		}
	);

	server.registerTool(
		"run_command",
		{
			title: "Run Workspace Command",
			description: "在当前 workspace 中运行自由命令。普通模式必须使用 OS 沙箱，Full Trust 模式裸跑。",
			inputSchema: commandRunSchema
		},
		async (input: CommandRunInput & TerminalInternalInput, extra) => {
			const progress: TerminalProgressReporter = createTerminalProgressReporter(extra);
			try {
				return asJsonTextResult(await runCommand(input, progress.onOutput, extra.signal));
			} finally {
				await progress.close();
			}
		}
	);

	server.registerTool(
		"run_safe_preset",
		{
			title: "Run Safe Command Preset",
			description: "执行安全的预设命令（read/verify 风险），自动允许。默认同步等待；executionMode=job 时启动长任务并返回 jobId。",
			inputSchema: presetRunSchema
		},
		async (input: PresetRunInput) => asJsonTextResult(await runPreset(input, ["read", "verify"]))
	);

	server.registerTool(
		"run_write_preset",
		{
			title: "Run Write Command Preset",
			description: "执行写操作预设命令（write 风险），需要通过审批系统批准。也允许执行更低风险的 read/verify 预设，避免审批后的流程因为工具包装器选择错误而中断。默认同步等待；executionMode=job 时启动长任务并返回 jobId。",
			inputSchema: presetRunSchema
		},
		async (input: PresetRunInput) => asJsonTextResult(await runPreset(input, ["read", "verify", "write"]))
	);

	server.registerTool(
		"get_terminal_job_status",
		{
			title: "Get Terminal Job Status",
			description: "查询 terminal 长任务状态和最近输出 tail。",
			inputSchema: z.object({
				jobId: z.string().min(1)
			})
		},
		async ({ jobId }) => {
			const record: TerminalJobRecord | null = await terminalJobStore.get(jobId);
			return asJsonTextResult(record === null
				? { ok: false, status: "missing", jobId, error: `Terminal job not found: ${jobId}` }
				: annotateTerminalApplicability(record as unknown as Record<string, unknown>));
		}
	);

	server.registerTool(
		"get_terminal_job_tail",
		{
			title: "Get Terminal Job Tail",
			description: "读取 terminal 长任务最近 stdout/stderr tail。",
			inputSchema: z.object({
				jobId: z.string().min(1)
			})
		},
		async ({ jobId }) => {
			const record: TerminalJobRecord | null = await terminalJobStore.get(jobId);
			if (record === null) {
				return asJsonTextResult({ ok: false, status: "missing", jobId, error: `Terminal job not found: ${jobId}` });
			}
			return asJsonTextResult({
				ok: record.status === "completed",
				status: record.status,
				jobId,
				stdoutTail: record.stdoutTail,
				stderrTail: record.stderrTail,
				durationMs: record.durationMs,
				exitCode: record.exitCode ?? null
			});
		}
	);

	server.registerTool(
		"cancel_terminal_job",
		{
			title: "Cancel Terminal Job",
			description: "取消正在运行的 terminal 长任务。需要审批。",
			inputSchema: z.object({
				jobId: z.string().min(1)
			})
		},
		async ({ jobId }) => asJsonTextResult(await terminalJobStore.cancel(jobId))
	);

	server.registerTool(
		"run_godot_scene_script",
		{
			title: "Run Godot Scene Script",
			description: "通过 Godot headless 模式调用 scene_operator.gd 执行场景操作。操作通过审批后实际写入磁盘。",
			inputSchema: z.object({
				operationJson: z.string().min(1).describe("JSON 格式的场景操作，包含 operation 字段和对应参数")
			}).passthrough()
		},
		async (input: { operationJson: string } & TerminalInternalInput) => {
			const { operationJson } = input;
			let parsed: unknown;
			try {
				parsed = JSON.parse(operationJson);
			} catch {
				return asJsonTextResult({ ok: false, error: "Invalid JSON: operationJson must be valid JSON" });
			}

			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				return asJsonTextResult({ ok: false, error: "operationJson must be a JSON object" });
			}

			const op = parsed as Record<string, unknown>;
			if (typeof op.operation !== "string" || op.operation.length === 0) {
				return asJsonTextResult({ ok: false, error: "Missing required field: operation" });
			}

			const scriptPath: string = "res://addons/godot_daedalus/tools/scene_operator.gd";
			const context = resolveTerminalContext(input);
			const godotProject: string = context.godotProjectPath;
			const godotExecutable: string = context.godotExecutablePath;
			const applicability = resolvePresetApplicability({
				presetName: "godot.scene_script",
				workingDirectory: context.workspaceRoot,
				requiresGodotProject: true,
				godotProjectPath: godotProject
			});
			if (!applicability.applicable) {
				return createMissingGodotProjectResult("godot.scene_script", context);
			}
			const command: string[] = [
				godotExecutable,
				"--headless",
				"--disable-crash-handler",
				"--path", godotProject,
				"--script", scriptPath,
				"--", operationJson
			];
			const cwd: string = path.resolve(godotProject);
			const allowedWorkingRoots: string[] = createAllowedWorkingRoots({
				godotProjectPath: godotProject,
				godotExecutablePath: godotExecutable
			});
			if (!allowedWorkingRoots.some((allowedRoot: string): boolean => isPathInsideRoot(cwd, allowedRoot))) {
				return asJsonTextResult({ ok: false, error: "Godot project path is outside allowed roots" });
			}

			const result: TerminalCommandResult = await runCommandWait({
				preset: {
					name: "godot.scene_script",
					description: "Run scene operator",
					command,
					workingDirectory: cwd,
					risk: "write"
				},
				command,
				cwd,
				timeoutMs: COMMAND_TIMEOUT_MS,
				godotProjectPath: godotProject || null,
				godotExecutablePath: godotExecutable
			});
			const parsedEvents: unknown[] = parseJsonObjectsFromOutput(result.stdout);
			const parsedOutput: unknown = selectGodotOperationResult(parsedEvents);
			return asJsonTextResult({
				ok: result.exitCode === 0 && parsedOutput !== null && typeof parsedOutput === "object" && (parsedOutput as Record<string, unknown>).ok === true,
				exitCode: result.exitCode,
				stdout: result.stdout,
				stderr: result.stderr,
				durationMs: result.durationMs,
				truncated: result.truncated,
				parsed: parsedOutput,
				parsedEvents
			});
		}
	);
}
