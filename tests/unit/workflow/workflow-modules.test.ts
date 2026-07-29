import assert from "node:assert/strict";
import test from "node:test";
import type { ToolEvent } from "../../../src/tools/tool-dispatcher.js";
import type { WorkflowPhase } from "../../../src/workflow/types.js";
import { createReadOnlyFactWorkflowPlan, isCurrentProjectFactRequest, planWorkflow, planWorkflowAfterLlmPlannerFailure } from "../../../src/workflow/planner.js";
import {
	classifyGodotTask,
	createGodotTemplateWorkflowPlan,
	createWorkflowCompletionContract,
	getAllowedToolsForLlmPlannedStep,
	narrowLlmPlannedWriteTools
} from "../../../src/workflow/godot-template-planner.js";
import {
	createEmptyWorkflowPhaseToolStats,
	createWorkflowWriteGuardRetryMessage,
	didWorkflowWritePhaseExecute,
	getWorkflowWriteGuardRetryAllowedTools,
	isWorkflowProposalPhase,
	updateWorkflowPhaseToolStats
} from "../../../src/server/workflow/tool-events.js";
import {
	mapWorkflowEventToAgentEvent
} from "../../../src/server/workflow/events.js";
import { isEmptyProviderResponseError } from "../../../src/server/workflow/provider-errors.js";

test("workflow tool stats track propose, write and approval events", (): void => {
	const stats = createEmptyWorkflowPhaseToolStats();
	const writePhase: WorkflowPhase = {
		id: "write",
		title: "实现功能",
		instruction: "写入文件",
		status: "pending",
		toolGroup: "write",
		toolBudget: "normal",
		allowedTools: []
	} as WorkflowPhase;

	updateWorkflowPhaseToolStats(stats, {
		type: "tool.call",
		toolName: "mcp_godot_propose_create_text_file"
	} as ToolEvent);
	updateWorkflowPhaseToolStats(stats, {
		type: "tool.call",
		toolName: "mcp_godot_create_text_file"
	} as ToolEvent);
	updateWorkflowPhaseToolStats(stats, {
		type: "tool.approval_required",
		toolName: "mcp_godot_create_text_file"
	} as ToolEvent);

	assert.equal(stats.toolEvents, 3);
	assert.equal(stats.proposeToolEvents, 1);
	assert.equal(stats.writeToolEvents, 2);
	assert.equal(stats.approvalEvents, 1);
	assert.equal(didWorkflowWritePhaseExecute(writePhase, stats), true);
});

test("workflow proposal phases satisfy write guard with propose tools", (): void => {
	const phase: WorkflowPhase = {
		id: "preview_patch",
		title: "预览修改方案",
		instruction: "生成 diff 预览",
		status: "pending",
		toolGroup: "write",
		toolBudget: "normal",
		allowedTools: []
	} as WorkflowPhase;
	const stats = createEmptyWorkflowPhaseToolStats();

	updateWorkflowPhaseToolStats(stats, {
		type: "tool.call",
		step: 0,
		toolCallId: "proposal-1",
		toolName: "mcp_godot_propose_replace_text_in_file"
	} as ToolEvent);
	updateWorkflowPhaseToolStats(stats, {
		type: "tool.result",
		step: 0,
		toolCallId: "proposal-1",
		toolName: "mcp_godot_propose_replace_text_in_file",
		resultChars: 120,
		truncated: false,
		ok: true,
		validationStatus: "passed",
		summary: "proposal valid"
	} as ToolEvent);

	assert.equal(isWorkflowProposalPhase(phase), true);
	assert.equal(didWorkflowWritePhaseExecute(phase, stats), true);
	const retryMessage: string = createWorkflowWriteGuardRetryMessage("阶段消息", ["mcp_godot_attach_script_to_node"], 2, "准备调用工具。");
	assert.match(retryMessage, /后端执行守卫/);
	assert.match(retryMessage, /mcp_godot_attach_script_to_node/);
	assert.match(retryMessage, /read\/verify 结果不能完成当前写入阶段/);
});

test("workflow write guard retry narrows allowed tools to mutation tools", (): void => {
	const phase: WorkflowPhase = {
		id: "attach-script",
		title: "将脚本挂载到场景",
		instruction: "挂载脚本",
		status: "pending",
		toolGroup: "write",
		toolBudget: "project_edit",
		allowedTools: [
			"mcp_godot_read_text_file",
			"mcp_godot_propose_attach_script_to_node",
			"mcp_godot_attach_script_to_node",
			"mcp_godot_validate_scene_script_references",
			"mcp_terminal_run_safe_preset",
			"mcp_terminal_run_write_preset"
		]
	} as WorkflowPhase;

	assert.deepEqual(getWorkflowWriteGuardRetryAllowedTools(phase), [
		"mcp_godot_propose_attach_script_to_node",
		"mcp_godot_attach_script_to_node"
	]);
	assert.match(createWorkflowWriteGuardRetryMessage("阶段消息"), /第一步必须发出 API tool_call/);
});

test("workflow phase runner recognizes provider empty response errors", (): void => {
	assert.equal(isEmptyProviderResponseError(new Error("LLM returned empty response")), true);
	assert.equal(isEmptyProviderResponseError(new Error("LLM returned empty choices")), false);
	assert.equal(isEmptyProviderResponseError("LLM returned empty response"), false);
});

test("workflow write guard rejects ordinary write phases that only proposed changes", (): void => {
	const phase: WorkflowPhase = {
		id: "attach-script",
		title: "将脚本挂载到场景",
		instruction: "实际挂载脚本",
		status: "pending",
		toolGroup: "write",
		toolBudget: "project_edit",
		allowedTools: []
	} as WorkflowPhase;
	const stats = createEmptyWorkflowPhaseToolStats();

	updateWorkflowPhaseToolStats(stats, {
		type: "tool.call",
		toolName: "mcp_godot_propose_attach_script_to_node"
	} as ToolEvent);

	assert.equal(didWorkflowWritePhaseExecute(phase, stats), false);
});

test("workflow write guard rejects failed write tool results", (): void => {
	const phase: WorkflowPhase = {
		id: "create-scene",
		title: "创建场景",
		instruction: "实际创建场景",
		status: "pending",
		toolGroup: "write",
		toolBudget: "project_edit",
		allowedTools: []
	} as WorkflowPhase;
	const stats = createEmptyWorkflowPhaseToolStats();

	updateWorkflowPhaseToolStats(stats, {
		type: "tool.call",
		step: 0,
		toolCallId: "create-scene-1",
		toolName: "mcp_godot_create_text_file",
		args: { relativePath: "scenes/tic_tac_toe.tscn" },
		serverId: "godot",
		serverName: "Godot",
		category: "write",
		title: "创建文件",
		summary: "scenes/tic_tac_toe.tscn",
		target: { kind: "file", path: "scenes/tic_tac_toe.tscn", label: "scenes/tic_tac_toe.tscn" }
	} as ToolEvent);
	updateWorkflowPhaseToolStats(stats, {
		type: "tool.result",
		step: 0,
		toolCallId: "create-scene-1",
		toolName: "mcp_godot_create_text_file",
		resultChars: 120,
		truncated: false,
		ok: false,
		validationStatus: "failed",
		summary: "mcp_godot_create_text_file failed: File already exists: scenes/tic_tac_toe.tscn",
		failedChecks: ["File already exists: scenes/tic_tac_toe.tscn"],
		artifactRefs: ["scenes/tic_tac_toe.tscn"]
	} as ToolEvent);

	assert.equal(stats.writeToolEvents, 1);
	assert.equal(stats.successfulWriteToolEvents, 0);
	assert.equal(didWorkflowWritePhaseExecute(phase, stats), false);
});

test("workflow write stats do not count safe terminal presets through write wrapper as mutations", (): void => {
	const phase: WorkflowPhase = {
		id: "write",
		title: "实现功能",
		instruction: "写入文件",
		status: "pending",
		toolGroup: "write",
		toolBudget: "project_edit",
		allowedTools: []
	} as WorkflowPhase;
	const stats = createEmptyWorkflowPhaseToolStats();

	updateWorkflowPhaseToolStats(stats, {
		type: "tool.call",
		step: 0,
		toolCallId: "call-check",
		toolName: "mcp_terminal_run_write_preset",
		args: { presetName: "godot.check_only", resourcePath: "scripts/game.gd" },
		serverId: "terminal",
		serverName: "Terminal",
		category: "terminal",
		title: "运行终端命令",
		summary: "godot.check_only scripts/game.gd",
		target: {
			kind: "command",
			path: "scripts/game.gd",
			label: "godot.check_only scripts/game.gd"
		}
	});

	assert.equal(stats.writeToolEvents, 0);
	assert.equal(didWorkflowWritePhaseExecute(phase, stats), false);
});

test("llm planner failure falls back to fixed multi-phase workflow for implementation requests", (): void => {
	const plan = planWorkflowAfterLlmPlannerFailure({
		message: "创建一个最小 Godot 场景并挂载脚本",
		mode: "agent",
		options: {
			workflow: "llm_planned"
		}
	});

	assert.notEqual(plan, null);
	assert.deepEqual(plan?.phases.map((phase: WorkflowPhase): WorkflowPhase["toolGroup"] => phase.toolGroup), [
		"read",
		"write",
		"verify",
		"summarize"
	]);
});

test("Godot task classifier detects script scene attachment tasks", (): void => {
	const classification = classifyGodotTask([
		"创建脚本 scripts/smoke.gd，内容如下：",
		"```gdscript",
		"extends Node",
		"```",
		"创建场景 scenes/smoke.tscn，并把 res://scripts/smoke.gd 挂载到根节点。"
	].join("\n"));

	assert.equal(classification.type, "scene_attach_script");
	assert.equal(classification.scriptPath, "scripts/smoke.gd");
	assert.equal(classification.scenePath, "scenes/smoke.tscn");
	assert.equal(classification.nodePath, ".");
	assert.equal(classification.scriptContent, "extends Node\n");
});

test("Godot task classifier does not upgrade explicit read-only script requests to write workflows", (): void => {
	assert.equal(classifyGodotTask("只读测试：读取 scripts/a.gd，不要写入").type, "general_edit");
	assert.equal(classifyGodotTask("解读 scripts/a.gd 的逻辑").type, "general_edit");
	assert.equal(classifyGodotTask("修改 scripts/a.gd 添加方法").type, "script_create_or_edit");
});

test("Godot task classifier only treats generic local game requests as Godot work inside a Godot project", (): void => {
	assert.equal(classifyGodotTask("帮我写一个本地井字棋").type, "general_edit");
	assert.equal(classifyGodotTask("帮我写一个本地井字棋", { isGodotProject: true }).type, "local_game_create");
	assert.equal(classifyGodotTask("只读：看看本地井字棋应该怎么设计，不要修改", { isGodotProject: true }).type, "general_edit");
});

test("Godot template workflow is disabled for ask and plan modes", (): void => {
	assert.equal(createGodotTemplateWorkflowPlan({
		message: "修改 scripts/a.gd 添加方法",
		mode: "ask",
		options: {
			workflow: "auto"
		}
	}), null);
	assert.equal(createGodotTemplateWorkflowPlan({
		message: "创建场景 scenes/a.tscn",
		mode: "plan",
		options: {
			workflow: "auto"
		}
	}), null);
});

test("fixed workflow planner does not upgrade explicit read-only requests to implementation", (): void => {
	assert.equal(planWorkflow({
		message: "只读测试：读取 scripts/tic_tac_toe_board.gd 并概括职责，不要写入，不要修改",
		mode: "agent",
		options: {
			workflow: "auto"
		}
	}), null);
});

test("fixed workflow planner routes explicit approval test requests to a write approval phase", (): void => {
	const plan = planWorkflow({
		message: "帮我随便拉起一个审批",
		mode: "agent",
		options: {
			workflow: "auto"
		}
	});

	assert.notEqual(plan, null);
	assert.equal(plan?.phases.length, 1);
	assert.equal(plan?.phases[0]?.toolGroup, "write");
	assert.equal(plan?.phases[0]?.requireToolCallOnFirstStep, true);
	assert.deepEqual(plan?.phases[0]?.allowedTools, ["mcp_godot_create_text_file"]);
	assert.match(plan?.phases[0]?.instruction ?? "", /approvalReason/u);
});

test("workflow todos omit the internal summary phase", (): void => {
	const plan = planWorkflow({
		message: "重构多个脚本并运行验证",
		mode: "agent",
		options: {
			workflow: "multi_phase"
		}
	});

	assert.notEqual(plan, null);
	assert.equal(plan?.phases.some((phase: WorkflowPhase): boolean => phase.toolGroup === "summarize"), true);
	assert.equal(plan?.todos.some((todo): boolean => (
		plan.phases.find((phase: WorkflowPhase): boolean => phase.id === todo.phaseId)?.toolGroup === "summarize"
	)), false);
	assert.equal(plan?.todos.some((todo): boolean => (
		plan.phases.find((phase: WorkflowPhase): boolean => phase.id === todo.phaseId)?.toolGroup === "read"
	)), false);
});

test("Ask current project fact requests use a read-only fact plan with required first tool call", (): void => {
	const plan = createReadOnlyFactWorkflowPlan({
		message: "项目里多少脚本并列出路径",
		mode: "ask"
	});

	assert.equal(isCurrentProjectFactRequest("项目里多少脚本并列出路径"), true);
	assert.deepEqual(plan.phases.map((phase: WorkflowPhase): WorkflowPhase["toolGroup"] => phase.toolGroup), [
		"read",
		"summarize"
	]);
	assert.equal(plan.phases[0]?.requireToolCallOnFirstStep, true);
	assert.equal(plan.todos.some((todo): boolean => todo.phaseId === plan.phases[0]?.id), true);
	assert.equal(plan.phases.some((phase: WorkflowPhase): boolean => phase.toolGroup === "write"), false);
	assert.equal(plan.phases.flatMap((phase: WorkflowPhase): string[] => phase.allowedTools).some((toolName: string): boolean => toolName.includes("create") || toolName.includes("overwrite") || toolName.includes("replace")), false);
});

test("Godot template workflow uses narrow phase tools for script scene attach", (): void => {
	const plan = createGodotTemplateWorkflowPlan({
		message: "创建脚本 scripts/smoke.gd，创建场景 scenes/smoke.tscn，并把脚本挂载到根节点。",
		options: {
			workflow: "auto"
		}
	});

	assert.equal(plan?.source, "godot_template");
	assert.deepEqual(plan?.phases.map((phase: WorkflowPhase): string => phase.id), [
		"inspect",
		"write-script",
		"create-scene",
		"attach-script",
		"validate-scene-references",
		"summarize"
	]);
	const attachPhase = plan?.phases.find((phase: WorkflowPhase): boolean => phase.id === "attach-script");
	assert.ok(attachPhase !== undefined);
	assert.equal(attachPhase.allowedTools.includes("mcp_godot_attach_script_to_node"), true);
	assert.equal(attachPhase.allowedTools.includes("mcp_godot_apply_scene_patch"), true);
	assert.equal(attachPhase.allowedTools.includes("mcp_godot_create_text_file"), false);
	assert.equal(attachPhase.allowedTools.includes("mcp_terminal_run_write_preset"), false);
});

test("Godot template workflow creates a narrow local tic tac toe plan in Godot projects", (): void => {
	const plan = createGodotTemplateWorkflowPlan({
		message: "帮我写一个本地井字棋",
		mode: "agent",
		options: {
			workflow: "auto"
		}
	}, { isGodotProject: true });

	assert.equal(plan?.source, "godot_template");
	assert.deepEqual(plan?.phases.map((phase: WorkflowPhase): string => phase.id), [
		"inspect-project",
		"write-game-script",
		"write-game-scene",
		"set-main-scene",
		"verify-game",
		"summarize"
	]);
	assert.equal(plan?.phases.find((phase: WorkflowPhase): boolean => phase.id === "inspect-project")?.requireToolCallOnFirstStep, undefined);
	assert.equal(plan?.phases.find((phase: WorkflowPhase): boolean => phase.id === "write-game-script")?.requireToolCallOnFirstStep, true);
	assert.equal(plan?.phases.find((phase: WorkflowPhase): boolean => phase.id === "verify-game")?.requireToolCallOnFirstStep, undefined);
	assert.equal(plan?.phases.find((phase: WorkflowPhase): boolean => phase.id === "summarize")?.requireToolCallOnFirstStep, undefined);
	const scriptPhase = plan?.phases.find((phase: WorkflowPhase): boolean => phase.id === "write-game-script");
	const scenePhase = plan?.phases.find((phase: WorkflowPhase): boolean => phase.id === "write-game-scene");
	const settingPhase = plan?.phases.find((phase: WorkflowPhase): boolean => phase.id === "set-main-scene");
	assert.equal(scriptPhase?.allowedTools.includes("mcp_godot_read_text_file"), false);
	assert.equal(scriptPhase?.allowedTools.includes("mcp_godot_create_text_file"), true);
	assert.equal(scriptPhase?.allowedTools.includes("mcp_terminal_run_write_preset"), false);
	assert.equal(scenePhase?.allowedTools.includes("mcp_godot_read_text_file"), false);
	assert.equal(scenePhase?.allowedTools.includes("mcp_godot_inspect_scene_tree"), false);
	assert.equal(scenePhase?.allowedTools.includes("mcp_godot_create_text_file"), true);
	assert.equal(scenePhase?.allowedTools.includes("mcp_godot_apply_scene_patch"), true);
	assert.equal(settingPhase?.allowedTools.includes("mcp_godot_get_project_settings"), false);
	assert.equal(settingPhase?.allowedTools.includes("mcp_godot_set_project_setting"), true);
	assert.equal(settingPhase?.allowedTools.includes("mcp_godot_apply_scene_patch"), false);
});

test("LLM planned write tools are narrowed by phase semantics", (): void => {
	const readTools = getAllowedToolsForLlmPlannedStep(
		"read",
		"读取当前项目文件列表",
		"读取项目中的脚本和场景文件。"
	);
	assert.equal(readTools.includes("mcp_godot_list_project_files"), true);

	const attachTools = getAllowedToolsForLlmPlannedStep(
		"write",
		"Attach script to root",
		"Attach res://scripts/smoke.gd to scenes/smoke.tscn root node"
	);
	assert.equal(attachTools.includes("mcp_godot_attach_script_to_node"), true);
	assert.equal(attachTools.includes("mcp_godot_create_text_file"), false);
	assert.equal(attachTools.includes("mcp_terminal_run_write_preset"), false);

	const sceneTools = narrowLlmPlannedWriteTools({
		title: "创建场景",
		instruction: "创建场景 scenes/smoke.tscn，根节点 Node",
		toolGroup: "write"
	});
	assert.equal(sceneTools.includes("mcp_godot_create_scene"), true);
	assert.equal(sceneTools.includes("mcp_godot_overwrite_text_file"), true);
	assert.equal(sceneTools.includes("mcp_godot_apply_scene_patch"), true);
	assert.equal(sceneTools.includes("mcp_godot_attach_script_to_node"), false);

	const uiTools = getAllowedToolsForLlmPlannedStep(
		"write",
		"Build scene UI",
		"Build the tic tac toe UI in scenes/tic_tac_toe.tscn with buttons and labels"
	);
	assert.equal(uiTools.includes("mcp_godot_apply_scene_patch"), true);
	assert.equal(uiTools.includes("mcp_godot_overwrite_text_file"), true);

	const mainSceneTools = getAllowedToolsForLlmPlannedStep(
		"write",
		"Set main scene",
		"Set application/run/main_scene to res://scenes/tic_tac_toe.tscn"
	);
	assert.equal(mainSceneTools.includes("mcp_godot_set_project_setting"), true);
	assert.equal(mainSceneTools.includes("mcp_godot_apply_scene_patch"), false);
});

test("main scene workflow intent keeps scene creation and project settings distinct", (): void => {
	const createTools = getAllowedToolsForLlmPlannedStep(
		"write",
		"Create main scene",
		"Create scenes/Main.tscn with a Node root."
	);
	assert.equal(createTools.includes("mcp_godot_create_scene"), true);
	assert.equal(createTools.includes("mcp_godot_set_project_setting"), false);

	const settingTools = getAllowedToolsForLlmPlannedStep(
		"write",
		"Set main scene",
		"Set application/run/main_scene to res://scenes/Main.tscn."
	);
	assert.equal(settingTools.includes("mcp_godot_create_scene"), false);
	assert.equal(settingTools.includes("mcp_godot_set_project_setting"), true);

	const mixedTools = getAllowedToolsForLlmPlannedStep(
		"write",
		"Create and configure main scene",
		"Create scenes/Main.tscn, then set application/run/main_scene to res://scenes/Main.tscn."
	);
	assert.equal(mixedTools.includes("mcp_godot_create_scene"), true);
	assert.equal(mixedTools.includes("mcp_godot_set_project_setting"), true);

	assert.deepEqual(
		createWorkflowCompletionContract(
			"write",
			"Set main scene",
			"Set application/run/main_scene to res://scenes/Main.tscn."
		)?.targets,
		[{ kind: "project_setting", key: "application/run/main_scene" }]
	);
	assert.deepEqual(
		createWorkflowCompletionContract(
			"write",
			"Create and configure main scene",
			"Create scenes/Main.tscn, then set application/run/main_scene to res://scenes/Main.tscn."
		)?.targets,
		[
			{ kind: "artifact", path: "scenes/Main.tscn" },
			{ kind: "project_setting", key: "application/run/main_scene" }
		]
	);
});

test("Godot template distinguishes setting an existing main scene from creating and setting one", (): void => {
	assert.equal(
		classifyGodotTask("Set application/run/main_scene to res://scenes/Main.tscn", { isGodotProject: true }).type,
		"project_setting_change"
	);
	const mixedClassification = classifyGodotTask(
		"Create scene res://scenes/Main.tscn and set it as the main scene.",
		{ isGodotProject: true }
	);
	assert.equal(mixedClassification.type, "scene_create");
	assert.equal(mixedClassification.setAsMain, true);

	const plan = createGodotTemplateWorkflowPlan({
		message: "Create scene res://scenes/Main.tscn and set it as the main scene.",
		mode: "agent"
	}, { isGodotProject: true });
	assert.deepEqual(
		plan?.phases.filter((phase: WorkflowPhase): boolean => phase.toolGroup === "write").map((phase: WorkflowPhase): string => phase.id),
		["create-scene", "set-main-scene"]
	);
	assert.deepEqual(
		plan?.phases.find((phase: WorkflowPhase): boolean => phase.id === "create-scene")?.completionContract?.targets,
		[{ kind: "artifact", path: "scenes/Main.tscn" }]
	);
	assert.deepEqual(
		plan?.phases.find((phase: WorkflowPhase): boolean => phase.id === "set-main-scene")?.completionContract?.targets,
		[{ kind: "project_setting", key: "application/run/main_scene" }]
	);
});

test("workflow events map to agent event compatibility surface", (): void => {
	assert.deepEqual(mapWorkflowEventToAgentEvent("workflow.phase.started", {
		workflowId: "workflow-1",
		phaseId: "phase-1",
		phaseRunId: "run-1",
		title: "读取项目",
		toolGroup: "read",
		acceptanceCriteria: ["完成读取"]
	}), {
		eventName: "agent.step.started",
		data: {
			runId: "workflow-1",
			stepId: "phase-1",
			stepRunId: "run-1",
			title: "读取项目",
			toolGroup: "read",
			acceptanceCriteria: ["完成读取"],
			repairOf: undefined,
			repairRound: undefined
		}
	});

	assert.equal(mapWorkflowEventToAgentEvent("workflow.phase.done", {
		workflowId: "workflow-1"
	}), null);
});
