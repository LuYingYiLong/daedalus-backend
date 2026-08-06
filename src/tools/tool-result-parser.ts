import { createTerminalDisplaySnapshot, type TerminalDisplaySnapshot } from "../mcp/terminal/display-output.js";
import { isToolApplicabilityCode, type ToolApplicabilityCode } from "./tool-applicability.js";
import type { WorkspaceFileRef } from "../workspace/source-context.js";

export type { ToolApplicabilityCode } from "./tool-applicability.js";

export type ToolValidationStatus = "passed" | "failed" | "not_applicable" | "unknown";

export type ParsedToolResultSummary = {
	ok?: boolean | undefined;
	exitCode?: number | null | undefined;
	diagnosticsCount?: number | undefined;
	diagnosticsErrorCount?: number | undefined;
	validationStatus?: ToolValidationStatus | undefined;
	summary?: string | undefined;
	failedChecks?: string[] | undefined;
	failureCode?: string | undefined;
	environmentIssue?: boolean | undefined;
	applicabilityCode?: ToolApplicabilityCode | undefined;
	notApplicableReason?: string | undefined;
	artifactRefs?: string[] | undefined;
	artifactFileRefs?: WorkspaceFileRef[] | undefined;
	sourceFolderId?: string | undefined;
	terminalJobId?: string | undefined;
	terminalJobStatus?: string | undefined;
	terminalJobWakeAfterMs?: number | undefined;
	terminalDisplay?: TerminalDisplaySnapshot | undefined;
};

// 旧结果只有同时满足 preset、退出码和完整错误签名时才允许兼容放行。
const LEGACY_GIT_NOT_REPOSITORY_PATTERN: RegExp = /\bfatal:\s*not a git repository\b/iu;
const LEGACY_PACKAGE_ENOENT_PATTERN: RegExp = /(?:\bnpm\s+(?:ERR!|error)\s+code\s+ENOENT\b[\s\S]{0,300}\bpackage\.json\b|\bpackage\.json\b[\s\S]{0,80}\bENOENT\b)/iu;
const LEGACY_MISSING_TYPECHECK_SCRIPT_PATTERN: RegExp = /\bnpm\s+(?:ERR!|error)\s+Missing script:\s*["'`]?typecheck["'`]?\b/iu;
const LEGACY_GODOT_SPAWN_ERROR_PATTERN: RegExp = /\bspawn\s+\S+\s+ENOENT\b/iu;
const GIT_NON_REPOSITORY_EXIT_CODES: ReadonlySet<number> = new Set([128, 129]);
const NOT_APPLICABLE_CODES: ReadonlySet<ToolApplicabilityCode> = new Set([
	"git_repository_missing",
	"package_manifest_missing",
	"typecheck_script_missing",
	"godot_project_missing"
]);
const ENVIRONMENT_CODES: ReadonlySet<ToolApplicabilityCode> = new Set([
	"git_repository_missing",
	"package_manifest_missing",
	"typecheck_script_missing",
	"godot_project_missing",
	"godot_runtime_unavailable",
	"diagnostics_unavailable",
	"workspace_unavailable"
]);

function parseJsonObject(text: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(text);
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: null;
	} catch {
		return null;
	}
}

function getString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getNumberOrNull(value: unknown): number | null | undefined {
	if (typeof value === "number") return value;
	if (value === null) return null;
	return undefined;
}

function getBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getErrorCode(record: Record<string, unknown>): string | undefined {
	const error: unknown = record.error;
	if (isRecord(error)) return getString(error.code);
	return getString(record.errorCode) ?? getString(record.code);
}

function getErrorMessage(record: Record<string, unknown>): string | undefined {
	const error: unknown = record.error;
	if (typeof error === "string" && error.length > 0) return error;
	if (isRecord(error)) return getString(error.message) ?? getString(error.code);
	return undefined;
}

function getApplicabilityCode(record: Record<string, unknown>): ToolApplicabilityCode | undefined {
	return isToolApplicabilityCode(record.applicabilityCode) ? record.applicabilityCode : undefined;
}

function getValidationStatus(record: Record<string, unknown>): ToolValidationStatus | undefined {
	const value: unknown = record.validationStatus;
	return value === "passed" || value === "failed" || value === "not_applicable" || value === "unknown"
		? value
		: undefined;
}

function isDiagnosticsTool(toolName: string): boolean {
	return toolName.startsWith("mcp_godot_lsp_") || toolName.startsWith("mcp_godot_dap_");
}

function isEnvironmentCode(code: ToolApplicabilityCode | undefined): boolean {
	return code !== undefined && ENVIRONMENT_CODES.has(code);
}

function getTerminalOutputText(record: Record<string, unknown>): string {
	return [
		getErrorCode(record),
		getErrorMessage(record),
		getString(record.summary),
		getString(record.stderr),
		getString(record.stdout),
		getString(record.stderrTail),
		getString(record.stdoutTail),
		getString(record.lastError)
	].filter((value: string | undefined): value is string => value !== undefined).join("\n");
}

function getLegacyTerminalApplicability(
	presetName: string,
	record: Record<string, unknown>
): { applicabilityCode: ToolApplicabilityCode; notApplicableReason: string } | undefined {
	const text: string = getTerminalOutputText(record);
	const exitCode: number | null | undefined = getNumberOrNull(record.exitCode);
	if (
		(presetName === "git.status" || presetName === "git.diff")
		&& exitCode !== null
		&& exitCode !== undefined
		&& GIT_NON_REPOSITORY_EXIT_CODES.has(exitCode)
		&& LEGACY_GIT_NOT_REPOSITORY_PATTERN.test(text)
	) {
		return {
			applicabilityCode: "git_repository_missing",
			notApplicableReason: `${presetName} is not applicable because the workspace is not a Git repository.`
		};
	}
	if (presetName === "workspace.typecheck" && exitCode !== null && exitCode !== undefined && exitCode !== 0) {
		if (LEGACY_PACKAGE_ENOENT_PATTERN.test(text)) {
			return {
				applicabilityCode: "package_manifest_missing",
				notApplicableReason: "workspace.typecheck is not applicable because package.json is missing from the workspace."
			};
		}
		if (LEGACY_MISSING_TYPECHECK_SCRIPT_PATTERN.test(text)) {
			return {
				applicabilityCode: "typecheck_script_missing",
				notApplicableReason: "workspace.typecheck is not applicable because package.json has no typecheck script."
			};
		}
	}
	return undefined;
}

function getLegacyDiagnosticsApplicability(toolName: string, record: Record<string, unknown>): ToolApplicabilityCode | undefined {
	if (!isDiagnosticsTool(toolName)) return undefined;
	const errorCode: string | undefined = getErrorCode(record);
	if (errorCode === "godot_diagnostics_unavailable" || errorCode === "lsp_unavailable" || errorCode === "dap_unavailable") {
		return "diagnostics_unavailable";
	}
	if (errorCode === "workspace_unavailable") return "workspace_unavailable";
	return undefined;
}

function getStructuredGodotApplicability(toolName: string, record: Record<string, unknown>): ToolApplicabilityCode | undefined {
	if (!toolName.startsWith("mcp_godot_") && !toolName.startsWith("godot.")) return undefined;
	const errorCode: string | undefined = getErrorCode(record);
	return errorCode === "godot_runtime_unavailable" || errorCode === "godot_executable_unavailable"
		? "godot_runtime_unavailable"
		: undefined;
}

function clipSummary(text: string, maxChars: number = 360): string {
	const trimmedText: string = text.trim();
	return trimmedText.length <= maxChars ? trimmedText : `${trimmedText.slice(0, maxChars)}...`;
}

function firstUsefulLine(text: string): string | undefined {
	return text.split(/\r?\n/u).map((line: string): string => line.trim()).find((line: string): boolean => line.length > 0);
}

function collectArtifactRefs(args: Record<string, unknown>, record: Record<string, unknown> | null): string[] {
	const refs: Set<string> = new Set();
	for (const key of ["relativePath", "resourcePath", "scenePath", "scriptPath", "path"]) {
		const argValue: string | undefined = getString(args[key]);
		if (argValue !== undefined) refs.add(argValue);
		const recordValue: string | undefined = record === null ? undefined : getString(record[key]);
		if (recordValue !== undefined) refs.add(recordValue);
	}
	const resultRefs: unknown = record?.artifactRefs;
	if (Array.isArray(resultRefs)) {
		for (const value of resultRefs) {
			if (typeof value === "string" && value.length > 0) refs.add(value);
		}
	}
	return [...refs];
}

function collectArtifactFileRefs(
	args: Record<string, unknown>,
	record: Record<string, unknown> | null,
	workspaceId: string | undefined
): WorkspaceFileRef[] | undefined {
	const sourceFolderId: string | undefined = getString(args.sourceFolderId)
		?? (record === null ? undefined : getString(record.sourceFolderId));
	if (workspaceId === undefined || sourceFolderId === undefined) return undefined;
	const refs = collectArtifactRefs(args, record);
	const fileRefs: WorkspaceFileRef[] = refs.flatMap((value: string): WorkspaceFileRef[] => {
		const relativePath: string = value.replace(/^res:\/\//iu, "").replaceAll("\\", "/");
		if (relativePath.length === 0 || relativePath.startsWith("/") || /^[A-Za-z]:\//u.test(relativePath)
			|| relativePath.split("/").some((segment: string): boolean => segment === ".." || segment === ".")) {
			return [];
		}
		return [{ workspaceId, sourceFolderId, relativePath }];
	});
	return fileRefs.length === 0 ? undefined : fileRefs;
}

function enrichParsedSummary(
	summary: ParsedToolResultSummary,
	args: Record<string, unknown>,
	record: Record<string, unknown> | null,
	workspaceId: string | undefined
): ParsedToolResultSummary {
	const sourceFolderId: string | undefined = getString(args.sourceFolderId)
		?? (record === null ? undefined : getString(record.sourceFolderId));
	const artifactFileRefs: WorkspaceFileRef[] | undefined = collectArtifactFileRefs(args, record, workspaceId);
	return {
		...summary,
		...(sourceFolderId === undefined ? {} : { sourceFolderId }),
		...(artifactFileRefs === undefined ? {} : { artifactFileRefs })
	};
}

function createFailureMessage(record: Record<string, unknown>, fallback: string): string {
	const errorText: string | undefined = getErrorMessage(record);
	if (errorText !== undefined) return errorText;
	const stderrLine: string | undefined = getString(record.stderr) === undefined ? undefined : firstUsefulLine(String(record.stderr));
	if (stderrLine !== undefined) return stderrLine;
	const stdoutLine: string | undefined = getString(record.stdout) === undefined ? undefined : firstUsefulLine(String(record.stdout));
	return stdoutLine ?? fallback;
}

function parseDiagnosticsSummary(toolName: string, record: Record<string, unknown>, args: Record<string, unknown>): ParsedToolResultSummary {
	const diagnostics: unknown = record.diagnostics;
	const diagnosticsList: Record<string, unknown>[] = Array.isArray(diagnostics)
		? diagnostics.filter((item: unknown): item is Record<string, unknown> => isRecord(item))
		: [];
	const errorDiagnostics: Record<string, unknown>[] = diagnosticsList.filter((diagnostic: Record<string, unknown>): boolean => String(diagnostic.severity ?? "").toLowerCase() === "error");
	const failedChecks: string[] = errorDiagnostics.map((diagnostic: Record<string, unknown>): string => {
		const resourcePath: string = String(diagnostic.resourcePath ?? args.resourcePath ?? "script");
		const line: string = diagnostic.lineStart === undefined ? "?" : String(diagnostic.lineStart);
		const column: string = diagnostic.columnStart === undefined ? "?" : String(diagnostic.columnStart);
		return `${resourcePath}:${line}:${column} ${String(diagnostic.message ?? "LSP diagnostic error")}`;
	});
	const ok: boolean | undefined = getBoolean(record.ok);
	const explicitCode: ToolApplicabilityCode | undefined = getApplicabilityCode(record);
	const applicabilityCode: ToolApplicabilityCode | undefined = explicitCode ?? getLegacyDiagnosticsApplicability(toolName, record);
	const explicitStatus: ToolValidationStatus | undefined = getValidationStatus(record);
	const environmentIssue: boolean = record.environmentIssue === true || isEnvironmentCode(applicabilityCode);
	const failureMessage: string | undefined = ok === false ? createFailureMessage(record, "LSP diagnostics failed") : undefined;
	const diagnosticsCount: number = diagnosticsList.length;
	const diagnosticsErrorCount: number = errorDiagnostics.length;
	const reason: string = getString(record.notApplicableReason) ?? getString(record.summary) ?? `${toolName} is not applicable in the current workspace`;
	if (explicitStatus === "not_applicable") {
		return {
			ok: undefined,
			validationStatus: "not_applicable",
			summary: reason,
			environmentIssue: true,
			applicabilityCode,
			notApplicableReason: reason,
			artifactRefs: collectArtifactRefs(args, record)
		};
	}

	const validationStatus: ToolValidationStatus = environmentIssue || diagnosticsErrorCount > 0 || ok === false
		? "failed"
		: explicitStatus ?? (ok === true ? "passed" : "unknown");
	const failedChecksWithToolFailure: string[] = failedChecks.length > 0
		? failedChecks
		: failureMessage === undefined && !environmentIssue ? [] : [failureMessage ?? "Diagnostics are unavailable in the current environment."];
	return {
		ok: validationStatus === "failed" ? false : ok,
		diagnosticsCount,
		diagnosticsErrorCount,
		validationStatus,
		summary: failureMessage === undefined
			? `${String(record.resourcePath ?? args.resourcePath ?? "script")} LSP diagnostics: ${diagnosticsCount} total, ${diagnosticsErrorCount} errors`
			: `${String(record.resourcePath ?? args.resourcePath ?? "script")} LSP diagnostics unavailable: ${failureMessage}`,
		failedChecks: failedChecksWithToolFailure,
		environmentIssue: environmentIssue || undefined,
		applicabilityCode,
		artifactRefs: collectArtifactRefs(args, record)
	};
}

function parseTerminalSummary(record: Record<string, unknown>, args: Record<string, unknown>): ParsedToolResultSummary {
	const presetName: string = String(record.preset ?? args.presetName ?? "terminal");
	const status: string | undefined = getString(record.status);
	const jobId: string | undefined = getString(record.jobId);
	const ok: boolean | undefined = getBoolean(record.ok);
	const exitCode: number | null | undefined = getNumberOrNull(record.exitCode);
	const resourcePath: string | undefined = getString(record.resourcePath) ?? getString(args.resourcePath);
	const failureMessage: string = createFailureMessage(record, `exitCode=${String(exitCode)}`);
	const explicitCode: ToolApplicabilityCode | undefined = getApplicabilityCode(record);
	const legacyApplicability = explicitCode === undefined ? getLegacyTerminalApplicability(presetName, record) : undefined;
	const structuredGodotCode: ToolApplicabilityCode | undefined = explicitCode === undefined
		? getStructuredGodotApplicability(presetName, record)
		: undefined;
	const explicitStatus: ToolValidationStatus | undefined = getValidationStatus(record);
	const structuredNotApplicable: boolean = explicitStatus === "not_applicable"
		|| status === "not_applicable"
		|| (explicitCode !== undefined && NOT_APPLICABLE_CODES.has(explicitCode));
	const notApplicableReason: string | undefined = structuredNotApplicable
		? getString(record.notApplicableReason)
		: legacyApplicability?.notApplicableReason;
	const legacyGodotRuntimeUnavailable: boolean = explicitCode === undefined
		&& presetName.startsWith("godot.")
		&& LEGACY_GODOT_SPAWN_ERROR_PATTERN.test(failureMessage);
	const applicabilityCode: ToolApplicabilityCode | undefined = explicitCode
		?? legacyApplicability?.applicabilityCode
		?? structuredGodotCode
		?? (legacyGodotRuntimeUnavailable ? "godot_runtime_unavailable" : undefined);
	const environmentIssue: boolean = record.environmentIssue === true
		|| isEnvironmentCode(applicabilityCode)
		|| legacyGodotRuntimeUnavailable;
	const inferredNotApplicable: boolean = applicabilityCode !== undefined && NOT_APPLICABLE_CODES.has(applicabilityCode);
	if (explicitStatus === "not_applicable" || status === "not_applicable" || notApplicableReason !== undefined || inferredNotApplicable) {
		const reason: string = notApplicableReason ?? `${presetName} is not applicable in the current workspace`;
		return {
			ok: undefined,
			exitCode,
			validationStatus: "not_applicable",
			summary: reason,
			environmentIssue: true,
			applicabilityCode,
			notApplicableReason: reason,
			artifactRefs: collectArtifactRefs(args, record),
			terminalJobId: jobId,
			terminalJobStatus: status
		};
	}
	if (status === "running") {
		return {
			ok: undefined,
			exitCode,
			validationStatus: "unknown",
			summary: `${presetName}${jobId === undefined ? "" : ` ${jobId}`} running`,
			artifactRefs: collectArtifactRefs(args, record),
			terminalJobId: jobId,
			terminalJobStatus: status,
			terminalJobWakeAfterMs: getNumberOrNull(record.wakeAfterMs) ?? undefined
		};
	}

	const isFailedStatus: boolean = status === "failed" || status === "timed_out" || status === "spawn_error";
	const failed: boolean = ok === false || isFailedStatus || (environmentIssue && applicabilityCode !== undefined);
	const failedChecks: string[] = failed
		? [`${presetName}${resourcePath === undefined ? "" : ` ${resourcePath}`} failed: ${failureMessage}`]
		: [];
	return {
		ok: failed ? false : ok,
		exitCode,
		validationStatus: explicitStatus ?? (failed ? "failed" : ok === true || status === "completed" ? "passed" : "unknown"),
		summary: `${presetName}${resourcePath === undefined ? "" : ` ${resourcePath}`} ${failed ? "failed" : ok === true || status === "completed" ? "passed" : "finished"}`,
		failedChecks: failedChecks.length > 0 ? failedChecks : undefined,
		failureCode: failed ? (getString(record.failureCode) ?? getErrorCode(record) ?? "tool_failed") : undefined,
		environmentIssue: environmentIssue || undefined,
		applicabilityCode,
		artifactRefs: collectArtifactRefs(args, record),
		terminalJobId: jobId,
		terminalJobStatus: status
	};
}

function isGodotRuntimeTool(toolName: string): boolean {
	return toolName === "mcp_godot_launch_editor" || toolName === "mcp_godot_run_project" || toolName === "mcp_godot_stop_project";
}

function parseGenericJsonSummary(toolName: string, record: Record<string, unknown>, args: Record<string, unknown>): ParsedToolResultSummary {
	const ok: boolean | undefined = getBoolean(record.ok) ?? getBoolean(record.valid);
	const applicabilityCode: ToolApplicabilityCode | undefined = getApplicabilityCode(record);
	const structuredGodotCode: ToolApplicabilityCode | undefined = applicabilityCode === undefined
		? getStructuredGodotApplicability(toolName, record)
		: undefined;
	const effectiveApplicabilityCode: ToolApplicabilityCode | undefined = applicabilityCode ?? structuredGodotCode;
	const explicitStatus: ToolValidationStatus | undefined = getValidationStatus(record);
	const reason: string = getString(record.notApplicableReason) ?? getString(record.summary) ?? `${toolName} is not applicable in the current workspace`;
	if (explicitStatus === "not_applicable" || (effectiveApplicabilityCode !== undefined && NOT_APPLICABLE_CODES.has(effectiveApplicabilityCode))) {
		return {
			ok: undefined,
			validationStatus: "not_applicable",
			summary: reason,
			environmentIssue: true,
			applicabilityCode: effectiveApplicabilityCode,
			notApplicableReason: reason,
			artifactRefs: collectArtifactRefs(args, record)
		};
	}
	const failedChecks: string[] = [];
	const errors: unknown = record.errors;
	if (Array.isArray(errors)) {
		for (const error of errors) failedChecks.push(String(error));
	}
	const legacyDiagnosticsCode: ToolApplicabilityCode | undefined = getLegacyDiagnosticsApplicability(toolName, record);
	const finalApplicabilityCode: ToolApplicabilityCode | undefined = effectiveApplicabilityCode ?? legacyDiagnosticsCode;
	const environmentIssue: boolean = record.environmentIssue === true
		|| isEnvironmentCode(finalApplicabilityCode)
		|| (isDiagnosticsTool(toolName) && getLegacyDiagnosticsApplicability(toolName, record) !== undefined);
	const effectiveOk: boolean | undefined = ok ?? (failedChecks.length > 0 || environmentIssue ? false : undefined);
	if (effectiveOk === false && failedChecks.length === 0) failedChecks.push(createFailureMessage(record, `${toolName} returned ok=false`));
	return {
		ok: effectiveOk,
		validationStatus: explicitStatus ?? (effectiveOk === false ? "failed" : effectiveOk === true ? "passed" : "unknown"),
		summary: getString(record.summary) ?? `${toolName}${effectiveOk === undefined ? "" : effectiveOk ? " passed" : ` failed: ${createFailureMessage(record, "ok=false")}`}`,
		failedChecks: failedChecks.length > 0 ? failedChecks : undefined,
		failureCode: effectiveOk === false ? (getString(record.failureCode) ?? getErrorCode(record) ?? "tool_failed") : undefined,
		environmentIssue: environmentIssue || undefined,
		applicabilityCode: finalApplicabilityCode,
		artifactRefs: collectArtifactRefs(args, record)
	};
}

export function parseToolResultSummary(
	toolName: string,
	args: Record<string, unknown>,
	content: string,
	workspaceId?: string | undefined
): ParsedToolResultSummary {
	const record: Record<string, unknown> | null = parseJsonObject(content);
	if (record === null) {
		const firstLine: string | undefined = firstUsefulLine(content);
		return enrichParsedSummary({
			validationStatus: "unknown",
			summary: firstLine === undefined ? toolName : clipSummary(firstLine),
			artifactRefs: collectArtifactRefs(args, null)
		}, args, null, workspaceId);
	}

	let summary: ParsedToolResultSummary;
	if (
		toolName === "mcp_terminal_run_command"
		|| toolName === "mcp_terminal_run_safe_preset"
		|| toolName === "mcp_terminal_run_write_preset"
		|| isGodotRuntimeTool(toolName)
	) {
		const terminalSummary: ParsedToolResultSummary = parseTerminalSummary(record, args);
		summary = toolName === "mcp_terminal_run_command" ? { ...terminalSummary, terminalDisplay: createTerminalDisplaySnapshot(record, args) } : terminalSummary;
	} else if (toolName.startsWith("mcp_godot_lsp_") || toolName.startsWith("mcp_godot_dap_")) {
		summary = parseDiagnosticsSummary(toolName, record, args);
	} else {
		summary = parseGenericJsonSummary(toolName, record, args);
	}
	return enrichParsedSummary(summary, args, record, workspaceId);
}
