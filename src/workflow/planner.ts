import type { AiChatParams } from "../protocol/types.js";
import { CUSTOM_MCP_TOOLS_SENTINEL } from "../tools/tool-sentinels.js";
export { READ_TOOLS, VERIFY_TOOLS, WRITE_TOOLS } from "./tool-sets.js";
import { READ_TOOLS, VERIFY_TOOLS, WRITE_TOOLS } from "./tool-sets.js";
import type { WorkflowCompletionContract, WorkflowPhase, WorkflowPhaseId, WorkflowPlan, WorkflowTodoItem } from "./types.js";
import { createVisibleWorkflowTodos } from "./todos.js";
import { getExecutionPolicy } from "./router.js";
import { getWorkflowExecutionProfile, getWorkflowToolsForProfile, type WorkflowExecutionProfileId } from "./execution-profile.js";
import { applyWorkflowVerificationPolicy } from "./verification-policy.js";

type FixedWorkflowPhaseId = "inspect" | "implement" | "review" | "verify" | "summarize";

const PHASE_TEMPLATES: Record<FixedWorkflowPhaseId, WorkflowPhase> = {
	inspect: {
		id: "inspect",
		title: "Inspect context",
		toolGroup: "read",
		toolBudget: "normal",
		allowedTools: READ_TOOLS,
		instruction: "读取最小必要上下文，确认相关文件、场景、脚本和项目约束。只做事实收集，不修改文件。",
		acceptanceCriteria: ["已确认相关文件、场景、脚本和项目约束。"]
	},
	implement: {
		id: "implement",
		title: "Implement changes",
		toolGroup: "write",
		skillId: "file.creator",
		promptId: "godot.assistant",
		toolBudget: "project_edit",
		allowedTools: [...READ_TOOLS, ...WRITE_TOOLS],
		writeRequirement: "write",
		instruction: "基于已收集上下文完成必要修改。优先小步修改，必须使用 create/overwrite/replace/apply/add/attach/connect/set/unset 等实际写入工具完成修改；这些写入工具会走审批系统。修改项目设置时先用 propose_* 预览，但不要把 propose_* 当作实现结果。",
		acceptanceCriteria: ["必要文件、场景或项目设置已由实际写入工具完成修改。"]
	},
	review: {
		id: "review",
		title: "Review results",
		toolGroup: "verify",
		skillId: "gdscript.review",
		promptId: "gdscript.reviewer",
		toolBudget: "normal",
		allowedTools: [...READ_TOOLS, ...VERIFY_TOOLS],
		instruction: "审查修改后的代码、场景和相邻调用。优先指出真实风险、回归和遗漏验证。默认不要写文件。",
		acceptanceCriteria: ["已审查修改后的代码、场景和相邻调用。"]
	},
	verify: {
		id: "verify",
		title: "Run verification",
		toolGroup: "verify",
		toolBudget: "normal",
		allowedTools: [...READ_TOOLS, ...VERIFY_TOOLS],
		instruction: "运行可用的低成本验证。修改 .gd 后优先读取 LSP diagnostics，再运行 Godot check-only、类型检查或安全预设。记录通过、失败和未覆盖项。如果发现失败或需要修改的问题，明确列出失败检查和修复要求，不要把验证阶段标成通过。",
		acceptanceCriteria: ["相关 LSP diagnostics、Godot check-only 或场景验证已经实际运行且无阻塞失败。"]
	},
	summarize: {
		id: "summarize",
		title: "Summarize delivery",
		toolGroup: "summarize",
		promptId: "godot.assistant",
		toolBudget: "simple",
		allowedTools: [],
		instruction: "只基于前面阶段的结果给用户最终总结。说明完成内容、验证状态、剩余风险和是否有审批未完成。不要再调用工具。",
		acceptanceCriteria: ["所有前置阶段均完成，且不存在未解决的验证失败、阻塞或审批。"]
	}
};

export function createWorkflowId(): string {
	return `workflow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const WORKSPACE_PHASE_CONTENT: Partial<Record<FixedWorkflowPhaseId, Pick<WorkflowPhase, "title" | "instruction" | "acceptanceCriteria">>> = {
	inspect: {
		title: "Inspect workspace context",
		instruction: "Read only the minimum workspace context needed to identify the affected files and constraints. Do not modify files.",
		acceptanceCriteria: ["Relevant workspace files and constraints were observed through read tools."]
	},
	implement: {
		title: "Implement approved change",
		instruction: "Make only the necessary approved workspace changes. Use an actual approval-gated write tool; previews and prose do not count as implementation.",
		acceptanceCriteria: ["The required workspace change was completed by an actual write tool."]
	},
	review: {
		title: "Review result",
		instruction: "Review the changed files and their immediate callers for concrete regressions. Do not modify files in this phase.",
		acceptanceCriteria: ["Changed files and relevant immediate integrations were reviewed."]
	},
	verify: {
		title: "Verify change",
		instruction: "Run the available low-cost verification for the changed workspace artifacts and report passed, failed, and uncovered checks truthfully.",
		acceptanceCriteria: ["Available verification completed without an unresolved blocking failure."]
	},
	summarize: {
		title: "Summarize delivery",
		instruction: "Summarize completed changes, verification status, remaining risks, and pending approvals using only prior phase evidence. Do not call tools.",
		acceptanceCriteria: ["All prior phases are complete and no unresolved failure, blocker, or approval is hidden."]
	}
};

function createPhase(phaseId: FixedWorkflowPhaseId, executionProfile: WorkflowExecutionProfileId): WorkflowPhase {
	const phase: WorkflowPhase = PHASE_TEMPLATES[phaseId];
	const profile = getWorkflowExecutionProfile(executionProfile);
	const workspaceContent = executionProfile === "workspace" ? WORKSPACE_PHASE_CONTENT[phaseId] : undefined;
	return {
		...phase,
		...workspaceContent,
		skillId: phaseId === "implement"
			? profile.writeSkillId
			: (phaseId === "review" ? profile.reviewSkillId : undefined),
		promptId: phaseId === "review"
			? profile.reviewPromptId
			: ((phaseId === "implement" || phaseId === "summarize") ? profile.promptId : undefined),
		allowedTools: getWorkflowToolsForProfile(executionProfile, phase.toolGroup ?? "read")
	};
}

function createTodos(phases: WorkflowPhase[]): WorkflowTodoItem[] {
	return createVisibleWorkflowTodos(phases);
}

function createPlan(
	title: string,
	phaseIds: FixedWorkflowPhaseId[],
	executionProfile: WorkflowExecutionProfileId,
	completionContract?: WorkflowCompletionContract | undefined
): WorkflowPlan {
	const phases: WorkflowPhase[] = phaseIds.map((phaseId: FixedWorkflowPhaseId): WorkflowPhase => createPhase(phaseId, executionProfile));
	const firstWriteIndex: number = phases.findIndex((phase: WorkflowPhase): boolean => phase.toolGroup === "write");
	if (firstWriteIndex >= 0 && completionContract !== undefined) {
		phases[firstWriteIndex] = {
			...phases[firstWriteIndex]!,
			completionContract: {
				requireAll: completionContract.requireAll,
				targets: completionContract.targets.map((target) => ({ ...target }))
			}
		};
	}
	return {
		id: createWorkflowId(),
		title,
		phases,
		todos: createTodos(phases),
		source: "fixed",
		revision: 0,
		executionProfile,
		semanticsVersion: 2
	};
}

export function createSingleAnswerPlan(params: AiChatParams, allowedTools?: readonly string[] | undefined): WorkflowPlan {
	const title: string = createWorkflowTitle(params.message);
	const phase: WorkflowPhase = {
		id: "answer",
		title: "Answer user",
		toolGroup: "summarize",
		promptId: params.promptId,
		skillId: undefined,
		toolBudget: (params.options?.toolBudget ?? "normal"),
		allowedTools: allowedTools !== undefined ? [...allowedTools] : [...READ_TOOLS, ...VERIFY_TOOLS, CUSTOM_MCP_TOOLS_SENTINEL],
		instruction: "完成用户本轮请求。可以读取或验证必要信息，但不得用文本 XML/DSML/裸标签模拟工具调用；如需工具，必须使用 API tool_calls。",
		acceptanceCriteria: ["已直接回答用户本轮请求，或说明无法完成的明确原因。"]
	};
	return {
		id: createWorkflowId(),
		title,
		phases: [phase],
		todos: createTodos([phase]),
		source: "fixed",
		revision: 0,
		semanticsVersion: 2
	};
}

export function createWorkflowTitle(message: string): string {
	const normalized: string = message.replace(/\s+/g, " ").trim();
	if (normalized.length <= 24) {
		return normalized.length > 0 ? normalized : "Multi-stage task";
	}

	return `${normalized.slice(0, 24)}...`;
}

export function planWorkflow(
	params: AiChatParams,
	executionProfile: WorkflowExecutionProfileId = "godot",
	completionContract?: WorkflowCompletionContract | undefined
): WorkflowPlan | null {
	const workflowMode = params.options?.workflow ?? "auto";
	if (
		workflowMode === "single"
		|| workflowMode === "llm_planned"
		|| params.mode === "ask"
		|| params.mode === "plan"
		|| getExecutionPolicy(params) === "read_only"
	) {
		return null;
	}
	if (completionContract === undefined || completionContract.targets.length === 0) {
		return null;
	}
	const title: string = createWorkflowTitle(params.message);
	return applyWorkflowVerificationPolicy(createPlan(title, ["inspect", "implement", "verify", "summarize"], executionProfile, completionContract), params);
}

export function planWorkflowAfterLlmPlannerFailure(
	params: AiChatParams,
	executionProfile: WorkflowExecutionProfileId = "godot",
	completionContract?: WorkflowCompletionContract | undefined
): WorkflowPlan | null {
	if (params.mode === "ask" || params.mode === "plan" || getExecutionPolicy(params) === "read_only") return null;
	if (completionContract === undefined || completionContract.targets.length === 0) return null;
	return applyWorkflowVerificationPolicy(
		createPlan(createWorkflowTitle(params.message), ["inspect", "implement", "verify", "summarize"], executionProfile, completionContract),
		params
	);
}
