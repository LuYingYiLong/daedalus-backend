import { z } from "zod";
import { chatWithDeepSeek, type DeepSeekChatOptions } from "../providers/deepseek-client.js";
import { parseJsonObjectFromLlm } from "../providers/llm-json.js";
import { promptIdSchema } from "../protocol/schema.js";
import type { AiChatParams, ChatMessage, PromptId } from "../protocol/types.js";
import { isSkillId, type SkillId } from "../skills/registry.js";
import type { ToolBudgetLevel } from "../tools/llm-tool-budget.js";
import { createWorkflowId, createWorkflowTitle, READ_TOOLS, VERIFY_TOOLS, WRITE_TOOLS } from "./planner.js";
import { createWorkflowCompletionContract, getAllowedToolsForLlmPlannedStep } from "./godot-template-planner.js";
import type {
	WorkflowPhase,
	WorkflowPhaseOutput,
	WorkflowPlan,
	WorkflowTodoItem,
	WorkflowToolGroup
} from "./types.js";
import { createVisibleWorkflowTodos } from "./todos.js";

const MAX_LLM_WORKFLOW_STEPS: number = 8;
const MAX_LLM_WORKFLOW_REVISIONS: number = 3;
const MAX_PLANNING_CONTEXT_CHARS: number = 8000;
const MAX_PHASE_INSTRUCTION_CHARS: number = 1200;

const toolGroupSchema = z.enum(["read", "write", "verify", "summarize"]);

const normalizedPromptIdSchema = z.preprocess((value: unknown): unknown => {
	if (value === null || value === undefined || value === "") {
		return undefined;
	}

	return promptIdSchema.safeParse(value).success ? value : undefined;
}, promptIdSchema.optional());

const llmPlanStepSchema = z.object({
	id: z.string().min(1).max(48).optional(),
	title: z.string().min(1).max(80),
	instruction: z.string().min(1).max(2000),
	toolGroup: toolGroupSchema,
	acceptanceCriteria: z.array(z.string().min(1).max(240)).max(8).optional(),
	skillId: z.string().nullable().optional(),
	promptId: normalizedPromptIdSchema
}).strict();

const llmPlanSchema = z.object({
	title: z.string().min(1).max(80).optional(),
	steps: z.array(llmPlanStepSchema).min(1).max(MAX_LLM_WORKFLOW_STEPS)
}).strict();

type LlmPlanStep = z.infer<typeof llmPlanStepSchema>;
type LlmPlan = z.infer<typeof llmPlanSchema>;

export async function createLlmWorkflowPlan(
	params: AiChatParams,
	options: DeepSeekChatOptions,
	history: ChatMessage[],
	planningContext: string,
	abortSignal?: AbortSignal | undefined
): Promise<WorkflowPlan | null> {
	const text: string = await chatWithDeepSeek(
		createPlannerParams(createInitialPlanMessage(params.message, planningContext)),
		options,
		limitPlanningHistory(history),
		createPlannerSystemPrompt(),
		abortSignal
	);
	const rawPlan: LlmPlan = parseLlmPlan(text);
	return createWorkflowPlanFromLlmPlan(rawPlan, params.message);
}

export async function reviseLlmWorkflowPlan(
	plan: WorkflowPlan,
	completedPhaseIndex: number,
	originalParams: AiChatParams,
	phaseOutputs: WorkflowPhaseOutput[],
	options: DeepSeekChatOptions,
	history: ChatMessage[],
	planningContext: string,
	abortSignal?: AbortSignal | undefined
): Promise<WorkflowPlan> {
	if (plan.source !== "llm") {
		return plan;
	}

	const revision: number = plan.revision ?? 0;
	const maxRevisions: number = plan.maxRevisions ?? MAX_LLM_WORKFLOW_REVISIONS;
	if (revision >= maxRevisions || completedPhaseIndex >= plan.phases.length - 1) {
		return plan;
	}

	const text: string = await chatWithDeepSeek(
		createPlannerParams(createRevisionMessage(plan, completedPhaseIndex, originalParams.message, phaseOutputs, planningContext)),
		options,
		limitPlanningHistory(history),
		createPlannerSystemPrompt(),
		abortSignal
	);
	const rawPlan: LlmPlan = parseLlmPlan(text);
	return mergeRevisedPendingSteps(plan, completedPhaseIndex + 1, rawPlan);
}

function createPlannerParams(message: string): AiChatParams {
	return {
		message,
		options: {
			temperature: 0.2,
			maxTokens: 2000,
			responseFormat: "json",
			workflow: "single"
		}
	};
}

function createPlannerSystemPrompt(): string {
	return [
		"你是 Godot Daedalus 的任务调度器，只负责输出 JSON 计划，不调用工具，不写解释文本。",
		"输出必须是一个 JSON object，格式为：",
		"{\"title\":\"简短任务标题\",\"steps\":[{\"id\":\"stable-id\",\"title\":\"简短 Todo 标题\",\"instruction\":\"给执行模型的具体指令\",\"toolGroup\":\"read|write|verify|summarize\",\"acceptanceCriteria\":[\"可判定验收标准\"],\"skillId\":null,\"promptId\":\"godot.assistant\"}]}",
		"toolGroup 只能选择：",
		"- read：只读项目上下文。",
		"- write：允许读取和实际写入，写入仍会走后端审批。",
		"- verify：允许读取和运行安全验证。",
		"- summarize：不使用工具，只总结交付。",
		"规则：",
		`- steps 数量 1-${MAX_LLM_WORKFLOW_STEPS}。`,
		"- 每个 title 必须是前端 Todo 可显示的短标题，不要写长描述。",
		"- 每个 step 必须给出 acceptanceCriteria，标准要能由工具事实或后端验证判定，不要写“模型认为完成”。",
		"- 复杂修改通常包含 read/write/verify/summarize；简单问答可以只有 summarize。",
		"- 最后一步必须能给用户最终交付总结，优先使用 toolGroup=summarize。",
		"- 如果上下文显示 Godot 编辑器在线，且用户目标指向当前打开场景、选中节点、当前脚本/这几行或 FileSystem Dock 选中项，read/write 步骤应让执行模型优先使用 godot_editor 工具；若编辑器离线、stale 或不匹配，则回退到离线 .tscn/text/headless 工具。",
		"- 当前打开场景由 godot_editor patch 成功修改后，后续步骤不得再用离线 `.tscn` 文本工具覆盖同一场景；如果 patch 能力不足而必须切换路径，应先重新读取并显式要求执行模型协调编辑器内状态与磁盘状态。",
		"- 如果用户询问运行报错、日志、user://logs/godot.log 或项目设置，read 步骤应收集日志配置/日志内容/当前项目设置；修改项目设置时使用 write 步骤，并要求执行模型先预览再实际写入。",
		"- 如果用户询问 Godot 编辑器设置、主题、字体、最近项目、当前打开场景/脚本或 .godot/editor 状态，read 步骤应收集编辑器配置摘要；除非用户明确要求原始路径/原文，否则保持脱敏读取。",
		"- 修改 GDScript 的任务应包含 verify 步骤，让执行模型优先读取 LSP diagnostics，再运行 Godot check-only；运行时报错排查应优先尝试 DAP last error / stack trace，失败后再回退项目日志。",
		"- 修订计划时不能删除未解决 failedChecks，除非后续 verify/reverify 已证明修复完成。",
		"- 不要输出 tool 名称，后端会根据 toolGroup 决定安全工具集合。"
	].join("\n");
}

function createInitialPlanMessage(userMessage: string, planningContext: string): string {
	return [
		"请为下面用户需求生成可执行 Todo 计划。",
		"",
		"## 用户需求",
		userMessage,
		"",
		"## 当前后端注入上下文",
		clipPlanningContext(planningContext)
	].join("\n");
}

function createRevisionMessage(
	plan: WorkflowPlan,
	completedPhaseIndex: number,
	userMessage: string,
	phaseOutputs: WorkflowPhaseOutput[],
	planningContext: string
): string {
	const completedPhases: WorkflowPhase[] = plan.phases.slice(0, completedPhaseIndex + 1);
	const pendingPhases: WorkflowPhase[] = plan.phases.slice(completedPhaseIndex + 1);
	return [
		"请根据已完成步骤结果，修订后续 pending Todo。只能替换未执行步骤，不能改已完成步骤。",
		"如果已完成步骤输出包含 failedChecks 或 requiredFixes，pending steps 必须覆盖这些问题，不能直接删除或跳过。",
		"",
		"## 用户原始需求",
		userMessage,
		"",
		"## 已完成步骤",
		JSON.stringify(completedPhases.map((phase: WorkflowPhase) => ({ id: phase.id, title: phase.title, toolGroup: phase.toolGroup ?? null }))),
		"",
		"## 已完成步骤输出",
		phaseOutputs.map(formatPhaseOutputForPlanner).join("\n\n"),
		"",
		"## 当前 pending 步骤",
		JSON.stringify(pendingPhases.map((phase: WorkflowPhase) => ({ id: phase.id, title: phase.title, instruction: phase.instruction, toolGroup: phase.toolGroup ?? null }))),
		"",
		"## 当前后端注入上下文",
		clipPlanningContext(planningContext),
		"",
		"请只输出完整替换后的 pending steps。若无需调整，原样输出 pending steps。不要输出已完成步骤，不要复用已完成步骤 id。"
	].join("\n");
}

function parseLlmPlan(text: string): LlmPlan {
	const parsed: unknown = parseJsonObject(text);
	return llmPlanSchema.parse(parsed);
}

function parseJsonObject(text: string): unknown {
	return parseJsonObjectFromLlm(text, "LLM planner did not return valid JSON");
}

function createWorkflowPlanFromLlmPlan(rawPlan: LlmPlan, userMessage: string): WorkflowPlan | null {
	const phases: WorkflowPhase[] = createPhasesFromSteps(rawPlan.steps);
	if (phases.length === 0) {
		return null;
	}

	return {
		id: createWorkflowId(),
		title: rawPlan.title ?? createWorkflowTitle(userMessage),
		phases,
		todos: createTodos(phases),
		source: "llm",
		revision: 0,
		maxRevisions: MAX_LLM_WORKFLOW_REVISIONS
	};
}

function createPhasesFromSteps(steps: LlmPlanStep[]): WorkflowPhase[] {
	return createPhasesFromStepsWithReservedIds(steps, new Set());
}

function createPhasesFromStepsWithReservedIds(steps: LlmPlanStep[], reservedIds: Set<string>): WorkflowPhase[] {
	const trimmedSteps: LlmPlanStep[] = ensureSummaryStep(steps.slice(0, MAX_LLM_WORKFLOW_STEPS));
	const usedIds: Set<string> = new Set(reservedIds);
	return trimmedSteps.map((step: LlmPlanStep, index: number): WorkflowPhase => createPhaseFromStep(step, index, usedIds));
}

function ensureSummaryStep(steps: LlmPlanStep[]): LlmPlanStep[] {
	if (steps.length === 0) {
		return [{
			id: "summarize",
			title: "总结交付",
			instruction: "直接回答用户需求，说明结论和必要的后续建议。",
			toolGroup: "summarize",
			acceptanceCriteria: ["用户需求已经被直接回答，且没有未解决的验证失败或审批。"],
			promptId: "godot.assistant"
		}];
	}

	const lastStep: LlmPlanStep | undefined = steps[steps.length - 1];
	if (lastStep?.toolGroup === "summarize") {
		return steps;
	}

	const baseSteps: LlmPlanStep[] = steps.length >= MAX_LLM_WORKFLOW_STEPS
		? steps.slice(0, MAX_LLM_WORKFLOW_STEPS - 1)
		: steps;

	return [
		...baseSteps,
		{
			id: "summarize",
			title: "总结交付",
			instruction: "基于前面步骤结果给用户最终总结，说明完成内容、验证状态和剩余风险。",
			toolGroup: "summarize",
			acceptanceCriteria: ["所有前置步骤已完成，验证失败、审批和阻塞状态已被如实说明。"],
			promptId: "godot.assistant"
		}
	];
}

function createPhaseFromStep(step: LlmPlanStep, index: number, usedIds: Set<string>): WorkflowPhase {
	const toolGroup: WorkflowToolGroup = step.toolGroup;
	const skillId: SkillId | undefined = normalizeSkillId(step.skillId ?? defaultSkillForToolGroup(toolGroup));
	const promptId: PromptId | undefined = step.promptId ?? defaultPromptForToolGroup(toolGroup);
	return {
		id: createUniqueStepId(step.id ?? step.title, index, usedIds),
		title: clipText(step.title, 32),
		toolGroup,
		skillId,
		promptId,
		toolBudget: getToolBudgetForToolGroup(toolGroup),
		allowedTools: getAllowedToolsForLlmPlannedStep(toolGroup, step.title, step.instruction),
		instruction: clipText(step.instruction, MAX_PHASE_INSTRUCTION_CHARS),
		acceptanceCriteria: normalizeAcceptanceCriteria(step.acceptanceCriteria, toolGroup),
		completionContract: createWorkflowCompletionContract(toolGroup, step.title, step.instruction, step.acceptanceCriteria),
		requireToolCallOnFirstStep: toolGroup === "write" || toolGroup === "verify" ? true : undefined
	};
}

function mergeRevisedPendingSteps(plan: WorkflowPlan, firstPendingIndex: number, rawPlan: LlmPlan): WorkflowPlan {
	const completedPhases: WorkflowPhase[] = plan.phases.slice(0, firstPendingIndex);
	const completedPhaseIds: Set<string> = new Set(completedPhases.map((phase: WorkflowPhase): string => phase.id));
	const completedPhaseTitles: Set<string> = new Set(completedPhases.map((phase: WorkflowPhase): string => phase.title.toLowerCase()));
	const usableSteps: LlmPlanStep[] = rawPlan.steps.filter((step: LlmPlanStep, index: number): boolean => (
		!doesStepRepeatCompletedPhase(step, index, completedPhaseIds, completedPhaseTitles)
	));
	const previousPendingPhases: WorkflowPhase[] = plan.phases.slice(firstPendingIndex);
	const revisedPendingPhases: WorkflowPhase[] = usableSteps.length > 0
		? createPhasesFromStepsWithReservedIds(usableSteps, completedPhaseIds)
		: previousPendingPhases.map((phase: WorkflowPhase): WorkflowPhase => ({
			...phase,
			allowedTools: [...phase.allowedTools],
			completionContract: phase.completionContract === undefined
				? undefined
				: {
					requireAll: phase.completionContract.requireAll,
					targets: phase.completionContract.targets.map((target) => ({ ...target }))
				}
		}));
	const phases: WorkflowPhase[] = [...completedPhases, ...revisedPendingPhases];
	const completedTodos: WorkflowTodoItem[] = plan.todos.filter((todo: WorkflowTodoItem): boolean => completedPhaseIds.has(todo.phaseId));
	const revisedPendingPhaseIds: Set<string> = new Set(revisedPendingPhases.map((phase: WorkflowPhase): string => phase.id));

	return {
		...plan,
		title: plan.title,
		phases,
		todos: [
			...completedTodos,
			...createVisibleWorkflowTodos(phases).filter((
				todo: WorkflowTodoItem
			): boolean => revisedPendingPhaseIds.has(todo.phaseId))
		],
		revision: (plan.revision ?? 0) + 1
	};
}

function doesStepRepeatCompletedPhase(
	step: LlmPlanStep,
	index: number,
	completedPhaseIds: Set<string>,
	completedPhaseTitles: Set<string>
): boolean {
	const stepId: string | undefined = step.id?.trim();
	if (stepId !== undefined && completedPhaseIds.has(normalizeStepId(stepId, index))) {
		return true;
	}

	if (completedPhaseIds.has(normalizeStepId(step.title, index))) {
		return true;
	}

	return completedPhaseTitles.has(step.title.trim().toLowerCase());
}

function createTodos(phases: WorkflowPhase[]): WorkflowTodoItem[] {
	return createVisibleWorkflowTodos(phases);
}

function createUniqueStepId(value: string, index: number, usedIds: Set<string>): string {
	const baseId: string = normalizeStepId(value, index);
	let nextId: string = baseId;
	let suffix: number = 2;
	while (usedIds.has(nextId)) {
		nextId = `${baseId}-${suffix}`;
		suffix += 1;
	}
	usedIds.add(nextId);
	return nextId;
}

function normalizeStepId(value: string, index: number): string {
	const normalized: string = value
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const fallback: string = `step-${index + 1}`;
	return normalized.length > 0 ? normalized : fallback;
}

function normalizeSkillId(value: string | null | undefined): SkillId | undefined {
	if (value === null || value === undefined || value.length === 0) {
		return undefined;
	}

	return isSkillId(value) ? value : undefined;
}

function defaultSkillForToolGroup(toolGroup: WorkflowToolGroup): SkillId | undefined {
	if (toolGroup === "write") {
		return "file.creator";
	}

	return undefined;
}

function defaultPromptForToolGroup(toolGroup: WorkflowToolGroup): PromptId | undefined {
	if (toolGroup === "summarize" || toolGroup === "write") {
		return "godot.assistant";
	}

	return undefined;
}

function getToolBudgetForToolGroup(toolGroup: WorkflowToolGroup): ToolBudgetLevel {
	if (toolGroup === "write") {
		return "project_edit";
	}
	if (toolGroup === "summarize") {
		return "simple";
	}

	return "normal";
}

function getAllowedToolsForToolGroup(toolGroup: WorkflowToolGroup): string[] {
	if (toolGroup === "write") {
		return [...READ_TOOLS, ...WRITE_TOOLS];
	}
	if (toolGroup === "verify") {
		return [...READ_TOOLS, ...VERIFY_TOOLS];
	}
	if (toolGroup === "summarize") {
		return [];
	}

	return [...READ_TOOLS];
}

function normalizeAcceptanceCriteria(criteria: string[] | undefined, toolGroup: WorkflowToolGroup): string[] {
	const normalized: string[] = (criteria ?? [])
		.map((item: string): string => item.trim())
		.filter((item: string): boolean => item.length > 0)
		.slice(0, 8);
	if (normalized.length > 0) {
		return normalized;
	}
	if (toolGroup === "verify") {
		return ["已实际运行可判定的诊断或验证工具，且没有未解决失败。"];
	}
	if (toolGroup === "write") {
		return ["必要修改已通过实际写入工具完成，审批状态已处理。"];
	}
	if (toolGroup === "summarize") {
		return ["所有前置步骤完成后再总结，不覆盖未解决失败。"];
	}
	return ["已收集完成当前步骤所需事实。"];
}

function limitPlanningHistory(history: ChatMessage[]): ChatMessage[] {
	return history.slice(-6);
}

function clipPlanningContext(context: string): string {
	return clipText(context, MAX_PLANNING_CONTEXT_CHARS);
}

function clipText(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}

	return `${text.slice(0, maxChars)}\n\n[内容已截断，原始长度 ${text.length} 字符]`;
}

function formatPhaseOutputForPlanner(output: WorkflowPhaseOutput): string {
	const lines: string[] = [
		`### ${output.title}（${output.phaseId}）`,
		`status: ${output.status}`,
		clipText(output.summary, 1200)
	];
	if (output.failedChecks.length > 0) {
		lines.push("failedChecks:");
		lines.push(...output.failedChecks.map((check): string => `- ${check.message}`));
	}
	if (output.requiredFixes.length > 0) {
		lines.push("requiredFixes:");
		lines.push(...output.requiredFixes.map((fix: string): string => `- ${fix}`));
	}
	if (output.text !== undefined && output.text.trim().length > 0) {
		lines.push("rawText:");
		lines.push(clipText(output.text, 2000));
	}
	return lines.join("\n");
}
