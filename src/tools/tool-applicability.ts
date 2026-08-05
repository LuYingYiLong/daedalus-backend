export const TOOL_APPLICABILITY_CODES = [
	"git_repository_missing",
	"package_manifest_missing",
	"typecheck_script_missing",
	"godot_project_missing",
	"godot_runtime_unavailable",
	"diagnostics_unavailable",
	"workspace_unavailable"
] as const;

export type ToolApplicabilityCode = typeof TOOL_APPLICABILITY_CODES[number];

const TOOL_APPLICABILITY_CODE_SET: ReadonlySet<string> = new Set(TOOL_APPLICABILITY_CODES);

export function isToolApplicabilityCode(value: unknown): value is ToolApplicabilityCode {
	return typeof value === "string" && TOOL_APPLICABILITY_CODE_SET.has(value);
}
