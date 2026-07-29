import { READ_TOOLS, VERIFY_TOOLS, WRITE_TOOLS } from "./planner.js";
import { getToolPolicy } from "../tools/tool-policy.js";
import type {
	WorkflowCompletionContract,
	WorkflowCompletionTarget,
	WorkflowFailedCheck,
	WorkflowPhase,
	WorkflowPlan,
	WorkflowTodoItem
} from "./types.js";
import { createVisibleWorkflowTodos } from "./todos.js";

const AUTO_REPAIR_ID_PREFIX: string = "auto-repair-";
const AUTO_VERIFY_ID_PREFIX: string = "auto-verify-";
const REPAIR_READ_TOOLS: string[] = [
	"mcp_workspace_list_files",
	"mcp_workspace_read_text_file",
	"mcp_workspace_search_text",
	"mcp_godot_get_project_summary",
	"mcp_godot_list_project_files",
	"mcp_godot_list_scenes",
	"mcp_godot_list_scripts",
	"mcp_godot_read_text_file",
	"mcp_godot_search_text",
	"mcp_godot_inspect_scene_tree",
	"mcp_godot_get_project_settings",
	"mcp_godot_get_input_actions",
	"mcp_godot_get_autoloads",
	"mcp_godot_analyze_project_dependencies",
	"mcp_godot_find_scene_nodes",
	"mcp_godot_find_script_references",
	"mcp_godot_lsp_get_status",
	"mcp_godot_lsp_get_file_diagnostics"
];
const WORKSPACE_REPAIR_WRITE_TOOLS: string[] = [
	"mcp_workspace_create_text_file",
	"mcp_workspace_overwrite_text_file",
	"mcp_workspace_replace_text_in_file",
	"mcp_workspace_replace_line_in_file"
];
const SCRIPT_REPAIR_WRITE_TOOLS: string[] = [
	"mcp_godot_create_text_file",
	"mcp_godot_overwrite_text_file",
	"mcp_godot_replace_text_in_file"
];
const SCENE_REPAIR_WRITE_TOOLS: string[] = [
	"mcp_godot_create_scene",
	"mcp_godot_add_node_to_scene",
	"mcp_godot_attach_script_to_node",
	"mcp_godot_connect_signal_in_scene",
	"mcp_godot_apply_scene_patch",
	"mcp_godot_editor_apply_scene_patch"
];
const PROJECT_SETTING_REPAIR_WRITE_TOOLS: string[] = [
	"mcp_godot_set_project_setting",
	"mcp_godot_unset_project_setting",
	"mcp_godot_set_input_action",
	"mcp_godot_unset_input_action",
	"mcp_godot_set_autoload",
	"mcp_godot_unset_autoload"
];

function isWriteGuardFailure(failedPhase: WorkflowPhase, failedChecks: WorkflowFailedCheck[]): boolean {
	return failedPhase.toolGroup === "write" && failedChecks.some((check: WorkflowFailedCheck): boolean => check.code === "write_tool_missing");
}

export function countWorkflowAutoRepairRounds(plan: WorkflowPlan): number {
	return plan.phases.reduce((highestRound: number, phase: WorkflowPhase): number => (
		Math.max(highestRound, phase.repairRound ?? 0)
	), 0);
}

function createUniquePhaseId(plan: WorkflowPlan, prefix: string, round: number): string {
	const existingIds: Set<string> = new Set(plan.phases.map((phase: WorkflowPhase): string => phase.id));
	let phaseId: string = `${prefix}${round}`;
	let suffix: number = 2;
	while (existingIds.has(phaseId)) {
		phaseId = `${prefix}${round}-${suffix}`;
		suffix += 1;
	}

	return phaseId;
}

function rebuildTodosForPhases(plan: WorkflowPlan, phases: WorkflowPhase[]): WorkflowTodoItem[] {
	const existingTodos: Map<string, WorkflowTodoItem> = new Map(
		plan.todos.map((todo: WorkflowTodoItem): [string, WorkflowTodoItem] => [todo.phaseId, todo])
	);

	return createVisibleWorkflowTodos(phases)
		.map((todo: WorkflowTodoItem): WorkflowTodoItem => existingTodos.get(todo.phaseId) ?? todo);
}

function shouldUseVerifyOnlyRepair(failedChecks: WorkflowFailedCheck[]): boolean {
	if (failedChecks.length === 0) {
		return false;
	}

	const verifyOnlyCodes: Set<string> = new Set([
		"lsp_diagnostics_required",
		"godot_check_only_required",
		"scene_validation_required",
		"verify_tool_missing",
		"validation_environment_unavailable"
	]);
	return failedChecks.every((check: WorkflowFailedCheck): boolean => verifyOnlyCodes.has(check.code));
}

function uniqueTools(tools: readonly string[]): string[] {
	const result: string[] = [];
	const seen: Set<string> = new Set();
	for (const toolName of tools) {
		if (seen.has(toolName)) {
			continue;
		}
		seen.add(toolName);
		result.push(toolName);
	}

	return result;
}

function collectRepairEvidence(
	failedPhase: WorkflowPhase,
	verifyFailureReason: string,
	failedChecks: WorkflowFailedCheck[]
): string {
	const parts: string[] = [
		failedPhase.id,
		failedPhase.title,
		failedPhase.instruction,
		verifyFailureReason
	];
	for (const check of failedChecks) {
		parts.push(check.code);
		parts.push(check.message);
		if (check.artifact !== undefined) {
			parts.push(check.artifact);
		}
	}

	return parts.join("\n").toLowerCase();
}

function collectActualWriteToolsFromPhase(failedPhase: WorkflowPhase): string[] {
	return failedPhase.allowedTools.filter((toolName: string): boolean => {
		if (toolName.startsWith("mcp_terminal_")) {
			return false;
		}
		const risk: string | undefined = getToolPolicy(toolName)?.risk;
		return risk === "write" || risk === "destructive";
	});
}

function hasAny(text: string, terms: readonly string[]): boolean {
	return terms.some((term: string): boolean => text.includes(term));
}

function inferRepairWriteTools(
	failedPhase: WorkflowPhase,
	verifyFailureReason: string,
	failedChecks: WorkflowFailedCheck[]
): string[] {
	const evidence: string = collectRepairEvidence(failedPhase, verifyFailureReason, failedChecks);
	const tools: string[] = [];

	if (hasAny(evidence, [
		".gitignore",
		".md",
		".json",
		".jsonc",
		".yaml",
		".yml",
		".toml",
		".env",
		"markdown",
		"gitignore"
	])) {
		tools.push(...WORKSPACE_REPAIR_WRITE_TOOLS);
	}

	if (hasAny(evidence, [
		".ts",
		".tsx",
		".js",
		".jsx",
		"typescript",
		"javascript",
		"electron",
		"renderer",
		"preload",
		"frontend",
		"front-end",
		"前端",
		"渲染进程"
	])) {
		tools.push(...WORKSPACE_REPAIR_WRITE_TOOLS);
	}

	if (hasAny(evidence, [
		"project.godot",
		"project setting",
		"project_settings",
		"项目设置",
		"application/config",
		"display/window",
		"input/",
		"autoload"
	])) {
		tools.push(...PROJECT_SETTING_REPAIR_WRITE_TOOLS);
	}

	if (hasAny(evidence, [
		".tscn",
		"scene",
		"node",
		"script reference",
		"attach",
		"signal",
		"场景",
		"节点",
		"脚本引用",
		"挂载",
		"信号"
	])) {
		tools.push(...SCENE_REPAIR_WRITE_TOOLS);
	}

	if (hasAny(evidence, [
		".gd",
		"gdscript",
		"diagnostic",
		"parse error",
		"type error",
		"script or scene",
		"脚本或场景",
		"语法",
		"诊断",
		"类型"
	])) {
		tools.push(...SCRIPT_REPAIR_WRITE_TOOLS);
	}

	if (tools.length === 0) {
		const phaseWriteTools: string[] = collectActualWriteToolsFromPhase(failedPhase);
		if (phaseWriteTools.length > 0) {
			return uniqueTools(phaseWriteTools);
		}

		return WRITE_TOOLS.filter((toolName: string): boolean => !toolName.includes("_propose_") && toolName !== "mcp_terminal_run_write_preset");
	}

	return uniqueTools(tools);
}

function createRepairInstruction(
	failedPhase: WorkflowPhase,
	verifyFailureReason: string,
	repairWriteTools: string[],
	failedChecks: WorkflowFailedCheck[]
): string {
	const failureDetails: string = uniqueTools([
		verifyFailureReason,
		...failedChecks.map((check: WorkflowFailedCheck): string => {
			const prefix: string = check.toolName !== undefined ? `${check.toolName}: ` : "";
			const artifact: string = check.artifact !== undefined ? `（${check.artifact}）` : "";
			return `${prefix}${check.message}${artifact}`;
		})
	].filter((item: string): boolean => item.length > 0)).join("\n");
	const isWriteRetry: boolean = failedPhase.toolGroup === "write" && (
		verifyFailureReason.includes("没有实际调用写入工具")
		|| verifyFailureReason.includes("oldText not found")
		|| failedChecks.some((check: WorkflowFailedCheck): boolean => check.code === "write_tool_missing")
	);
	if (isWriteRetry) {
		return [
			`上一写入阶段「${failedPhase.title}」没有完成实际落盘修改。`,
			"请先用只读工具重新读取目标文件的最新内容，再调用下面列出的实际写入工具之一完成修改；如果写入触发审批，按审批流程暂停。",
			"如果上一次失败包含 oldText not found，必须基于最新文件内容重新构造 oldText 或改用更稳定的行级/覆盖写入工具。",
			"不要只输出计划、修复建议、工具调用预告或后续动作。不要只调用 read/verify/propose 工具替代实际写入。",
			"不要创建占位文件、临时文件或与用户目标无关的文件；这些不算完成当前修改。",
			"",
			"## 本阶段允许的实际写入工具",
			...repairWriteTools.map((toolName: string): string => `- ${toolName}`),
			"",
			"## 写入失败内容",
			failureDetails
		].join("\n");
	}

	return [
		`上一验证阶段「${failedPhase.title}」发现任务尚未可交付。`,
		"请根据验证失败内容完成必要修复。当前阶段第一步必须调用下面列出的实际写入工具之一；如果写入触发审批，按审批流程暂停。",
		"不要只输出计划、修复建议、工具调用预告或后续动作。不要只调用 read/verify 工具替代写入。",
		"不要创建占位文件、临时文件或与用户目标无关的文件；这些不算完成当前修复。",
		"",
		"## 本阶段允许的实际写入工具",
		...repairWriteTools.map((toolName: string): string => `- ${toolName}`),
		"",
		"## 验证失败内容",
		failureDetails
	].join("\n");
}

function createAutoVerifyPhase(
	plan: WorkflowPlan,
	failedPhase: WorkflowPhase,
	round: number,
	acceptanceCriteria: string[],
	verifyFailureReason: string,
	verifyOnly: boolean
): WorkflowPhase {
	return {
		id: createUniquePhaseId(plan, AUTO_VERIFY_ID_PREFIX, round),
		title: verifyOnly ? "补跑验证" : "重新验证修复",
		toolGroup: "verify",
		toolBudget: "normal",
		allowedTools: [...READ_TOOLS, ...VERIFY_TOOLS],
		repairOf: failedPhase.id,
		repairRound: round,
		acceptanceCriteria,
		instruction: verifyOnly
			? [
				`上一验证阶段「${failedPhase.title}」缺少必要验证或验证环境不可用。`,
				"请只补跑与失败点相关的验证工具，不能修改项目文件。",
				"如果 LSP、Godot CLI 或其它验证环境不可用，请明确报告环境原因，不要进入写入修复。",
				"",
				"## 验证失败内容",
				verifyFailureReason
			].join("\n")
			: "重新运行与失败点相关的验证。只有确认失败已消除，且没有新的阻塞问题，才能报告验证通过。"
	};
}

function normalizeCompletionTarget(value: string): string {
	return value.replace(/^res:\/\//iu, "").replace(/\\/g, "/").toLowerCase();
}

function completionTargetValue(target: WorkflowCompletionTarget): string {
	return target.kind === "artifact" ? target.path : target.key;
}

function createRepairCompletionContract(
	failedPhase: WorkflowPhase,
	failedChecks: WorkflowFailedCheck[]
): WorkflowCompletionContract | undefined {
	const completionChecks: WorkflowFailedCheck[] = failedChecks.filter((check: WorkflowFailedCheck): boolean => (
		check.code === "required_mutation_missing"
			|| check.code === "target_artifact_missing"
			|| check.code === "target_readback_failed"
	));
	if (completionChecks.length === 0) {
		return undefined;
	}

	const missingTargets: Set<string> = new Set(completionChecks
		.map((check: WorkflowFailedCheck): string | undefined => check.artifact)
		.filter((value: string | undefined): value is string => value !== undefined)
		.map(normalizeCompletionTarget));
	const inheritedTargets: WorkflowCompletionTarget[] = failedPhase.completionContract?.targets
		.filter((target: WorkflowCompletionTarget): boolean => (
			missingTargets.size === 0 || missingTargets.has(normalizeCompletionTarget(completionTargetValue(target)))
		))
		.map((target: WorkflowCompletionTarget): WorkflowCompletionTarget => ({ ...target }))
		?? [];
	if (inheritedTargets.length > 0) {
		return { targets: inheritedTargets, requireAll: true };
	}

	const targets: WorkflowCompletionTarget[] = completionChecks.flatMap((check: WorkflowFailedCheck): WorkflowCompletionTarget[] => {
		if (check.artifact === undefined) {
			return [];
		}
		return check.code === "required_mutation_missing"
			? [{ kind: "project_setting", key: check.artifact }]
			: [{ kind: "artifact", path: check.artifact }];
	});
	return targets.length > 0 ? { targets, requireAll: true } : undefined;
}

export function insertWorkflowAutoRepairPhases(
	plan: WorkflowPlan,
	insertIndex: number,
	failedPhase: WorkflowPhase,
	verifyFailureReason: string,
	failedChecks: WorkflowFailedCheck[] = []
): WorkflowPlan {
	const round: number = countWorkflowAutoRepairRounds(plan) + 1;
	const acceptanceCriteria: string[] = failedChecks.length > 0
		? failedChecks.map((check: WorkflowFailedCheck): string => check.message)
		: [verifyFailureReason];
	const verifyOnly: boolean = shouldUseVerifyOnlyRepair(failedChecks);
	const verifyPhase: WorkflowPhase = createAutoVerifyPhase(plan, failedPhase, round, acceptanceCriteria, verifyFailureReason, verifyOnly);
	if (verifyOnly) {
		const phases: WorkflowPhase[] = [
			...plan.phases.slice(0, insertIndex),
			verifyPhase,
			...plan.phases.slice(insertIndex)
		];

		return {
			...plan,
			phases,
			todos: rebuildTodosForPhases(plan, phases),
			revision: (plan.revision ?? 0) + 1
		};
	}

	const repairWriteTools: string[] = inferRepairWriteTools(failedPhase, verifyFailureReason, failedChecks);
	const repairPhase: WorkflowPhase = {
		id: createUniquePhaseId(plan, AUTO_REPAIR_ID_PREFIX, round),
		title: isWriteGuardFailure(failedPhase, failedChecks) ? "重试实际修改" : "修复验证问题",
		toolGroup: "write",
		skillId: "file.creator",
		promptId: "godot.assistant",
		toolBudget: "project_edit",
		allowedTools: uniqueTools([...REPAIR_READ_TOOLS, ...repairWriteTools]),
		repairOf: failedPhase.id,
		repairRound: round,
		acceptanceCriteria,
		instruction: createRepairInstruction(failedPhase, verifyFailureReason, repairWriteTools, failedChecks),
		completionContract: createRepairCompletionContract(failedPhase, failedChecks),
		requireToolCallOnFirstStep: true
	};
	const phases: WorkflowPhase[] = [
		...plan.phases.slice(0, insertIndex),
		repairPhase,
		verifyPhase,
		...plan.phases.slice(insertIndex)
	];

	return {
		...plan,
		phases,
		todos: rebuildTodosForPhases(plan, phases),
		revision: (plan.revision ?? 0) + 1
	};
}
