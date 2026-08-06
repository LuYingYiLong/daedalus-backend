/** Workflow-only semantics. These values are deliberately independent from tool display names. */
export const workflowTargetKinds = ["workspace_file", "godot_script", "godot_scene", "project_setting"] as const;
export type WorkflowTargetKind = typeof workflowTargetKinds[number];

export const workflowValidationCapabilities = [
	"artifact_readback",
	"workspace_typecheck",
	"godot_script_check",
	"godot_scene_reference_check"
] as const;
export type WorkflowValidationCapability = typeof workflowValidationCapabilities[number];

export type WorkflowToolSemantics = {
	readonly validationCapabilities?: readonly WorkflowValidationCapability[];
	readonly repairFamilies?: readonly WorkflowTargetKind[];
};

const WORKSPACE_WRITE_TOOLS: ReadonlySet<string> = new Set([
	"mcp_workspace_create_text_file",
	"mcp_workspace_propose_create_text_file",
	"mcp_workspace_overwrite_text_file",
	"mcp_workspace_propose_overwrite_text_file",
	"mcp_workspace_replace_text_in_file",
	"mcp_workspace_propose_replace_text_in_file",
	"mcp_workspace_replace_line_in_file",
	"mcp_workspace_propose_replace_line_in_file",
	"mcp_workspace_delete_file"
]);

const GODOT_SCRIPT_WRITE_TOOLS: ReadonlySet<string> = new Set([
	"mcp_godot_create_text_file",
	"mcp_godot_propose_create_text_file",
	"mcp_godot_overwrite_text_file",
	"mcp_godot_propose_overwrite_text_file",
	"mcp_godot_replace_text_in_file",
	"mcp_godot_propose_replace_text_in_file",
	"mcp_godot_delete_file"
]);

const GODOT_SCENE_WRITE_TOOLS: ReadonlySet<string> = new Set([
	"mcp_godot_create_scene",
	"mcp_godot_propose_create_scene",
	"mcp_godot_add_node_to_scene",
	"mcp_godot_propose_add_node_to_scene",
	"mcp_godot_attach_script_to_node",
	"mcp_godot_propose_attach_script_to_node",
	"mcp_godot_connect_signal_in_scene",
	"mcp_godot_propose_connect_signal_in_scene",
	"mcp_godot_apply_scene_patch",
	"mcp_godot_propose_apply_scene_patch",
	"mcp_godot_editor_apply_scene_patch"
]);

const GODOT_SETTING_WRITE_TOOLS: ReadonlySet<string> = new Set([
	"mcp_godot_set_project_setting",
	"mcp_godot_propose_set_project_setting",
	"mcp_godot_unset_project_setting",
	"mcp_godot_propose_unset_project_setting",
	"mcp_godot_set_input_action",
	"mcp_godot_propose_set_input_action",
	"mcp_godot_unset_input_action",
	"mcp_godot_propose_unset_input_action",
	"mcp_godot_set_autoload",
	"mcp_godot_propose_set_autoload",
	"mcp_godot_unset_autoload",
	"mcp_godot_propose_unset_autoload"
]);

export function getWorkflowToolSemantics(
	toolName: string,
	args: Record<string, unknown> = {}
): WorkflowToolSemantics {
	if (toolName === "mcp_workspace_read_text_file" || toolName === "mcp_godot_read_text_file") {
		return { validationCapabilities: ["artifact_readback"] };
	}
	if (toolName === "mcp_godot_validate_scene_script_references" || toolName === "mcp_godot_inspect_scene_tree") {
		return { validationCapabilities: ["godot_scene_reference_check"] };
	}
	if (toolName === "mcp_terminal_run_safe_preset" || toolName === "mcp_terminal_run_write_preset") {
		const presetName: unknown = args.presetName;
		if (presetName === "workspace.typecheck" || presetName === "backend.typecheck") return { validationCapabilities: ["workspace_typecheck"] };
		if (presetName === "godot.check_only") return { validationCapabilities: ["godot_script_check"] };
		if (presetName === "godot.validate_scene") return { validationCapabilities: ["godot_scene_reference_check"] };
		return {};
	}
	if (WORKSPACE_WRITE_TOOLS.has(toolName)) return { repairFamilies: ["workspace_file"] };
	if (GODOT_SCRIPT_WRITE_TOOLS.has(toolName)) return { repairFamilies: ["godot_script", "workspace_file"] };
	if (GODOT_SCENE_WRITE_TOOLS.has(toolName)) return { repairFamilies: ["godot_scene"] };
	if (GODOT_SETTING_WRITE_TOOLS.has(toolName)) return { repairFamilies: ["project_setting"] };
	return {};
}
