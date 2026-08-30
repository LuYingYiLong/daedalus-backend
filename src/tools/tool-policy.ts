import { isDynamicMcpToolName } from "./dynamic-mcp-tools.js";
import { HARD_BLOCKED_TOOLS, TOOL_POLICIES } from "./tool-policy-table.js";
import { findWorkspace, isPathInsideWorkspaceSources } from "../workspace/registry.js";
import { getPluginMcpToolByLlmName, getPluginTool } from "../plugins/runtime/registries.js";
import type { DownloadAuthorizationScope } from "./download-authorization.js";
import type { NetworkAccessRequired } from "./download-authorization.js";

export type ApprovalMode = "manual" | "auto-safe" | "full-trust";

export type ToolRisk = "read" | "verify" | "propose" | "write" | "destructive";

export type ToolPolicy = {
	risk: ToolRisk;
};

export type ToolRequiredConsent = {
	prompt: string;
	expectedText: string;
};

const TERMINAL_PRESET_RISKS: Record<string, ToolRisk> = {
	"backend.typecheck": "verify",
	"workspace.typecheck": "verify",
	"git.status": "read",
	"git.diff": "read",
	"git.init": "write",
	"godot.check_only": "verify",
	"godot.validate_scene": "verify"
};

const AUTO_SAFE_FILE_DELETE_TOOLS: ReadonlySet<string> = new Set([
	"mcp_workspace_delete_file",
	"mcp_godot_delete_file"
]);

const SANDBOXED_PROCESS_TOOLS: ReadonlySet<string> = new Set([
	"mcp_terminal_run_command",
	"mcp_terminal_run_safe_preset",
	"mcp_terminal_run_write_preset",
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
	"mcp_godot_export_mesh_library"
]);

export function isAutoSafeFileDeleteTool(toolName: string): boolean {
	return AUTO_SAFE_FILE_DELETE_TOOLS.has(toolName);
}

export function isSandboxedProcessToolName(toolName: string): boolean {
	return SANDBOXED_PROCESS_TOOLS.has(toolName);
}

export function getToolPolicy(toolName: string, _workspaceId?: string | undefined): ToolPolicy | undefined {
	if (isDynamicMcpToolName(toolName)) {
		return { risk: "write" };
	}

	const pluginTool = getPluginTool(toolName);
	if (pluginTool !== undefined) return { risk: pluginTool.risk };
	const pluginMcpTool = getPluginMcpToolByLlmName(toolName);
	return TOOL_POLICIES[toolName] ?? (pluginMcpTool === undefined ? undefined : { risk: pluginMcpTool.risk });
}

export function getEffectiveToolPolicy(toolName: string, args: Record<string, unknown>, workspaceId?: string | undefined): ToolPolicy | undefined {
	const policy: ToolPolicy | undefined = getToolPolicy(toolName, workspaceId);
	if (policy === undefined) {
		return undefined;
	}

	if (toolName !== "mcp_terminal_run_write_preset") {
		return policy;
	}

	const presetName: unknown = args.presetName;
	if (typeof presetName !== "string") {
		return policy;
	}

	const presetRisk: ToolRisk | undefined = TERMINAL_PRESET_RISKS[presetName];
	if (presetRisk === "read" || presetRisk === "verify") {
		return { risk: presetRisk };
	}

	return policy;
}

export function isHardBlocked(toolName: string): boolean {
	return HARD_BLOCKED_TOOLS.has(toolName);
}

export type ApprovalDecision =
	| { action: "allow"; review?: ToolReviewAudit | undefined }
	| {
		action: "request_approval";
		reason: string;
		requiredConsent?: ToolRequiredConsent | undefined;
		review?: ToolReviewAudit | undefined;
		approvalKind?: "network_download" | undefined;
		downloadAuthorization?: DownloadAuthorizationScope | undefined;
		networkAccessRequired?: NetworkAccessRequired | undefined;
	}
	| { action: "deny"; reason: string; code?: string | undefined; review?: ToolReviewAudit | undefined };

export type ToolReviewAudit = {
	source: "model" | "policy";
	decision: "allow" | "ask_user" | "deny";
	reason: string;
	provider?: string | undefined;
	model?: string | undefined;
};

function getRequiredConsentForToolCall(
	toolName: string,
	args: Record<string, unknown>,
	workspaceId?: string | undefined
): ToolRequiredConsent | undefined {
	if (toolName !== "mcp_terminal_run_command") {
		return undefined;
	}

	const cwd: unknown = args.cwd;
	if (typeof cwd !== "string" || cwd.trim().length === 0) {
		return undefined;
	}

	if (!/^(?:[A-Za-z]:[\\/]|\/)/u.test(cwd.trim())) {
		return undefined;
	}
	const workspace = workspaceId === undefined ? undefined : findWorkspace(workspaceId);
	if (workspace !== undefined && isPathInsideWorkspaceSources(workspace, cwd.trim())) {
		return undefined;
	}

	return {
		prompt: `This command requests an absolute working directory outside the normal workspace-relative command path: ${cwd.trim()}`,
		expectedText: `ALLOW CROSS-WORKSPACE: ${cwd.trim()}`
	};
}

export function evaluateToolCall(
	mode: ApprovalMode,
	toolName: string,
	args: Record<string, unknown>,
	workspaceId?: string | undefined
): ApprovalDecision {
	const policy: ToolPolicy | undefined = getEffectiveToolPolicy(toolName, args, workspaceId);

	if (!policy) {
		return { action: "deny", reason: `Unknown tool: ${toolName}` };
	}

	if (isHardBlocked(toolName)) {
		return { action: "deny", reason: "This tool is hard-disabled." };
	}

	if ([
		"mcp_scheduled_task_create",
		"mcp_scheduled_task_update",
		"mcp_scheduled_task_pause",
		"mcp_scheduled_task_resume",
		"mcp_scheduled_task_delete",
	].includes(toolName)) {
		return { action: "request_approval", reason: "Scheduled tasks persist future behavior and require explicit confirmation." };
	}

	const requiredConsent: ToolRequiredConsent | undefined = getRequiredConsentForToolCall(toolName, args, workspaceId);
	if (requiredConsent !== undefined && mode !== "full-trust") {
		return {
			action: "request_approval",
			reason: "Terminal execution outside the workspace or against an absolute path requires written user confirmation.",
			requiredConsent
		};
	}

	if (mode === "manual") {
		if (policy.risk === "read" || policy.risk === "verify" || policy.risk === "propose") {
			return { action: "allow" };
		}

		return { action: "request_approval", reason: "This operation can modify files or external state and requires confirmation in Studio." };
	}

	if (mode === "auto-safe") {
		if (policy.risk === "read" || policy.risk === "verify" || policy.risk === "propose") {
			return { action: "allow" };
		}

		if (policy.risk === "destructive" && isAutoSafeFileDeleteTool(toolName)) {
			return { action: "allow" };
		}

		if (policy.risk === "write" && !isDynamicMcpToolName(toolName) && toolName !== "mcp_terminal_run_command") {
			return { action: "allow" };
		}

		return { action: "request_approval", reason: "This write operation requires confirmation in auto-safe mode." };
	}

	if (mode === "full-trust") {
		return { action: "allow" };
	}

	return { action: "deny", reason: "Unknown approval mode." };
}
