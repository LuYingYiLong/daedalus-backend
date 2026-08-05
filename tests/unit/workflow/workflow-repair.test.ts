import assert from "node:assert/strict";
import test from "node:test";
import { countWorkflowAutoRepairRounds, insertWorkflowAutoRepairPhases, resolveRepairWriteTools } from "../../../src/workflow/repair.js";
import type { WorkflowFailedCheck, WorkflowPhase, WorkflowPlan, WorkflowTodoItem } from "../../../src/workflow/types.js";

function createPhase(id: string, title: string, toolGroup: WorkflowPhase["toolGroup"]): WorkflowPhase {
	return {
		id,
		title,
		toolGroup,
		toolBudget: toolGroup === "write" ? "project_edit" : "normal",
		allowedTools: [],
		instruction: title
	};
}

function createTodo(phase: WorkflowPhase, status: WorkflowTodoItem["status"] = "pending"): WorkflowTodoItem {
	return {
		id: `${phase.id}-todo`,
		phaseId: phase.id,
		text: phase.title,
		status
	};
}

test("workflow auto repair insertion preserves current todos and adds repair plus reverify", (): void => {
	const inspect: WorkflowPhase = createPhase("inspect", "理解上下文", "read");
	const implement: WorkflowPhase = {
		...createPhase("implement", "实现修改", "write"),
		allowedTools: ["mcp_godot_replace_text_in_file", "mcp_godot_apply_scene_patch"]
	};
	const verify: WorkflowPhase = createPhase("verify", "运行验证", "verify");
	const summarize: WorkflowPhase = createPhase("summarize", "总结交付", "summarize");
	const plan: WorkflowPlan = {
		id: "workflow-test",
		title: "测试 workflow 修复",
		source: "fixed",
		revision: 0,
		phases: [inspect, implement, verify, summarize],
		todos: [
			createTodo(inspect, "done"),
			createTodo(implement, "done"),
			createTodo(verify, "failed"),
			createTodo(summarize)
		]
	};

	const repairedPlan: WorkflowPlan = insertWorkflowAutoRepairPhases(
		plan,
		3,
		verify,
		"`%TitleLabel` 未设置 unique name，需要修复脚本。",
		[{ code: "script_invalid", message: "脚本检查失败。", artifact: "scripts/game.gd" }]
	);

	assert.deepEqual(
		repairedPlan.phases.map((phase: WorkflowPhase): string => phase.id),
		["inspect", "implement", "verify", "auto-repair-1", "auto-verify-1", "summarize"]
	);
	assert.equal(repairedPlan.todos.find((todo: WorkflowTodoItem): boolean => todo.phaseId === "verify")?.status, "failed");
	assert.equal(repairedPlan.todos.find((todo: WorkflowTodoItem): boolean => todo.phaseId === "auto-repair-1")?.status, "pending");
	assert.equal(repairedPlan.phases[3]?.toolGroup, "write");
	assert.equal(repairedPlan.phases[4]?.toolGroup, "verify");
	assert.ok(repairedPlan.phases[3]?.allowedTools.includes("mcp_godot_replace_text_in_file"));
	assert.equal(repairedPlan.phases[3]?.allowedTools.includes("mcp_godot_apply_scene_patch"), false);
	assert.ok(!repairedPlan.phases[3]?.allowedTools.includes("mcp_terminal_run_write_preset"));
	assert.ok(!repairedPlan.phases[3]?.allowedTools.includes("mcp_godot_propose_replace_text_in_file"));
	assert.match(repairedPlan.phases[3]?.instruction ?? "", /第一步必须调用/);
	assert.ok(repairedPlan.phases[4]?.allowedTools.includes("mcp_terminal_run_safe_preset"));
	assert.equal(countWorkflowAutoRepairRounds(repairedPlan), 1);
	assert.equal(repairedPlan.revision, 1);
});

test("workspace repairs inherit the generic execution profile", (): void => {
	const write: WorkflowPhase = {
		...createPhase("write", "Update workspace file", "write"),
		allowedTools: ["mcp_workspace_write_text_file"]
	};
	const verify: WorkflowPhase = createPhase("verify", "Verify workspace file", "verify");
	const plan: WorkflowPlan = {
		id: "workspace-repair",
		title: "Workspace repair",
		source: "fixed",
		executionProfile: "workspace",
		phases: [write, verify],
		todos: [createTodo(write, "done"), createTodo(verify, "failed")]
	};
	const repairedPlan: WorkflowPlan = insertWorkflowAutoRepairPhases(
		plan,
		2,
		verify,
		"Verification failed",
		[{ code: "target_readback_failed", message: "Readback failed", artifact: "src/service.ts" }],
		["mcp_workspace_write_text_file"]
	);
	const repair: WorkflowPhase | undefined = repairedPlan.phases.find((phase: WorkflowPhase): boolean => phase.repairOf === "verify");
	assert.equal(repair?.promptId, "workspace.assistant");
	assert.equal(repair?.skillId, undefined);
});

test("workflow repair permits two actual rounds and preserves missing target contracts", (): void => {
	const write: WorkflowPhase = {
		...createPhase("create-main", "Create main scene", "write"),
		allowedTools: ["mcp_godot_create_scene"],
		completionContract: {
			targets: [{ kind: "artifact", path: "scenes/Main.tscn" }],
			requireAll: true
		}
	};
	const summarize: WorkflowPhase = createPhase("summarize", "Summarize", "summarize");
	const plan: WorkflowPlan = {
		id: "workflow-target-repair",
		title: "Create Main.tscn",
		source: "llm",
		revision: 0,
		phases: [write, summarize],
		todos: [createTodo(write, "failed"), createTodo(summarize)]
	};
	const failedChecks: WorkflowFailedCheck[] = [{
		code: "target_artifact_missing",
		message: "The target scene was not created.",
		artifact: "scenes/Main.tscn"
	}];

	const firstRepair = insertWorkflowAutoRepairPhases(plan, 1, write, "Missing Main.tscn", failedChecks);
	const firstRepairPhase = firstRepair.phases.find((phase: WorkflowPhase): boolean => phase.id === "auto-repair-1");
	assert.equal(countWorkflowAutoRepairRounds(firstRepair), 1);
	assert.equal(firstRepairPhase?.allowedTools.includes("mcp_godot_create_scene"), true);
	assert.deepEqual(firstRepairPhase?.completionContract, {
		targets: [{ kind: "artifact", path: "scenes/Main.tscn" }],
		requireAll: true
	});

	const secondRepair = insertWorkflowAutoRepairPhases(
		firstRepair,
		firstRepair.phases.length - 1,
		firstRepairPhase!,
		"Main.tscn is still missing",
		failedChecks
	);
	assert.equal(countWorkflowAutoRepairRounds(secondRepair), 2);
	assert.equal(secondRepair.phases.some((phase: WorkflowPhase): boolean => phase.id === "auto-repair-2"), true);
});

test("workflow verification-only failures add reverify without write repair", (): void => {
	const inspect: WorkflowPhase = createPhase("inspect", "理解上下文", "read");
	const implement: WorkflowPhase = createPhase("implement", "实现修改", "write");
	const verify: WorkflowPhase = createPhase("verify", "运行验证", "verify");
	const summarize: WorkflowPhase = createPhase("summarize", "总结交付", "summarize");
	const plan: WorkflowPlan = {
		id: "workflow-test",
		title: "测试 workflow 补验",
		source: "godot_template",
		revision: 0,
		phases: [inspect, implement, verify, summarize],
		todos: [
			createTodo(inspect, "done"),
			createTodo(implement, "done"),
			createTodo(verify, "failed"),
			createTodo(summarize)
		]
	};
	const failedChecks: WorkflowFailedCheck[] = [
		{
			code: "godot_check_only_required",
			message: "修改了 GDScript，但验证阶段没有运行 Godot check-only。",
			artifact: "scripts/game.gd"
		}
	];

	const repairedPlan: WorkflowPlan = insertWorkflowAutoRepairPhases(
		plan,
		3,
		verify,
		"修改了 GDScript，但验证阶段没有运行 Godot check-only。",
		failedChecks
	);

	assert.deepEqual(
		repairedPlan.phases.map((phase: WorkflowPhase): string => phase.id),
		["inspect", "implement", "verify", "auto-verify-1", "summarize"]
	);
	assert.equal(repairedPlan.phases[3]?.toolGroup, "verify");
	assert.equal(repairedPlan.phases[3]?.skillId, undefined);
	assert.ok(repairedPlan.phases[3]?.allowedTools.includes("mcp_terminal_run_safe_preset"));
	assert.ok(!repairedPlan.phases[3]?.allowedTools.includes("mcp_godot_overwrite_text_file"));
	assert.match(repairedPlan.phases[3]?.instruction ?? "", /不能修改项目文件/);
	assert.equal(repairedPlan.revision, 1);
});

test("workflow auto repair narrows scene failures to scene write tools", (): void => {
	const write: WorkflowPhase = {
		...createPhase("write-scene", "写入场景", "write"),
		allowedTools: ["mcp_godot_attach_script_to_node", "mcp_godot_apply_scene_patch", "mcp_godot_overwrite_text_file"]
	};
	const verify: WorkflowPhase = createPhase("verify-scene", "验证场景引用", "verify");
	const summarize: WorkflowPhase = createPhase("summarize", "总结交付", "summarize");
	const plan: WorkflowPlan = {
		id: "workflow-scene-repair",
		title: "测试场景修复",
		source: "godot_template",
		revision: 0,
		phases: [write, verify, summarize],
		todos: [createTodo(write, "done"), createTodo(verify, "failed"), createTodo(summarize)]
	};
	const failedChecks: WorkflowFailedCheck[] = [
		{
			code: "scene_reference_invalid",
			message: "scenes/main.tscn 的 script reference 缺失，需要重新挂载脚本。",
			artifact: "scenes/main.tscn"
		}
	];

	const repairedPlan: WorkflowPlan = insertWorkflowAutoRepairPhases(
		plan,
		2,
		verify,
		"scenes/main.tscn 的 script reference 缺失，需要重新挂载脚本。",
		failedChecks
	);
	const repairPhase: WorkflowPhase | undefined = repairedPlan.phases[2];

	assert.equal(repairPhase?.toolGroup, "write");
	assert.equal(repairPhase?.allowedTools.includes("mcp_godot_attach_script_to_node"), true);
	assert.equal(repairPhase?.allowedTools.includes("mcp_godot_apply_scene_patch"), true);
	assert.equal(repairPhase?.allowedTools.includes("mcp_godot_overwrite_text_file"), false);
	assert.match(repairPhase?.instruction ?? "", /mcp_godot_attach_script_to_node/);
});

test("workflow auto repair narrows project setting failures to setting write tools", (): void => {
	const write: WorkflowPhase = {
		...createPhase("write-settings", "写入项目设置", "write"),
		allowedTools: ["mcp_godot_set_project_setting", "mcp_godot_unset_project_setting", "mcp_godot_apply_scene_patch"]
	};
	const verify: WorkflowPhase = createPhase("verify-settings", "验证项目设置", "verify");
	const summarize: WorkflowPhase = createPhase("summarize", "总结交付", "summarize");
	const plan: WorkflowPlan = {
		id: "workflow-settings-repair",
		title: "测试项目设置修复",
		source: "godot_template",
		revision: 0,
		phases: [write, verify, summarize],
		todos: [createTodo(write, "done"), createTodo(verify, "failed"), createTodo(summarize)]
	};
	const failedChecks: WorkflowFailedCheck[] = [
		{
			code: "project_setting_mismatch",
			message: "project.godot 中 application/config/name 仍为旧值。",
			artifact: "project.godot"
		}
	];

	const repairedPlan: WorkflowPlan = insertWorkflowAutoRepairPhases(
		plan,
		2,
		verify,
		"project.godot 中 application/config/name 仍为旧值。",
		failedChecks
	);
	const repairPhase: WorkflowPhase | undefined = repairedPlan.phases[2];

	assert.equal(repairPhase?.toolGroup, "write");
	assert.equal(repairPhase?.allowedTools.includes("mcp_godot_set_project_setting"), true);
	assert.equal(repairPhase?.allowedTools.includes("mcp_godot_unset_project_setting"), true);
	assert.equal(repairPhase?.allowedTools.includes("mcp_godot_apply_scene_patch"), false);
	assert.equal(repairPhase?.allowedTools.includes("mcp_godot_replace_text_in_file"), false);
	assert.match(repairPhase?.instruction ?? "", /mcp_godot_set_project_setting/);
});

test("unknown repair targets block automatic write repair", (): void => {
	const verify: WorkflowPhase = createPhase("verify", "验证", "verify");
	const plan: WorkflowPlan = {
		id: "workflow-unknown-repair",
		title: "Unknown repair",
		phases: [verify],
		todos: [createTodo(verify, "failed")]
	};
	const resolution = resolveRepairWriteTools(plan, 1, verify, [{
		code: "unknown_target",
		message: "The repair target cannot be identified."
	}]);

	assert.deepEqual(resolution.tools, []);
	assert.match(resolution.reason, /No prior write phase/u);

	const priorWrite: WorkflowPhase = {
		...createPhase("write", "写入", "write"),
		allowedTools: ["mcp_workspace_replace_text_in_file"]
	};
	const withPriorWrite: WorkflowPlan = { ...plan, phases: [priorWrite, verify] };
	const unresolved = resolveRepairWriteTools(withPriorWrite, 2, verify, [{
		code: "unknown_target",
		message: "The repair target cannot be identified."
	}]);
	assert.deepEqual(unresolved.tools, []);
	assert.match(unresolved.reason, /no structured artifact/u);
});
