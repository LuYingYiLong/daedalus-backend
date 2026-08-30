import type { ChatCompletionMessageToolCall } from "openai/resources/chat/completions";

const XML_NAME_PATTERN: string = "[A-Za-z_][A-Za-z0-9_.:-]*";
const TOOL_TAG_PATTERN: RegExp = new RegExp(`<\\s*(${XML_NAME_PATTERN})\\s*>([\\s\\S]*?)<\\/\\s*\\1\\s*>`, "g");
const SELF_CLOSING_TOOL_TAG_PATTERN: RegExp = new RegExp(`<\\s*(${XML_NAME_PATTERN})([^<>]*?)\\/\\s*>`, "g");
const PARAMETER_TAG_PATTERN: RegExp = new RegExp(`<\\s*(${XML_NAME_PATTERN})\\s*>([\\s\\S]*?)<\\/\\s*\\1\\s*>`, "g");
const ATTRIBUTE_PATTERN: RegExp = new RegExp(`(${XML_NAME_PATTERN})\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "g");

const RAW_TOOL_NAME_MAP: Readonly<Record<string, string>> = {
	computer_request_access: "mcp_computer_request_access",
	computer_observe: "mcp_computer_observe",
	computer_screenshot: "mcp_computer_screenshot",
	load_skill: "mcp_skills_load",
	propose_create_skill: "mcp_skills_propose_create",
	create_skill: "mcp_skills_create",
	list_files: "mcp_workspace_list_files",
	workspace_list_files: "mcp_workspace_list_files",
	read_workspace_text_file: "mcp_workspace_read_text_file",
	workspace_read_text_file: "mcp_workspace_read_text_file",
	search_workspace_text: "mcp_workspace_search_text",
	workspace_search_text: "mcp_workspace_search_text",
	workspace_propose_create_text_file: "mcp_workspace_propose_create_text_file",
	workspace_create_text_file: "mcp_workspace_create_text_file",
	workspace_propose_overwrite_text_file: "mcp_workspace_propose_overwrite_text_file",
	workspace_overwrite_text_file: "mcp_workspace_overwrite_text_file",
	workspace_propose_replace_text_in_file: "mcp_workspace_propose_replace_text_in_file",
	workspace_replace_text_in_file: "mcp_workspace_replace_text_in_file",
	workspace_propose_replace_line_in_file: "mcp_workspace_propose_replace_line_in_file",
	workspace_replace_line_in_file: "mcp_workspace_replace_line_in_file",
	workspace_download_file: "mcp_workspace_download_file",
	download_workspace_file: "mcp_workspace_download_file",
	workspace_delete_file: "mcp_workspace_delete_file",
	get_runtime_status: "mcp_godot_get_runtime_status",
	get_godot_version: "mcp_godot_get_godot_version",
	search_documentation: "mcp_godot_search_documentation",
	search_godot_documentation: "mcp_godot_search_documentation",
	launch_editor: "mcp_godot_launch_editor",
	run_project: "mcp_godot_run_project",
	stop_project: "mcp_godot_stop_project",
	get_debug_output: "mcp_godot_get_debug_output",
	list_projects: "mcp_godot_list_projects",
	get_project_summary: "mcp_godot_get_project_summary",
	list_project_files: "mcp_godot_list_project_files",
	list_scenes: "mcp_godot_list_scenes",
	list_scripts: "mcp_godot_list_scripts",
	read_text_file: "mcp_godot_read_text_file",
	search_text: "mcp_godot_search_text",
	get_project_log_config: "mcp_godot_get_project_log_config",
	list_project_logs: "mcp_godot_list_project_logs",
	read_project_log: "mcp_godot_read_project_log",
	get_project_settings: "mcp_godot_get_project_settings",
	get_editor_config_summary: "mcp_godot_get_editor_config_summary",
	get_editor_settings: "mcp_godot_get_editor_settings",
	list_editor_config_files: "mcp_godot_list_editor_config_files",
	read_editor_config_file: "mcp_godot_read_editor_config_file",
	get_editor_project_state: "mcp_godot_get_editor_project_state",
	get_recent_projects: "mcp_godot_get_recent_projects",
	get_uid: "mcp_godot_get_uid",
	resave_resource: "mcp_godot_resave_resource",
	update_project_uids: "mcp_godot_update_project_uids",
	save_scene_variant: "mcp_godot_save_scene_variant",
	load_sprite_texture: "mcp_godot_load_sprite_texture",
	export_mesh_library: "mcp_godot_export_mesh_library",
	propose_set_project_setting: "mcp_godot_propose_set_project_setting",
	set_project_setting: "mcp_godot_set_project_setting",
	propose_unset_project_setting: "mcp_godot_propose_unset_project_setting",
	unset_project_setting: "mcp_godot_unset_project_setting",
	get_input_actions: "mcp_godot_get_input_actions",
	propose_set_input_action: "mcp_godot_propose_set_input_action",
	set_input_action: "mcp_godot_set_input_action",
	propose_unset_input_action: "mcp_godot_propose_unset_input_action",
	unset_input_action: "mcp_godot_unset_input_action",
	get_autoloads: "mcp_godot_get_autoloads",
	propose_set_autoload: "mcp_godot_propose_set_autoload",
	set_autoload: "mcp_godot_set_autoload",
	propose_unset_autoload: "mcp_godot_propose_unset_autoload",
	unset_autoload: "mcp_godot_unset_autoload",
	analyze_project_dependencies: "mcp_godot_analyze_project_dependencies",
	find_unused_resources: "mcp_godot_find_unused_resources",
	find_scene_nodes: "mcp_godot_find_scene_nodes",
	find_script_references: "mcp_godot_find_script_references",
	list_project_global_classes: "mcp_godot_list_project_global_classes",
	list_global_classes: "mcp_godot_list_project_global_classes",
	list_project_tests: "mcp_godot_list_project_tests",
	inspect_csharp_project_support: "mcp_godot_inspect_csharp_project_support",
	get_import_metadata: "mcp_godot_get_import_metadata",
	audit_project_health: "mcp_godot_audit_project_health",
	propose_create_text_file: "mcp_godot_propose_create_text_file",
	create_text_file: "mcp_godot_create_text_file",
	propose_overwrite_text_file: "mcp_godot_propose_overwrite_text_file",
	overwrite_text_file: "mcp_godot_overwrite_text_file",
	propose_replace_text_in_file: "mcp_godot_propose_replace_text_in_file",
	replace_text_in_file: "mcp_godot_replace_text_in_file",
	delete_file: "mcp_godot_delete_file",
	get_terminal_capabilities: "mcp_terminal_get_capabilities",
	run_command: "mcp_terminal_run_command",
	terminal_run_command: "mcp_terminal_run_command",
	run_safe_preset: "mcp_terminal_run_safe_preset",
	run_write_preset: "mcp_terminal_run_write_preset",
	run_godot_scene_script: "mcp_terminal_run_godot_scene_script",
	inspect_scene_tree: "mcp_godot_inspect_scene_tree",
	propose_create_scene: "mcp_godot_propose_create_scene",
	create_scene: "mcp_godot_create_scene",
	propose_add_node_to_scene: "mcp_godot_propose_add_node_to_scene",
	add_node_to_scene: "mcp_godot_add_node_to_scene",
	propose_attach_script_to_node: "mcp_godot_propose_attach_script_to_node",
	attach_script_to_node: "mcp_godot_attach_script_to_node",
	propose_connect_signal_in_scene: "mcp_godot_propose_connect_signal_in_scene",
	connect_signal_in_scene: "mcp_godot_connect_signal_in_scene",
	propose_apply_scene_patch: "mcp_godot_propose_apply_scene_patch",
	apply_scene_patch: "mcp_godot_apply_scene_patch",
	editor_get_context: "mcp_godot_editor_get_context",
	get_editor_context: "mcp_godot_editor_get_context",
	editor_get_selected_nodes: "mcp_godot_editor_get_selected_nodes",
	get_selected_nodes: "mcp_godot_editor_get_selected_nodes",
	editor_inspect_node: "mcp_godot_editor_inspect_node",
	inspect_live_node: "mcp_godot_editor_inspect_node",
	editor_capture_scene_view: "mcp_godot_editor_capture_scene_view",
	capture_scene_view: "mcp_godot_editor_capture_scene_view",
	image_inspect: "mcp_image_inspect",
	inspect_image: "mcp_image_inspect",
	editor_apply_scene_patch: "mcp_godot_editor_apply_scene_patch",
	apply_editor_scene_patch: "mcp_godot_editor_apply_scene_patch",
	lsp_get_status: "mcp_godot_lsp_get_status",
	get_lsp_status: "mcp_godot_lsp_get_status",
	lsp_get_file_diagnostics: "mcp_godot_lsp_get_file_diagnostics",
	get_file_diagnostics: "mcp_godot_lsp_get_file_diagnostics",
	lsp_get_document_symbols: "mcp_godot_lsp_get_document_symbols",
	get_document_symbols: "mcp_godot_lsp_get_document_symbols",
	lsp_hover: "mcp_godot_lsp_hover",
	hover: "mcp_godot_lsp_hover",
	lsp_goto_definition: "mcp_godot_lsp_goto_definition",
	goto_definition: "mcp_godot_lsp_goto_definition",
	dap_get_status: "mcp_godot_dap_get_status",
	get_dap_status: "mcp_godot_dap_get_status",
	dap_get_last_error: "mcp_godot_dap_get_last_error",
	get_last_error: "mcp_godot_dap_get_last_error",
	dap_get_stack_trace: "mcp_godot_dap_get_stack_trace",
	get_stack_trace: "mcp_godot_dap_get_stack_trace",
	dap_get_variables: "mcp_godot_dap_get_variables",
	get_variables: "mcp_godot_dap_get_variables"
};
const RAW_TOOL_NAMES: readonly string[] = Object.keys(RAW_TOOL_NAME_MAP);

const RELATIVE_PATH_TOOL_NAMES: ReadonlySet<string> = new Set([
	"mcp_workspace_read_text_file",
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
	"mcp_godot_read_text_file",
	"mcp_godot_propose_create_text_file",
	"mcp_godot_create_text_file",
	"mcp_godot_propose_overwrite_text_file",
	"mcp_godot_overwrite_text_file",
	"mcp_godot_propose_replace_text_in_file",
	"mcp_godot_replace_text_in_file",
	"mcp_godot_delete_file",
	"mcp_godot_inspect_scene_tree",
	"mcp_godot_propose_create_scene",
	"mcp_godot_create_scene"
]);

const SCENE_PATH_TOOL_NAMES: ReadonlySet<string> = new Set([
	"mcp_godot_run_project",
	"mcp_godot_save_scene_variant",
	"mcp_godot_load_sprite_texture",
	"mcp_godot_export_mesh_library",
	"mcp_godot_propose_add_node_to_scene",
	"mcp_godot_add_node_to_scene",
	"mcp_godot_propose_attach_script_to_node",
	"mcp_godot_attach_script_to_node",
	"mcp_godot_propose_connect_signal_in_scene",
	"mcp_godot_connect_signal_in_scene",
	"mcp_godot_propose_apply_scene_patch",
	"mcp_godot_apply_scene_patch",
	"mcp_godot_editor_apply_scene_patch"
]);

const RESOURCE_PATH_TOOL_NAMES: ReadonlySet<string> = new Set([
	"mcp_godot_get_uid",
	"mcp_godot_resave_resource",
	"mcp_godot_lsp_get_file_diagnostics",
	"mcp_godot_lsp_get_document_symbols",
	"mcp_godot_lsp_hover",
	"mcp_godot_lsp_goto_definition",
	"mcp_godot_find_script_references",
	"mcp_godot_get_import_metadata"
]);

function decodeXmlEntities(text: string): string {
	return text
		.replaceAll("&quot;", "\"")
		.replaceAll("&apos;", "'")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&amp;", "&");
}

function getXmlLocalName(name: string): string {
	const namespaceSeparatorIndex: number = name.lastIndexOf(":");
	if (namespaceSeparatorIndex < 0) {
		return name;
	}

	return name.slice(namespaceSeparatorIndex + 1);
}

function parseLooseValue(rawValue: string): unknown {
	const decoded: string = decodeXmlEntities(rawValue).trim();
	if (decoded.length === 0) {
		return "";
	}

	if (
		decoded.startsWith("{")
		|| decoded.startsWith("[")
		|| decoded.startsWith("\"")
		|| decoded === "true"
		|| decoded === "false"
		|| decoded === "null"
		|| /^-?\d+(?:\.\d+)?$/.test(decoded)
	) {
		try {
			return JSON.parse(decoded) as unknown;
		} catch {
			return decoded;
		}
	}

	return decoded;
}

export function normalizeKnownToolName(toolName: string): string | undefined {
	const localToolName: string = getXmlLocalName(toolName);
	if (localToolName.startsWith("mcp_")) {
		return localToolName;
	}

	return RAW_TOOL_NAME_MAP[localToolName];
}

export function isKnownLooseToolTagName(toolName: string): boolean {
	const localToolName: string = getXmlLocalName(toolName);
	return localToolName.startsWith("mcp_") || RAW_TOOL_NAME_MAP[localToolName] !== undefined;
}

export function isPotentialLooseToolTagName(toolNamePrefix: string): boolean {
	const localToolNamePrefix: string = getXmlLocalName(toolNamePrefix);
	return localToolNamePrefix.length > 0 && (
		"mcp_".startsWith(localToolNamePrefix)
		|| localToolNamePrefix.startsWith("mcp_")
		|| RAW_TOOL_NAMES.some((toolName: string): boolean => toolName.startsWith(localToolNamePrefix))
	);
}

function normalizeParameterName(toolName: string, parameterName: string): string {
	const localParameterName: string = getXmlLocalName(parameterName);
	if (toolName === "mcp_godot_read_project_log" && (localParameterName === "path" || localParameterName === "resourcePath" || localParameterName === "file")) {
		return "fileName";
	}

	if (toolName === "mcp_godot_read_editor_config_file" && (localParameterName === "path" || localParameterName === "resourcePath" || localParameterName === "file")) {
		return "fileId";
	}

	if (
		(toolName === "mcp_godot_get_editor_settings" || toolName === "mcp_godot_get_project_settings")
		&& (localParameterName === "setting" || localParameterName === "settingKey")
	) {
		return "prefix";
	}

	if (
		(toolName === "mcp_godot_propose_set_project_setting" || toolName === "mcp_godot_set_project_setting")
		&& (localParameterName === "value" || localParameterName === "expression")
	) {
		return "valueExpression";
	}

	if (
		(toolName === "mcp_godot_save_scene_variant" || toolName === "mcp_godot_export_mesh_library")
		&& (localParameterName === "output" || localParameterName === "outputPath")
	) {
		return "outputPath";
	}

	if (toolName === "mcp_godot_load_sprite_texture" && (localParameterName === "texture" || localParameterName === "texturePath")) {
		return "texturePath";
	}

	if (toolName === "mcp_godot_update_project_uids" && (localParameterName === "path" || localParameterName === "directory" || localParameterName === "resourcePath")) {
		return "subdir";
	}

	if (toolName === "mcp_terminal_run_command" && (localParameterName === "command" || localParameterName === "cmd" || localParameterName === "shell")) {
		return "commandLine";
	}

	if (
		(toolName === "mcp_godot_get_project_settings"
			|| toolName === "mcp_godot_propose_set_project_setting"
			|| toolName === "mcp_godot_set_project_setting"
			|| toolName === "mcp_godot_propose_unset_project_setting"
			|| toolName === "mcp_godot_unset_project_setting")
		&& (localParameterName === "setting" || localParameterName === "settingKey")
	) {
		return "key";
	}

	if (localParameterName === "path" || localParameterName === "resourcePath") {
		if (toolName === "mcp_godot_list_projects") {
			return "directory";
		}

		if (SCENE_PATH_TOOL_NAMES.has(toolName)) {
			return "scenePath";
		}

		if (RELATIVE_PATH_TOOL_NAMES.has(toolName)) {
			return "relativePath";
		}

		if (RESOURCE_PATH_TOOL_NAMES.has(toolName)) {
			return "resourcePath";
		}
	}

	if (localParameterName === "preset") {
		return "presetName";
	}

	if (localParameterName === "operation") {
		return "operationJson";
	}

	return localParameterName;
}

function defaultParameterName(toolName: string): string | undefined {
	if (SCENE_PATH_TOOL_NAMES.has(toolName)) {
		return "scenePath";
	}

	if (RELATIVE_PATH_TOOL_NAMES.has(toolName)) {
		return "relativePath";
	}

	if (RESOURCE_PATH_TOOL_NAMES.has(toolName)) {
		return "resourcePath";
	}

	if (toolName === "mcp_godot_search_text" || toolName === "mcp_workspace_search_text") {
		return "query";
	}

	if (toolName === "mcp_godot_list_projects") {
		return "directory";
	}

	if (toolName === "mcp_godot_editor_inspect_node") {
		return "nodePath";
	}

	if (toolName === "mcp_godot_dap_get_variables") {
		return "variablesReference";
	}

	if (toolName === "mcp_godot_read_project_log") {
		return "fileName";
	}

	if (toolName === "mcp_godot_read_editor_config_file") {
		return "fileId";
	}

	if (
		toolName === "mcp_godot_list_project_tests"
		|| toolName === "mcp_godot_inspect_csharp_project_support"
	) {
		return "searchPath";
	}

	if (
		toolName === "mcp_godot_propose_unset_input_action"
		|| toolName === "mcp_godot_unset_input_action"
	) {
		return "action";
	}

	if (
		toolName === "mcp_godot_propose_unset_autoload"
		|| toolName === "mcp_godot_unset_autoload"
	) {
		return "name";
	}

	if (
		toolName === "mcp_godot_propose_set_project_setting"
		|| toolName === "mcp_godot_set_project_setting"
		|| toolName === "mcp_godot_propose_unset_project_setting"
		|| toolName === "mcp_godot_unset_project_setting"
	) {
		return "key";
	}

	if (toolName === "mcp_terminal_run_safe_preset" || toolName === "mcp_terminal_run_write_preset") {
		return "presetName";
	}

	if (toolName === "mcp_terminal_run_command") {
		return "commandLine";
	}

	return undefined;
}

function parseLooseParameterValue(parameterName: string, rawValue: string): unknown {
	if (parameterName === "valueExpression") {
		return decodeXmlEntities(rawValue).trim();
	}

	return parseLooseValue(rawValue);
}

function parseLooseArguments(toolName: string, body: string): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	let foundParameter: boolean = false;
	let parameterMatch: RegExpExecArray | null;

	PARAMETER_TAG_PATTERN.lastIndex = 0;
	while ((parameterMatch = PARAMETER_TAG_PATTERN.exec(body)) !== null) {
		const rawParameterName: string = parameterMatch[1] ?? "";
		const rawParameterValue: string = parameterMatch[2] ?? "";
		if (rawParameterName.length === 0) {
			continue;
		}

		foundParameter = true;
		const parameterName: string = normalizeParameterName(toolName, rawParameterName);
		args[parameterName] = parseLooseParameterValue(parameterName, rawParameterValue);
	}

	if (!foundParameter) {
		const fallbackName: string | undefined = defaultParameterName(toolName);
		const fallbackValue: unknown = fallbackName === undefined ? undefined : parseLooseParameterValue(fallbackName, body);
		if (fallbackName !== undefined && typeof fallbackValue === "string" && fallbackValue.length > 0) {
			args[fallbackName] = fallbackValue;
		}
	}

	return args;
}

function parseLooseAttributeArguments(toolName: string, attributesText: string): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	let attributeMatch: RegExpExecArray | null;

	ATTRIBUTE_PATTERN.lastIndex = 0;
	while ((attributeMatch = ATTRIBUTE_PATTERN.exec(attributesText)) !== null) {
		const rawParameterName: string = attributeMatch[1] ?? "";
		const rawParameterValue: string = attributeMatch[2] ?? attributeMatch[3] ?? "";
		if (rawParameterName.length === 0) {
			continue;
		}

		const parameterName: string = normalizeParameterName(toolName, rawParameterName);
		args[parameterName] = parseLooseParameterValue(parameterName, rawParameterValue);
	}

	return args;
}

function isAllowedToolName(toolName: string, allowedToolNames?: ReadonlySet<string>): boolean {
	return allowedToolNames === undefined || allowedToolNames.has(toolName);
}

export function containsLooseToolCalls(
	text: string | null | undefined,
	allowedToolNames?: ReadonlySet<string>
): boolean {
	if (text === null || text === undefined) {
		return false;
	}

	let tagMatch: RegExpExecArray | null;
	TOOL_TAG_PATTERN.lastIndex = 0;
	while ((tagMatch = TOOL_TAG_PATTERN.exec(text)) !== null) {
		const rawToolName: string = tagMatch[1] ?? "";
		const toolName: string | undefined = normalizeKnownToolName(rawToolName);
		if (toolName !== undefined && isAllowedToolName(toolName, allowedToolNames)) {
			return true;
		}
	}

	SELF_CLOSING_TOOL_TAG_PATTERN.lastIndex = 0;
	while ((tagMatch = SELF_CLOSING_TOOL_TAG_PATTERN.exec(text)) !== null) {
		const rawToolName: string = tagMatch[1] ?? "";
		const toolName: string | undefined = normalizeKnownToolName(rawToolName);
		if (toolName !== undefined && isAllowedToolName(toolName, allowedToolNames)) {
			return true;
		}
	}

	return false;
}

export function stripLooseToolCalls(text: string, allowedToolNames?: ReadonlySet<string>): string {
	return text.replace(
		TOOL_TAG_PATTERN,
		(match: string, rawToolName: string): string => {
			const toolName: string | undefined = normalizeKnownToolName(rawToolName);
			if (toolName !== undefined && isAllowedToolName(toolName, allowedToolNames)) {
				return "";
			}

			return match;
		}
	).replace(
		SELF_CLOSING_TOOL_TAG_PATTERN,
		(match: string, rawToolName: string): string => {
			const toolName: string | undefined = normalizeKnownToolName(rawToolName);
			if (toolName !== undefined && isAllowedToolName(toolName, allowedToolNames)) {
				return "";
			}

			return match;
		}
	).trim();
}

export function parseLooseToolCalls(
	text: string,
	idPrefix: string = "loose-tool",
	allowedToolNames?: ReadonlySet<string>
): ChatCompletionMessageToolCall[] {
	const toolCalls: ChatCompletionMessageToolCall[] = [];
	let tagMatch: RegExpExecArray | null;

	TOOL_TAG_PATTERN.lastIndex = 0;
	while ((tagMatch = TOOL_TAG_PATTERN.exec(text)) !== null) {
		const rawToolName: string = tagMatch[1] ?? "";
		const body: string = tagMatch[2] ?? "";
		const toolName: string | undefined = normalizeKnownToolName(rawToolName);
		if (toolName === undefined || !isAllowedToolName(toolName, allowedToolNames)) {
			continue;
		}

		toolCalls.push({
			id: `${idPrefix}-${toolCalls.length + 1}`,
			type: "function",
			function: {
				name: toolName,
				arguments: JSON.stringify(parseLooseArguments(toolName, body))
			}
		});
	}

	SELF_CLOSING_TOOL_TAG_PATTERN.lastIndex = 0;
	while ((tagMatch = SELF_CLOSING_TOOL_TAG_PATTERN.exec(text)) !== null) {
		const rawToolName: string = tagMatch[1] ?? "";
		const attributesText: string = tagMatch[2] ?? "";
		const toolName: string | undefined = normalizeKnownToolName(rawToolName);
		if (toolName === undefined || !isAllowedToolName(toolName, allowedToolNames)) {
			continue;
		}

		toolCalls.push({
			id: `${idPrefix}-${toolCalls.length + 1}`,
			type: "function",
			function: {
				name: toolName,
				arguments: JSON.stringify(parseLooseAttributeArguments(toolName, attributesText))
			}
		});
	}

	return toolCalls;
}
