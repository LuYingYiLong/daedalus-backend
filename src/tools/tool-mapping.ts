import { getDynamicMcpToolMapping } from "./dynamic-mcp-tools.js";

export type ToolMapping = {
	serverId: string;
	toolName: string;
};

export const BUILTIN_TOOL_MAPPINGS: Record<string, ToolMapping> = {
	"mcp_skills_load": { serverId: "skills", toolName: "load" },
	"mcp_skills_propose_create": { serverId: "skills", toolName: "propose_create" },
	"mcp_skills_create": { serverId: "skills", toolName: "create" },
	"mcp_image_generate": { serverId: "image", toolName: "generate" },
	"mcp_image_inspect": { serverId: "image", toolName: "inspect" },
	"mcp_image_propose_import_to_workspace": { serverId: "image", toolName: "propose_import_to_workspace" },
	"mcp_image_import_to_workspace": { serverId: "image", toolName: "import_to_workspace" },
	"mcp_image_replace_workspace_asset": { serverId: "image", toolName: "replace_workspace_asset" },
	"mcp_web_search": { serverId: "web_search", toolName: "search" },
	"mcp_workspace_list_files": { serverId: "workspace", toolName: "list_files" },
	"mcp_workspace_list_source_folders": { serverId: "workspace", toolName: "list_source_folders" },
	"mcp_workspace_get_source_context": { serverId: "workspace", toolName: "get_source_context" },
	"mcp_workspace_read_text_file": { serverId: "workspace", toolName: "read_text_file" },
	"mcp_workspace_search_text": { serverId: "workspace", toolName: "search_text" },
	"mcp_workspace_propose_create_text_file": { serverId: "workspace", toolName: "propose_create_text_file" },
	"mcp_workspace_create_text_file": { serverId: "workspace", toolName: "create_text_file" },
	"mcp_workspace_propose_overwrite_text_file": { serverId: "workspace", toolName: "propose_overwrite_text_file" },
	"mcp_workspace_overwrite_text_file": { serverId: "workspace", toolName: "overwrite_text_file" },
	"mcp_workspace_propose_replace_text_in_file": { serverId: "workspace", toolName: "propose_replace_text_in_file" },
	"mcp_workspace_replace_text_in_file": { serverId: "workspace", toolName: "replace_text_in_file" },
	"mcp_workspace_propose_replace_line_in_file": { serverId: "workspace", toolName: "propose_replace_line_in_file" },
	"mcp_workspace_replace_line_in_file": { serverId: "workspace", toolName: "replace_line_in_file" },
	"mcp_workspace_delete_file": { serverId: "workspace", toolName: "delete_file" },
	"mcp_godot_get_runtime_status": {
		serverId: "godot",
		toolName: "get_runtime_status"
	},
	"mcp_godot_get_godot_version": {
		serverId: "godot",
		toolName: "get_godot_version"
	},
	"mcp_godot_search_documentation": {
		serverId: "godot_documentation",
		toolName: "search_documentation"
	},
	"mcp_godot_launch_editor": {
		serverId: "godot",
		toolName: "launch_editor"
	},
	"mcp_godot_run_project": {
		serverId: "godot",
		toolName: "run_project"
	},
	"mcp_godot_stop_project": {
		serverId: "godot",
		toolName: "stop_project"
	},
	"mcp_godot_get_debug_output": {
		serverId: "godot",
		toolName: "get_debug_output"
	},
	"mcp_godot_list_projects": {
		serverId: "godot",
		toolName: "list_projects"
	},
	"mcp_godot_get_project_summary": {
		serverId: "godot",
		toolName: "get_project_summary"
	},
	"mcp_godot_list_project_files": {
		serverId: "godot",
		toolName: "list_project_files"
	},
	"mcp_godot_list_scenes": {
		serverId: "godot",
		toolName: "list_scenes"
	},
	"mcp_godot_list_scripts": {
		serverId: "godot",
		toolName: "list_scripts"
	},
	"mcp_godot_read_text_file": {
		serverId: "godot",
		toolName: "read_text_file"
	},
	"mcp_godot_search_text": {
		serverId: "godot",
		toolName: "search_text"
	},
	"mcp_godot_get_project_log_config": {
		serverId: "godot",
		toolName: "get_project_log_config"
	},
	"mcp_godot_list_project_logs": {
		serverId: "godot",
		toolName: "list_project_logs"
	},
	"mcp_godot_read_project_log": {
		serverId: "godot",
		toolName: "read_project_log"
	},
	"mcp_godot_get_project_settings": {
		serverId: "godot",
		toolName: "get_project_settings"
	},
	"mcp_godot_get_editor_config_summary": {
		serverId: "godot",
		toolName: "get_editor_config_summary"
	},
	"mcp_godot_get_editor_settings": {
		serverId: "godot",
		toolName: "get_editor_settings"
	},
	"mcp_godot_list_editor_config_files": {
		serverId: "godot",
		toolName: "list_editor_config_files"
	},
	"mcp_godot_read_editor_config_file": {
		serverId: "godot",
		toolName: "read_editor_config_file"
	},
	"mcp_godot_get_editor_project_state": {
		serverId: "godot",
		toolName: "get_editor_project_state"
	},
	"mcp_godot_get_recent_projects": {
		serverId: "godot",
		toolName: "get_recent_projects"
	},
	"mcp_godot_get_uid": {
		serverId: "godot",
		toolName: "get_uid"
	},
	"mcp_godot_resave_resource": {
		serverId: "godot",
		toolName: "resave_resource"
	},
	"mcp_godot_update_project_uids": {
		serverId: "godot",
		toolName: "update_project_uids"
	},
	"mcp_godot_save_scene_variant": {
		serverId: "godot",
		toolName: "save_scene_variant"
	},
	"mcp_godot_load_sprite_texture": {
		serverId: "godot",
		toolName: "load_sprite_texture"
	},
	"mcp_godot_export_mesh_library": {
		serverId: "godot",
		toolName: "export_mesh_library"
	},
	"mcp_godot_propose_set_project_setting": {
		serverId: "godot",
		toolName: "propose_set_project_setting"
	},
	"mcp_godot_set_project_setting": {
		serverId: "godot",
		toolName: "set_project_setting"
	},
	"mcp_godot_propose_unset_project_setting": {
		serverId: "godot",
		toolName: "propose_unset_project_setting"
	},
	"mcp_godot_unset_project_setting": {
		serverId: "godot",
		toolName: "unset_project_setting"
	},
	"mcp_godot_get_input_actions": {
		serverId: "godot",
		toolName: "get_input_actions"
	},
	"mcp_godot_propose_set_input_action": {
		serverId: "godot",
		toolName: "propose_set_input_action"
	},
	"mcp_godot_set_input_action": {
		serverId: "godot",
		toolName: "set_input_action"
	},
	"mcp_godot_propose_unset_input_action": {
		serverId: "godot",
		toolName: "propose_unset_input_action"
	},
	"mcp_godot_unset_input_action": {
		serverId: "godot",
		toolName: "unset_input_action"
	},
	"mcp_godot_get_autoloads": {
		serverId: "godot",
		toolName: "get_autoloads"
	},
	"mcp_godot_propose_set_autoload": {
		serverId: "godot",
		toolName: "propose_set_autoload"
	},
	"mcp_godot_set_autoload": {
		serverId: "godot",
		toolName: "set_autoload"
	},
	"mcp_godot_propose_unset_autoload": {
		serverId: "godot",
		toolName: "propose_unset_autoload"
	},
	"mcp_godot_unset_autoload": {
		serverId: "godot",
		toolName: "unset_autoload"
	},
	"mcp_godot_analyze_project_dependencies": {
		serverId: "godot",
		toolName: "analyze_project_dependencies"
	},
	"mcp_godot_find_unused_resources": {
		serverId: "godot",
		toolName: "find_unused_resources"
	},
	"mcp_godot_find_scene_nodes": {
		serverId: "godot",
		toolName: "find_scene_nodes"
	},
	"mcp_godot_find_script_references": {
		serverId: "godot",
		toolName: "find_script_references"
	},
	"mcp_godot_list_project_global_classes": {
		serverId: "godot",
		toolName: "list_project_global_classes"
	},
	"mcp_godot_list_project_tests": {
		serverId: "godot",
		toolName: "list_project_tests"
	},
	"mcp_godot_inspect_csharp_project_support": {
		serverId: "godot",
		toolName: "inspect_csharp_project_support"
	},
	"mcp_godot_get_import_metadata": {
		serverId: "godot",
		toolName: "get_import_metadata"
	},
	"mcp_godot_audit_project_health": {
		serverId: "godot",
		toolName: "audit_project_health"
	},
	"mcp_godot_propose_create_text_file": {
		serverId: "godot",
		toolName: "propose_create_text_file"
	},
	"mcp_godot_create_text_file": {
		serverId: "godot",
		toolName: "create_text_file"
	},
	"mcp_godot_propose_overwrite_text_file": {
		serverId: "godot",
		toolName: "propose_overwrite_text_file"
	},
	"mcp_godot_overwrite_text_file": {
		serverId: "godot",
		toolName: "overwrite_text_file"
	},
	"mcp_godot_propose_replace_text_in_file": {
		serverId: "godot",
		toolName: "propose_replace_text_in_file"
	},
	"mcp_godot_replace_text_in_file": {
		serverId: "godot",
		toolName: "replace_text_in_file"
	},
	"mcp_godot_delete_file": {
		serverId: "godot",
		toolName: "delete_file"
	},
	"mcp_terminal_run_safe_preset": {
		serverId: "terminal",
		toolName: "run_safe_preset"
	},
	"mcp_terminal_run_write_preset": {
		serverId: "terminal",
		toolName: "run_write_preset"
	},
	"mcp_terminal_get_job_status": {
		serverId: "terminal",
		toolName: "get_terminal_job_status"
	},
	"mcp_terminal_get_job_tail": {
		serverId: "terminal",
		toolName: "get_terminal_job_tail"
	},
	"mcp_terminal_run_command": {
		serverId: "terminal",
		toolName: "run_command"
	},
	"mcp_terminal_cancel_job": {
		serverId: "terminal",
		toolName: "cancel_terminal_job"
	},
	"mcp_terminal_get_capabilities": {
		serverId: "terminal",
		toolName: "get_terminal_capabilities"
	},
	"mcp_godot_inspect_scene_tree": {
		serverId: "godot",
		toolName: "inspect_scene_tree"
	},
	"mcp_godot_validate_scene_script_references": {
		serverId: "godot",
		toolName: "validate_scene_script_references"
	},
	"mcp_godot_propose_create_scene": {
		serverId: "godot",
		toolName: "propose_create_scene"
	},
	"mcp_godot_create_scene": {
		serverId: "godot",
		toolName: "create_scene"
	},
	"mcp_godot_propose_add_node_to_scene": {
		serverId: "godot",
		toolName: "propose_add_node_to_scene"
	},
	"mcp_godot_add_node_to_scene": {
		serverId: "godot",
		toolName: "add_node_to_scene"
	},
	"mcp_godot_propose_attach_script_to_node": {
		serverId: "godot",
		toolName: "propose_attach_script_to_node"
	},
	"mcp_godot_attach_script_to_node": {
		serverId: "godot",
		toolName: "attach_script_to_node"
	},
	"mcp_godot_propose_connect_signal_in_scene": {
		serverId: "godot",
		toolName: "propose_connect_signal_in_scene"
	},
	"mcp_godot_connect_signal_in_scene": {
		serverId: "godot",
		toolName: "connect_signal_in_scene"
	},
	"mcp_godot_propose_apply_scene_patch": {
		serverId: "godot",
		toolName: "propose_apply_scene_patch"
	},
	"mcp_godot_apply_scene_patch": {
		serverId: "godot",
		toolName: "apply_scene_patch"
	},
	"mcp_godot_editor_get_context": {
		serverId: "godot_editor",
		toolName: "get_context"
	},
	"mcp_godot_editor_get_selected_nodes": {
		serverId: "godot_editor",
		toolName: "get_selected_nodes"
	},
	"mcp_godot_editor_inspect_node": {
		serverId: "godot_editor",
		toolName: "inspect_node"
	},
	"mcp_godot_editor_capture_scene_view": {
		serverId: "godot_editor",
		toolName: "capture_scene_view"
	},
	"mcp_godot_editor_apply_scene_patch": {
		serverId: "godot_editor",
		toolName: "apply_scene_patch"
	},
	"mcp_godot_lsp_get_status": {
		serverId: "godot_diagnostics",
		toolName: "lsp_get_status"
	},
	"mcp_godot_lsp_get_file_diagnostics": {
		serverId: "godot_diagnostics",
		toolName: "lsp_get_file_diagnostics"
	},
	"mcp_godot_lsp_get_document_symbols": {
		serverId: "godot_diagnostics",
		toolName: "lsp_get_document_symbols"
	},
	"mcp_godot_lsp_hover": {
		serverId: "godot_diagnostics",
		toolName: "lsp_hover"
	},
	"mcp_godot_lsp_goto_definition": {
		serverId: "godot_diagnostics",
		toolName: "lsp_goto_definition"
	},
	"mcp_godot_dap_get_status": {
		serverId: "godot_diagnostics",
		toolName: "dap_get_status"
	},
	"mcp_godot_dap_get_last_error": {
		serverId: "godot_diagnostics",
		toolName: "dap_get_last_error"
	},
	"mcp_godot_dap_get_stack_trace": {
		serverId: "godot_diagnostics",
		toolName: "dap_get_stack_trace"
	},
	"mcp_godot_dap_get_variables": {
		serverId: "godot_diagnostics",
		toolName: "dap_get_variables"
	},
	"mcp_terminal_run_godot_scene_script": {
		serverId: "terminal",
		toolName: "run_godot_scene_script"
	}
};

export function resolveToolMapping(llmToolName: string, workspaceId?: string | undefined): ToolMapping {
	const mapping: ToolMapping | undefined = BUILTIN_TOOL_MAPPINGS[llmToolName] ?? getDynamicMcpToolMapping(llmToolName, workspaceId);

	if (!mapping) {
		throw new Error(`Unknown tool: ${llmToolName}`);
	}

	return mapping;
}
