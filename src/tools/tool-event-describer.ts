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
	if (toolName.startsWith("mcp_scheduled_task")) {
		const labels: Record<string, [ToolEventCategory, string]> = {
			mcp_scheduled_tasks_list: ["read", "查看定时任务"],
			mcp_scheduled_task_create: ["write", "创建定时任务"],
			mcp_scheduled_task_update: ["write", "修改定时任务"],
			mcp_scheduled_task_pause: ["write", "暂停定时任务"],
			mcp_scheduled_task_resume: ["write", "恢复定时任务"],
			mcp_scheduled_task_delete: ["write", "删除定时任务"],
			mcp_scheduled_task_report: ["read", "报告监测结果"],
		};
		const [category, title] = labels[toolName] ?? ["unknown", "操作定时任务"];
		const label = getStringArg(args, "title") ?? getStringArg(args, "taskId") ?? "scheduled task";
		return createDisplay("studio_scheduled_tasks", "Daedalus Scheduler", category, title, label, { kind: "unknown", label });
	}
	if (toolName.startsWith("mcp_browser_")) {
		const action = toolName.slice("mcp_browser_".length);
		const labels: Record<string, [ToolEventCategory, string, string]> = {
			observe: ["read", "观察网页", "读取当前网页的可见内容与交互元素"],
			navigate: ["read", "打开网页", getStringArg(args, "url") ?? "导航到网页"],
			navigation: ["read", "网页导航", getStringArg(args, "action") ?? "导航网页"],
			scroll: ["read", "滚动网页", getStringArg(args, "direction") ?? "滚动当前网页"],
			wait: ["read", "等待网页", getStringArg(args, "condition") ?? "等待页面状态"],
			screenshot: ["image", "截取网页", "捕获当前浏览器视口"],
			click: ["write", "点击网页元素", `元素 ${String(args.elementId ?? "")}`],
			type: ["write", "输入网页内容", `元素 ${String(args.elementId ?? "")}`],
			select: ["write", "选择网页选项", `元素 ${String(args.elementId ?? "")}`]
		};
		const [category, title, summary] = labels[action] ?? ["unknown", "操作网页", action];
		return createDisplay("studio_browser", "Daedalus Browser", category, title, summary, { kind: "unknown", label: action });
	}
	if (toolName === "daedalus_prepare_summary") {
		return createDisplay("workflow", "Daedalus Workflow", "read", "准备总结", "检查 Agent Loop 是否可以开始总结", {
			kind: "unknown",
			label: "summary checkpoint"
		});
	}

	if (toolName.startsWith("mcp_skills_")) {
		const ref: string | undefined = getStringArg(args, "ref");
		const slug: string | undefined = getStringArg(args, "slug");
		const label: string = ref ?? slug ?? "skill";
		if (toolName === "mcp_skills_load") {
			return createDisplay("skills", "Skills", "read", "加载 Skill", `读取 ${label} 的指令`, { kind: "unknown", label });
		}
		if (toolName === "mcp_skills_propose_create") {
			return createDisplay("skills", "Skills", "propose", "预览 Skill", `校验 ${label}`, { kind: "unknown", label });
		}
		return createDisplay("skills", "Skills", "write", "创建 Skill", `创建 ${label}`, { kind: "unknown", label });
	}
	if (toolName === "mcp_image_generate") {
		const prompt: string = getStringArg(args, "prompt") ?? "image";
		const count: string = String(args.count ?? 1);
		return createDisplay("image", "Image Generation", "image", "生成图片", `生成 ${count} 张图片：${prompt.slice(0, 80)}`, {
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
		return createDisplay("web_search", "Web Search", "read", "联网搜索", `搜索：${query.slice(0, 100)}`, {
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
			return createDisplay("workspace", "Workspace", "read", "列出文件", "列出 workspace 文件", {
				kind: "file",
					label: formatSourceScope(args, "[primary]")
			});
		}
		if (toolName.includes("read_text_file")) {
				const filePath: string = formatSourcePath(args, relativePath ?? "unknown file");
			return createDisplay("workspace", "Workspace", "read", "读取文件", `读取 ${filePath}`, {
				kind: "file",
				path: filePath,
				label: filePath
			});
		}
		if (toolName.includes("search_text")) {
			const query: string = getStringArg(args, "query") ?? "search";
			return createDisplay("workspace", "Workspace", "search", "搜索文件", `搜索：${query.slice(0, 100)}`, {
				kind: "unknown",
					label: `${formatSourceScope(args, "[primary]")} ${query}`
			});
		}
		if (toolName.includes("propose_")) {
				const filePath: string = formatSourcePath(args, relativePath ?? "unknown file");
			return createDisplay("workspace", "Workspace", "propose", "预览文件修改", filePath, {
				kind: "file",
				path: filePath,
				label: filePath
			});
		}
		if (toolName.includes("create_text_file") || toolName.includes("overwrite_text_file") || toolName.includes("replace_text_in_file") || toolName.includes("replace_line_in_file") || toolName.includes("delete_file")) {
				const filePath: string = formatSourcePath(args, relativePath ?? "unknown file");
			return createDisplay("workspace", "Workspace", "write", "写入文件", `写入 ${filePath}`, {
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
		const title: string = metadata?.planAccess === "read" ? "读取自定义 MCP" : "自定义 MCP 工具";
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
			return createDisplay("godot_editor", "Godot Editor", "read", "读取编辑器上下文", "读取当前编辑器在线状态与场景上下文", {
				kind: "unknown",
				label: "Godot Editor"
			});
		}

		if (toolName.includes("get_selected_nodes")) {
			return createDisplay("godot_editor", "Godot Editor", "read", "读取选中节点", "读取当前编辑器选中的节点", {
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
			return createDisplay("godot_editor", "Godot Editor", "read", "查看在线节点", `查看 ${targetLabel}`, {
				...target
			});
		}

		if (toolName.includes("capture_scene_view")) {
			const view: string = getStringArg(args, "view") ?? "auto";
			return createDisplay("godot_editor", "Godot Editor", "read", "截取场景视图", `截取 ${view} 编辑器场景视口供视觉分析`, {
				kind: "scene",
				label: `scene view (${view})`
			});
		}

		if (toolName.includes("apply_scene_patch")) {
			const target: ToolEventTarget = scenePath === undefined ? {
				kind: "scene",
				label: "当前场景"
			} : {
				kind: "scene",
				path: scenePath,
				label: scenePath
			};
			return createDisplay("godot_editor", "Godot Editor", "scene", "编辑在线场景", `编辑 ${scenePath ?? "当前场景"}`, {
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
			return createDisplay("godot_diagnostics", "Godot Diagnostics", "read", "检查 LSP 状态", "探测 Godot GDScript LSP", {
				kind: "unknown",
				label: "Godot LSP"
			});
		}

		if (toolName.includes("lsp_get_file_diagnostics")) {
			const targetLabel: string = resourcePath ?? "script";
			return createDisplay("godot_diagnostics", "Godot Diagnostics", "read", "读取脚本诊断", `读取 ${targetLabel} 的 LSP 诊断`, {
				kind: "file",
				path: targetLabel,
				label: targetLabel
			});
		}

		if (toolName.includes("lsp_get_document_symbols")) {
			const targetLabel: string = resourcePath ?? "script";
			return createDisplay("godot_diagnostics", "Godot Diagnostics", "read", "查看脚本符号", `查看 ${targetLabel} 的符号结构`, {
				kind: "file",
				path: targetLabel,
				label: targetLabel
			});
		}

		if (toolName.includes("lsp_hover")) {
			const targetLabel: string = resourcePath ?? "script";
			return createDisplay("godot_diagnostics", "Godot Diagnostics", "read", "查看 Hover 信息", `查看 ${targetLabel} 的符号说明`, {
				kind: "file",
				path: targetLabel,
				label: targetLabel
			});
		}

		if (toolName.includes("lsp_goto_definition")) {
			const targetLabel: string = resourcePath ?? "script";
			return createDisplay("godot_diagnostics", "Godot Diagnostics", "read", "查找定义", `查找 ${targetLabel} 中的定义`, {
				kind: "file",
				path: targetLabel,
				label: targetLabel
			});
		}

		if (toolName.includes("dap_get_status")) {
			return createDisplay("godot_diagnostics", "Godot Diagnostics", "read", "检查 DAP 状态", "探测 Godot DAP 调试会话", {
				kind: "unknown",
				label: "Godot DAP"
			});
		}

		if (toolName.includes("dap_get_last_error")) {
			return createDisplay("godot_diagnostics", "Godot Diagnostics", "read", "读取运行错误", "读取 Godot DAP 最近运行错误", {
				kind: "unknown",
				label: "last runtime error"
			});
		}

		if (toolName.includes("dap_get_stack_trace")) {
			return createDisplay("godot_diagnostics", "Godot Diagnostics", "read", "读取调用栈", "读取 Godot DAP 调用栈", {
				kind: "unknown",
				label: "stack trace"
			});
		}

		if (toolName.includes("dap_get_variables")) {
			const reference: string = String(args["variablesReference"] ?? "variables");
			return createDisplay("godot_diagnostics", "Godot Diagnostics", "read", "读取变量", `读取变量引用 ${reference}`, {
				kind: "unknown",
				label: reference
			});
		}

		if (toolName.includes("get_project_log_config")) {
			return createDisplay("godot", "Godot", "read", "读取日志配置", "解析 Godot 项目日志路径", {
				kind: "unknown",
				label: "project log config"
			});
		}

		if (toolName.includes("list_project_logs")) {
			return createDisplay("godot", "Godot", "read", "列出项目日志", "列出 Godot 项目日志文件", {
				kind: "file",
				label: "project logs"
			});
		}

		if (toolName.includes("read_project_log")) {
			const fileName: string = getStringArg(args, "fileName") ?? "godot.log";
			return createDisplay("godot", "Godot", "read", "读取项目日志", `读取 ${fileName}`, {
				kind: "file",
				label: fileName
			});
		}

		if (toolName.includes("get_project_settings")) {
			return createDisplay("godot", "Godot", "read", "读取项目设置", "读取 project.godot 设置", {
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
			return createDisplay("godot", "Godot", "read", "读取编辑器摘要", "读取 Godot 编辑器设置与项目编辑状态摘要", {
				kind: "unknown",
				label: "Godot editor config"
			});
		}

		if (toolName.includes("get_editor_settings")) {
			return createDisplay("godot", "Godot", "read", "读取编辑器设置", "读取 editor_settings 配置", {
				kind: "file",
				label: "editor_settings"
			});
		}

		if (toolName.includes("list_editor_config_files")) {
			return createDisplay("godot", "Godot", "read", "列出编辑器配置", "列出可读的 Godot 编辑器配置文件", {
				kind: "file",
				label: "editor config files"
			});
		}

		if (toolName.includes("read_editor_config_file")) {
			const fileId: string = getStringArg(args, "fileId") ?? getStringArg(args, "filePath") ?? "editor config";
			return createDisplay("godot", "Godot", "read", "读取编辑器配置", `读取 ${fileId}`, {
				kind: "file",
				label: fileId
			});
		}

		if (toolName.includes("get_editor_project_state")) {
			return createDisplay("godot", "Godot", "read", "读取编辑器状态", "读取当前项目 .godot/editor 状态", {
				kind: "file",
				path: ".godot/editor",
				label: ".godot/editor"
			});
		}

		if (toolName.includes("get_recent_projects")) {
			return createDisplay("godot", "Godot", "read", "读取最近项目", "读取 Godot 最近项目与目录", {
				kind: "file",
				label: "projects.cfg"
			});
		}

		if (toolName.includes("propose_set_project_setting") || toolName.includes("propose_unset_project_setting")) {
			const targetLabel: string = settingKey ?? "project setting";
			return createDisplay("godot", "Godot", "propose", "预览项目设置修改", `预览 ${targetLabel}`, {
				kind: "file",
				path: "project.godot",
				label: targetLabel
			});
		}

		if (toolName.includes("set_project_setting") || toolName.includes("unset_project_setting")) {
			const targetLabel: string = settingKey ?? "project setting";
			return createDisplay("godot", "Godot", "write", "修改项目设置", `修改 ${targetLabel}`, {
				kind: "file",
				path: "project.godot",
				label: targetLabel
			});
		}

		if (toolName.includes("read_text_file")) {
			const filePath: string = relativePath ?? "unknown file";
			return createDisplay("godot", "Godot", "read", "读取文件", `读取 ${filePath}`, {
				kind: "file",
				path: filePath,
				label: filePath
			});
		}

		if (toolName.includes("validate_scene_script_references")) {
			const scenePath: string = relativePath ?? "unknown scene";
			return createDisplay("godot", "Godot", "scene", "验证场景引用", `验证 ${scenePath} 的脚本节点引用`, {
				kind: "scene",
				path: scenePath,
				label: scenePath
			});
		}

		if (toolName.includes("search_text")) {
			const query: string = getStringArg(args, "query") ?? "";
			return createDisplay("godot", "Godot", "search", "搜索文本", `搜索 ${query}`, {
				kind: "query",
				label: query
			});
		}

		if (toolName.includes("propose_")) {
			const targetKind: ToolEventTarget["kind"] = toolName.includes("scene") || toolName.includes("scene_patch") || relativePath?.endsWith(".tscn")
				? "scene"
				: "file";
			const targetLabel: string = relativePath ?? (targetKind === "scene" ? "unknown scene" : "unknown file");
			const title: string = targetKind === "scene" ? "预览场景修改" : "预览文件修改";
			return createDisplay("godot", "Godot", "propose", title, `${title} ${targetLabel}`, {
				kind: targetKind,
				path: targetLabel,
				label: targetLabel
			});
		}

		if (toolName.includes("scene")) {
			const scenePath: string = relativePath ?? "unknown scene";
			const category: ToolEventCategory = toolName.includes("inspect") ? "read" : "scene";
			const title: string = toolName.includes("inspect") ? "查看场景" : "编辑场景";
			return createDisplay("godot", "Godot", category, title, `${title} ${scenePath}`, {
				kind: "scene",
				path: scenePath,
				label: scenePath
			});
		}

		if (toolName.includes("create_text_file") || toolName.includes("overwrite_text_file") || toolName.includes("replace_text_in_file") || toolName.includes("replace_line_in_file") || toolName.includes("delete_file")) {
			const filePath: string = relativePath ?? "unknown file";
			return createDisplay("godot", "Godot", "write", "写入文件", `写入 ${filePath}`, {
				kind: "file",
				path: filePath,
				label: filePath
			});
		}

		return createDisplay("godot", "Godot", "unknown", "Godot 工具", toolName, {
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
		return createDisplay("terminal", "Terminal", "scene", "执行 Godot 场景脚本", `场景操作 ${scenePath}`, {
			kind: "scene",
			path: scenePath,
			label: scenePath
		});
	}

	if (toolName === "mcp_terminal_run_command") {
		const reason: string | undefined = getStringArg(args, "reason");
		const commandLine: string | undefined = getStringArg(args, "commandLine");
		const label: string = reason ?? commandLine ?? toolName;
		return createDisplay("terminal", "Terminal", "terminal", "运行终端命令", label, {
			kind: "command",
			label: commandLine ?? label
		});
	}
	if (toolName.startsWith("mcp_plugin_dev_")) {
		const action: string = toolName.slice("mcp_plugin_dev_".length);
		const labels: Record<string, [ToolEventCategory, string]> = {
			prepare: ["propose", "设计插件"],
			apply: ["write", "生成插件工程"],
			validate: ["read", "验证插件"],
			install: ["write", "安装插件"],
			test: ["read", "测试插件"]
		};
		const [category, title] = labels[action] ?? ["unknown", "开发插件"];
		const label: string = getStringArg(args, "slug") ?? getStringArg(args, "pluginId") ?? "plugin";
		return createDisplay("plugin_development", "Plugin Creator", category, title, label, { kind: "unknown", label });
	}

	if (toolName === "mcp_workspace_download_file") {
		const relativePath: string = getStringArg(args, "relativePath") ?? "workspace file";
		const dependency: string = getStringArg(args, "dependency") ?? "file";
		const targetPath: string = formatSourcePath(args, relativePath);
		return createDisplay("workspace", "Workspace", "write", "下载文件", `下载 ${dependency} 到 ${targetPath}`, {
			kind: "file",
			path: relativePath,
			label: targetPath
		});
	}

	if (toolName === "mcp_terminal_get_capabilities") {
		return createDisplay("terminal", "Terminal", "read", "查看终端能力", "查看可用终端预设", {
			kind: "command",
			label: "终端预设"
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
		return createDisplay("terminal", "Terminal", "terminal", "运行终端命令", label, target);
	}

	if (toolName.includes("context7") || toolName.includes("library") || toolName.includes("docs")) {
		return createDisplay("context7", "Context7", "docs", "查询文档", toolName, {
			kind: "query",
			label: toolName
		});
	}

	return createDisplay("unknown", "MCP", "unknown", "MCP 工具", toolName, {
		kind: "unknown",
		label: toolName
	});
}
