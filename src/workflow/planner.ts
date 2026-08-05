import type { AiChatParams } from "../protocol/types.js";
import { getDefaultWorkflowToolNames } from "../tools/tool-catalog.js";
import { CUSTOM_MCP_TOOLS_SENTINEL } from "../tools/tool-sentinels.js";
import type { WorkflowPhase, WorkflowPhaseId, WorkflowPlan, WorkflowTodoItem } from "./types.js";
import { createVisibleWorkflowTodos } from "./todos.js";

type FixedWorkflowPhaseId = "inspect" | "implement" | "review" | "verify" | "summarize";

export const READ_TOOLS: string[] = getDefaultWorkflowToolNames("read");

export const VERIFY_TOOLS: string[] = getDefaultWorkflowToolNames("verify");

export const WRITE_TOOLS: string[] = getDefaultWorkflowToolNames("write");

const PHASE_TEMPLATES: Record<FixedWorkflowPhaseId, WorkflowPhase> = {
	inspect: {
		id: "inspect",
		title: "理解上下文",
		toolGroup: "read",
		toolBudget: "normal",
		allowedTools: READ_TOOLS,
		instruction: "读取最小必要上下文，确认相关文件、场景、脚本和项目约束。只做事实收集，不修改文件。",
		acceptanceCriteria: ["已确认相关文件、场景、脚本和项目约束。"]
	},
	implement: {
		id: "implement",
		title: "实现修改",
		toolGroup: "write",
		skillId: "file.creator",
		promptId: "godot.assistant",
		toolBudget: "project_edit",
		allowedTools: [...READ_TOOLS, ...WRITE_TOOLS],
		instruction: "基于已收集上下文完成必要修改。优先小步修改，必须使用 create/overwrite/replace/apply/add/attach/connect/set/unset 等实际写入工具完成修改；这些写入工具会走审批系统。修改项目设置时先用 propose_* 预览，但不要把 propose_* 当作实现结果。",
		acceptanceCriteria: ["必要文件、场景或项目设置已由实际写入工具完成修改。"]
	},
	review: {
		id: "review",
		title: "审查结果",
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
		title: "运行验证",
		toolGroup: "verify",
		toolBudget: "normal",
		allowedTools: [...READ_TOOLS, ...VERIFY_TOOLS],
		instruction: "运行可用的低成本验证。修改 .gd 后优先读取 LSP diagnostics，再运行 Godot check-only、类型检查或安全预设。记录通过、失败和未覆盖项。如果发现失败或需要修改的问题，明确列出失败检查和修复要求，不要把验证阶段标成通过。",
		acceptanceCriteria: ["相关 LSP diagnostics、Godot check-only 或场景验证已经实际运行且无阻塞失败。"]
	},
	summarize: {
		id: "summarize",
		title: "总结交付",
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

function includesAny(text: string, terms: readonly string[]): boolean {
	return terms.some((term: string): boolean => text.includes(term));
}

export function isExplicitReadOnlyRequest(text: string): boolean {
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
		"先不动文件",
		"暂时不动文件",
		"先不修改",
		"暂时不修改",
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

function createPhase(phaseId: FixedWorkflowPhaseId): WorkflowPhase {
	const phase: WorkflowPhase = PHASE_TEMPLATES[phaseId];
	return {
		...phase,
		allowedTools: [...phase.allowedTools]
	};
}

function createTodos(phases: WorkflowPhase[]): WorkflowTodoItem[] {
	return createVisibleWorkflowTodos(phases);
}

function createPlan(title: string, phaseIds: FixedWorkflowPhaseId[]): WorkflowPlan {
	const phases: WorkflowPhase[] = phaseIds.map(createPhase);
	return {
		id: createWorkflowId(),
		title,
		phases,
		todos: createTodos(phases),
		source: "fixed",
		revision: 0
	};
}

export function isApprovalTestRequest(message: string): boolean {
	const normalized: string = message.toLowerCase();
	const mentionsApproval: boolean = includesAny(normalized, [
		"审批",
		"approval",
		"approve"
	]);
	const requestsTrigger: boolean = includesAny(normalized, [
		"拉起",
		"触发",
		"测试",
		"试一下",
		"随便",
		"test",
		"trigger",
		"show"
	]);

	return mentionsApproval && requestsTrigger && !isExplicitReadOnlyRequest(normalized);
}

export function createApprovalTestWorkflowPlan(params: AiChatParams): WorkflowPlan {
	const phase: WorkflowPhase = {
		id: "approval-test",
		title: "触发审批",
		toolGroup: "write",
		promptId: params.promptId,
		skillId: undefined,
		toolBudget: "project_edit",
		allowedTools: ["mcp_godot_create_text_file"],
		instruction: [
			"为测试 Studio 审批界面，必须通过 API tool_calls 调用 mcp_godot_create_text_file 创建一个临时 Markdown 文件。",
			"不要调用只读工具，不要只描述计划或意图。",
			"建议参数：relativePath 使用 daedalus-approval-test.md 或带短随机后缀的 .md 文件名；content 写明这是审批 UI 测试文件。",
			"必须填写 approvalReason，例如：Create a temporary markdown file to test the Studio approval UI."
		].join("\n"),
		acceptanceCriteria: ["已发起 mcp_godot_create_text_file 写入调用并进入审批流程。"],
		requireToolCallOnFirstStep: true
	};
	return {
		id: createWorkflowId(),
		title: createWorkflowTitle(params.message),
		phases: [phase],
		todos: createTodos([phase]),
		source: "fixed",
		revision: 0
	};
}

export function createSingleAnswerPlan(params: AiChatParams, allowedTools?: readonly string[] | undefined): WorkflowPlan {
	const title: string = createWorkflowTitle(params.message);
	const phase: WorkflowPhase = {
		id: "answer",
		title: "回答用户",
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
		revision: 0
	};
}

export function isCurrentProjectFactRequest(message: string): boolean {
	const normalized: string = message.toLowerCase();
	const asksDynamicFact: boolean = includesAny(normalized, [
		"当前",
		"现在",
		"项目里",
		"项目中",
		"有哪些",
		"多少",
		"几个",
		"列出",
		"读取",
		"查看",
		"状态",
		"路径",
		"list",
		"count",
		"read",
		"show",
		"current"
	]);
	const mentionsProjectScope: boolean = includesAny(normalized, [
		"项目",
		"文件",
		"脚本",
		"场景",
		"编辑器",
		"project",
		"file",
		"script",
		"scene",
		"editor",
		".gd",
		".tscn",
		"project.godot"
	]);
	return asksDynamicFact && mentionsProjectScope;
}

export function createReadOnlyFactWorkflowPlan(params: AiChatParams): WorkflowPlan {
	const inspectPhase: WorkflowPhase = {
		id: "inspect-current-facts",
		title: "读取当前事实",
		toolGroup: "read",
		promptId: params.promptId,
		toolBudget: "normal",
		allowedTools: [...READ_TOOLS, ...VERIFY_TOOLS],
		instruction: [
			"使用最小必要只读/验证工具读取当前项目事实；不要只基于历史消息、摘要或记忆回答。",
			"只能调用 read/verify 工具，不得调用写入、预览补丁、变更类或破坏性工具。",
			"如果无法读取实时事实，明确说明无法确认，不要编造文件列表、数量或状态。"
		].join("\n"),
		acceptanceCriteria: ["已通过工具收集当前项目事实，或明确说明无法读取实时事实。"],
		requireToolCallOnFirstStep: true
	};
	const summarizePhase: WorkflowPhase = {
		id: "summarize-current-facts",
		title: "总结当前事实",
		toolGroup: "summarize",
		promptId: params.promptId,
		toolBudget: "simple",
		allowedTools: [],
		instruction: "只基于上一阶段的工具结果回答用户。不要补充未经工具确认的当前项目事实。",
		acceptanceCriteria: ["回答中的动态事实均来自上一阶段工具结果，或已明确说明无法确认。"]
	};
	const phases: WorkflowPhase[] = [inspectPhase, summarizePhase];
	return {
		id: createWorkflowId(),
		title: createWorkflowTitle(params.message),
		phases,
		todos: createTodos(phases),
		source: "fixed",
		revision: 0
	};
}

export function createWorkflowTitle(message: string): string {
	const normalized: string = message.replace(/\s+/g, " ").trim();
	if (normalized.length <= 24) {
		return normalized.length > 0 ? normalized : "多阶段任务";
	}

	return `${normalized.slice(0, 24)}...`;
}

export function planWorkflow(params: AiChatParams): WorkflowPlan | null {
	const workflowMode = params.options?.workflow ?? "auto";
	if (workflowMode === "single" || workflowMode === "llm_planned") {
		return null;
	}

	const text: string = params.message.toLowerCase();
	if (isExplicitReadOnlyRequest(text)) {
		return null;
	}

	if (params.mode === "agent" && isApprovalTestRequest(text)) {
		return createApprovalTestWorkflowPlan(params);
	}

	const wantsReview: boolean = includesAny(text, ["审查", "检查", "review", "code review", "复查", "评审"]);
	const wantsImplementation: boolean = includesAny(text, [
		"完善",
		"实现",
		"修改",
		"编写",
		"写一个",
		"写下",
		"创建",
		"新增",
		"修复",
		"改一下",
		"生成",
		"搭建",
		"做一个"
	]);

	const title: string = createWorkflowTitle(params.message);

	if (workflowMode === "multi_phase" && !wantsReview && !wantsImplementation) {
		return createPlan(title, ["inspect", "implement", "verify", "summarize"]);
	}

	if (wantsImplementation && wantsReview) {
		return createPlan(title, ["inspect", "implement", "review", "verify", "summarize"]);
	}

	if (wantsReview) {
		return createPlan(title, ["inspect", "review", "summarize"]);
	}

	if (wantsImplementation) {
		return createPlan(title, ["inspect", "implement", "verify", "summarize"]);
	}

	return null;
}

export function planWorkflowAfterLlmPlannerFailure(params: AiChatParams): WorkflowPlan | null {
	return planWorkflow({
		...params,
		options: {
			...(params.options ?? {}),
			workflow: "auto"
		}
	});
}
