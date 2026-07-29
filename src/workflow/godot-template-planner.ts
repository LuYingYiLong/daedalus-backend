import type { AiChatParams } from "../protocol/types.js";
import type { WorkflowCompletionContract, WorkflowCompletionTarget, WorkflowPhase, WorkflowPlan } from "./types.js";
import { createWorkflowId, createWorkflowTitle, READ_TOOLS, VERIFY_TOOLS, WRITE_TOOLS } from "./planner.js";
import { createVisibleWorkflowTodos } from "./todos.js";

export type GodotTaskType = "script_create_or_edit" | "scene_create" | "scene_attach_script" | "project_setting_change" | "local_game_create" | "general_edit";

export type GodotTaskClassification = {
	type: GodotTaskType;
	scriptPath?: string | undefined;
	scenePath?: string | undefined;
	nodePath?: string | undefined;
	scriptContent?: string | undefined;
	setAsMain?: boolean | undefined;
};

export type GodotTemplateWorkflowContext = {
	isGodotProject?: boolean | undefined;
};

const TEXT_FILE_READ_TOOLS: string[] = [
	"mcp_godot_get_project_summary",
	"mcp_godot_list_project_files",
	"mcp_godot_read_text_file",
	"mcp_godot_search_text"
];

const SCENE_READ_TOOLS: string[] = [
	"mcp_godot_list_scenes",
	"mcp_godot_read_text_file",
	"mcp_godot_inspect_scene_tree",
	"mcp_godot_editor_capture_scene_view"
];

const SCRIPT_WRITE_TOOLS: string[] = [
	"mcp_godot_propose_create_text_file",
	"mcp_godot_create_text_file",
	"mcp_godot_propose_overwrite_text_file",
	"mcp_godot_overwrite_text_file",
	"mcp_godot_propose_replace_text_in_file",
	"mcp_godot_replace_text_in_file"
];

const SCENE_CREATE_WRITE_TOOLS: string[] = [
	"mcp_godot_propose_create_scene",
	"mcp_godot_create_scene",
	"mcp_godot_propose_create_text_file",
	"mcp_godot_create_text_file"
];

const SCENE_EDIT_WRITE_TOOLS: string[] = [
	"mcp_godot_propose_overwrite_text_file",
	"mcp_godot_overwrite_text_file",
	"mcp_godot_propose_apply_scene_patch",
	"mcp_godot_apply_scene_patch",
	"mcp_godot_editor_apply_scene_patch",
	"mcp_godot_propose_add_node_to_scene",
	"mcp_godot_add_node_to_scene",
	"mcp_godot_propose_connect_signal_in_scene",
	"mcp_godot_connect_signal_in_scene"
];

const SCENE_ATTACH_WRITE_TOOLS: string[] = [
	"mcp_godot_propose_attach_script_to_node",
	"mcp_godot_attach_script_to_node",
	"mcp_godot_propose_apply_scene_patch",
	"mcp_godot_apply_scene_patch"
];

const PROJECT_SETTING_WRITE_TOOLS: string[] = [
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
	"mcp_godot_unset_autoload"
];

const PROJECT_SETTING_READ_TOOLS: string[] = [
	"mcp_godot_get_project_settings",
	"mcp_godot_get_input_actions",
	"mcp_godot_get_autoloads"
];

export function classifyGodotTask(message: string, context?: GodotTemplateWorkflowContext | undefined): GodotTaskClassification {
	const normalized: string = message.toLowerCase();
	const scriptPath: string | undefined = findFirstPath(message, ".gd");
	const scenePath: string | undefined = findFirstPath(message, ".tscn");
	const scriptContent: string | undefined = extractFirstFencedBlock(message);
	const nodePath: string = inferNodePath(message);
	const mentionsGodot: boolean = normalized.includes("godot") || normalized.includes(".gd") || normalized.includes(".tscn") || normalized.includes("project.godot") || normalized.includes("项目设置");
	const hasGodotWorkspaceContext: boolean = context?.isGodotProject === true;
	const wantsWrite: boolean = wantsMutation(normalized);
	const sceneCreationIntent: boolean = scenePath !== undefined && includesAny(normalized, [
		"create scene", "build scene", "write scene", "创建场景", "创建主场景", "生成场景", "搭建场景", "写入场景"
	]);
	const setMainSceneIntent: boolean = includesAny(normalized, ["application/run/main_scene", "run/main_scene"])
		|| (
			includesAny(normalized, ["main scene", "主场景", "启动场景"])
			&& includesAny(normalized, ["set", "configure", "设置", "配置", "指定", "设为"])
		);

	if ((!mentionsGodot && !hasGodotWorkspaceContext) || !wantsWrite) {
		return { type: "general_edit" };
	}

	if (
		!sceneCreationIntent
		&& (
			setMainSceneIntent
			|| includesAny(normalized, ["project.godot", "项目设置", "project setting", "inputmap", "input map", "input action", "autoload", "display/window", "application/config"])
		)
	) {
		return { type: "project_setting_change" };
	}

	if (scriptPath !== undefined && scenePath !== undefined && includesAny(normalized, ["挂载", "attach", "脚本引用", "script reference"])) {
		return {
			type: "scene_attach_script",
			scriptPath,
			scenePath,
			nodePath,
			scriptContent
		};
	}

	if (wantsLocalGameCreation(normalized)) {
		return {
			type: "local_game_create",
			scriptPath: scriptPath ?? "scripts/tic_tac_toe_game.gd",
			scenePath: scenePath ?? "scenes/tic_tac_toe_game.tscn"
		};
	}

	if (scenePath !== undefined && includesAny(normalized, ["场景", "scene", "tscn", "创建", "新增", "生成"])) {
		return {
			type: "scene_create",
			scenePath,
			setAsMain: setMainSceneIntent
		};
	}

	if (scriptPath !== undefined) {
		return {
			type: "script_create_or_edit",
			scriptPath,
			scriptContent
		};
	}

	return { type: "general_edit" };
}

export function createGodotTemplateWorkflowPlan(params: AiChatParams, context?: GodotTemplateWorkflowContext | undefined): WorkflowPlan | null {
	if (params.mode === "ask" || params.mode === "plan") {
		return null;
	}
	const classification: GodotTaskClassification = classifyGodotTask(params.message, context);
	if (classification.type === "scene_attach_script" && classification.scriptPath !== undefined && classification.scenePath !== undefined) {
		return createScriptSceneAttachPlan(params, classification);
	}
	if (classification.type === "local_game_create" && classification.scriptPath !== undefined && classification.scenePath !== undefined) {
		return createLocalGameCreatePlan(params, classification);
	}
	if (classification.type === "script_create_or_edit" && classification.scriptPath !== undefined) {
		return createScriptWritePlan(params, classification);
	}
	if (classification.type === "scene_create" && classification.scenePath !== undefined) {
		return createSceneCreatePlan(params, classification);
	}
	if (classification.type === "project_setting_change") {
		return createProjectSettingPlan(params);
	}

	return null;
}

export function narrowLlmPlannedWriteTools(phase: Pick<WorkflowPhase, "title" | "instruction" | "toolGroup">): string[] {
	if (phase.toolGroup !== "write") {
		return [];
	}

	return narrowWriteToolsForText(`${phase.title}\n${phase.instruction}`);
}

export function getAllowedToolsForLlmPlannedStep(toolGroup: WorkflowPhase["toolGroup"], title: string, instruction: string): string[] {
	if (toolGroup === "write") {
		const narrowedTools: string[] = narrowWriteToolsForText(`${title}\n${instruction}`);
		return narrowedTools.length > 0 ? narrowedTools : [...TEXT_FILE_READ_TOOLS, ...SCENE_READ_TOOLS, ...WRITE_TOOLS];
	}
	if (toolGroup === "verify") {
		return [...SCENE_READ_TOOLS, "mcp_godot_lsp_get_file_diagnostics", "mcp_godot_validate_scene_script_references", "mcp_terminal_run_safe_preset"];
	}
	if (toolGroup === "summarize") {
		return [];
	}

	return [...READ_TOOLS];
}

export function createWorkflowCompletionContract(
	toolGroup: WorkflowPhase["toolGroup"],
	title: string,
	instruction: string,
	acceptanceCriteria: readonly string[] = []
): WorkflowCompletionContract | undefined {
	if (toolGroup !== "write") {
		return undefined;
	}

	const text: string = [title, instruction, ...acceptanceCriteria].join("\n");
	const normalized: string = text.toLowerCase();
	const targets: WorkflowCompletionTarget[] = [];
	const seen: Set<string> = new Set();
	const artifactPattern: RegExp = /(?:res:\/\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:gd|tscn|tres|gdshader|ts|tsx|js|jsx|json|md)\b/giu;
	for (const match of text.matchAll(artifactPattern)) {
		const path: string = stripResourcePrefix(match[0]).replace(/\\/g, "/");
		const key: string = `artifact:${path.toLowerCase()}`;
		if (!seen.has(key)) {
			seen.add(key);
			targets.push({ kind: "artifact", path });
		}
	}

	const settingPattern: RegExp = /\b(?:application|display|rendering|physics|audio|network|editor|debug)\/[A-Za-z0-9_.\/-]+\b/giu;
	for (const match of text.matchAll(settingPattern)) {
		const settingKey: string = match[0].replace(/[.,;:]+$/u, "");
		const key: string = `project_setting:${settingKey.toLowerCase()}`;
		if (!seen.has(key)) {
			seen.add(key);
			targets.push({ kind: "project_setting", key: settingKey });
		}
	}

	if (targets.some((target: WorkflowCompletionTarget): boolean => target.kind === "project_setting")) {
		const sceneMutationIntent: boolean = includesAny(normalized, [
			"create scene", "build scene", "edit scene", "write scene",
			"创建场景", "生成场景", "搭建场景", "修改场景", "写入场景"
		]);
		const scriptMutationIntent: boolean = includesAny(normalized, [
			"create script", "edit script", "write script", "modify script",
			"创建脚本", "生成脚本", "修改脚本", "写入脚本"
		]);
		for (let index: number = targets.length - 1; index >= 0; index -= 1) {
			const target: WorkflowCompletionTarget | undefined = targets[index];
			if (
				target?.kind === "artifact"
				&& (
					target.path.toLowerCase() === "project.godot"
					|| (target.path.toLowerCase().endsWith(".tscn") && !sceneMutationIntent)
					|| (target.path.toLowerCase().endsWith(".gd") && !scriptMutationIntent)
				)
			) {
				targets.splice(index, 1);
			}
		}
	}

	return targets.length > 0 ? { targets, requireAll: true } : undefined;
}

function createScriptSceneAttachPlan(params: AiChatParams, classification: GodotTaskClassification): WorkflowPlan {
	const scriptPath: string = classification.scriptPath ?? "scripts/generated.gd";
	const scenePath: string = classification.scenePath ?? "scenes/generated.tscn";
	const nodePath: string = classification.nodePath ?? ".";
	const scriptContent: string | undefined = classification.scriptContent;
	const phases: WorkflowPhase[] = [
		createPhase(
			"inspect",
			"确认目标文件",
			"read",
			[...TEXT_FILE_READ_TOOLS, ...SCENE_READ_TOOLS],
			[
				`确认目标脚本 ${scriptPath} 和目标场景 ${scenePath} 的当前状态。`,
				"只做事实收集，不修改文件。"
			].join("\n"),
			["已确认目标脚本和场景是否存在。"]
		),
		createPhase(
			"write-script",
			"写入脚本",
			"write",
			["mcp_godot_read_text_file", ...SCRIPT_WRITE_TOOLS],
			[
				`实际写入脚本 ${scriptPath}。`,
				scriptContent === undefined ? "按用户需求生成脚本内容。" : `脚本内容必须逐字匹配：\n\`\`\`gdscript\n${scriptContent}\n\`\`\``,
				"第一步必须调用脚本写入工具并按审批流程暂停；不要只输出文字意图。"
			].join("\n"),
			[`脚本 ${scriptPath} 已由实际写入工具创建或更新。`]
		),
		createPhase(
			"create-scene",
			"创建场景",
			"write",
			["mcp_godot_read_text_file", "mcp_godot_inspect_scene_tree", ...SCENE_CREATE_WRITE_TOOLS],
			[
				`实际创建场景 ${scenePath}。`,
				"根节点类型必须是 Node，根节点名称必须是 DaedalusFullSmoke，除非用户需求明确指定了其它名称。",
				"第一步必须调用 mcp_godot_create_scene 或 mcp_godot_create_text_file 并按审批流程暂停；不要只输出文字意图。"
			].join("\n"),
			[`场景 ${scenePath} 已由实际写入工具创建。`, "根节点类型和名称符合用户需求。"]
		),
		createPhase(
			"attach-script",
			"挂载脚本",
			"write",
			["mcp_godot_inspect_scene_tree", "mcp_godot_read_text_file", ...SCENE_ATTACH_WRITE_TOOLS],
			[
				`把 res://${stripResourcePrefix(scriptPath)} 挂载到场景 ${scenePath} 的节点 ${nodePath}。`,
				"第一步必须调用 mcp_godot_attach_script_to_node 或 mcp_godot_apply_scene_patch 并按审批流程暂停；不要只输出文字意图。",
				"不要重新创建脚本或场景，不要使用 terminal 写命令。"
			].join("\n"),
			[`场景 ${scenePath} 的 ${nodePath} 节点已引用 res://${stripResourcePrefix(scriptPath)}。`]
		),
		createPhase(
			"validate-scene-references",
			"验证脚本引用",
			"verify",
			["mcp_godot_inspect_scene_tree", "mcp_godot_validate_scene_script_references"],
			[
				`验证场景 ${scenePath} 可以引用脚本 res://${stripResourcePrefix(scriptPath)}。`,
				"必须调用 mcp_godot_validate_scene_script_references 或 inspect_scene_tree。"
			].join("\n"),
			["场景脚本引用验证通过，且验证结果来自工具事实。"]
		),
		createPhase(
			"summarize",
			"总结交付",
			"summarize",
			[],
			"只基于前面阶段的工具结果总结完成内容、审批状态、验证状态和剩余风险。不要调用工具。",
			["所有前置阶段均完成，且没有未解决失败。"]
		)
	];
	return createPlan(params, "Godot 场景脚本挂载", phases);
}

function createScriptWritePlan(params: AiChatParams, classification: GodotTaskClassification): WorkflowPlan {
	const scriptPath: string = classification.scriptPath ?? "scripts/generated.gd";
	const phases: WorkflowPhase[] = [
		createPhase("inspect", "确认脚本上下文", "read", TEXT_FILE_READ_TOOLS, `确认脚本 ${scriptPath} 的当前状态。`, ["已确认目标脚本状态。"]),
		createPhase(
			"write-script",
			"写入脚本",
			"write",
			["mcp_godot_read_text_file", ...SCRIPT_WRITE_TOOLS],
			[`实际创建或修改脚本 ${scriptPath}。`, "必须调用脚本写入工具并按审批流程暂停。"].join("\n"),
			[`脚本 ${scriptPath} 已由实际写入工具创建或更新。`]
		),
		createPhase("verify-script", "验证脚本", "verify", ["mcp_godot_lsp_get_file_diagnostics", "mcp_terminal_run_safe_preset"], `验证脚本 ${scriptPath}。`, ["脚本验证没有阻塞失败。"]),
		createPhase("summarize", "总结交付", "summarize", [], "总结完成内容和验证状态，不调用工具。", ["已总结交付。"])
	];
	return createPlan(params, "Godot 脚本写入", phases);
}

function createSceneCreatePlan(params: AiChatParams, classification: GodotTaskClassification): WorkflowPlan {
	const scenePath: string = classification.scenePath ?? "scenes/generated.tscn";
	const resourceScenePath: string = `res://${stripResourcePrefix(scenePath)}`;
	const phases: WorkflowPhase[] = [
		createPhase("inspect", "确认场景上下文", "read", SCENE_READ_TOOLS, `确认场景 ${scenePath} 的当前状态。`, ["已确认目标场景状态。"]),
		createPhase(
			"create-scene",
			"创建场景",
			"write",
			["mcp_godot_read_text_file", "mcp_godot_inspect_scene_tree", ...SCENE_CREATE_WRITE_TOOLS],
			[`实际创建场景 ${scenePath}。`, "必须调用 mcp_godot_create_scene 或 mcp_godot_create_text_file 并按审批流程暂停。"].join("\n"),
			[`场景 ${scenePath} 已由实际写入工具创建。`]
		),
		...(classification.setAsMain === true ? [
			createPhase(
				"set-main-scene",
				"设置启动场景",
				"write",
				PROJECT_SETTING_WRITE_TOOLS,
				`将 application/run/main_scene 设置为 ${resourceScenePath}。`,
				[`application/run/main_scene 已设置为 ${resourceScenePath}。`]
			)
		] : []),
		createPhase("verify-scene", "验证场景", "verify", ["mcp_godot_inspect_scene_tree", "mcp_godot_validate_scene_script_references"], `验证场景 ${scenePath}。`, ["场景验证没有阻塞失败。"]),
		createPhase("summarize", "总结交付", "summarize", [], "总结完成内容和验证状态，不调用工具。", ["已总结交付。"])
	];
	return createPlan(params, "Godot 场景创建", phases);
}

function createLocalGameCreatePlan(params: AiChatParams, classification: GodotTaskClassification): WorkflowPlan {
	const scriptPath: string = classification.scriptPath ?? "scripts/tic_tac_toe_game.gd";
	const scenePath: string = classification.scenePath ?? "scenes/tic_tac_toe_game.tscn";
	const resourceScriptPath: string = `res://${stripResourcePrefix(scriptPath)}`;
	const resourceScenePath: string = `res://${stripResourcePrefix(scenePath)}`;
	const phases: WorkflowPhase[] = [
		createPhase(
			"inspect-project",
			"确认项目结构",
			"read",
			["mcp_godot_get_project_summary", "mcp_godot_list_project_files", "mcp_godot_search_text"],
			[
				"确认当前 Godot 项目结构、已有脚本和场景命名，避免覆盖无关文件。",
				`重点检查 ${scriptPath} 和 ${scenePath} 是否已存在。`
			].join("\n"),
			["已确认项目结构和目标文件状态。"]
		),
		createPhase(
			"write-game-script",
			"写入游戏脚本",
			"write",
			SCRIPT_WRITE_TOOLS,
			[
				`实际创建或更新脚本 ${scriptPath}。`,
				"脚本必须实现完整本地井字棋：3x3 棋盘、X/O 轮流落子、胜负/平局判断、重开按钮、状态文本更新。",
				"使用 Godot 4 强类型 GDScript，避免推断赋值写法；不要依赖外部资源。",
				"本阶段只允许写入/预览写入脚本，不要先读取文件或解释计划。",
				"第一步必须调用脚本写入工具并按审批流程暂停；不要只输出文字意图。"
			].join("\n"),
			[`脚本 ${scriptPath} 已由实际写入工具创建或更新。`, "脚本包含完整本地井字棋交互逻辑。"]
		),
		createPhase(
			"write-game-scene",
			"写入游戏场景",
			"write",
			[...SCENE_CREATE_WRITE_TOOLS, ...SCENE_EDIT_WRITE_TOOLS],
			[
				`实际创建或更新场景 ${scenePath}，并引用脚本 ${resourceScriptPath}。`,
				"不要读取脚本，不要解释计划；直接创建场景或写入 .tscn。",
				"场景根节点使用 Control，包含标题/状态文本、3x3 按钮网格和重开按钮。",
				"节点命名固定为 StatusLabel、RestartButton、Btn00、Btn01、Btn02、Btn10、Btn11、Btn12、Btn20、Btn21、Btn22，以便脚本通过唯一名称访问。",
				"优先用 Godot 场景/文本文件工具创建可运行 .tscn；不要使用终端写命令绕过审批。",
				"第一步必须调用场景写入工具并按审批流程暂停；不要只输出文字意图。"
			].join("\n"),
			[`场景 ${scenePath} 已由实际写入工具创建或更新。`, `场景引用 ${resourceScriptPath}。`]
		),
		createPhase(
			"set-main-scene",
			"设置启动场景",
			"write",
			PROJECT_SETTING_WRITE_TOOLS,
			[
				`把 application/run/main_scene 设置为 ${resourceScenePath}。`,
				"必须通过 project setting 工具写入，不要手写 project.godot。",
				"本阶段只允许项目设置写入/预览写入，不要先读取 project.godot 或解释计划。",
				"第一步必须调用 project setting 写入工具并按审批流程暂停；不要只输出文字意图。"
			].join("\n"),
			[`项目启动场景已设置为 ${resourceScenePath}。`]
		),
		createPhase(
			"verify-game",
			"验证游戏资源",
			"verify",
			["mcp_godot_lsp_get_file_diagnostics", "mcp_godot_validate_scene_script_references", "mcp_godot_inspect_scene_tree", "mcp_terminal_run_safe_preset"],
			[
				`验证 ${scriptPath} 和 ${scenePath}。`,
				"必须调用脚本诊断或场景脚本引用验证工具；如可用，再运行 godot.check_only 针对 .gd 或 .tscn。",
				"验证失败时明确列出失败原因，不要进入总结。"
			].join("\n"),
			["脚本诊断和场景脚本引用验证没有阻塞失败。"]
		),
		createPhase(
			"summarize",
			"总结交付",
			"summarize",
			[],
			"只基于前面阶段的工具结果总结创建的脚本、场景、启动场景和验证状态。不要调用工具。",
			["所有前置阶段均完成，且没有未解决失败。"]
		)
	];
	return createPlan(params, "Godot 本地井字棋", phases);
}

function createProjectSettingPlan(params: AiChatParams): WorkflowPlan {
	const phases: WorkflowPhase[] = [
		createPhase("inspect-settings", "读取项目设置", "read", PROJECT_SETTING_READ_TOOLS, "读取当前 project.godot 相关设置。", ["已读取当前项目设置。"]),
		createPhase(
			"write-settings",
			"修改项目设置",
			"write",
			[...PROJECT_SETTING_READ_TOOLS, ...PROJECT_SETTING_WRITE_TOOLS],
			"先用 propose project setting 工具预览，再用 set/unset project setting 工具实际写入并走审批。不要手写 project.godot 文件。",
			["项目设置已通过 project setting 工具更新。"]
		),
		createPhase("verify-settings", "验证项目设置", "verify", [...PROJECT_SETTING_READ_TOOLS, "mcp_terminal_run_safe_preset"], "读取项目设置并运行可用安全验证。", ["项目设置验证没有阻塞失败。"]),
		createPhase("summarize", "总结交付", "summarize", [], "总结设置变更和验证状态，不调用工具。", ["已总结交付。"])
	];
	return createPlan(params, "Godot 项目设置修改", phases);
}

function createPlan(params: AiChatParams, fallbackTitle: string, phases: WorkflowPhase[]): WorkflowPlan {
	return {
		id: createWorkflowId(),
		title: createWorkflowTitle(params.message) || fallbackTitle,
		phases,
		todos: createVisibleWorkflowTodos(phases),
		source: "godot_template",
		revision: 0
	};
}

function createPhase(
	id: string,
	title: string,
	toolGroup: WorkflowPhase["toolGroup"],
	allowedTools: string[],
	instruction: string,
	acceptanceCriteria: string[]
): WorkflowPhase {
	return {
		id,
		title,
		toolGroup,
		skillId: toolGroup === "write" ? "file.creator" : undefined,
		promptId: toolGroup === "write" || toolGroup === "summarize" ? "godot.assistant" : undefined,
		toolBudget: toolGroup === "write" ? "project_edit" : (toolGroup === "summarize" ? "simple" : "normal"),
		allowedTools: [...allowedTools],
		requireToolCallOnFirstStep: toolGroup === "write" ? true : undefined,
		instruction,
		acceptanceCriteria,
		completionContract: createWorkflowCompletionContract(toolGroup, title, instruction, acceptanceCriteria)
	};
}

function narrowWriteToolsForText(text: string): string[] {
	const normalized: string = text.toLowerCase();
	const tools: string[] = [];
	const attachIntent: boolean = includesAny(normalized, ["attach", "挂载", "脚本引用"]);
	if (attachIntent) {
		tools.push("mcp_godot_inspect_scene_tree", "mcp_godot_read_text_file", ...SCENE_ATTACH_WRITE_TOOLS);
	}
	const explicitProjectSetting: boolean = includesAny(normalized, [
		"project.godot", "项目设置", "project setting", "projectsettings", "inputmap", "input map",
		"input action", "autoload", "display/window", "application/config", "application/run/main_scene",
		"run/main_scene", "main_scene"
	]);
	const setMainScene: boolean = includesAny(normalized, ["main scene", "主场景", "启动场景"])
		&& includesAny(normalized, ["set", "configure", "设置", "配置", "指定"]);
	if (explicitProjectSetting || setMainScene) {
		tools.push(...PROJECT_SETTING_READ_TOOLS, ...PROJECT_SETTING_WRITE_TOOLS);
	}
	const sceneAction: boolean = includesAny(normalized, [
		"create scene", "创建场景", "build scene", "edit scene",
		"创建主场景", "生成场景", "修改场景", "场景节点", "ui", "界面"
	]) || (
		!attachIntent
		&& includesAny(normalized, ["scene root", "根节点"])
	) || (
		normalized.includes(".tscn")
		&& !attachIntent
		&& includesAny(normalized, ["create", "build", "edit", "write", "生成", "创建", "搭建", "修改", "写入"])
	);
	if (sceneAction) {
		tools.push("mcp_godot_read_text_file", "mcp_godot_inspect_scene_tree", ...SCENE_CREATE_WRITE_TOOLS, ...SCENE_EDIT_WRITE_TOOLS);
	}
	if (!attachIntent && includesAny(normalized, [".gd", "script", "脚本", "gdscript"])) {
		tools.push("mcp_godot_read_text_file", ...SCRIPT_WRITE_TOOLS);
	}

	return [...new Set(tools)];
}

function findFirstPath(message: string, extension: ".gd" | ".tscn"): string | undefined {
	const pattern: RegExp = new RegExp(`(?:res://)?[A-Za-z0-9_./-]+\\${extension}`, "u");
	const match: RegExpMatchArray | null = message.match(pattern);
	return match?.[0] === undefined ? undefined : stripResourcePrefix(match[0]);
}

function extractFirstFencedBlock(message: string): string | undefined {
	const match: RegExpMatchArray | null = message.match(/```(?:[A-Za-z0-9_-]+)?\r?\n([\s\S]*?)```/u);
	const content: string | undefined = match?.[1];
	return content === undefined ? undefined : content.replace(/\r\n/g, "\n");
}

function inferNodePath(message: string): string {
	const rootHints: string[] = ["根节点", "root node", "node path \".\"", "node path '.'", "节点 ."];
	return includesAny(message.toLowerCase(), rootHints) ? "." : ".";
}

function stripResourcePrefix(value: string): string {
	return value.replace(/^res:\/\//u, "");
}

function includesAny(text: string, terms: readonly string[]): boolean {
	return terms.some((term: string): boolean => text.includes(term));
}

function wantsLocalGameCreation(text: string): boolean {
	return includesAny(text, [
		"井字棋",
		"tic tac toe",
		"tic-tac-toe",
		"tictactoe",
		"本地游戏",
		"小游戏",
		"五子棋",
		"gomoku",
		"贪吃蛇",
		"snake",
		"扫雷",
		"minesweeper",
		"2048",
		"game"
	]);
}

function isExplicitReadOnlyRequest(text: string): boolean {
	return includesAny(text, [
		"只读",
		"只看",
		"不要写入",
		"不要修改",
		"不要改",
		"不写入",
		"不修改",
		"禁止写入",
		"禁止修改",
		"无需写入",
		"无需修改",
		"read-only",
		"readonly",
		"do not write",
		"don't write",
		"no write",
		"do not modify",
		"don't modify",
		"no modify"
	]);
}

function wantsMutation(text: string): boolean {
	if (isExplicitReadOnlyRequest(text)) {
		return false;
	}

	return includesAny(text, [
		"创建",
		"新增",
		"生成",
		"修改",
		"改一下",
		"实现",
		"编写",
		"写入",
		"写一个",
		"写下",
		"挂载",
		"设置",
		"修复",
		"attach",
		"create",
		"edit",
		"modify",
		"update",
		"set",
		"unset",
		"write"
	]);
}
