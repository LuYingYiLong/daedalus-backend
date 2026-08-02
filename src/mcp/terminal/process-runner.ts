import { type ChildProcess, spawn } from "node:child_process";
import { MAX_STDERR_CHARS, MAX_STDOUT_CHARS, normalizeTailLines, tailText, truncateOutput } from "./output-tail.js";
import {
	COMMAND_TIMEOUT_MS,
	describePresetCommand
} from "./presets.js";
import { terminalJobStore } from "./job-store.js";
import type { CommandPreset, TerminalCommandResult, TerminalJobRecord, TerminalSandboxMode } from "./types.js";

type Invocation = {
	command: string;
	args: string[];
	commandLine: string;
	shell?: boolean | undefined;
	env?: Record<string, string> | undefined;
	sandboxMode?: TerminalSandboxMode | undefined;
	workspaceId?: string | undefined;
	workspaceRoot?: string | undefined;
	trusted?: boolean | undefined;
	consentText?: string | undefined;
	authorizationSource?: "model" | "policy" | "user" | undefined;
};

export async function runCommandWait(params: {
	preset: CommandPreset;
	command: string[];
	cwd: string;
	resourcePath?: string | null | undefined;
	godotProjectPath?: string | null | undefined;
	godotExecutablePath?: string | undefined;
	timeoutMs?: number | undefined;
	env?: Record<string, string> | undefined;
	sandboxMode?: TerminalSandboxMode | undefined;
	workspaceId?: string | undefined;
	workspaceRoot?: string | undefined;
	trusted?: boolean | undefined;
	consentText?: string | undefined;
	authorizationSource?: "model" | "policy" | "user" | undefined;
}): Promise<TerminalCommandResult> {
	return new Promise((resolve) => {
		const startMs: number = Date.now();
		let stdout: string = "";
		let stderr: string = "";
		let child: ChildProcess;

		try {
			child = spawn(params.command[0]!, params.command.slice(1), {
				cwd: params.cwd,
				stdio: ["ignore", "pipe", "pipe"],
				env: params.env,
				timeout: params.timeoutMs ?? COMMAND_TIMEOUT_MS
			});
		} catch (error: unknown) {
			resolve({
				preset: params.preset.name,
				ok: false,
				exitCode: null,
				command: params.command,
				commandLine: describePresetCommand(params.command),
				cwd: params.cwd,
				resourcePath: params.resourcePath,
				godotProjectPath: params.godotProjectPath,
				godotExecutablePath: params.godotExecutablePath,
				sandboxMode: params.sandboxMode,
				workspaceId: params.workspaceId,
				workspaceRoot: params.workspaceRoot,
				trusted: params.trusted,
				consentText: params.consentText,
				authorizationSource: params.authorizationSource,
				stdout,
				stderr: error instanceof Error ? `Process error: ${error.message}` : "Process spawn failed",
				durationMs: Date.now() - startMs,
				truncated: false
			});
			return;
		}

		child.stdout?.on("data", (data: Buffer): void => {
			stdout += data.toString("utf8");
		});

		child.stderr?.on("data", (data: Buffer): void => {
			stderr += data.toString("utf8");
		});

		child.on("error", (error: Error): void => {
			stderr += `\nProcess error: ${error.message}`;
			resolve({
				preset: params.preset.name,
				ok: false,
				exitCode: null,
				command: params.command,
				commandLine: describePresetCommand(params.command),
				cwd: params.cwd,
				resourcePath: params.resourcePath,
				godotProjectPath: params.godotProjectPath,
				godotExecutablePath: params.godotExecutablePath,
				sandboxMode: params.sandboxMode,
				workspaceId: params.workspaceId,
				workspaceRoot: params.workspaceRoot,
				trusted: params.trusted,
				consentText: params.consentText,
				authorizationSource: params.authorizationSource,
				stdout,
				stderr,
				durationMs: Date.now() - startMs,
				truncated: false
			});
		});

		child.on("close", (exitCode: number | null): void => {
			const stdoutResult = truncateOutput(stdout, MAX_STDOUT_CHARS);
			const stderrResult = truncateOutput(stderr, MAX_STDERR_CHARS);

			resolve({
				preset: params.preset.name,
				ok: exitCode === 0,
				exitCode,
				command: params.command,
				commandLine: describePresetCommand(params.command),
				cwd: params.cwd,
				resourcePath: params.resourcePath,
				godotProjectPath: params.godotProjectPath,
				godotExecutablePath: params.godotExecutablePath,
				sandboxMode: params.sandboxMode,
				workspaceId: params.workspaceId,
				workspaceRoot: params.workspaceRoot,
				trusted: params.trusted,
				consentText: params.consentText,
				authorizationSource: params.authorizationSource,
				stdout: stdoutResult.text,
				stderr: stderrResult.text,
				durationMs: Date.now() - startMs,
				truncated: stdoutResult.truncated || stderrResult.truncated
			});
		});
	});
}

export function startCommandJob(params: {
	preset: CommandPreset;
	command: string[];
	cwd: string;
	timeoutMs: number;
	wakeAfterMs?: number | undefined;
	tailLines?: number | undefined;
	resourcePath?: string | null | undefined;
	godotProjectPath?: string | null | undefined;
	godotExecutablePath?: string | undefined;
	env?: Record<string, string> | undefined;
	sandboxMode?: TerminalSandboxMode | undefined;
	workspaceId?: string | undefined;
	workspaceRoot?: string | undefined;
	trusted?: boolean | undefined;
	consentText?: string | undefined;
	authorizationSource?: "model" | "policy" | "user" | undefined;
}): TerminalJobRecord {
	const tailLines: number = normalizeTailLines(params.tailLines);
	const record: TerminalJobRecord = terminalJobStore.createRecord({
		preset: params.preset.name,
		command: params.command,
		commandLine: describePresetCommand(params.command),
		cwd: params.cwd,
		timeoutMs: params.timeoutMs,
		wakeAfterMs: params.wakeAfterMs,
		resourcePath: params.resourcePath,
		godotProjectPath: params.godotProjectPath,
		godotExecutablePath: params.godotExecutablePath,
		sandboxMode: params.sandboxMode,
		workspaceId: params.workspaceId,
		workspaceRoot: params.workspaceRoot,
		trusted: params.trusted,
		consentText: params.consentText,
		authorizationSource: params.authorizationSource
	});

	let child: ChildProcess;
	try {
		child = spawn(params.command[0]!, params.command.slice(1), {
			cwd: params.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: params.env
		});
	} catch (error: unknown) {
		const finishedAt: string = new Date().toISOString();
		record.status = "spawn_error";
		record.error = error instanceof Error ? error.message : "Process spawn failed";
		record.finishedAt = finishedAt;
		record.updatedAt = finishedAt;
		void terminalJobStore.persistSnapshot(record);
		return record;
	}

	record.pid = child.pid;
	const timeout: NodeJS.Timeout = setTimeout((): void => {
		child.kill();
		void terminalJobStore.finish(record.jobId, "timed_out", null, `Process timed out after ${params.timeoutMs}ms`);
	}, params.timeoutMs);

	terminalJobStore.addRunning({ record, child, timeout });

	child.stdout?.on("data", (data: Buffer): void => {
		terminalJobStore.appendStdout(record.jobId, data.toString("utf8"), tailLines);
	});

	child.stderr?.on("data", (data: Buffer): void => {
		terminalJobStore.appendStderr(record.jobId, data.toString("utf8"), tailLines);
	});

	child.on("error", (error: Error): void => {
		void terminalJobStore.finish(record.jobId, "spawn_error", null, `Process error: ${error.message}`);
	});

	child.on("close", (exitCode: number | null): void => {
		void terminalJobStore.finish(record.jobId, exitCode === 0 ? "completed" : "failed", exitCode);
	});

	return {
		...record,
		stdoutTail: tailText(record.stdout, tailLines),
		stderrTail: tailText(record.stderr, tailLines)
	};
}

export async function runCommandInvocationWait(params: {
	presetName: string;
	invocation: Invocation;
	cwd: string;
	timeoutMs?: number | undefined;
}): Promise<TerminalCommandResult> {
	return new Promise((resolve) => {
		const startMs: number = Date.now();
		let stdout: string = "";
		let stderr: string = "";
		let child: ChildProcess;

		try {
			child = spawn(params.invocation.command, params.invocation.args, {
				cwd: params.cwd,
				stdio: ["ignore", "pipe", "pipe"],
				env: params.invocation.env,
				shell: params.invocation.shell,
				timeout: params.timeoutMs ?? COMMAND_TIMEOUT_MS
			});
		} catch (error: unknown) {
			resolve({
				preset: params.presetName,
				ok: false,
				exitCode: null,
				command: [params.invocation.command, ...params.invocation.args],
				commandLine: params.invocation.commandLine,
				cwd: params.cwd,
				sandboxMode: params.invocation.sandboxMode,
				workspaceId: params.invocation.workspaceId,
				workspaceRoot: params.invocation.workspaceRoot,
				trusted: params.invocation.trusted,
				consentText: params.invocation.consentText,
				authorizationSource: params.invocation.authorizationSource,
				stdout,
				stderr: error instanceof Error ? `Process error: ${error.message}` : "Process spawn failed",
				durationMs: Date.now() - startMs,
				truncated: false
			});
			return;
		}

		child.stdout?.on("data", (data: Buffer): void => {
			stdout += data.toString("utf8");
		});

		child.stderr?.on("data", (data: Buffer): void => {
			stderr += data.toString("utf8");
		});

		child.on("error", (error: Error): void => {
			stderr += `\nProcess error: ${error.message}`;
			resolve({
				preset: params.presetName,
				ok: false,
				exitCode: null,
				command: [params.invocation.command, ...params.invocation.args],
				commandLine: params.invocation.commandLine,
				cwd: params.cwd,
				sandboxMode: params.invocation.sandboxMode,
				workspaceId: params.invocation.workspaceId,
				workspaceRoot: params.invocation.workspaceRoot,
				trusted: params.invocation.trusted,
				consentText: params.invocation.consentText,
				authorizationSource: params.invocation.authorizationSource,
				stdout,
				stderr,
				durationMs: Date.now() - startMs,
				truncated: false
			});
		});

		child.on("close", (exitCode: number | null): void => {
			const stdoutResult = truncateOutput(stdout, MAX_STDOUT_CHARS);
			const stderrResult = truncateOutput(stderr, MAX_STDERR_CHARS);

			resolve({
				preset: params.presetName,
				ok: exitCode === 0,
				exitCode,
				command: [params.invocation.command, ...params.invocation.args],
				commandLine: params.invocation.commandLine,
				cwd: params.cwd,
				sandboxMode: params.invocation.sandboxMode,
				workspaceId: params.invocation.workspaceId,
				workspaceRoot: params.invocation.workspaceRoot,
				trusted: params.invocation.trusted,
				consentText: params.invocation.consentText,
				authorizationSource: params.invocation.authorizationSource,
				stdout: stdoutResult.text,
				stderr: stderrResult.text,
				durationMs: Date.now() - startMs,
				truncated: stdoutResult.truncated || stderrResult.truncated
			});
		});
	});
}

export function startCommandInvocationJob(params: {
	presetName: string;
	invocation: Invocation;
	cwd: string;
	timeoutMs: number;
	wakeAfterMs?: number | undefined;
	tailLines?: number | undefined;
}): TerminalJobRecord {
	const tailLines: number = normalizeTailLines(params.tailLines);
	const command: string[] = [params.invocation.command, ...params.invocation.args];
	const record: TerminalJobRecord = terminalJobStore.createRecord({
		preset: params.presetName,
		command,
		commandLine: params.invocation.commandLine,
		cwd: params.cwd,
		timeoutMs: params.timeoutMs,
		wakeAfterMs: params.wakeAfterMs,
		sandboxMode: params.invocation.sandboxMode,
		workspaceId: params.invocation.workspaceId,
		workspaceRoot: params.invocation.workspaceRoot,
		trusted: params.invocation.trusted,
		consentText: params.invocation.consentText,
		authorizationSource: params.invocation.authorizationSource
	});

	let child: ChildProcess;
	try {
		child = spawn(params.invocation.command, params.invocation.args, {
			cwd: params.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: params.invocation.env,
			shell: params.invocation.shell
		});
	} catch (error: unknown) {
		const finishedAt: string = new Date().toISOString();
		record.status = "spawn_error";
		record.error = error instanceof Error ? error.message : "Process spawn failed";
		record.finishedAt = finishedAt;
		record.updatedAt = finishedAt;
		void terminalJobStore.persistSnapshot(record);
		return record;
	}

	record.pid = child.pid;
	const timeout: NodeJS.Timeout = setTimeout((): void => {
		child.kill();
		void terminalJobStore.finish(record.jobId, "timed_out", null, `Process timed out after ${params.timeoutMs}ms`);
	}, params.timeoutMs);

	terminalJobStore.addRunning({ record, child, timeout });

	child.stdout?.on("data", (data: Buffer): void => {
		terminalJobStore.appendStdout(record.jobId, data.toString("utf8"), tailLines);
	});

	child.stderr?.on("data", (data: Buffer): void => {
		terminalJobStore.appendStderr(record.jobId, data.toString("utf8"), tailLines);
	});

	child.on("error", (error: Error): void => {
		void terminalJobStore.finish(record.jobId, "spawn_error", null, `Process error: ${error.message}`);
	});

	child.on("close", (exitCode: number | null): void => {
		void terminalJobStore.finish(record.jobId, exitCode === 0 ? "completed" : "failed", exitCode);
	});

	return {
		...record,
		stdoutTail: tailText(record.stdout, tailLines),
		stderrTail: tailText(record.stderr, tailLines)
	};
}
