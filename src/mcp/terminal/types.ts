import type { ChildProcess } from "node:child_process";
import type { ToolApplicabilityCode } from "../../tools/tool-applicability.js";

export type CommandRisk = "read" | "verify" | "write" | "destructive";

export type CommandPreset = {
	name: string;
	description: string;
	command: string[];
	workingDirectory: string;
	risk: CommandRisk;
	requiresGodotProject?: boolean | undefined;
	resourcePathMode?: "optional" | "required" | undefined;
	defaultTimeoutMs?: number | undefined;
};

export type TerminalExecutionMode = "wait" | "job";

export type PresetRunInput = {
	presetName: string;
	sourceFolderId?: string | undefined;
	workingDirectory?: string | undefined;
	resourcePath?: string | undefined;
	executionMode?: TerminalExecutionMode | undefined;
	wakeAfterMs?: number | undefined;
	timeoutMs?: number | undefined;
	tailLines?: number | undefined;
};

export type TerminalSandboxMode = "os-sandbox" | "approved-unsandboxed" | "full-trust" | "preset";

export type CommandRunInput = {
	commandLine: string;
	sourceFolderId?: string | undefined;
	cwd?: string | undefined;
	env?: Record<string, string> | undefined;
	executionMode?: TerminalExecutionMode | undefined;
	wakeAfterMs?: number | undefined;
	timeoutMs?: number | undefined;
	tailLines?: number | undefined;
	reason?: string | undefined;
};

export type TerminalCommandResult = {
	preset: string;
	ok: boolean;
	status?: Exclude<TerminalJobStatus, "running"> | undefined;
	exitCode: number | null;
	command: string[];
	commandLine: string;
	cwd: string;
	resourcePath?: string | null | undefined;
	godotProjectPath?: string | null | undefined;
	godotExecutablePath?: string | undefined;
	sandboxMode?: TerminalSandboxMode | undefined;
	workspaceId?: string | undefined;
	workspaceRoot?: string | undefined;
	trusted?: boolean | undefined;
	consentText?: string | undefined;
	authorizationSource?: "model" | "policy" | "user" | undefined;
	validationStatus?: "passed" | "failed" | "not_applicable" | "unknown" | undefined;
	applicabilityCode?: ToolApplicabilityCode | undefined;
	notApplicableReason?: string | undefined;
	environmentIssue?: boolean | undefined;
	stdout: string;
	stderr: string;
	stdoutOmittedChars?: number | undefined;
	stderrOmittedChars?: number | undefined;
	durationMs: number;
	truncated: boolean;
};

export type TerminalJobStatus = "running" | "completed" | "failed" | "cancelled" | "timed_out" | "spawn_error";

export type TerminalJobRecord = {
	jobId: string;
	preset: string;
	status: TerminalJobStatus;
	command: string[];
	commandLine: string;
	cwd: string;
	startedAt: string;
	updatedAt: string;
	finishedAt?: string | undefined;
	timeoutAt?: string | undefined;
	wakeAfterMs?: number | undefined;
	nextWakeAt?: string | undefined;
	exitCode?: number | null | undefined;
	durationMs: number;
	stdout: string;
	stderr: string;
	stdoutTail: string;
	stderrTail: string;
	truncated: boolean;
	pid?: number | undefined;
	resourcePath?: string | null | undefined;
	godotProjectPath?: string | null | undefined;
	godotExecutablePath?: string | undefined;
	sandboxMode?: TerminalSandboxMode | undefined;
	workspaceId?: string | undefined;
	workspaceRoot?: string | undefined;
	trusted?: boolean | undefined;
	consentText?: string | undefined;
	authorizationSource?: "model" | "policy" | "user" | undefined;
	error?: string | undefined;
};

export type RunningTerminalJob = {
	record: TerminalJobRecord;
	child: ChildProcess;
	timeout?: NodeJS.Timeout | undefined;
};
