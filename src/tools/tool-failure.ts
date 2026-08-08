import type { WorkspaceFileRef } from "../workspace/source-context.js";

export const TOOL_FAILURE_CATEGORIES = [
	"business",
	"environment",
	"policy",
	"protocol",
	"infrastructure"
] as const;

export type ToolFailureCategory = typeof TOOL_FAILURE_CATEGORIES[number];

export type ToolFailure = {
	code: string;
	category: ToolFailureCategory;
	message: string;
	retryable: boolean;
	artifactRefs: string[];
	artifactFileRefs?: WorkspaceFileRef[] | undefined;
	sourceFolderId?: string | undefined;
	details?: Record<string, unknown> | undefined;
};

export class StructuredToolError extends Error {
	readonly failure: ToolFailure;

	constructor(failure: ToolFailure, options?: ErrorOptions) {
		super(failure.message, options);
		this.name = "StructuredToolError";
		this.failure = cloneToolFailure(failure);
	}
}

const BUSINESS_FAILURE_CODES: ReadonlySet<string> = new Set([
	"signal_node_not_found",
	"property_not_found",
	"old_text_not_found",
	"expected_text_mismatch",
	"node_not_found",
	"node_already_exists",
	"signal_already_connected",
	"resource_uid_missing",
	"resource_not_found",
	"target_not_found"
]);

const ENVIRONMENT_FAILURE_CODES: ReadonlySet<string> = new Set([
	"editor_unavailable",
	"editor_tool_timeout",
	"godot_runtime_unavailable",
	"godot_executable_unavailable",
	"diagnostics_unavailable",
	"lsp_unavailable",
	"dap_unavailable",
	"workspace_unavailable",
	"runtime_capability_unavailable_cached"
]);

const POLICY_FAILURE_CODES: ReadonlySet<string> = new Set([
	"approval_denied",
	"approval_rejected",
	"command_review_denied",
	"network_access_required",
	"network_download_declined",
	"path_traversal_denied",
	"path_outside_workspace",
	"source_required",
	"ambiguous_source",
	"invalid_source"
]);

const PROTOCOL_FAILURE_CODES: ReadonlySet<string> = new Set([
	"invalid_arguments",
	"invalid_tool_result",
	"unsupported_tool_call_type",
	"tool_protocol_violation",
	"retry_exhausted"
]);

const LEGACY_EXACT_FAILURES: ReadonlyMap<string, Pick<ToolFailure, "code" | "category" | "retryable">> = new Map([
	["oldText was not found in file", { code: "old_text_not_found", category: "business", retryable: true }],
	["expectedText does not match the current line", { code: "expected_text_mismatch", category: "business", retryable: true }],
	["This signal connection already exists in the scene", { code: "signal_already_connected", category: "business", retryable: true }]
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function getStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item: unknown): item is string => typeof item === "string" && item.length > 0)
		: [];
}

function getWorkspaceFileRefs(value: unknown): WorkspaceFileRef[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item: unknown): item is WorkspaceFileRef => (
		isRecord(item)
		&& typeof item.workspaceId === "string"
		&& typeof item.sourceFolderId === "string"
		&& typeof item.relativePath === "string"
	)).map((item: WorkspaceFileRef): WorkspaceFileRef => ({ ...item }));
}

function getCategory(value: unknown): ToolFailureCategory | undefined {
	return typeof value === "string" && (TOOL_FAILURE_CATEGORIES as readonly string[]).includes(value)
		? value as ToolFailureCategory
		: undefined;
}

function categoryForCode(code: string): ToolFailureCategory | undefined {
	if (BUSINESS_FAILURE_CODES.has(code)) return "business";
	if (ENVIRONMENT_FAILURE_CODES.has(code)) return "environment";
	if (POLICY_FAILURE_CODES.has(code)) return "policy";
	if (PROTOCOL_FAILURE_CODES.has(code)) return "protocol";
	return undefined;
}

function parseLeadingCode(message: string): string | undefined {
	const separatorIndex: number = message.indexOf(":");
	const candidate: string = (separatorIndex < 0 ? message : message.slice(0, separatorIndex)).trim();
	return /^[a-z][a-z0-9_]*$/u.test(candidate) ? candidate : undefined;
}

export function cloneToolFailure(failure: ToolFailure): ToolFailure {
	return {
		...failure,
		artifactRefs: [...failure.artifactRefs],
		artifactFileRefs: failure.artifactFileRefs?.map((fileRef: WorkspaceFileRef): WorkspaceFileRef => ({ ...fileRef })),
		details: failure.details === undefined ? undefined : { ...failure.details }
	};
}

export function parseStructuredToolFailure(value: unknown): ToolFailure | undefined {
	if (!isRecord(value)) return undefined;
	const nestedFailure: unknown = value.failure;
	const record: Record<string, unknown> = isRecord(nestedFailure) ? nestedFailure : value;
	const code: string | undefined = getString(record.code);
	const message: string | undefined = getString(record.message) ?? getString(record.error);
	if (code === undefined || message === undefined) return undefined;
	const category: ToolFailureCategory | undefined = getCategory(record.category) ?? categoryForCode(code);
	if (category === undefined) return undefined;
	const details: Record<string, unknown> | undefined = isRecord(record.details) ? record.details : undefined;
	return {
		code,
		category,
		message,
		retryable: getBoolean(record.retryable) ?? (category === "business" || category === "protocol"),
		artifactRefs: getStringArray(record.artifactRefs),
		artifactFileRefs: getWorkspaceFileRefs(record.artifactFileRefs),
		sourceFolderId: getString(record.sourceFolderId),
		details
	};
}

export function createToolFailure(
	error: unknown,
	context: {
		artifactRefs?: string[] | undefined;
		artifactFileRefs?: WorkspaceFileRef[] | undefined;
		sourceFolderId?: string | undefined;
	} = {}
): ToolFailure {
	if (error instanceof StructuredToolError) {
		return {
			...cloneToolFailure(error.failure),
			artifactRefs: error.failure.artifactRefs.length > 0 ? [...error.failure.artifactRefs] : [...(context.artifactRefs ?? [])],
			artifactFileRefs: error.failure.artifactFileRefs ?? context.artifactFileRefs,
			sourceFolderId: error.failure.sourceFolderId ?? context.sourceFolderId
		};
	}
	const structuredFailure: ToolFailure | undefined = parseStructuredToolFailure(error);
	if (structuredFailure !== undefined) {
		return {
			...structuredFailure,
			artifactRefs: structuredFailure.artifactRefs.length > 0 ? structuredFailure.artifactRefs : [...(context.artifactRefs ?? [])],
			artifactFileRefs: structuredFailure.artifactFileRefs ?? context.artifactFileRefs,
			sourceFolderId: structuredFailure.sourceFolderId ?? context.sourceFolderId
		};
	}

	const message: string = error instanceof Error ? error.message : typeof error === "string" ? error : "Tool execution failed";
	const legacyFailure = LEGACY_EXACT_FAILURES.get(message);
	const leadingCode: string | undefined = parseLeadingCode(message);
	const category: ToolFailureCategory | undefined = leadingCode === undefined ? undefined : categoryForCode(leadingCode);
	return {
		code: legacyFailure?.code ?? (category === undefined ? "tool_execution_failed" : leadingCode!),
		category: legacyFailure?.category ?? category ?? "business",
		message,
		retryable: legacyFailure?.retryable ?? (category === undefined || category === "business" || category === "protocol"),
		artifactRefs: [...(context.artifactRefs ?? [])],
		artifactFileRefs: context.artifactFileRefs,
		sourceFolderId: context.sourceFolderId
	};
}

export function serializeToolFailure(failure: ToolFailure): string {
	return JSON.stringify({
		ok: false,
		validationStatus: failure.category === "environment" ? "not_applicable" : "failed",
		environmentIssue: failure.category === "environment" || undefined,
		failureCode: failure.code,
		failure: cloneToolFailure(failure),
		error: {
			code: failure.code,
			message: failure.message,
			category: failure.category,
			retryable: failure.retryable
		},
		artifactRefs: [...failure.artifactRefs],
		artifactFileRefs: failure.artifactFileRefs?.map((fileRef: WorkspaceFileRef): WorkspaceFileRef => ({ ...fileRef })),
		sourceFolderId: failure.sourceFolderId
	});
}
