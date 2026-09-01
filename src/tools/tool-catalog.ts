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
import {
	CHAT_COMPLETION_CONTROL_TOOL_DEFINITION,
	CHAT_COMPLETION_CONTROL_TOOL_NAME,
	type ChatCompletionContext
} from "./chat-completion-control.js";
import { isGodotDocumentationEnabled } from "../godot-documentation/store.js";
import type { ProviderChatOptions } from "../providers/provider-types.js";
import type { AgentLoopRecoveryController } from "../workflow/agent-loop-state.js";
import { findWorkspace } from "../workspace/registry.js";
import { hasGodotWorkspaceCapability } from "../workspace/capabilities.js";
import {
	CONTEXT_CONTROL_TOOL_DEFINITIONS,
	CONTEXT_CONTROL_TOOL_NAMES,
	type ContextControlContext
} from "./context-control.js";
import {
	TODO_UPDATE_TOOL_DEFINITION,
	TODO_UPDATE_TOOL_NAME,
	type TodoControlContext
} from "./todo-control.js";
import {
	SUMMARY_PREPARATION_TOOL_DEFINITION,
	SUMMARY_PREPARATION_TOOL_NAME,
	type SummaryPreparationContext
} from "./summary-control.js";
import { BROWSER_TOOL_NAMES, BROWSER_TOOL_NAME_SET, type BrowserControlContext } from "./browser-tools.js";
import { COMPUTER_TOOL_NAMES, COMPUTER_TOOL_NAME_SET, type ComputerControlContext } from "./computer-tools.js";
import { SCHEDULED_TASK_MANAGEMENT_TOOL_NAMES, SCHEDULED_TASK_TOOL_NAMES, SCHEDULED_TASK_TOOL_NAME_SET, type ScheduledTaskControlContext } from "./scheduled-task-tools.js";
import { getPluginToolEntries, listPluginMcpTools } from "../plugins/runtime/registries.js";
import type { PluginDevelopmentControlContext } from "../plugins/development/types.js";
import type { GodotRuntimeControlContext } from "./godot-runtime-control.js";

export type ToolExecutionContext = {
	workspaceId?: string | undefined;
	editorInstanceId?: string | undefined;
	sessionId?: string | undefined;
	requestId?: string | undefined;
	executionControl?: ExecutionControlContext | undefined;
	executionControlAvailable?: boolean | undefined;
	chatCompletion?: ChatCompletionContext | undefined;
	chatCompletionAvailable?: boolean | undefined;
	clientType?: "studio" | "studio_remote" | "studio_scheduler" | "godot_editor_bridge" | "godot_runtime_test_bridge" | "cli" | "smoke" | "external_mcp" | "legacy" | undefined;
	imageRouting?: {
		options: ProviderChatOptions;
		contextText: string;
	} | undefined;
	/** True only when the active workspace contains a source folder with project.godot. */
	hasGodotWorkspaceCapability?: boolean | undefined;
	agentLoopRecovery?: AgentLoopRecoveryController | undefined;
	contextControl?: ContextControlContext | undefined;
	contextControlAvailable?: boolean | undefined;
	todoControl?: TodoControlContext | undefined;
	todoControlAvailable?: boolean | undefined;
	summaryPreparation?: SummaryPreparationContext | undefined;
	summaryPreparationAvailable?: boolean | undefined;
	hookContext?: {
		model: string;
		approvalMode: "manual" | "auto-safe" | "full-trust";
		chatMode?: "agent" | "ask" | "plan" | "goal" | undefined;
	} | undefined;
	browserControl?: BrowserControlContext | undefined;
	computerControl?: ComputerControlContext | undefined;
	godotRuntimeControl?: GodotRuntimeControlContext | undefined;
	scheduledTaskControl?: ScheduledTaskControlContext | undefined;
	pluginDevelopmentControl?: PluginDevelopmentControlContext | undefined;
	scheduledMonitorRun?: boolean | undefined;
};

export type ToolPhaseEligibility = "read" | "verify" | "write";

export type WorkflowToolGroup = "read" | "verify" | "write";

// 这是 workflow 的保守默认工具集，不等同于同风险工具的全集。
const DEFAULT_WORKFLOW_TOOL_NAMES: Record<WorkflowToolGroup, readonly string[]> = {
	read: [
		...COMPUTER_TOOL_NAMES.filter(name => name !== "mcp_computer_action"),
		"mcp_scheduled_tasks_list",
		"mcp_scheduled_task_report",
		"mcp_browser_observe",
		"mcp_browser_connect",
		"mcp_browser_propose",
		"mcp_browser_navigate",
		"mcp_browser_navigation",
		"mcp_browser_scroll",
		"mcp_browser_wait",
		"mcp_browser_screenshot",
		"mcp_skills_load",
		"mcp_web_search",
		"mcp_image_inspect",
		"mcp_workspace_list_files",
		"mcp_workspace_list_source_folders",
		"mcp_workspace_get_source_context",
		"mcp_workspace_get_git_history",
		"mcp_workspace_read_text_file",
		"mcp_workspace_search_text",
		"mcp_godot_runtime_status",
		"mcp_godot_runtime_observe",
		"mcp_godot_runtime_screenshot",
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
		"mcp_godot_runtime_wait",
		"mcp_godot_runtime_assert",
		"mcp_godot_validate_scene_script_references",
		"mcp_godot_lsp_get_file_diagnostics",
		"mcp_terminal_run_safe_preset"
	],
	write: [
		"mcp_computer_action",
		"mcp_godot_runtime_start",
		"mcp_godot_runtime_action",
		"mcp_scheduled_task_create",
		"mcp_scheduled_task_update",
		"mcp_scheduled_task_pause",
		"mcp_scheduled_task_resume",
		"mcp_scheduled_task_delete",
		"mcp_browser_click",
		"mcp_browser_execute_step",
		"mcp_browser_type",
		"mcp_browser_select",
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
		"mcp_workspace_download_file",
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
	...SCHEDULED_TASK_TOOL_NAMES,
	...BROWSER_TOOL_NAMES,
	...COMPUTER_TOOL_NAMES,
	"mcp_skills_load",
	"mcp_skills_propose_create",
	"mcp_skills_create",
	"mcp_plugin_dev_prepare",
	"mcp_plugin_dev_apply",
	"mcp_plugin_dev_validate",
	"mcp_plugin_dev_install",
	"mcp_plugin_dev_test",
	"mcp_image_generate",
	"mcp_image_inspect",
	"mcp_godot_search_documentation",
	"mcp_web_search"
]);
const LEGACY_GODOT_PROCESS_TOOL_NAMES: ReadonlySet<string> = new Set([
	"mcp_godot_get_runtime_status",
	"mcp_godot_launch_editor",
	"mcp_godot_run_project",
	"mcp_godot_stop_project",
]);

export function isToolAvailableWithoutWorkspace(toolName: string): boolean {
	const pluginTool = getPluginToolEntries().find((entry): boolean => entry.llmToolName === toolName);
	return (pluginTool?.global === true && pluginTool.risk === "read")
		|| NO_WORKSPACE_TOOL_NAMES.has(toolName)
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
	return [...NO_WORKSPACE_TOOL_NAMES, ...getPluginToolEntries().filter((entry): boolean => entry.global && entry.risk === "read").map((entry): string => entry.llmToolName), CUSTOM_MCP_TOOLS_SENTINEL];
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

function isGodotToolName(toolName: string | undefined): boolean {
	return toolName?.startsWith("mcp_godot_") === true;
}

function isStaticToolAvailableInContext(toolName: string | undefined, context: ToolExecutionContext): boolean {
	if (toolName !== undefined && LEGACY_GODOT_PROCESS_TOOL_NAMES.has(toolName)) return false;
	if (toolName?.startsWith("mcp_godot_runtime_") === true) {
		if (context.clientType !== "studio" || context.scheduledMonitorRun || context.hookContext?.chatMode === "goal") return false;
		// Keep the Runtime Test tool surface stable for the whole provider loop.
		// A runtime can become online after `start`, but provider tool definitions
		// are fixed when the loop begins. Hiding observe/action while offline made
		// the same run unable to continue after a successful visible launch.
		// Status may discover an offline runtime after provider tools are fixed for the loop.
		// Keep start visible in Studio Agent mode and return a structured capability error
		// from the dispatcher if this particular Studio cannot launch it.
		if (toolName === "mcp_godot_runtime_start") return context.hookContext?.chatMode === "agent";
		if (toolName === "mcp_godot_runtime_action") return context.hookContext?.chatMode === "agent";
	}
	if (toolName !== undefined && SCHEDULED_TASK_TOOL_NAME_SET.has(toolName)) {
		if (context.scheduledTaskControl === undefined) return false;
		return context.clientType === "studio_scheduler"
			? toolName === "mcp_scheduled_task_report"
			: context.clientType === "studio" && (SCHEDULED_TASK_MANAGEMENT_TOOL_NAMES.has(toolName) || (toolName === "mcp_scheduled_task_report" && context.scheduledMonitorRun === true));
	}
	if (toolName !== undefined && BROWSER_TOOL_NAME_SET.has(toolName)) {
		if (["mcp_browser_connect", "mcp_browser_propose", "mcp_browser_execute_step"].includes(toolName)) return context.clientType === "studio" && context.browserControl?.externalSupported === true && !context.scheduledMonitorRun && context.hookContext?.chatMode !== "goal" && !(toolName === "mcp_browser_propose" && context.hookContext?.chatMode === "plan");
		return context.clientType === "studio" && context.browserControl !== undefined;
	}
	if (toolName !== undefined && COMPUTER_TOOL_NAME_SET.has(toolName)) return context.clientType === "studio" && context.computerControl !== undefined && context.hookContext?.chatMode !== "goal" && !context.scheduledMonitorRun && (toolName !== "mcp_computer_action" || context.computerControl.inputAllowed === true) && (toolName !== "mcp_computer_locate" || context.computerControl.groundingSupported === true);
	if (!isGodotToolName(toolName)) {
		return true;
	}
	// External MCP catalog discovery is workspace-agnostic and retains its
	// historical complete tool surface. Chat entry points apply the stricter
	// no-workspace list before reaching this catalog.
	if (context.workspaceId === undefined) {
		return toolName !== "mcp_godot_search_documentation" || isGodotDocumentationEnabled();
	}

	// Documentation remains usable in a workspace-free chat, but a bound
	// non-Godot workspace must not receive any Godot tool definitions.
	if (toolName === "mcp_godot_search_documentation") {
		return resolveGodotWorkspaceCapability(context) && isGodotDocumentationEnabled();
	}

	return resolveGodotWorkspaceCapability(context);
}

function resolveGodotWorkspaceCapability(context: ToolExecutionContext): boolean {
	if (context.hasGodotWorkspaceCapability !== undefined) {
		return context.hasGodotWorkspaceCapability;
	}

	const workspace = context.workspaceId === undefined ? undefined : findWorkspace(context.workspaceId);
	// Low-level callers created before capability propagation may still pass an
	// opaque test/runtime workspace id. Production session entry points always
	// provide the explicit flag; retain the old catalog shape only for that
	// unknown legacy context.
	return workspace === undefined || hasGodotWorkspaceCapability(workspace);
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

function createPluginEntry(pluginTool: ReturnType<typeof getPluginToolEntries>[number]): ToolCatalogEntry {
	return {
		id: pluginTool.llmToolName,
		definition: {
			type: "function",
			function: {
				name: pluginTool.llmToolName,
				description: pluginTool.description,
				parameters: pluginTool.inputSchema
			}
		},
		mapping: pluginTool.mapping,
		policy: { risk: pluginTool.risk },
		phaseEligibility: getPhaseEligibility(pluginTool.risk)
	};
}

function createPluginMcpEntry(pluginTool: ReturnType<typeof listPluginMcpTools>[number]): ToolCatalogEntry {
	return {
		id: pluginTool.llmToolName,
		definition: {
			type: "function",
			function: {
				name: pluginTool.llmToolName,
				description: pluginTool.description ?? pluginTool.name,
				parameters: pluginTool.inputSchema
			}
		},
		mapping: { serverId: pluginTool.serverId, toolName: pluginTool.name },
		policy: { risk: pluginTool.risk },
		phaseEligibility: getPhaseEligibility(pluginTool.risk)
	};
}

function createChatCompletionControlEntry(): ToolCatalogEntry {
	return {
		id: CHAT_COMPLETION_CONTROL_TOOL_NAME,
		definition: CHAT_COMPLETION_CONTROL_TOOL_DEFINITION,
		mapping: { serverId: "internal", toolName: "chat_answer" },
		policy: { risk: "read" },
		phaseEligibility: ["read", "verify", "write"]
	};
}

function createContextControlEntry(definition: ChatCompletionTool): ToolCatalogEntry {
	const id: string | undefined = getToolName(definition);
	if (id === undefined) throw new Error("Context control definition must be a function tool");
	return {
		id,
		definition,
		mapping: { serverId: "internal", toolName: id },
		policy: { risk: "read" },
		phaseEligibility: ["read", "verify", "write"]
	};
}

function createTodoControlEntry(): ToolCatalogEntry {
	return {
		id: TODO_UPDATE_TOOL_NAME,
		definition: TODO_UPDATE_TOOL_DEFINITION,
		mapping: { serverId: "internal", toolName: TODO_UPDATE_TOOL_NAME },
		policy: { risk: "read" },
		phaseEligibility: ["read", "verify", "write"]
	};
}

function createSummaryPreparationEntry(): ToolCatalogEntry {
	return {
		id: SUMMARY_PREPARATION_TOOL_NAME,
		definition: SUMMARY_PREPARATION_TOOL_DEFINITION,
		mapping: { serverId: "internal", toolName: SUMMARY_PREPARATION_TOOL_NAME },
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
				return isStaticToolAvailableInContext(getToolName(definition), this.context);
			})
			.map(createStaticEntry);
		const dynamicEntries: ToolCatalogEntry[] = getDynamicMcpToolDefinitions(this.context.workspaceId)
			.map((definition: ChatCompletionTool): ToolCatalogEntry => createDynamicEntry(withApprovalReasonSchema(definition), this.context.workspaceId));
		const pluginEntries: ToolCatalogEntry[] = [
			...getPluginToolEntries(this.context.workspaceId).map(createPluginEntry),
			...(this.context.workspaceId === undefined ? [] : listPluginMcpTools().map(createPluginMcpEntry))
		];
		const executionControlEntries: ToolCatalogEntry[] = this.context.executionControl === undefined || this.context.executionControlAvailable === false
			? []
			: [createExecutionControlEntry()];
		const chatCompletionEntries: ToolCatalogEntry[] = this.context.chatCompletion === undefined || this.context.chatCompletionAvailable === false
			? []
			: [createChatCompletionControlEntry()];
		const contextControlEntries: ToolCatalogEntry[] = this.context.contextControl === undefined || this.context.contextControlAvailable === false
			? []
			: CONTEXT_CONTROL_TOOL_DEFINITIONS.map(createContextControlEntry);
		const todoControlEntries: ToolCatalogEntry[] = this.context.todoControl === undefined || this.context.todoControlAvailable === false
			? []
			: [createTodoControlEntry()];
		const summaryPreparationEntries: ToolCatalogEntry[] = this.context.summaryPreparation === undefined || this.context.summaryPreparationAvailable === false
			? []
			: [createSummaryPreparationEntry()];
		return [...staticEntries, ...dynamicEntries, ...pluginEntries, ...executionControlEntries, ...chatCompletionEntries, ...contextControlEntries, ...todoControlEntries, ...summaryPreparationEntries];
	}

	getDefinitions(): ChatCompletionTool[] {
		return this.getEntries().map((entry: ToolCatalogEntry): ChatCompletionTool => entry.definition);
	}

	getDefinitionsForNames(toolNames: readonly string[]): ChatCompletionTool[] {
		const allowedNames: Set<string> = new Set(toolNames);
		if (this.context.executionControl !== undefined && this.context.executionControlAvailable !== false) {
			allowedNames.add(EXECUTION_CONTROL_TOOL_NAME);
		}
		if (this.context.chatCompletion !== undefined && this.context.chatCompletionAvailable !== false) {
			allowedNames.add(CHAT_COMPLETION_CONTROL_TOOL_NAME);
		}
		if (this.context.contextControl !== undefined && this.context.contextControlAvailable !== false) {
			for (const toolName of CONTEXT_CONTROL_TOOL_NAMES) allowedNames.add(toolName);
		}
		if (this.context.todoControl !== undefined && this.context.todoControlAvailable !== false) {
			allowedNames.add(TODO_UPDATE_TOOL_NAME);
		}
		if (this.context.summaryPreparation !== undefined && this.context.summaryPreparationAvailable !== false) {
			allowedNames.add(SUMMARY_PREPARATION_TOOL_NAME);
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
	const pluginNames: string[] = getPluginToolEntries().filter((entry): boolean => entry.workflow && ((group === "read" && entry.risk === "read") || (group === "verify" && (entry.risk === "verify" || entry.risk === "read")) || (group === "write" && (entry.risk === "write" || entry.risk === "destructive" || entry.risk === "propose")))).map((entry): string => entry.llmToolName);
	return [...DEFAULT_WORKFLOW_TOOL_NAMES[group], ...pluginNames];
}
