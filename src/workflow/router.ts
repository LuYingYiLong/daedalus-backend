import { z } from "zod";
import type { AiChatParams, ChatMessage } from "../protocol/types.js";
import { chatWithDeepSeek, type ProviderChatOptions } from "../providers/deepseek-client.js";
import { parseJsonObjectFromLlm } from "../providers/llm-json.js";
import { isExplicitReadOnlyRequest } from "./planner.js";
import type { AgentRunIntent, AgentRunLane, AgentRunScope } from "./agent-run-state.js";

export type WorkflowOption = NonNullable<NonNullable<AiChatParams["options"]>["workflow"]>;

export type WorkflowRouteDecision = {
	intent: AgentRunIntent;
	scope: AgentRunScope;
	lane: AgentRunLane;
	reason: string;
	planningHint: string;
	forcedByOption?: WorkflowOption | undefined;
	safetyOverride?: string | undefined;
};

export type WorkflowRouteContext = {
	workspaceSummary: string;
	editorSummary: string;
	additionalContextSummary: string;
};

const workflowRouteSchema = z.object({
	intent: z.enum(["answer", "inspect", "mutate"]),
	scope: z.enum(["bounded", "unknown", "complex"]),
	lane: z.enum(["direct", "read", "probe", "lightweight", "workflow"]),
	reason: z.string().min(1).max(500).optional(),
	planningHint: z.string().max(1000).optional()
}).strict();

type RawWorkflowRouteDecision = z.infer<typeof workflowRouteSchema>;

export function resolveForcedWorkflowRoute(params: AiChatParams): WorkflowRouteDecision | null {
	const workflowMode = params.options?.workflow ?? "auto";
	if (workflowMode === "auto") {
		return null;
	}

	if (workflowMode === "single") {
		const mutate: boolean = hasWriteIntent(params.message);
		return applyWorkflowRouteSafety({
			intent: mutate ? "mutate" : "inspect",
			scope: "bounded",
			lane: mutate ? "lightweight" : "read",
			reason: "Explicit workflow=single forces hidden single-turn execution.",
			planningHint: "",
			forcedByOption: workflowMode
		}, params);
	}

	return applyWorkflowRouteSafety({
		intent: "mutate",
		scope: "complex",
		lane: "workflow",
		reason: `Explicit workflow=${workflowMode} forces workflow execution.`,
		planningHint: "",
		forcedByOption: workflowMode
	}, params);
}

export async function routeWorkflowExecution(
	params: AiChatParams,
	options: ProviderChatOptions,
	history: ChatMessage[],
	context: WorkflowRouteContext,
	abortSignal?: AbortSignal | undefined
): Promise<WorkflowRouteDecision> {
	const forcedRoute: WorkflowRouteDecision | null = resolveForcedWorkflowRoute(params);
	if (forcedRoute !== null) {
		return forcedRoute;
	}

	const text: string = await chatWithDeepSeek(
		createRouterParams(createRouteUserMessage(params, context)),
		options,
		limitRoutingHistory(history),
		createRouteSystemPromptV3(),
		abortSignal
	);
	return applyProjectContextRouteOverride(normalizeWorkflowRouteDecision(parseWorkflowRouteDecision(text), params), params, context);
}

export function createFallbackWorkflowRoute(params: AiChatParams, reason: string = "Workflow router failed."): WorkflowRouteDecision {
	const mutate: boolean = hasWriteIntent(params.message);
	const complex: boolean = mutate && hasComplexWriteIntent(params.message);
	return applyWorkflowRouteSafety({
		intent: mutate ? "mutate" : "inspect",
		scope: complex ? "complex" : mutate ? "unknown" : "bounded",
		lane: complex ? "workflow" : mutate ? "probe" : "read",
		reason,
		planningHint: complex
			? "Router failed and the request appears complex or destructive. Create a focused implementation and verification workflow."
			: "",
		safetyOverride: "router_fallback"
	}, params);
}

export function normalizeWorkflowRouteDecision(raw: RawWorkflowRouteDecision, params: AiChatParams): WorkflowRouteDecision {
	const explicitMutationIntent: boolean = hasWriteIntent(params.message);
	const complexMutation: boolean = explicitMutationIntent && hasComplexWriteIntent(params.message);
	const intent: AgentRunIntent = explicitMutationIntent ? "mutate" : raw.intent;
	const scope: AgentRunScope = complexMutation
		? "complex"
		: intent === "mutate" && raw.scope === "bounded" && raw.lane === "direct"
			? "unknown"
			: raw.scope;
	const lane: AgentRunLane = normalizeLane(intent, scope, raw.lane);
	const decision: WorkflowRouteDecision = {
		intent,
		scope,
		lane,
		reason: [
			raw.reason?.trim() || "Routed by workflow router.",
			explicitMutationIntent && raw.intent !== "mutate"
				? "Deterministic safety guard preserved the user's mutation intent."
				: ""
		].filter((part: string): boolean => part.length > 0).join(" "),
		planningHint: raw.planningHint?.trim() ?? ""
	};
	return applyWorkflowRouteSafety(decision, params);
}

export function applyProjectContextRouteOverride(
	decision: WorkflowRouteDecision,
	params: AiChatParams,
	context: WorkflowRouteContext
): WorkflowRouteDecision {
	if (decision.lane !== "direct" || decision.intent === "mutate" || explicitlyAvoidsProjectReads(params.message)) {
		return decision;
	}
	if (!requiresCurrentProjectRead(params.message, context)) {
		return decision;
	}

	return {
		...decision,
		intent: "inspect",
		scope: "bounded",
		lane: "read",
		safetyOverride: "project_context_read",
		reason: `${decision.reason} Current project context requires read-only tools.`
	};
}

export function applyWorkflowRouteSafety(decision: WorkflowRouteDecision, params: AiChatParams): WorkflowRouteDecision {
	const explicitReadOnly: boolean = isExplicitReadOnlyRequest(params.message.toLowerCase());
	if (!explicitReadOnly && params.mode !== "ask") {
		return decision;
	}

	if (decision.intent !== "mutate") {
		return decision;
	}

	return {
		...decision,
		intent: "inspect",
		scope: "bounded",
		lane: "read",
		planningHint: "",
		safetyOverride: explicitReadOnly ? "explicit_read_only" : "ask_mode_read_only",
		reason: `${decision.reason} Safety override forced read-only tool answer.`
	};
}

function normalizeLane(intent: AgentRunIntent, scope: AgentRunScope, requestedLane: AgentRunLane): AgentRunLane {
	if (intent === "answer") {
		return "direct";
	}
	if (intent === "inspect") {
		return "read";
	}
	if (scope === "complex") {
		return "workflow";
	}
	if (scope === "unknown") {
		return "probe";
	}
	return requestedLane === "workflow" ? "workflow" : "lightweight";
}

function parseWorkflowRouteDecision(text: string): RawWorkflowRouteDecision {
	return workflowRouteSchema.parse(parseJsonObjectFromLlm(text, "Workflow router did not return valid JSON"));
}

export function hasWriteIntent(message: string): boolean {
	const normalized: string = message.toLowerCase();
	if (isExplicitReadOnlyRequest(normalized)) {
		return false;
	}

	return [
		"帮我改",
		"改一下",
		"修改",
		"修复",
		"实现",
		"完善",
		"新增",
		"添加",
		"创建",
		"生成",
		"编写",
		"搭建",
		"帮我做",
		"删除",
		"替换",
		"更新",
		"重构",
		"迁移",
		"批量",
		"清空",
		"卸载",
		"apply",
		"change",
		"modify",
		"fix",
		"implement",
		"create",
		"add",
		"delete",
		"replace",
		"update",
		"refactor",
		"migrate",
		"migration",
		"batch",
		"clear"
	].some((keyword: string): boolean => normalized.includes(keyword));
}

export function hasComplexWriteIntent(message: string): boolean {
	const normalized: string = message.toLowerCase();
	return [
		"多文件",
		"多个文件",
		"跨文件",
		"全部文件",
		"整个项目",
		"整个仓库",
		"批量",
		"迁移",
		"重构",
		"架构",
		"完整实现",
		"全面",
		"立个计划",
		"制定计划",
		"先计划",
		"执行计划",
		"删除",
		"卸载",
		"清空",
		"覆盖全部",
		"替换全部",
		"multi-file",
		"multiple files",
		"across files",
		"whole project",
		"entire project",
		"batch",
		"migrate",
		"migration",
		"refactor",
		"architecture",
		"make a plan",
		"plan first",
		"execute the plan",
		"delete",
		"remove all",
		"clear",
		"rewrite"
	].some((keyword: string): boolean => normalized.includes(keyword));
}

function includesAny(text: string, terms: readonly string[]): boolean {
	return terms.some((term: string): boolean => text.includes(term));
}

function createRouterParams(message: string): AiChatParams {
	return {
		message,
		options: {
			temperature: 0,
			maxTokens: 700,
			responseFormat: "json",
			workflow: "single"
		}
	};
}

function createRouteSystemPrompt(): string {
	return [
		"你是 Godot Daedalus 的执行路由器，只输出 JSON，不调用工具，不解释。",
		"判断本轮请求应该使用哪种执行形态：",
		"- direct_answer：普通问答、解释、建议、无需读取实时项目事实。",
		"- tool_answer：隐藏的轻量执行。可用于读取/验证，也可用于目标明确、低风险、最多两个逻辑写入的单点修改；不创建多阶段 Todo。",
		"- workflow：复杂、多步骤、破坏性或范围不明确的执行，需要多文件联动、迁移、批量修改、长流程或明确要求执行计划。",
		"输出格式：",
		"{\"execution\":\"direct_answer|tool_answer|workflow\",\"reason\":\"简短原因\",\"requiresTools\":true,\"requiresWrite\":false,\"planningHint\":\"给后续 planner 的简短提示\"}",
		"规则：",
		"- 简单动态事实查询，例如当前 workspace、文件数量、状态、路径，选 tool_answer。",
		"- 代码解释、概念说明、方案讨论，选 direct_answer，除非必须读取当前文件。",
		"- 涉及当前项目、仓库、工作区、已有 UI、组件、文件、代码结构或实现细节的问题，选 tool_answer，即使用户只是要建议或明确先不修改文件。",
		"- “先不动文件/不要修改”只禁止写入，不禁止读取；不能因此选 direct_answer。",
		"- 创建、修改、修复、生成项目内容本身不等于 workflow。单文件、单一目标、预计一至两个写操作的普通修改选 tool_answer，并设置 requiresWrite=true。",
		"- 跨文件联动、重构、迁移、批量变更、删除/清空等破坏性操作、需要多轮决策或用户明确要求计划时，选 workflow。",
		"- 如果修改范围暂不确定但可通过一次最小读取确认，优先选 tool_answer；轻量执行发现超出边界后会升级。",
		"- 用户明确只读/不要修改时 requiresWrite 必须为 false。",
		"- 不要因为存在 workspace/editor 上下文就自动选 workflow。"
	].join("\n");
}

function createRouteSystemPromptV3(): string {
	return [
		"You are the Daedalus execution router. Return JSON only. Do not call tools.",
		"Separate the user's intent, the known scope, and the execution lane.",
		"- intent=answer: explanation or advice that does not require current project facts.",
		"- intent=inspect: read or verify current project facts without mutation.",
		"- intent=mutate: the user expects files, resources, settings, or project state to change.",
		"- scope=bounded: one clear target and no more than two logical writes.",
		"- scope=unknown: a small read-only probe is needed before the write scope is known.",
		"- scope=complex: multi-file coordination, migration, destructive work, a long operation, or explicit planning.",
		"- lane=direct for answer, read for inspect, probe for unknown mutation, lightweight for bounded mutation, workflow for complex mutation.",
		"Creating, modifying, fixing, or generating something does not by itself require workflow.",
		"Ask mode and explicit read-only requests must never use a mutation lane.",
		"Output exactly:",
		"{\"intent\":\"answer|inspect|mutate\",\"scope\":\"bounded|unknown|complex\",\"lane\":\"direct|read|probe|lightweight|workflow\",\"reason\":\"short reason\",\"planningHint\":\"short planner hint\"}"
	].join("\n");
}

function createRouteUserMessage(params: AiChatParams, context: WorkflowRouteContext): string {
	return [
		"## 用户请求",
		params.message,
		"",
		"## 会话模式",
		params.mode ?? "agent",
		"",
		"## Workspace",
		context.workspaceSummary,
		"",
		"## Editor",
		context.editorSummary,
		"",
		"## Additional Context",
		context.additionalContextSummary
	].join("\n");
}

function limitRoutingHistory(history: ChatMessage[]): ChatMessage[] {
	return history.slice(-4);
}

function requiresCurrentProjectRead(message: string, context: WorkflowRouteContext): boolean {
	if (context.workspaceSummary === "No active workspace.") {
		return false;
	}

	const normalizedMessage: string = normalizeRouteText(message);
	if (getWorkspaceReferenceCandidates(context).some((candidate: string): boolean => normalizedMessage.includes(candidate))) {
		return true;
	}

	const lowerMessage: string = message.toLowerCase();
	return includesAny(lowerMessage, [
		"当前",
		"现有",
		"已有",
		"这个项目",
		"这个仓库",
		"项目里",
		"代码里",
		"实现",
		"结构",
		"标题栏",
		"菜单栏",
		"组件",
		"页面",
		"hook",
		"ipc",
		"rpc",
		"renderer",
		"preload"
	]) && includesAny(lowerMessage, [
		"项目",
		"仓库",
		"workspace",
		"工作区",
		"代码",
		"文件",
		"实现",
		"结构",
		"ui",
		"界面",
		"标题栏",
		"菜单栏",
		"组件",
		"页面",
		"前端",
		"后端",
		"electron",
		"react",
		"antd"
	]);
}

function explicitlyAvoidsProjectReads(message: string): boolean {
	const lowerMessage: string = message.toLowerCase();
	return includesAny(lowerMessage, [
		"不要读取",
		"不用读取",
		"无需读取",
		"不要查文件",
		"不用查文件",
		"不要看文件",
		"不用看文件",
		"不要看代码",
		"不用看代码",
		"别看代码",
		"只凭经验",
		"泛泛说",
		"do not read",
		"don't read",
		"without reading",
		"without inspecting"
	]);
}

function getWorkspaceReferenceCandidates(context: WorkflowRouteContext): string[] {
	const name: string | null = getRouteContextField(context.workspaceSummary, "name");
	const rootPath: string | null = getRouteContextField(context.workspaceSummary, "rootPath");
	const rootName: string | null = rootPath === null ? null : rootPath.split(/[\\/]/u).filter(Boolean).at(-1) ?? null;
	return [name, rootName]
		.map((value: string | null): string => normalizeRouteText(value ?? ""))
		.filter((value: string): boolean => value.length >= 3);
}

function getRouteContextField(summary: string, field: string): string | null {
	const match: RegExpMatchArray | null = summary.match(new RegExp(`(?:^|\\n)${field}=([^\\n]*)`, "u"));
	return match?.[1]?.trim() ?? null;
}

function normalizeRouteText(text: string): string {
	return text
		.normalize("NFKC")
		.toLowerCase()
		.replaceAll(/[^a-z0-9\u4e00-\u9fff]+/gu, "-")
		.replaceAll(/^-+|-+$/gu, "");
}
