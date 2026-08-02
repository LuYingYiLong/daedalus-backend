import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { BUILTIN_TOOL_DEFINITIONS, withApprovalReasonSchema } from "./builtin-tool-definitions.js";
import {
	getDynamicMcpToolDefinitions,
	getDynamicMcpToolMapping,
	getDynamicMcpToolMetadata,
	isDynamicMcpToolName,
	type DynamicMcpToolMetadata
} from "./dynamic-mcp-tools.js";
import { BUILTIN_TOOL_MAPPINGS, type ToolMapping } from "./tool-mapping.js";
import { TOOL_POLICIES } from "./tool-policy-table.js";
import type { ToolPolicy, ToolRisk } from "./tool-policy.js";
import { CUSTOM_MCP_TOOLS_SENTINEL } from "./tool-sentinels.js";
import {
	EXECUTION_CONTROL_TOOL_DEFINITION,
	EXECUTION_CONTROL_TOOL_NAME,
	type ExecutionControlContext
} from "./execution-control.js";
import { isGodotDocumentationEnabled } from "../godot-documentation/store.js";
import type { ProviderChatOptions } from "../providers/provider-types.js";

export type ToolExecutionContext = {
	workspaceId?: string | undefined;
	editorInstanceId?: string | undefined;
	sessionId?: string | undefined;
	requestId?: string | undefined;
	executionControl?: ExecutionControlContext | undefined;
	clientType?: "studio" | "godot_plugin" | "cli" | "smoke" | "external_mcp" | "legacy" | undefined;
	imageRouting?: {
		options: ProviderChatOptions;
		contextText: string;
	} | undefined;
};

export type ToolPhaseEligibility = "read" | "verify" | "write";

export type WorkflowToolGroup = "read" | "verify" | "write";

// 这是 workflow 的保守默认工具集，不等同于同风险工具的全集。
const DEFAULT_WORKFLOW_TOOL_NAMES: Record<WorkflowToolGroup, readonly string[]> = {
	read: [
		"mcp_skills_load",
		"mcp_web_search",
		"mcp_image_inspect",
		"mcp_workspace_list_files",
		"mcp_workspace_read_text_file",
		"mcp_workspace_search_text",
		"mcp_godot_get_runtime_status",
		"mcp_godot_get_godot_version",
		"mcp_godot_search_documentation",
		"mcp_godot_get_debug_output",
		"mcp_godot_list_projects",
		"mcp_godot_get_project_summary",
		"mcp_godot_list_project_files",
		"mcp_godot_list_scenes",
		"mcp_godot_list_scripts",
		"mcp_godot_read_text_file",
		"mcp_godot_search_text",
		"mcp_godot_get_project_log_config",
		"mcp_godot_list_project_logs",
		"mcp_godot_read_project_log",
		"mcp_godot_get_project_settings",
		"mcp_godot_get_input_actions",
		"mcp_godot_get_autoloads",
		"mcp_godot_analyze_project_dependencies",
		"mcp_godot_find_unused_resources",
		"mcp_godot_find_scene_nodes",
		"mcp_godot_find_script_references",
		"mcp_godot_list_project_global_classes",
		"mcp_godot_list_project_tests",
		"mcp_godot_inspect_csharp_project_support",
		"mcp_godot_get_import_metadata",
		"mcp_godot_audit_project_health",
		"mcp_godot_get_editor_config_summary",
		"mcp_godot_get_editor_settings",
		"mcp_godot_list_editor_config_files",
		"mcp_godot_read_editor_config_file",
		"mcp_godot_get_editor_project_state",
		"mcp_godot_get_recent_projects",
		"mcp_godot_get_uid",
		"mcp_godot_inspect_scene_tree",
		"mcp_godot_editor_get_context",
		"mcp_godot_editor_get_selected_nodes",
		"mcp_godot_editor_inspect_node",
		"mcp_godot_editor_capture_scene_view",
		"mcp_godot_lsp_get_status",
		"mcp_godot_lsp_get_file_diagnostics",
		"mcp_godot_lsp_get_document_symbols",
		"mcp_godot_lsp_hover",
		"mcp_godot_lsp_goto_definition",
		"mcp_godot_dap_get_status",
		"mcp_godot_dap_get_last_error",
		"mcp_godot_dap_get_stack_trace",
		"mcp_godot_dap_get_variables",
		CUSTOM_MCP_TOOLS_SENTINEL
	],
	verify: [
		"mcp_godot_validate_scene_script_references",
		"mcp_godot_lsp_get_file_diagnostics",
		"mcp_terminal_get_capabilities",
		"mcp_terminal_run_safe_preset"
	],
	write: [
		"mcp_image_generate",
		"mcp_image_propose_import_to_workspace",
		"mcp_image_import_to_workspace",
		"mcp_image_replace_workspace_asset",
		"mcp_terminal_run_command",
		"mcp_workspace_propose_create_text_file",
		"mcp_workspace_create_text_file",
		"mcp_workspace_propose_overwrite_text_file",
		"mcp_workspace_overwrite_text_file",
		"mcp_workspace_propose_replace_text_in_file",
		"mcp_workspace_replace_text_in_file",
		"mcp_workspace_propose_replace_line_in_file",
		"mcp_workspace_replace_line_in_file",
		"mcp_workspace_delete_file",
		"mcp_godot_propose_create_text_file",
		"mcp_godot_create_text_file",
		"mcp_godot_propose_overwrite_text_file",
		"mcp_godot_overwrite_text_file",
		"mcp_godot_propose_replace_text_in_file",
		"mcp_godot_replace_text_in_file",
		"mcp_godot_propose_create_scene",
		"mcp_godot_create_scene",
		"mcp_godot_propose_add_node_to_scene",
		"mcp_godot_add_node_to_scene",
		"mcp_godot_propose_attach_script_to_node",
		"mcp_godot_attach_script_to_node",
		"mcp_godot_propose_connect_signal_in_scene",
		"mcp_godot_connect_signal_in_scene",
		"mcp_godot_propose_apply_scene_patch",
		"mcp_godot_apply_scene_patch",
		"mcp_godot_editor_apply_scene_patch",
		"mcp_godot_launch_editor",
		"mcp_godot_run_project",
		"mcp_godot_stop_project",
		"mcp_godot_resave_resource",
		"mcp_godot_update_project_uids",
		"mcp_godot_save_scene_variant",
		"mcp_godot_load_sprite_texture",
		"mcp_godot_export_mesh_library",
		"mcp_godot_propose_set_project_setting",
		"mcp_godot_set_project_setting",
		"mcp_godot_propose_unset_project_setting",
		"mcp_godot_unset_project_setting",
		"mcp_godot_propose_set_input_action",
		"mcp_godot_set_input_action",
		"mcp_godot_propose_unset_input_action",
		"mcp_godot_unset_input_action",
		"mcp_godot_propose_set_autoload",
		"mcp_godot_set_autoload",
		"mcp_godot_propose_unset_autoload",
		"mcp_godot_unset_autoload",
		"mcp_terminal_run_write_preset",
		"mcp_terminal_run_godot_scene_script"
	]
};

const NO_WORKSPACE_TOOL_NAMES: ReadonlySet<string> = new Set([
	"mcp_skills_load",
	"mcp_skills_propose_create",
	"mcp_skills_create",
	"mcp_image_generate",
	"mcp_image_inspect",
	"mcp_web_search"
]);

export function isToolAvailableWithoutWorkspace(toolName: string): boolean {
	return NO_WORKSPACE_TOOL_NAMES.has(toolName)
		|| toolName === CUSTOM_MCP_TOOLS_SENTINEL
		|| isDynamicMcpToolName(toolName);
}

export function filterToolNamesForWorkspace(toolNames: readonly string[], workspaceId?: string | undefined): string[] {
	if (workspaceId !== undefined) {
		return [...toolNames];
	}
	return toolNames.filter(isToolAvailableWithoutWorkspace);
}

export function getNoWorkspaceToolNames(): string[] {
	return [...NO_WORKSPACE_TOOL_NAMES, CUSTOM_MCP_TOOLS_SENTINEL];
}

export type ToolCatalogEntry = {
	id: string;
	definition: ChatCompletionTool;
	mapping: ToolMapping;
	policy: ToolPolicy;
	phaseEligibility: readonly ToolPhaseEligibility[];
	capabilityRequirement?: string | undefined;
	dynamicMetadata?: DynamicMcpToolMetadata | undefined;
};

function getToolName(definition: ChatCompletionTool): string | undefined {
	return definition.type === "function" ? definition.function.name : undefined;
}

function getPhaseEligibility(risk: ToolRisk): ToolPhaseEligibility[] {
	if (risk === "read") {
		return ["read", "verify", "write"];
	}
	if (risk === "verify") {
		return ["verify", "write"];
	}
	return ["write"];
}

function getCapabilityRequirement(toolName: string): string | undefined {
	return toolName === "mcp_godot_editor_capture_scene_view" ? "sceneViewCapture" : undefined;
}

function createStaticEntry(definition: ChatCompletionTool): ToolCatalogEntry {
	const id: string | undefined = getToolName(definition);
	if (id === undefined) {
		throw new Error("ToolCatalog only supports function tools");
	}

	const mapping: ToolMapping | undefined = BUILTIN_TOOL_MAPPINGS[id];
	const policy: ToolPolicy | undefined = TOOL_POLICIES[id];
	if (mapping === undefined || policy === undefined) {
		throw new Error(`ToolCatalog entry is incomplete: ${id}`);
	}

	return {
		id,
		definition,
		mapping,
		policy,
		phaseEligibility: getPhaseEligibility(policy.risk),
		capabilityRequirement: getCapabilityRequirement(id)
	};
}

function createDynamicEntry(definition: ChatCompletionTool, workspaceId?: string | undefined): ToolCatalogEntry {
	const id: string | undefined = getToolName(definition);
	if (id === undefined) {
		throw new Error("ToolCatalog only supports function tools");
	}

	const mapping: ToolMapping | undefined = getDynamicMcpToolMapping(id, workspaceId);
	const dynamicMetadata: DynamicMcpToolMetadata | undefined = getDynamicMcpToolMetadata(id, workspaceId);
	if (mapping === undefined || dynamicMetadata === undefined) {
		throw new Error(`Dynamic ToolCatalog entry is incomplete: ${id}`);
	}

	const policy: ToolPolicy = { risk: "write" };
	return {
		id,
		definition,
		mapping,
		policy,
		phaseEligibility: dynamicMetadata.planAccess === "read" ? ["read", "verify", "write"] : ["write"],
		dynamicMetadata
	};
}

function createExecutionControlEntry(): ToolCatalogEntry {
	return {
		id: EXECUTION_CONTROL_TOOL_NAME,
		definition: EXECUTION_CONTROL_TOOL_DEFINITION,
		mapping: { serverId: "internal", toolName: "execution_decision" },
		policy: { risk: "read" },
		phaseEligibility: ["read", "verify", "write"]
	};
}

/**
 * 工具定义、映射与风险判断的唯一运行时入口。
 * workspace 必须由调用方显式提供，避免并发请求借用活动 workspace。
 */
export class WorkspaceToolCatalog {
	private readonly context: ToolExecutionContext;

	constructor(context: ToolExecutionContext = {}) {
		this.context = context;
	}

	getContext(): ToolExecutionContext {
		return { ...this.context };
	}

	getEntries(): ToolCatalogEntry[] {
		const staticEntries: ToolCatalogEntry[] = BUILTIN_TOOL_DEFINITIONS
			.filter((definition: ChatCompletionTool): boolean => {
				return getToolName(definition) !== "mcp_godot_search_documentation" || isGodotDocumentationEnabled();
			})
			.map(createStaticEntry);
		const dynamicEntries: ToolCatalogEntry[] = getDynamicMcpToolDefinitions(this.context.workspaceId)
			.map((definition: ChatCompletionTool): ToolCatalogEntry => createDynamicEntry(withApprovalReasonSchema(definition), this.context.workspaceId));
		const executionControlEntries: ToolCatalogEntry[] = this.context.executionControl === undefined
			? []
			: [createExecutionControlEntry()];
		return [...staticEntries, ...dynamicEntries, ...executionControlEntries];
	}

	getDefinitions(): ChatCompletionTool[] {
		return this.getEntries().map((entry: ToolCatalogEntry): ChatCompletionTool => entry.definition);
	}

	getDefinitionsForNames(toolNames: readonly string[]): ChatCompletionTool[] {
		const allowedNames: Set<string> = new Set(toolNames);
		if (this.context.executionControl !== undefined) {
			allowedNames.add(EXECUTION_CONTROL_TOOL_NAME);
		}
		const includeDynamicTools: boolean = allowedNames.has(CUSTOM_MCP_TOOLS_SENTINEL);
		return this.getEntries()
			.filter((entry: ToolCatalogEntry): boolean => allowedNames.has(entry.id) || (includeDynamicTools && isDynamicMcpToolName(entry.id)))
			.map((entry: ToolCatalogEntry): ChatCompletionTool => entry.definition);
	}

	getEntry(toolName: string): ToolCatalogEntry | undefined {
		return this.getEntries().find((entry: ToolCatalogEntry): boolean => entry.id === toolName);
	}

	resolveMapping(toolName: string): ToolMapping {
		const entry: ToolCatalogEntry | undefined = this.getEntry(toolName);
		if (entry === undefined) {
			throw new Error(`Unknown tool: ${toolName}`);
		}
		return entry.mapping;
	}

	getPolicy(toolName: string): ToolPolicy | undefined {
		return this.getEntry(toolName)?.policy;
	}

	getToolNamesForPhase(phase: ToolPhaseEligibility): string[] {
		return this.getEntries()
			.filter((entry: ToolCatalogEntry): boolean => entry.phaseEligibility.includes(phase))
			.map((entry: ToolCatalogEntry): string => entry.id);
	}
}

export function createWorkspaceToolCatalog(context: ToolExecutionContext = {}): WorkspaceToolCatalog {
	return new WorkspaceToolCatalog(context);
}

export function getDefaultWorkflowToolNames(group: WorkflowToolGroup): string[] {
	return [...DEFAULT_WORKFLOW_TOOL_NAMES[group]];
}
