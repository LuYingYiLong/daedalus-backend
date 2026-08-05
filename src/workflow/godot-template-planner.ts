import type { AiChatParams } from "../protocol/types.js";
import type { ExecutionTargetKind } from "./agent-run-state.js";
import { getExecutionPolicy } from "./router.js";
import type { WorkflowCompletionContract, WorkflowCompletionTarget, WorkflowPhase, WorkflowPlan } from "./types.js";
import { createWorkflowId, createWorkflowTitle, READ_TOOLS, VERIFY_TOOLS, WRITE_TOOLS } from "./planner.js";
import { createVisibleWorkflowTodos } from "./todos.js";

export type GodotTaskType = "script_create_or_edit" | "scene_create" | "scene_attach_script" | "project_setting_change" | "general_edit";

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

export type GodotTemplateTarget = {
	kind: ExecutionTargetKind;
	artifacts: readonly string[];
};

const TEXT_FILE_READ_TOOLS: string[] = [
	"mcp_godot_get_project_summary",
	"mcp_godot_search_documentation",
	"mcp_godot_list_project_files",
	"mcp_godot_read_text_file",
	"mcp_godot_search_text"
];

const SCENE_READ_TOOLS: string[] = [
	"mcp_image_inspect",
	"mcp_godot_search_documentation",
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

export function classifyGodotTask(target: GodotTemplateTarget | undefined, context?: GodotTemplateWorkflowContext | undefined): GodotTaskClassification {
	if (target === undefined || context?.isGodotProject !== true) return { type: "general_edit" };
	const scriptPath: string | undefined = target.artifacts.find((artifact: string): boolean => artifact.toLowerCase().endsWith(".gd"));
	const scenePath: string | undefined = target.artifacts.find((artifact: string): boolean => artifact.toLowerCase().endsWith(".tscn"));
	if (target.kind === "project_setting") return { type: "project_setting_change" };
	if (target.kind === "godot_script_scene" && scriptPath !== undefined && scenePath !== undefined) {
		return { type: "scene_attach_script", scriptPath, scenePath, nodePath: "." };
	}
	if (target.kind === "godot_scene" && scenePath !== undefined) return { type: "scene_create", scenePath };
	if (target.kind === "godot_script" && scriptPath !== undefined) return { type: "script_create_or_edit", scriptPath };
	return { type: "general_edit" };
}

export function createGodotTemplateWorkflowPlan(
	params: AiChatParams,
	target: GodotTemplateTarget | undefined,
	context?: GodotTemplateWorkflowContext | undefined
): WorkflowPlan | null {
	if (params.mode === "ask" || params.mode === "plan" || getExecutionPolicy(params) === "read_only") return null;
	const classification: GodotTaskClassification = classifyGodotTask(target, context);
	if (classification.type === "scene_attach_script" && classification.scriptPath !== undefined && classification.scenePath !== undefined) {
		return createScriptSceneAttachPlan(params, classification);
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
	return phase.toolGroup === "write" ? [...TEXT_FILE_READ_TOOLS, ...SCENE_READ_TOOLS, ...WRITE_TOOLS] : [];
}

export function getAllowedToolsForLlmPlannedStep(toolGroup: WorkflowPhase["toolGroup"], title: string, instruction: string): string[] {
	if (toolGroup === "write") {
		return [...TEXT_FILE_READ_TOOLS, ...SCENE_READ_TOOLS, ...WRITE_TOOLS];
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
		revision: 0,
		executionProfile: "godot"
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

function stripResourcePrefix(value: string): string {
	return value.replace(/^res:\/\//u, "");
}
