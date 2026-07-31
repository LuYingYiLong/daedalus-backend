import type { AiChatParams } from "../protocol/types.js";
import type {
	WorkflowPhase,
	WorkflowPhaseOutput,
	WorkflowPlan,
	WorkflowTodoItem,
	WorkflowTodoSnapshot,
	WorkflowTodoStatus
} from "./types.js";

const MAX_PHASE_OUTPUT_CHARS: number = 5000;

export function createWorkflowTodoSnapshot(
	plan: WorkflowPlan,
	phaseOutcomes: WorkflowPhaseOutput[] = [],
	activePhaseRunId?: string | undefined
): WorkflowTodoSnapshot {
	return {
		workflowId: plan.id,
		title: plan.title,
		source: plan.source,
		revision: plan.revision,
		phases: plan.phases.map((phase: WorkflowPhase) => ({
			id: phase.id,
			title: phase.title,
			status: getPhaseStatus(plan, phase.id)
		})),
		todos: plan.todos.map((todo: WorkflowTodoItem) => ({ ...todo })),
		phaseOutcomes: phaseOutcomes.map((output: WorkflowPhaseOutput): WorkflowPhaseOutput => ({ ...output })),
		activePhaseRunId,
		repairRound: Math.max(0, ...plan.phases.map((phase: WorkflowPhase): number => phase.repairRound ?? 0)),
		blockedReason: findLastBlockedReason(phaseOutcomes)
	};
}

export function updateWorkflowPhaseStatus(plan: WorkflowPlan, phaseId: string, status: WorkflowTodoStatus): WorkflowPlan {
	return {
		...plan,
		todos: plan.todos.map((todo: WorkflowTodoItem): WorkflowTodoItem => (
			todo.phaseId === phaseId ? { ...todo, status } : todo
		))
	};
}

export function markRemainingWorkflowTodos(plan: WorkflowPlan, status: WorkflowTodoStatus): WorkflowPlan {
	return {
		...plan,
		todos: plan.todos.map((todo: WorkflowTodoItem): WorkflowTodoItem => (
			todo.status === "done" ? todo : { ...todo, status }
		))
	};
}

export function createPhaseMessage(
	originalParams: AiChatParams,
	plan: WorkflowPlan,
	phase: WorkflowPhase,
	phaseOutputs: WorkflowPhaseOutput[]
): string {
	const previousResults: string = phaseOutputs.length > 0
		? phaseOutputs.map(formatPhaseOutput).join("\n\n")
		: "（暂无上一阶段结果）";

	return [
		`当前执行工作流：${plan.title}`,
		`当前阶段：${phase.title}（${phase.id}）`,
		"",
		"## 用户原始需求",
		originalParams.message,
		"",
		"## 当前阶段指令",
		phase.instruction,
		"",
		"## 当前阶段验收标准",
		formatAcceptanceCriteria(phase.acceptanceCriteria),
		"",
		"## 上一阶段结果",
		previousResults,
		"",
		"请只完成当前阶段。不要跳过后续阶段，不要输出最终交付总结，除非当前阶段是最后一步或阶段指令明确要求总结。"
	].join("\n");
}

export function createPhaseParams(originalParams: AiChatParams, phase: WorkflowPhase, message: string, stream: boolean): AiChatParams {
	const options: AiChatParams["options"] & Record<string, unknown> = {
		...(originalParams.options ?? {}),
		stream,
		toolBudget: phase.toolBudget,
		workflow: "single"
	};
	if (phase.requireToolCallOnFirstStep === true) {
		options.requireToolCallOnFirstStep = true;
	}
	return {
		...originalParams,
		message,
		promptId: phase.promptId ?? originalParams.promptId,
		skillRefs: originalParams.skillRefs,
		options
	};
}

function formatConversationMode(mode: string | undefined): string {
	if (mode === "ask") {
		return "Ask";
	}
	if (mode === "plan") {
		return "Plan";
	}
	return "Agent";
}

export function createPhasePrompt(phase: WorkflowPhase, skillPrompt: string, mcpSystemContext: string, conversationMode?: string | undefined): string {
	const toolGroupRules: string[] = createPhaseToolGroupRules(phase);
	const completionRules: string[] = createPhaseCompletionRules(phase);
	const modeLabel: string = formatConversationMode(conversationMode);
	return [
		"## 工作流阶段约束",
		`- 当前会话模式：${modeLabel} 模式。`,
		"- 当前阶段可用工具只是 workflow 阶段限制，不代表会话模式；不要因为当前阶段只有只读工具或没有写工具就声称当前是 Ask 模式。",
		`- 当前阶段：${phase.title}（${phase.id}）`,
		`- 阶段目标：${phase.instruction}`,
		`- 验收标准：${formatAcceptanceCriteria(phase.acceptanceCriteria)}`,
		"- 只完成当前阶段，不要跳过后续阶段。",
		"- 如果需要写入或执行审批工具，按现有审批流程暂停。",
		...toolGroupRules,
		...completionRules,
		"- 当前阶段实际可用工具：",
		...phase.allowedTools.map((toolName: string): string => `  - ${toolName}`),
		"",
		skillPrompt,
		mcpSystemContext
	].filter((part: string): boolean => part.length > 0).join("\n\n");
}

function formatAcceptanceCriteria(criteria: string[] | undefined): string {
	if (criteria === undefined || criteria.length === 0) {
		return "（未指定，按阶段目标和工具事实判定）";
	}

	return criteria.map((item: string): string => `- ${item}`).join("\n");
}

function createPhaseToolGroupRules(phase: WorkflowPhase): string[] {
	if (phase.toolGroup === "write") {
		return [
			"- 当前是写入/提案阶段：如果阶段目标是预览、提案或 diff，必须调用对应 propose_* 工具。",
			"- 如果阶段目标是实际创建、修改、删除或应用补丁，必须调用实际写入工具；写入工具触发审批时按现有流程暂停。",
			"- Godot 编辑器在线且目标是当前打开场景时，优先通过 editor scene patch 修改；同一 Run 不要在 editor patch 成功后再用原始 `.tscn` 文本覆盖同一场景。只有 patch 无法表达目标或编辑器不可用时才切换到离线场景工具，并在切换前重新读取场景。",
			"- 只修改当前任务直接相关的目标文件；不要创建占位文件、临时文件或无关文件来满足写入要求。",
			"- 修改 `.ts`、`.tsx`、`.js`、`.jsx`、Electron 或前端文件时，不要运行 `godot.check_only` 或 `godot.validate_scene`；后续验证应使用 `workspace.typecheck`、`git.diff` 或其它 workspace/TypeScript 验证。",
			"- 不要只输出计划、意图或“稍后将执行”；后端会把未调用当前阶段所需工具的阶段视为未完成。"
		];
	}

	if (phase.toolGroup === "verify") {
		return [
			"- 当前是验证阶段：优先实际调用诊断或验证工具，不要只描述验证计划。",
			"- 验证 `.ts`、`.tsx`、`.js`、`.jsx`、Electron 或前端修改时，优先调用 `mcp_terminal_run_safe_preset` 的 `workspace.typecheck`；可辅以 `git.diff`。不要把这些文件传给 Godot 预设。",
			"- `godot.check_only` 只用于 `.gd`；`godot.validate_scene` 只用于 `.tscn`。不要对 TypeScript、前端或普通 workspace 文件使用 Godot 预设。",
			"- 如果验证失败或发现需要修改的问题，不要声称阶段完成；明确列出失败点和需要修复的内容。",
			"- 当前阶段没有写入职责；不要说“接下来我会修改”后直接结束。需要修改时明确交给后续修复阶段。"
		];
	}

	return [];
}

function createPhaseCompletionRules(phase: WorkflowPhase): string[] {
	if (phase.toolGroup === "summarize") {
		return [
			"- 当前是专门的最终总结阶段：不要调用工具，只基于用户需求和上一阶段结果交付最终答复。",
			"- 总结应说明已完成的改动、验证结果、未覆盖或受环境限制的事项，以及用户接下来可采取的动作。",
			"- 不要把准备继续读取、准备调用工具或准备修改文件写成最终结论；如果资料不足，明确说明限制。"
		];
	}

	return [
		"- 当前不是最终总结阶段：不要输出完整交付总结、使用说明或阶段性收尾长文。",
		"- 阶段末尾只保留一两句事实性进展：完成了什么、发现了什么、是否需要后续阶段处理。",
		"- 不要说“最终”“总结如下”“已全部完成”等会让用户误以为长任务结束的措辞。"
	];
}

export function appendPhaseOutput(outputs: WorkflowPhaseOutput[], _phase: WorkflowPhase, output: WorkflowPhaseOutput): WorkflowPhaseOutput[] {
	const text: string | undefined = output.text;
	const clippedText: string | undefined = text !== undefined && text.length > MAX_PHASE_OUTPUT_CHARS
		? `${text.slice(0, MAX_PHASE_OUTPUT_CHARS)}\n\n[阶段输出已截断，原始长度 ${text.length} 字符]`
		: text;

	return [
		...outputs,
		{
			...output,
			text: clippedText
		}
	];
}

function formatPhaseOutput(output: WorkflowPhaseOutput): string {
	const parts: string[] = [
		`### ${output.title}`,
		`status: ${output.status}`,
		output.summary
	];
	if (output.failedChecks.length > 0) {
		parts.push("failedChecks:");
		parts.push(...output.failedChecks.map((check): string => `- ${check.message}`));
	}
	if (output.requiredFixes.length > 0) {
		parts.push("requiredFixes:");
		parts.push(...output.requiredFixes.map((fix: string): string => `- ${fix}`));
	}
	if (output.warnings !== undefined && output.warnings.length > 0) {
		parts.push("warnings:");
		parts.push(...output.warnings.map((warning: string): string => `- ${warning}`));
	}
	if (output.text !== undefined && output.text.trim().length > 0) {
		parts.push("rawText:");
		parts.push(output.text);
	}
	return parts.join("\n");
}

function getPhaseStatus(plan: WorkflowPlan, phaseId: string): WorkflowTodoStatus {
	const phaseTodos: WorkflowTodoItem[] = plan.todos.filter((todo: WorkflowTodoItem): boolean => todo.phaseId === phaseId);
	if (phaseTodos.some((todo: WorkflowTodoItem): boolean => todo.status === "failed")) {
		return "failed";
	}
	if (phaseTodos.some((todo: WorkflowTodoItem): boolean => todo.status === "paused")) {
		return "paused";
	}
	if (phaseTodos.some((todo: WorkflowTodoItem): boolean => todo.status === "running")) {
		return "running";
	}
	if (phaseTodos.length > 0 && phaseTodos.every((todo: WorkflowTodoItem): boolean => todo.status === "done")) {
		return "done";
	}

	return "pending";
}

function findLastBlockedReason(phaseOutcomes: WorkflowPhaseOutput[]): string | undefined {
	for (let index: number = phaseOutcomes.length - 1; index >= 0; index -= 1) {
		const output: WorkflowPhaseOutput | undefined = phaseOutcomes[index];
		if (output?.status === "blocked") {
			return output.blockedReason ?? output.summary;
		}
	}

	return undefined;
}
