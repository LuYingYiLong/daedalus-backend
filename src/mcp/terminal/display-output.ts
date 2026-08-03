import type { TerminalExecutionMode, TerminalSandboxMode } from "./types.js";

export const MAX_TERMINAL_DISPLAY_STREAM_CHARS: number = 6000;
const MAX_TERMINAL_DISPLAY_COMMAND_CHARS: number = 4000;
const REDACTED: string = "[REDACTED]";

export type TerminalDisplaySnapshot = {
	commandLine: string;
	cwd: string;
	executionMode: TerminalExecutionMode;
	sandboxMode?: TerminalSandboxMode | undefined;
	status: string;
	exitCode: number | null;
	durationMs?: number | undefined;
	jobId?: string | undefined;
	stdout: string;
	stderr: string;
	stdoutOmittedChars: number;
	stderrOmittedChars: number;
	truncated: boolean;
};

const OSC_SEQUENCE_PATTERN: RegExp = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/gu;
const CSI_SEQUENCE_PATTERN: RegExp = /\u001B\[[0-?]*[ -/]*[@-~]/gu;
const ESCAPE_SEQUENCE_PATTERN: RegExp = /\u001B[@-_]/gu;
const CONTROL_CHARACTER_PATTERN: RegExp = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;
const BEARER_PATTERN: RegExp = /(Authorization\s*:\s*Bearer\s+)[^\s,;]+/giu;
const ENV_SECRET_PATTERN: RegExp = /\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD))\s*([=:])\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const JSON_SECRET_PATTERN: RegExp = /("(?:api[_-]?key|authorization|auth[_-]?token|access[_-]?token|refresh[_-]?token|secret|password|passwd|bearer)"\s*:\s*)"[^"]*"/giu;
const COMMAND_BEARER_PATTERN: RegExp = /(\bBearer\s+)[A-Za-z0-9._~+/=-]+/giu;

function applyCarriageReturnSemantics(value: string): string {
	return value
		.replace(/\r\n/gu, "\n")
		.split("\n")
		.map((line: string): string => {
			const carriageReturnIndex: number = line.lastIndexOf("\r");
			return carriageReturnIndex < 0 ? line : line.slice(carriageReturnIndex + 1);
		})
		.join("\n");
}

export function sanitizeTerminalDisplayText(value: string): string {
	return applyCarriageReturnSemantics(value)
		.replace(OSC_SEQUENCE_PATTERN, "")
		.replace(CSI_SEQUENCE_PATTERN, "")
		.replace(ESCAPE_SEQUENCE_PATTERN, "")
		.replace(CONTROL_CHARACTER_PATTERN, "")
		.replace(BEARER_PATTERN, `$1${REDACTED}`)
		.replace(ENV_SECRET_PATTERN, `$1$2${REDACTED}`)
		.replace(JSON_SECRET_PATTERN, `$1"${REDACTED}"`);
}

export function sanitizeTerminalDisplayCommand(value: string): string {
	const sanitized: string = sanitizeTerminalDisplayText(value)
		.replace(COMMAND_BEARER_PATTERN, `$1${REDACTED}`);
	if (sanitized.length <= MAX_TERMINAL_DISPLAY_COMMAND_CHARS) {
		return sanitized;
	}
	return `${sanitized.slice(0, MAX_TERMINAL_DISPLAY_COMMAND_CHARS)}...`;
}

export function clipTerminalDisplayTail(value: string, previousOmittedChars: number = 0): {
	text: string;
	omittedChars: number;
	truncated: boolean;
} {
	const sanitized: string = sanitizeTerminalDisplayText(value);
	if (sanitized.length <= MAX_TERMINAL_DISPLAY_STREAM_CHARS) {
		return {
			text: sanitized,
			omittedChars: Math.max(0, previousOmittedChars),
			truncated: previousOmittedChars > 0
		};
	}

	return {
		text: sanitized.slice(-MAX_TERMINAL_DISPLAY_STREAM_CHARS),
		omittedChars: Math.max(0, previousOmittedChars) + sanitized.length - MAX_TERMINAL_DISPLAY_STREAM_CHARS,
		truncated: true
	};
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
	const value: unknown = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getNumber(record: Record<string, unknown>, key: string): number | undefined {
	const value: unknown = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function createTerminalDisplaySnapshot(
	record: Record<string, unknown>,
	args: Record<string, unknown>
): TerminalDisplaySnapshot {
	const executionMode: TerminalExecutionMode = args.executionMode === "job" ? "job" : "wait";
	const stdoutValue: string = getString(record, executionMode === "job" ? "stdoutTail" : "stdout") ?? "";
	const stderrValue: string = getString(record, executionMode === "job" ? "stderrTail" : "stderr") ?? "";
	const stdout = clipTerminalDisplayTail(stdoutValue, getNumber(record, "stdoutOmittedChars") ?? 0);
	const stderr = clipTerminalDisplayTail(stderrValue, getNumber(record, "stderrOmittedChars") ?? 0);
	const ok: unknown = record.ok;
	const status: string = getString(record, "status")
		?? (executionMode === "job" ? "running" : ok === false ? "failed" : ok === true ? "completed" : "finished");
	const exitCodeValue: unknown = record.exitCode;
	const sandboxModeValue: unknown = record.sandboxMode;
	const requestedCwd: string = typeof args.cwd === "string" && args.cwd.trim().length > 0 ? args.cwd.trim() : ".";

	return {
		commandLine: sanitizeTerminalDisplayCommand(getString(record, "commandLine") ?? String(args.commandLine ?? "")),
		cwd: sanitizeTerminalDisplayText(requestedCwd),
		executionMode,
		...(sandboxModeValue === "os-sandbox" || sandboxModeValue === "approved-unsandboxed" || sandboxModeValue === "full-trust" || sandboxModeValue === "preset"
			? { sandboxMode: sandboxModeValue }
			: {}),
		status,
		exitCode: typeof exitCodeValue === "number" ? exitCodeValue : null,
		...(getNumber(record, "durationMs") === undefined ? {} : { durationMs: getNumber(record, "durationMs") }),
		...(getString(record, "jobId") === undefined ? {} : { jobId: getString(record, "jobId") }),
		stdout: stdout.text,
		stderr: stderr.text,
		stdoutOmittedChars: stdout.omittedChars,
		stderrOmittedChars: stderr.omittedChars,
		truncated: record.truncated === true || stdout.truncated || stderr.truncated
	};
}
