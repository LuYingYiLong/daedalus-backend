import { READ_TOOLS, VERIFY_TOOLS } from "./planner.js";
import { getToolPolicy } from "../tools/tool-policy.js";
import { getWorkflowToolSemantics, type WorkflowTargetKind } from "./tool-semantics.js";
import type {
	WorkflowCompletionContract,
	WorkflowCompletionTarget,
	WorkflowFailedCheck,
	WorkflowPhase,
	WorkflowPlan,
	WorkflowTodoItem
} from "./types.js";
import { createVisibleWorkflowTodos } from "./todos.js";
import { getWorkflowExecutionProfile } from "./execution-profile.js";
import { isValidWorkflowCompletionTarget, normalizeProjectSettingKey, normalizeWorkspaceRelativeArtifactPath } from "./completion-contract.js";

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
type RepairToolFamily = WorkflowTargetKind;

export type RepairWriteToolResolution = {
	tools: string[];
	reason: string;
};

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

export function shouldUseVerifyOnlyRepair(failedChecks: WorkflowFailedCheck[]): boolean {
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

function collectActualWriteToolsFromPhase(failedPhase: WorkflowPhase): string[] {
	return failedPhase.allowedTools.filter((toolName: string): boolean => {
		const risk: string | undefined = getToolPolicy(toolName)?.risk;
		return (risk === "write" || risk === "destructive")
			&& (getWorkflowToolSemantics(toolName).repairFamilies?.length ?? 0) > 0;
	});
}

function getTargetFamily(target: WorkflowCompletionTarget): RepairToolFamily | undefined {
	if (target.kind === "project_setting") {
		return "project_setting";
	}
	return target.targetKind;
}

function collectStructuredRepairFamilies(failedPhase: WorkflowPhase, failedChecks: WorkflowFailedCheck[]): Set<RepairToolFamily> {
	const families: Set<RepairToolFamily> = new Set();
	for (const target of failedPhase.completionContract?.targets ?? []) {
		const family: RepairToolFamily | undefined = getTargetFamily(target);
		if (family !== undefined) families.add(family);
	}
	for (const check of failedChecks) {
		if (check.targetKind !== undefined) families.add(check.targetKind);
		if (check.toolName !== undefined) {
			for (const family of getWorkflowToolSemantics(check.toolName).repairFamilies ?? []) {
				families.add(family);
			}
		}
	}
	return families;
}

function collectPriorAuthorizedWriteTools(plan: WorkflowPlan, insertIndex: number, failedPhase: WorkflowPhase): string[] {
	const failedPhaseTools: string[] = collectActualWriteToolsFromPhase(failedPhase);
	if (failedPhaseTools.length > 0) return failedPhaseTools;
	for (let index: number = insertIndex - 1; index >= 0; index -= 1) {
		const phase: WorkflowPhase | undefined = plan.phases[index];
		if (phase?.toolGroup !== "write") continue;
		const tools: string[] = collectActualWriteToolsFromPhase(phase);
		if (tools.length > 0) return tools;
	}
	return [];
}

export function resolveRepairWriteTools(
	plan: WorkflowPlan,
	insertIndex: number,
	failedPhase: WorkflowPhase,
	failedChecks: WorkflowFailedCheck[]
): RepairWriteToolResolution {
	const authorizedTools: string[] = collectPriorAuthorizedWriteTools(plan, insertIndex, failedPhase);
	if (authorizedTools.length === 0) {
		return { tools: [], reason: "No prior write phase granted a repair tool that can be safely reused." };
	}
	if (failedChecks.some((check: WorkflowFailedCheck): boolean => check.failureCode === undefined)) {
		return { tools: [], reason: "The failed verification has no structured failure code for a safe repair." };
	}
	const targetFamilies: Set<RepairToolFamily> = collectStructuredRepairFamilies(failedPhase, failedChecks);
	if (targetFamilies.size === 0) {
		if (failedPhase.toolGroup === "write") {
			return { tools: uniqueTools(authorizedTools), reason: "Retrying the failed write phase with its existing authorization only." };
		}
		return { tools: [], reason: "The verification failure has no structured artifact, completion target, or tool family for a safe repair." };
	}
	const tools: string[] = authorizedTools.filter((toolName: string): boolean => {
		const families: readonly RepairToolFamily[] = getWorkflowToolSemantics(toolName).repairFamilies ?? [];
		return families.some((family: RepairToolFamily): boolean => targetFamilies.has(family));
	});
	return tools.length > 0
		? { tools: uniqueTools(tools), reason: "Repair tools match structured failed targets and existing authorization." }
		: { tools: [], reason: "Structured failed targets do not match any previously authorized write tool." };
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
	const isWriteRetry: boolean = failedPhase.toolGroup === "write"
		&& failedChecks.some((check: WorkflowFailedCheck): boolean => (
			check.failureCode === "write_tool_missing" || check.failureCode === "replace_target_not_found"
		));
	if (isWriteRetry) {
		return [
			`上一写入阶段「${failedPhase.title}」没有完成实际落盘修改。`,
			"请先用只读工具重新读取目标文件的最新内容，再调用下面列出的实际写入工具之一完成修改；如果写入触发审批，按审批流程暂停。",
			"如遇到结构化替换目标缺失错误，必须基于最新文件内容重新构造精确替换目标，或改用已授权的行级/覆盖写入工具。",
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
			sourceFolderId: failedPhase.sourceFolderId,
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
	return (normalizeWorkspaceRelativeArtifactPath(value)
		?? normalizeProjectSettingKey(value)
		?? value.replace(/^res:\/\//iu, "").replace(/\\/g, "/")).toLowerCase();
}

function completionTargetValue(target: WorkflowCompletionTarget): string {
	return target.kind === "artifact" ? target.path : target.key;
}

function completionTargetIdentity(value: string, sourceFolderId?: string | undefined): string {
	const normalized: string = normalizeCompletionTarget(value);
	return sourceFolderId === undefined ? normalized : `${sourceFolderId}:${normalized}`;
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

	const missingTargets: Set<string> = new Set(completionChecks.flatMap((check: WorkflowFailedCheck): string[] => (
		check.artifact === undefined
			? []
			: [
				normalizeCompletionTarget(check.artifact),
				...(check.sourceFolderId === undefined ? [] : [completionTargetIdentity(check.artifact, check.sourceFolderId)])
			]
	)));
	const inheritedTargets: WorkflowCompletionTarget[] = failedPhase.completionContract?.targets
		.filter((target: WorkflowCompletionTarget): boolean => (
			isValidWorkflowCompletionTarget(target)
			&& (missingTargets.size === 0
				|| missingTargets.has(completionTargetIdentity(completionTargetValue(target)))
				|| (target.sourceFolderId !== undefined && missingTargets.has(completionTargetIdentity(completionTargetValue(target), target.sourceFolderId))))
		))
		.map((target: WorkflowCompletionTarget): WorkflowCompletionTarget => ({ ...target }))
		?? [];
	if (inheritedTargets.length > 0) {
		return { targets: inheritedTargets, requireAll: true };
	}

	return undefined;
}

export function insertWorkflowAutoRepairPhases(
	plan: WorkflowPlan,
	insertIndex: number,
	failedPhase: WorkflowPhase,
	verifyFailureReason: string,
	failedChecks: WorkflowFailedCheck[] = [],
	repairWriteTools?: readonly string[] | undefined
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

	const resolvedRepairWriteTools: string[] = repairWriteTools === undefined
		? resolveRepairWriteTools(plan, insertIndex, failedPhase, failedChecks).tools
		: [...repairWriteTools];
	if (resolvedRepairWriteTools.length === 0) {
		return plan;
	}
	const executionProfile = getWorkflowExecutionProfile(plan.executionProfile);
	const repairPhase: WorkflowPhase = {
		id: createUniquePhaseId(plan, AUTO_REPAIR_ID_PREFIX, round),
		title: isWriteGuardFailure(failedPhase, failedChecks) ? "重试实际修改" : "修复验证问题",
		toolGroup: "write",
		skillId: executionProfile.writeSkillId,
		promptId: executionProfile.promptId,
		toolBudget: "project_edit",
		allowedTools: uniqueTools([...REPAIR_READ_TOOLS, ...resolvedRepairWriteTools]),
		repairOf: failedPhase.id,
		repairRound: round,
		acceptanceCriteria,
		instruction: createRepairInstruction(failedPhase, verifyFailureReason, resolvedRepairWriteTools, failedChecks),
			completionContract: createRepairCompletionContract(failedPhase, failedChecks),
			sourceFolderId: failedPhase.sourceFolderId,
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
