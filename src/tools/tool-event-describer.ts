import { getDynamicMcpToolMetadata, isDynamicMcpToolName } from "./dynamic-mcp-tools.js";

export type ToolEventCategory =
	| "read"
	| "write"
	| "search"
	| "terminal"
	| "scene"
	| "approval"
	| "propose"
	| "docs"
	| "image"
	| "unknown";

export type ToolEventTarget = {
	kind: "file" | "scene" | "command" | "query" | "approval" | "unknown";
	path?: string;
	line?: number;
	label?: string;
};

export type ToolEventDisplay = {
	serverId: string;
	serverName: string;
	category: ToolEventCategory;
	title: string;
	summary: string;
	target: ToolEventTarget;
};

function getStringArg(args: Record<string, unknown>, key: string): string | undefined {
	const value: unknown = args[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function formatSourcePath(args: Record<string, unknown>, path: string): string {
	const sourceFolderId: string | undefined = getStringArg(args, "sourceFolderId");
	return sourceFolderId === undefined ? path : `[${sourceFolderId}] ${path}`;
}

function formatSourceScope(args: Record<string, unknown>, fallback: string): string {
	const sourceFolderId: string | undefined = getStringArg(args, "sourceFolderId");
	if (sourceFolderId !== undefined) return `[${sourceFolderId}]`;
	return getStringArg(args, "scope") === "all" ? "[all sources]" : fallback;
}

function parseOperationJson(args: Record<string, unknown>): Record<string, unknown> {
	const operationJson: string | undefined = getStringArg(args, "operationJson");
	if (operationJson === undefined) {
		return {};
	}

	try {
		const parsed: unknown = JSON.parse(operationJson);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: {};
	} catch {
		return {};
	}
}

function createDisplay(
	serverId: string,
	serverName: string,
	category: ToolEventCategory,
	title: string,
	summary: string,
	target: ToolEventTarget
): ToolEventDisplay {
	return { serverId, serverName, category, title, summary, target };
}

export function describeToolEvent(toolName: string, args: Record<string, unknown>, workspaceId?: string | undefined): ToolEventDisplay {
	if (toolName.startsWith("mcp_computer_")) {
		const title = toolName === "mcp_computer_action" ? "Control authorized window" : toolName === "mcp_computer_request_access" ? (args.mode === "control" ? "Request control window" : "Request observation window") : toolName === "mcp_computer_observe" ? "Read window structure and text" : "View observation screenshot";
		return createDisplay("studio_computer", "Daedalus Computer Use", toolName === "mcp_computer_action" ? "write" : "read", title, "Limited to the window authorized for this turn", { kind: "unknown", label: "Authorized window" });
	}
	if (toolName.startsWith("mcp_scheduled_task")) {
		const labels: Record<string, [ToolEventCategory, string]> = {
			mcp_scheduled_tasks_list: ["read", "List scheduled tasks"],
			mcp_scheduled_task_create: ["write", "Create scheduled task"],
			mcp_scheduled_task_update: ["write", "Update scheduled task"],
			mcp_scheduled_task_pause: ["write", "Pause scheduled task"],
			mcp_scheduled_task_resume: ["write", "Resume scheduled task"],
			mcp_scheduled_task_delete: ["write", "Delete scheduled task"],
			mcp_scheduled_task_report: ["read", "Report monitoring result"],
		};
		const [category, title] = labels[toolName] ?? ["unknown", "Manage scheduled task"];
		const label = getStringArg(args, "title") ?? getStringArg(args, "taskId") ?? "scheduled task";
		return createDisplay("studio_scheduled_tasks", "Daedalus Scheduler", category, title, label, { kind: "unknown", label });
	}
	if (toolName.startsWith("mcp_browser_")) {
		const action = toolName.slice("mcp_browser_".length);
		const labels: Record<string, [ToolEventCategory, string, string]> = {
			observe: ["read", "Observe webpage", "Read visible page content and interactive elements"],
			navigate: ["read", "Open webpage", getStringArg(args, "url") ?? "Navigate to webpage"],
			navigation: ["read", "Navigate webpage", getStringArg(args, "action") ?? "Navigate current webpage"],
			scroll: ["read", "Scroll webpage", getStringArg(args, "direction") ?? "Scroll current webpage"],
			wait: ["read", "Wait for webpage", getStringArg(args, "condition") ?? "Wait for page state"],
			screenshot: ["image", "Capture webpage", "Capture the current browser viewport"],
			click: ["write", "Click webpage element", `Element ${String(args.elementId ?? "")}`],
			type: ["write", "Type webpage content", `Element ${String(args.elementId ?? "")}`],
			select: ["write", "Select webpage option", `Element ${String(args.elementId ?? "")}`]
		};
		const [category, title, summary] = labels[action] ?? ["unknown", "Operate webpage", action];
		return createDisplay("studio_browser", "Daedalus Browser", category, title, summary, { kind: "unknown", label: action });
	}
	if (toolName === "daedalus_prepare_summary") {
			return createDisplay("workflow", "Daedalus Workflow", "read", "Prepare summary", "Check whether the Agent Loop can start summarizing", {
			kind: "unknown",
			label: "summary checkpoint"
		});
	}

	if (toolName.startsWith("mcp_skills_")) {
		const ref: string | undefined = getStringArg(args, "ref");
		const slug: string | undefined = getStringArg(args, "slug");
		const label: string = ref ?? slug ?? "skill";
		if (toolName === "mcp_skills_load") {
			return createDisplay("skills", "Skills", "read", "Load skill", `Read instructions for ${label}`, { kind: "unknown", label });
		}
		if (toolName === "mcp_skills_propose_create") {
			return createDisplay("skills", "Skills", "propose", "Preview skill", `Validate ${label}`, { kind: "unknown", label });
		}
		return createDisplay("skills", "Skills", "write", "Create skill", `Create ${label}`, { kind: "unknown", label });
	}
	if (toolName === "mcp_image_generate") {
		const prompt: string = getStringArg(args, "prompt") ?? "image";
		const count: string = String(args.count ?? 1);
		return createDisplay("image", "Image Generation", "image", "Generate image", `Generate ${count} image(s): ${prompt.slice(0, 80)}`, {
			kind: "unknown",
			label: "generated image"
		});
	}
	if (toolName === "mcp_image_inspect") {
		const source: string = getStringArg(args, "source") ?? "image";
		const label: string = getStringArg(args, "relativePath") ?? getStringArg(args, "imageId") ?? source;
		const relativePath: string | undefined = getStringArg(args, "relativePath");
		return createDisplay("image", "Image Inspection", "image", "Inspect image", label, relativePath === undefined
			? { kind: "unknown", label }
			: { kind: "file", path: relativePath, label });
	}
	if (toolName.startsWith("mcp_image_") && toolName.includes("workspace")) {
		const relativePath: string = getStringArg(args, "relativePath") ?? "workspace image";
		const category: ToolEventCategory = toolName.includes("propose")
			? "propose"
			: "write";
		return createDisplay("image", "Image Generation", category, "Import image", relativePath, {
			kind: "file",
			path: relativePath,
			label: relativePath
		});
	}
	if (toolName === "mcp_web_search") {
		const query: string = getStringArg(args, "query") ?? "search";
		return createDisplay("web_search", "Web Search", "read", "Web search", `Search: ${query.slice(0, 100)}`, {
			kind: "unknown",
			label: query
		});
	}
		if (toolName.startsWith("mcp_workspace_")) {
			const relativePath: string | undefined = getStringArg(args, "relativePath");
			if (toolName.includes("source_folders") || toolName.includes("source_context")) {
				return createDisplay("workspace", "Workspace", "read", "Source folders", "Inspect workspace source folders", {
					kind: "unknown",
					label: "source folders"
				});
			}
		if (toolName.includes("list_files")) {
			return createDisplay("workspace", "Workspace", "read", "List files", "List workspace files", {
				kind: "file",
					label: formatSourceScope(args, "[primary]")
			});
		}
		if (toolName.includes("read_text_file")) {
				const filePath: string = formatSourcePath(args, relativePath ?? "unknown file");
			return createDisplay("workspace", "Workspace", "read", "Read file", `Read ${filePath}`, {
				kind: "file",
				path: filePath,
				label: filePath
			});
		}
		if (toolName.includes("search_text")) {
			const query: string = getStringArg(args, "query") ?? "search";
			return createDisplay("workspace", "Workspace", "search", "Search files", `Search: ${query.slice(0, 100)}`, {
				kind: "unknown",
					label: `${formatSourceScope(args, "[primary]")} ${query}`
			});
		}
		if (toolName.includes("propose_")) {
				const filePath: string = formatSourcePath(args, relativePath ?? "unknown file");
			return createDisplay("workspace", "Workspace", "propose", "Preview file change", filePath, {
				kind: "file",
				path: filePath,
				label: filePath
			});
		}
		if (toolName.includes("create_text_file") || toolName.includes("overwrite_text_file") || toolName.includes("replace_text_in_file") || toolName.includes("replace_line_in_file") || toolName.includes("delete_file")) {
				const filePath: string = formatSourcePath(args, relativePath ?? "unknown file");
			return createDisplay("workspace", "Workspace", "write", "Write file", `Write ${filePath}`, {
				kind: "file",
				path: filePath,
				label: filePath
			});
		}
	}
	if (isDynamicMcpToolName(toolName)) {
		const metadata = getDynamicMcpToolMetadata(toolName, workspaceId);
		const serverId: string = metadata?.serverId ?? "custom";
		const serverName: string = metadata?.serverName ?? "Custom MCP";
		const originalToolName: string = metadata?.toolName ?? toolName;
		const category: ToolEventCategory = metadata?.planAccess === "read" ? "docs" : "write";
		const title: string = metadata?.planAccess === "read" ? "Read custom MCP" : "Custom MCP tool";
		return createDisplay(serverId, serverName, category, title, `${serverName}: ${originalToolName}`, {
			kind: "unknown",
			label: originalToolName
		});
	}

	if (toolName.startsWith("mcp_godot_editor_")) {
		const scenePath: string | undefined = getStringArg(args, "scenePath");
		const nodePath: string | undefined = getStringArg(args, "nodePath");
		const targetLabel: string = nodePath ?? scenePath ?? "Godot Editor";

		if (toolName.includes("get_context")) {
			return createDisplay("godot_editor", "Godot Editor", "read", "Read editor context", "Read the current editor online state and scene context", {
				kind: "unknown",
				label: "Godot Editor"
			});
		}

		if (toolName.includes("get_selected_nodes")) {
			return createDisplay("godot_editor", "Godot Editor", "read", "Read selected nodes", "Read the nodes selected in the current editor", {
				kind: "scene",
				label: "selected nodes"
			});
		}

		if (toolName.includes("inspect_node")) {
			const target: ToolEventTarget = scenePath === undefined ? {
				kind: "scene",
				label: targetLabel
			} : {
				kind: "scene",
				path: scenePath,
				label: targetLabel
			};
			return createDisplay("godot_editor", "Godot Editor", "read", "Inspect online node", `Inspect ${targetLabel}`, {
				...target
			});
		}

		if (toolName.includes("capture_scene_view")) {
			const view: string = getStringArg(args, "view") ?? "auto";
			return createDisplay("godot_editor", "Godot Editor", "read", "Capture scene view", `Capture the ${view} editor scene viewport for visual analysis`, {
				kind: "scene",
				label: `scene view (${view})`
			});
		}

		if (toolName.includes("apply_scene_patch")) {
			const target: ToolEventTarget = scenePath === undefined ? {
				kind: "scene",
				label: "Current scene"
			} : {
				kind: "scene",
				path: scenePath,
				label: scenePath
			};
			return createDisplay("godot_editor", "Godot Editor", "scene", "Edit online scene", `Edit ${scenePath ?? "current scene"}`, {
				...target
			});
		}
	}

	if (toolName.startsWith("mcp_godot_")) {
		const relativePath: string | undefined = getStringArg(args, "relativePath") ?? getStringArg(args, "scenePath");
		const resourcePath: string | undefined = getStringArg(args, "resourcePath") ?? relativePath;
		const settingKey: string | undefined = getStringArg(args, "key");
		const inputAction: string | undefined = getStringArg(args, "action");
		const autoloadName: string | undefined = getStringArg(args, "name");
		const scriptPath: string | undefined = getStringArg(args, "scriptPath");

		if (toolName.includes("search_documentation")) {
			const query: string = getStringArg(args, "query") ?? "Godot documentation";
			return createDisplay("godot", "Godot Documentation", "docs", "Search Godot documentation", `Search local docs: ${query}`, {
				kind: "query",
				label: query
			});
		}

		if (toolName.includes("lsp_get_status")) {
			return createDisplay("godot_diagnostics", "Godot Diagnostics", "read", "Check LSP status", "Probe the Godot GDScript LSP", {
				kind: "unknown",
				label: "Godot LSP"
			});
		}

		if (toolName.includes("lsp_get_file_diagnostics")) {
			const targetLabel: string = resourcePath ?? "script";
			return createDisplay("godot_diagnostics", "Godot Diagnostics", "read", "Read script diagnostics", `Read LSP diagnostics for ${targetLabel}`, {
				kind: "file",
				path: targetLabel,
				label: targetLabel
			});
		}

		if (toolName.includes("lsp_get_document_symbols")) {
			const targetLabel: string = resourcePath ?? "script";
			return createDisplay("godot_diagnostics", "Godot Diagnostics", "read", "Inspect script symbols", `Inspect the symbol structure of ${targetLabel}`, {
				kind: "file",
				path: targetLabel,
				label: targetLabel
			});
		}

		if (toolName.includes("lsp_hover")) {
			const targetLabel: string = resourcePath ?? "script";
			return createDisplay("godot_diagnostics", "Godot Diagnostics", "read", "Inspect hover information", `Inspect symbol information for ${targetLabel}`, {
				kind: "file",
				path: targetLabel,
				label: targetLabel
			});
		}

		if (toolName.includes("lsp_goto_definition")) {
			const targetLabel: string = resourcePath ?? "script";
			return createDisplay("godot_diagnostics", "Godot Diagnostics", "read", "Find definition", `Find definitions in ${targetLabel}`, {
				kind: "file",
				path: targetLabel,
				label: targetLabel
			});
		}

		if (toolName.includes("dap_get_status")) {
			return createDisplay("godot_diagnostics", "Godot Diagnostics", "read", "Check DAP status", "Probe the Godot DAP debug session", {
				kind: "unknown",
				label: "Godot DAP"
			});
		}

		if (toolName.includes("dap_get_last_error")) {
			return createDisplay("godot_diagnostics", "Godot Diagnostics", "read", "Read runtime errors", "Read recent runtime errors from Godot DAP", {
				kind: "unknown",
				label: "last runtime error"
			});
		}

		if (toolName.includes("dap_get_stack_trace")) {
			return createDisplay("godot_diagnostics", "Godot Diagnostics", "read", "Read call stack", "Read the Godot DAP call stack", {
				kind: "unknown",
				label: "stack trace"
			});
		}

		if (toolName.includes("dap_get_variables")) {
			const reference: string = String(args["variablesReference"] ?? "variables");
			return createDisplay("godot_diagnostics", "Godot Diagnostics", "read", "Read variables", `Read variable reference ${reference}`, {
				kind: "unknown",
				label: reference
			});
		}

		if (toolName.includes("get_project_log_config")) {
			return createDisplay("godot", "Godot", "read", "Read log configuration", "Resolve the Godot project log path", {
				kind: "unknown",
				label: "project log config"
			});
		}

		if (toolName.includes("list_project_logs")) {
			return createDisplay("godot", "Godot", "read", "List project logs", "List Godot project log files", {
				kind: "file",
				label: "project logs"
			});
		}

		if (toolName.includes("read_project_log")) {
			const fileName: string = getStringArg(args, "fileName") ?? "godot.log";
			return createDisplay("godot", "Godot", "read", "Read project log", `Read ${fileName}`, {
				kind: "file",
				label: fileName
			});
		}

		if (toolName.includes("get_project_settings")) {
			return createDisplay("godot", "Godot", "read", "Read project settings", "Read project.godot settings", {
				kind: "file",
				path: "project.godot",
				label: "project.godot"
			});
		}

		if (toolName.includes("get_input_actions")) {
			return createDisplay("godot", "Godot", "read", "Read Input Actions", "Read Godot input actions", {
				kind: "file",
				path: "project.godot",
				label: "input actions"
			});
		}

		if (toolName.includes("input_action")) {
			const targetLabel: string = inputAction ?? "input action";
			const category: ToolEventCategory = toolName.includes("propose_") ? "propose" : "write";
			const title: string = category === "propose" ? "Preview Input Action" : "Modify Input Action";
			return createDisplay("godot", "Godot", category, title, `${title}: ${targetLabel}`, {
				kind: "file",
				path: "project.godot",
				label: targetLabel
			});
		}

		if (toolName.includes("get_autoloads")) {
			return createDisplay("godot", "Godot", "read", "Read Autoloads", "Read Godot autoload singletons", {
				kind: "file",
				path: "project.godot",
				label: "autoloads"
			});
		}

		if (toolName.includes("autoload")) {
			const targetLabel: string = autoloadName ?? "autoload";
			const category: ToolEventCategory = toolName.includes("propose_") ? "propose" : "write";
			const title: string = category === "propose" ? "Preview Autoload" : "Modify Autoload";
			return createDisplay("godot", "Godot", category, title, `${title}: ${targetLabel}`, {
				kind: "file",
				path: "project.godot",
				label: targetLabel
			});
		}

		if (toolName.includes("analyze_project_dependencies")) {
			return createDisplay("godot", "Godot", "read", "Analyze Dependencies", "Analyze Godot project resource dependencies", {
				kind: "unknown",
				label: "dependencies"
			});
		}

		if (toolName.includes("find_unused_resources")) {
			return createDisplay("godot", "Godot", "search", "Find Unused Resources", "Search for unused Godot resources", {
				kind: "unknown",
				label: "unused resources"
			});
		}

		if (toolName.includes("find_scene_nodes")) {
			const targetLabel: string = relativePath ?? getStringArg(args, "nodeType") ?? getStringArg(args, "group") ?? "scene nodes";
			const target: ToolEventTarget = relativePath === undefined
				? { kind: "scene", label: targetLabel }
				: { kind: "scene", path: relativePath, label: targetLabel };
			return createDisplay("godot", "Godot", "search", "Find Scene Nodes", `Search scene nodes: ${targetLabel}`, {
				...target
			});
		}

		if (toolName.includes("find_script_references")) {
			const targetLabel: string = scriptPath ?? "script";
			return createDisplay("godot", "Godot", "search", "Find Script References", `Find references to ${targetLabel}`, {
				kind: "file",
				path: targetLabel,
				label: targetLabel
			});
		}

		if (toolName.includes("list_project_global_classes")) {
			return createDisplay("godot", "Godot", "search", "List Global Classes", "Scan Godot global classes", {
				kind: "unknown",
				label: "global classes"
			});
		}

		if (toolName.includes("list_project_tests")) {
			const targetLabel: string = getStringArg(args, "searchPath") ?? "tests";
			return createDisplay("godot", "Godot", "search", "List Tests", `Discover project tests in ${targetLabel}`, {
				kind: "file",
				path: targetLabel,
				label: targetLabel
			});
		}

		if (toolName.includes("inspect_csharp_project_support")) {
			const targetLabel: string = getStringArg(args, "searchPath") ?? ".";
			return createDisplay("godot", "Godot", "read", "Inspect C# Support", `Inspect C# project support in ${targetLabel}`, {
				kind: "file",
				path: targetLabel,
				label: targetLabel
			});
		}

		if (toolName.includes("get_import_metadata")) {
			const targetLabel: string = getStringArg(args, "resourcePath") ?? "resource";
			return createDisplay("godot", "Godot", "read", "Read Import Metadata", `Read import metadata for ${targetLabel}`, {
				kind: "file",
				path: targetLabel,
				label: targetLabel
			});
		}

		if (toolName.includes("audit_project_health")) {
			return createDisplay("godot", "Godot", "read", "Audit Project Health", "Audit Godot project health", {
				kind: "unknown",
				label: "project health"
			});
		}

		if (toolName.includes("get_editor_config_summary")) {
			return createDisplay("godot", "Godot", "read", "Read editor summary", "Read a summary of Godot editor settings and project edit state", {
				kind: "unknown",
				label: "Godot editor config"
			});
		}

		if (toolName.includes("get_editor_settings")) {
			return createDisplay("godot", "Godot", "read", "Read editor settings", "Read editor_settings configuration", {
				kind: "file",
				label: "editor_settings"
			});
		}

		if (toolName.includes("list_editor_config_files")) {
			return createDisplay("godot", "Godot", "read", "List editor configuration", "List readable Godot editor configuration files", {
				kind: "file",
				label: "editor config files"
			});
		}

		if (toolName.includes("read_editor_config_file")) {
			const fileId: string = getStringArg(args, "fileId") ?? getStringArg(args, "filePath") ?? "editor config";
			return createDisplay("godot", "Godot", "read", "Read editor configuration", `Read ${fileId}`, {
				kind: "file",
				label: fileId
			});
		}

		if (toolName.includes("get_editor_project_state")) {
			return createDisplay("godot", "Godot", "read", "Read editor state", "Read the current project's .godot/editor state", {
				kind: "file",
				path: ".godot/editor",
				label: ".godot/editor"
			});
		}

		if (toolName.includes("get_recent_projects")) {
			return createDisplay("godot", "Godot", "read", "Read recent projects", "Read recent Godot projects and directories", {
				kind: "file",
				label: "projects.cfg"
			});
		}

		if (toolName.includes("propose_set_project_setting") || toolName.includes("propose_unset_project_setting")) {
			const targetLabel: string = settingKey ?? "project setting";
			return createDisplay("godot", "Godot", "propose", "Preview project setting change", `Preview ${targetLabel}`, {
				kind: "file",
				path: "project.godot",
				label: targetLabel
			});
		}

		if (toolName.includes("set_project_setting") || toolName.includes("unset_project_setting")) {
			const targetLabel: string = settingKey ?? "project setting";
			return createDisplay("godot", "Godot", "write", "Change project setting", `Change ${targetLabel}`, {
				kind: "file",
				path: "project.godot",
				label: targetLabel
			});
		}

		if (toolName.includes("read_text_file")) {
			const filePath: string = relativePath ?? "unknown file";
			return createDisplay("godot", "Godot", "read", "Read file", `Read ${filePath}`, {
				kind: "file",
				path: filePath,
				label: filePath
			});
		}

		if (toolName.includes("validate_scene_script_references")) {
			const scenePath: string = relativePath ?? "unknown scene";
			return createDisplay("godot", "Godot", "scene", "Validate scene references", `Validate script node references in ${scenePath}`, {
				kind: "scene",
				path: scenePath,
				label: scenePath
			});
		}

		if (toolName.includes("search_text")) {
			const query: string = getStringArg(args, "query") ?? "";
			return createDisplay("godot", "Godot", "search", "Search text", `Search ${query}`, {
				kind: "query",
				label: query
			});
		}

		if (toolName.includes("propose_")) {
			const targetKind: ToolEventTarget["kind"] = toolName.includes("scene") || toolName.includes("scene_patch") || relativePath?.endsWith(".tscn")
				? "scene"
				: "file";
			const targetLabel: string = relativePath ?? (targetKind === "scene" ? "unknown scene" : "unknown file");
			const title: string = targetKind === "scene" ? "Preview scene change" : "Preview file change";
			return createDisplay("godot", "Godot", "propose", title, `${title} ${targetLabel}`, {
				kind: targetKind,
				path: targetLabel,
				label: targetLabel
			});
		}

		if (toolName.includes("scene")) {
			const scenePath: string = relativePath ?? "unknown scene";
			const category: ToolEventCategory = toolName.includes("inspect") ? "read" : "scene";
			const title: string = toolName.includes("inspect") ? "Inspect scene" : "Edit scene";
			return createDisplay("godot", "Godot", category, title, `${title} ${scenePath}`, {
				kind: "scene",
				path: scenePath,
				label: scenePath
			});
		}

		if (toolName.includes("create_text_file") || toolName.includes("overwrite_text_file") || toolName.includes("replace_text_in_file") || toolName.includes("replace_line_in_file") || toolName.includes("delete_file")) {
			const filePath: string = relativePath ?? "unknown file";
			return createDisplay("godot", "Godot", "write", "Write file", `Write ${filePath}`, {
				kind: "file",
				path: filePath,
				label: filePath
			});
		}

		return createDisplay("godot", "Godot", "unknown", "Godot tool", toolName, {
			kind: "unknown",
			label: toolName
		});
	}

	if (toolName === "mcp_terminal_run_godot_scene_script") {
		const operation: Record<string, unknown> = parseOperationJson(args);
		const scenePath: string = typeof operation.scene_path === "string"
			? operation.scene_path
			: typeof operation.path === "string"
				? operation.path
				: "scene operation";
		return createDisplay("terminal", "Terminal", "scene", "Run Godot scene script", `Scene operation ${scenePath}`, {
			kind: "scene",
			path: scenePath,
			label: scenePath
		});
	}

	if (toolName === "mcp_terminal_run_command") {
		const reason: string | undefined = getStringArg(args, "reason");
		const commandLine: string | undefined = getStringArg(args, "commandLine");
		const label: string = reason ?? commandLine ?? toolName;
		return createDisplay("terminal", "Terminal", "terminal", "Run terminal command", label, {
			kind: "command",
			label: commandLine ?? label
		});
	}
	if (toolName.startsWith("mcp_plugin_dev_")) {
		const action: string = toolName.slice("mcp_plugin_dev_".length);
		const labels: Record<string, [ToolEventCategory, string]> = {
			prepare: ["propose", "Prepare plugin"],
			apply: ["write", "Generate plugin project"],
			validate: ["read", "Validate plugin"],
			install: ["write", "Install plugin"],
			test: ["read", "Test plugin"]
		};
		const [category, title] = labels[action] ?? ["unknown", "Develop plugin"];
		const label: string = getStringArg(args, "slug") ?? getStringArg(args, "pluginId") ?? "plugin";
		return createDisplay("plugin_development", "Plugin Creator", category, title, label, { kind: "unknown", label });
	}

	if (toolName === "mcp_workspace_download_file") {
		const relativePath: string = getStringArg(args, "relativePath") ?? "workspace file";
		const dependency: string = getStringArg(args, "dependency") ?? "file";
		const targetPath: string = formatSourcePath(args, relativePath);
		return createDisplay("workspace", "Workspace", "write", "Download file", `Download ${dependency} to ${targetPath}`, {
			kind: "file",
			path: relativePath,
			label: targetPath
		});
	}

	if (toolName === "mcp_terminal_get_capabilities") {
		return createDisplay("terminal", "Terminal", "read", "View terminal capabilities", "View available terminal presets", {
			kind: "command",
			label: "Terminal presets"
		});
	}

	if (toolName.startsWith("mcp_terminal_")) {
		const presetName: string = getStringArg(args, "presetName") ?? toolName;
		const resourcePath: string | undefined = getStringArg(args, "resourcePath");
		const label: string = resourcePath === undefined ? presetName : `${presetName} ${resourcePath}`;
		const target: ToolEventTarget = resourcePath === undefined ? {
			kind: "command",
			label
		} : {
			kind: "command",
			path: resourcePath,
			label
		};
		return createDisplay("terminal", "Terminal", "terminal", "Run terminal command", label, target);
	}

	if (toolName.includes("context7") || toolName.includes("library") || toolName.includes("docs")) {
		return createDisplay("context7", "Context7", "docs", "Query documentation", toolName, {
			kind: "query",
			label: toolName
		});
	}

	return createDisplay("unknown", "MCP", "unknown", "MCP tool", toolName, {
		kind: "unknown",
		label: toolName
	});
}
