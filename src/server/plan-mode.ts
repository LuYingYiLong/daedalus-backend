import type WebSocket from "ws";
import type { AiChatParams, ChatMessage, ProviderId } from "../protocol/types.js";
import type { ProviderChatOptions } from "../providers/deepseek-client.js";
import type { McpHost } from "../mcp/mcp-host.js";
import { parseJsonObjectLoose } from "./next-step-hints.js";
import type { ClientSession } from "./client-session.js";
import { clipTextByChars, cloneAdditionalContextItems } from "./additional-context.js";
import {
	createPlanEventPayload,
	createPlanMetadata,
	type PlanRecommendedReply,
	type StoredPlan,
	type StoredPlanMetadata,
	updateStoredPlan,
	writeStoredPlan
} from "./plan-store.js";
import { sendSessionEvent, waitForSessionEventPersistence } from "./session-events.js";
import { appendTranscriptOnlyChatTurnToSession } from "./transcript-history.js";
import { logger } from "../logger.js";
import { runProviderAgentStreaming } from "../providers/provider-agent.js";
import { ReadOnlyToolApprovalGateway } from "../tools/approval-gateway.js";
import type { OnToolEvent, ToolEvent } from "../tools/tool-dispatcher.js";
import { resolveAllowedToolsForChatParams } from "./chat-mode.js";
import { createAgentToolEventForwarder } from "./workflow/tool-events.js";
import { loadCorePrompt } from "../prompts/registry.js";
import { getClientConnection } from "./client-connections.js";

const PLAN_PREVIEW_MAX_CHARS: number = 1600;
const CLARIFICATION_REPLY_MAX_COUNT: number = 3;
const PLAN_RUNNER_MAX_ATTEMPTS: number = 2;

type PlanDecisionRuntime = {
	socket: WebSocket;
	requestId: string;
	operationRequestId?: string | undefined;
	planId?: string | undefined;
	session: ClientSession;
	mcpHost: McpHost;
	requireToolInspection?: boolean | undefined;
};

export type PlanDecision =
	| {
		decision: "needs_clarification";
		title: string;
		question: string;
		recommendedReplies: PlanRecommendedReply[];
	}
	| {
		decision: "plan_ready";
		title: string;
		planMarkdown: string;
		assumptions: string[];
	};

export function sendPlanMessageDelta(
	socket: WebSocket,
	requestId: string,
	session: ClientSession,
	text: string,
	operationRequestId?: string | undefined,
	planId?: string | undefined
): void {
	if (text.trim().length === 0) {
		return;
	}
	sendSessionEvent(socket, requestId, session, "agent.message.delta", {
		runId: requestId,
		requestId,
		operationRequestId: operationRequestId ?? requestId,
		planId: planId ?? null,
		mode: "plan",
		text
	});
}

export function sendPlanMessageDone(
	socket: WebSocket,
	requestId: string,
	session: ClientSession,
	planId?: string | undefined,
	canonicalRequestId?: string | undefined,
	operationRequestId?: string | undefined
): void {
	sendSessionEvent(socket, requestId, session, "agent.message.done", {
		runId: canonicalRequestId ?? requestId,
		mode: "plan",
		requestId: canonicalRequestId ?? requestId,
		operationRequestId: operationRequestId ?? requestId,
		planId: planId ?? null
	});
}

export type PlanVisibleDeltaFilter = {
	push(text: string): string;
};

export function createPlanVisibleDeltaFilter(): PlanVisibleDeltaFilter {
	let pendingWhitespace: string = "";
	let suppressFinalJson: boolean = false;
	return {
		push(text: string): string {
			if (suppressFinalJson || text.length === 0) {
				return "";
			}

			const combinedText: string = pendingWhitespace + text;
			const trimmedStart: string = combinedText.trimStart();
			if (trimmedStart.startsWith("{")) {
				suppressFinalJson = true;
				pendingWhitespace = "";
				return "";
			}
			if (combinedText.trim().length === 0) {
				pendingWhitespace = combinedText;
				return "";
			}

			pendingWhitespace = "";
			return combinedText;
		}
	};
}

function isBroadGodotPluginGoal(message: string): boolean {
	const normalized: string = message.trim().toLowerCase();
	if (normalized.length === 0 || normalized.length > 120) {
		return false;
	}

	const hasBuildIntent: boolean = /帮我|做一个|开发|实现|打造|创建/.test(normalized);
	const hasGodotAiPlugin: boolean = normalized.includes("godot") && (normalized.includes("ai") || normalized.includes("插件") || normalized.includes("plugin"));
	const hasConcreteScope: boolean = /前端|后端|ui|界面|gds|gdscript|typescript|ts|provider|供应商|mcp|审批|会话|工具|场景|脚本|测试/.test(normalized);
	return hasBuildIntent && hasGodotAiPlugin && !hasConcreteScope;
}

function createGodotPluginClarification(message: string): PlanDecision {
	return {
		decision: "needs_clarification",
		title: "Godot AI 插件方向澄清",
		question: "这个目标比较大。你想先把 Godot AI 插件推进到哪个方向？",
		recommendedReplies: [
			{
				label: "前端 GDS 插件",
				text: "先做前端 GDS 插件，重点是 Godot 编辑器 UI、会话面板、审批交互和 EditorBridge。",
				description: "适合先打磨用户可见体验。"
			},
			{
				label: "后端 TS 服务",
				text: "先做后端 TypeScript 服务，重点是 WebSocket/RPC、LLM provider、MCP 工具、审批和会话持久化。",
				description: "适合先稳定能力底座。"
			},
			{
				label: "UI 原型",
				text: "先做 UI/交互原型，重点是聊天、计划、审批、diff、设置和多前端协作流程。",
				description: "适合先确认产品形态。"
			}
		]
	};
}

function readFirstString(record: Record<string, unknown>, keys: readonly string[]): string {
	for (const key of keys) {
		const value: unknown = record[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}
	return "";
}

function readFirstValue(record: Record<string, unknown>, keys: readonly string[]): unknown {
	for (const key of keys) {
		if (record[key] !== undefined) {
			return record[key];
		}
	}
	return undefined;
}

function normalizeDecisionValue(value: unknown): string {
	const decision: string = String(value ?? "").trim().toLowerCase().replaceAll("-", "_");
	if (decision === "needs_clarification" || decision === "need_clarification" || decision === "clarification" || decision === "clarify" || decision === "ask_clarification") {
		return "needs_clarification";
	}
	if (decision === "plan_ready" || decision === "ready" || decision === "plan" || decision === "planned" || decision === "create_plan") {
		return "plan_ready";
	}
	return decision;
}

function isPlanDecisionFormatError(error: unknown): boolean {
	const message: string = error instanceof Error ? error.message : String(error);
	return message.includes("Plan planner returned non-object JSON")
		|| message.includes("Plan clarification decision is missing question")
		|| message.includes("Unknown plan decision")
		|| message.includes("LLM did not return valid JSON");
}

function normalizeRecommendedReplies(value: unknown): PlanRecommendedReply[] {
	if (!Array.isArray(value)) {
		return [];
	}

	const replies: PlanRecommendedReply[] = [];
	for (const item of value) {
		if (typeof item === "string") {
			const text: string = item.trim();
			if (text.length > 0) {
				replies.push({
					label: clipTextByChars(text, 32),
					text: clipTextByChars(text, 1200)
				});
			}
			if (replies.length >= CLARIFICATION_REPLY_MAX_COUNT) {
				break;
			}
			continue;
		}
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			continue;
		}
		const record: Record<string, unknown> = item as Record<string, unknown>;
		const label: string = readFirstString(record, ["label", "title", "name"]);
		const text: string = readFirstString(record, ["text", "message", "content", "value", "reply"]);
		const description: string = String(record.description ?? "").trim();
		if (label.length === 0 || text.length === 0) {
			continue;
		}
		replies.push({
			label: clipTextByChars(label, 32),
			text: clipTextByChars(text, 1200),
			description: description.length > 0 ? clipTextByChars(description, 180) : undefined
		});
		if (replies.length >= CLARIFICATION_REPLY_MAX_COUNT) {
			break;
		}
	}
	return replies;
}

function createStructuredPlanMarkdown(record: Record<string, unknown>, title: string): string {
	const lines: string[] = [`# ${title}`];
	const sections: Array<[string, readonly string[]]> = [
		["Summary", ["summary", "overview"]],
		["Key Changes", ["keyChanges", "key_changes", "changes"]],
		["Public Interfaces", ["publicInterfaces", "public_interfaces", "interfaces"]],
		["Test Plan", ["testPlan", "test_plan", "tests"]],
		["Assumptions", ["assumptions"]]
	];

	for (const [heading, keys] of sections) {
		const value: unknown = readFirstValue(record, keys);
		if (value === undefined) {
			continue;
		}
		lines.push("", `## ${heading}`);
		if (Array.isArray(value)) {
			for (const item of value) {
				const text: string = String(item).trim();
				if (text.length > 0) {
					lines.push(`- ${text}`);
				}
			}
			continue;
		}
		const text: string = String(value).trim();
		if (text.length > 0) {
			lines.push(text);
		}
	}

	return lines.join("\n").trim();
}

function ensurePlanMarkdown(title: string, markdown: string, assumptions: readonly string[]): string {
	const trimmedMarkdown: string = markdown.trim();
	const lines: string[] = [];
	if (!trimmedMarkdown.startsWith("#")) {
		lines.push(`# ${title}`);
	}
	lines.push(trimmedMarkdown.length > 0 ? trimmedMarkdown : "## Summary\n\n需要先补充计划内容。");
	if (assumptions.length > 0 && !trimmedMarkdown.toLowerCase().includes("assumption")) {
		lines.push("\n## Assumptions");
		for (const assumption of assumptions) {
			lines.push(`- ${assumption}`);
		}
	}
	return lines.join("\n").trim() + "\n";
}

function createPlanPreview(markdown: string): string {
	return clipTextByChars(markdown.trim(), PLAN_PREVIEW_MAX_CHARS);
}

export async function createPlannerSystemPrompt(): Promise<string> {
	const corePrompt: string = await loadCorePrompt();
	return [
		corePrompt,
		"",
		"## Plan 模式规划器",
		"你是 Godot Daedalus 的 Plan 模式规划器。此阶段只能澄清和生成计划，不能执行、不能写文件、不能假装已经修改项目。",
		"你必须遵循 CORE；尤其是调用工具前要先用用户可见正文给出一句简短预告，要求用户澄清前也要先说明为什么必须澄清。",
		"最终决策必须是 JSON object。工具前预告和澄清前预告可以是普通正文，但最终 JSON 不要包在 markdown fence 中。",
		"先判断用户目标是否足够明确；如果直接做容易偏离真实需求，必须要求澄清。",
		"关键缺失信息会影响整体设计时必须问；不关键的信息可以写入 assumptions。",
		"不要臆测技术栈、协议或测试框架；如果缺少关键信息，优先要求澄清，或把不关键的不确定点写为假设。",
		"当前 daedalus-backend 仓库事实：后端是 TypeScript WebSocket/RPC 服务，协议边界使用 zod schema，测试使用 Node 内置 test runner（node:test / node --import tsx --test），常用命令是 npm run typecheck、npm test、npm run check。",
		"除非用户明确要求或目标仓库已有证据，不要在计划中写 Vitest、Jest、gRPC、protobuf 等未确认技术。",
		"输出必须是 JSON object，不要输出 markdown fence。",
		"需要澄清时格式：{\"decision\":\"needs_clarification\",\"title\":\"短标题\",\"question\":\"一个问题\",\"recommendedReplies\":[{\"label\":\"短按钮\",\"text\":\"用户可直接采用的澄清回复\",\"description\":\"可选说明\"}]}。",
		"计划就绪时格式：{\"decision\":\"plan_ready\",\"title\":\"短标题\",\"planMarkdown\":\"完整 Markdown 计划\",\"assumptions\":[\"合理假设\"]}。",
		"recommendedReplies 最多 3 条。planMarkdown 必须包含 Summary、Key Changes、Public Interfaces、Test Plan、Assumptions。"
	].join("\n");
}

function createPlannerMessage(
	originalMessage: string,
	clarifications: readonly string[],
	revisions: readonly string[],
	currentPlanMarkdown?: string | undefined,
	extraInstruction?: string | undefined
): string {
	const lines: string[] = [
		"用户原始目标：",
		originalMessage.trim()
	];
	if (clarifications.length > 0) {
		lines.push("\n用户澄清：");
		for (const clarification of clarifications) {
			lines.push(`- ${clarification}`);
		}
	}
	if (currentPlanMarkdown !== undefined && currentPlanMarkdown.trim().length > 0) {
		lines.push("\n当前计划：");
		lines.push(currentPlanMarkdown.trim());
	}
	if (revisions.length > 0) {
		lines.push("\n用户修订反馈：");
		for (const revision of revisions) {
			lines.push(`- ${revision}`);
		}
	}
	if (extraInstruction !== undefined && extraInstruction.trim().length > 0) {
		lines.push("\n本次额外要求：");
		lines.push(extraInstruction.trim());
	}
	return lines.join("\n");
}

export function normalizePlanDecision(raw: unknown, fallbackTitle: string): PlanDecision {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error("Plan planner returned non-object JSON.");
	}
	const record: Record<string, unknown> = raw as Record<string, unknown>;
	const title: string = clipTextByChars(String(record.title ?? fallbackTitle).trim() || fallbackTitle, 80);
	const question: string = readFirstString(record, ["question", "clarificationQuestion", "prompt"]);
	const rawPlanMarkdown: string = readFirstString(record, ["planMarkdown", "plan_markdown", "markdown"]);
	const structuredPlanMarkdown: string = rawPlanMarkdown.length > 0 ? rawPlanMarkdown : createStructuredPlanMarkdown(record, title);
	let decision: string = normalizeDecisionValue(record.decision);
	if (decision.length === 0) {
		if (question.length > 0) {
			decision = "needs_clarification";
		} else if (structuredPlanMarkdown.length > title.length + 2) {
			decision = "plan_ready";
		}
	}

	if (decision === "needs_clarification") {
		const replies: PlanRecommendedReply[] = normalizeRecommendedReplies(readFirstValue(record, [
			"recommendedReplies",
			"recommended_replies",
			"replies",
			"options",
			"choices",
			"suggestions"
		]));
		if (question.length === 0) {
			throw new Error("Plan clarification decision is missing question.");
		}
		return {
			decision: "needs_clarification",
			title,
			question: clipTextByChars(question, 600),
			recommendedReplies: replies
		};
	}
	if (decision === "plan_ready") {
		const assumptions: string[] = Array.isArray(record.assumptions)
			? record.assumptions.map((item: unknown): string => String(item).trim()).filter((item: string): boolean => item.length > 0).slice(0, 12)
			: [];
		return {
			decision: "plan_ready",
			title,
			planMarkdown: ensurePlanMarkdown(title, structuredPlanMarkdown, assumptions),
			assumptions
		};
	}
	throw new Error(`Unknown plan decision: ${decision}`);
}

export async function createPlanDecision(
	params: AiChatParams,
	options: ProviderChatOptions,
	clarifications: readonly string[] = [],
	revisions: readonly string[] = [],
	currentPlanMarkdown?: string | undefined,
	runtime?: PlanDecisionRuntime | undefined,
	abortSignal?: AbortSignal | undefined
): Promise<PlanDecision> {
	if (clarifications.length === 0 && revisions.length === 0 && isBroadGodotPluginGoal(params.message)) {
		return createGodotPluginClarification(params.message);
	}

	if (runtime === undefined) {
		throw new Error("Plan agent runner requires runtime context.");
	}

	const requireToolInspection: boolean = runtime.requireToolInspection === true;
	let lastPlanReadyDecision: PlanDecision | null = null;
	let lastToolCallCount: number = 0;
	let formatRetryInstruction: string | undefined;
	for (let attempt: number = 0; attempt < PLAN_RUNNER_MAX_ATTEMPTS; attempt += 1) {
		const extraInstruction: string | undefined = formatRetryInstruction !== undefined
			? formatRetryInstruction
			: attempt === 0
				? undefined
			: "你上一次没有先调用任何工具就给出了计划。请先使用一个最小必要的 read/verify 或 Plan-safe custom MCP 工具读取事实，再输出 JSON 决策。";
		let result: { decision: PlanDecision; toolCallCount: number };
		try {
			result = await runPlanAgentDecision(
				params,
				options,
				clarifications,
				revisions,
				currentPlanMarkdown,
				runtime,
				extraInstruction,
				abortSignal
			);
		} catch (error: unknown) {
			if (!isPlanDecisionFormatError(error) || attempt + 1 >= PLAN_RUNNER_MAX_ATTEMPTS) {
				throw error;
			}
			formatRetryInstruction = [
				"你上一次没有输出可识别的最终 JSON 决策。现在必须只在最终答案中输出一个 JSON object。",
				"如果需要用户澄清，必须包含 decision:\"needs_clarification\" 和 question；recommendedReplies 可以为空数组。",
				"如果计划已经足够明确，必须包含 decision:\"plan_ready\" 和 planMarkdown。"
			].join("\n");
			continue;
		}
		formatRetryInstruction = undefined;
		if (result.decision.decision !== "plan_ready" || !requireToolInspection || result.toolCallCount > 0) {
			return result.decision;
		}
		lastPlanReadyDecision = result.decision;
		lastToolCallCount = result.toolCallCount;
	}

	if (lastPlanReadyDecision !== null) {
		logger.warn("plan", "plan_ready_without_tool_inspection", {
			requestId: runtime.requestId,
			sessionId: runtime.session.sessionId,
			planId: runtime.planId,
			toolCallCount: lastToolCallCount
		});
		return lastPlanReadyDecision;
	}

	throw new Error("Plan runner did not produce a usable plan decision.");
}

async function runPlanAgentDecision(
	params: AiChatParams,
	options: ProviderChatOptions,
	clarifications: readonly string[],
	revisions: readonly string[],
	currentPlanMarkdown: string | undefined,
	runtime: PlanDecisionRuntime,
	extraInstruction: string | undefined,
	abortSignal?: AbortSignal | undefined
): Promise<{ decision: PlanDecision; toolCallCount: number }> {
	const plannerParams: AiChatParams = {
		message: createPlannerMessage(params.message, clarifications, revisions, currentPlanMarkdown, extraInstruction),
		mode: "plan",
		options: {
			temperature: 0.2,
			maxTokens: 3200,
			responseFormat: "json",
			stream: true,
			toolBudget: "normal",
			workflow: "single"
		}
	};

	const allowedToolNames: readonly string[] = resolveAllowedToolsForChatParams(plannerParams, undefined, runtime.session.activeWorkspace?.id) ?? [];
	const gateway = new ReadOnlyToolApprovalGateway(runtime.session.approvalGateway, allowedToolNames);
	const visibleDeltaFilter: PlanVisibleDeltaFilter = createPlanVisibleDeltaFilter();
	const planThreadRequestId: string = runtime.requestId;
	const operationRequestId: string = runtime.operationRequestId ?? runtime.requestId;
	const baseForwarder: OnToolEvent = createAgentToolEventForwarder(
		runtime.socket,
		planThreadRequestId,
		runtime.session,
		planThreadRequestId,
		`plan-step-${operationRequestId}`,
		planThreadRequestId,
		runtime.mcpHost,
		{
			requestId: planThreadRequestId,
			operationRequestId,
			planId: runtime.planId ?? null
		}
	);
	let toolCallCount: number = 0;
	const onEvent: OnToolEvent = (event: ToolEvent): void => {
		if (event.type === "ai.delta") {
			const visibleText: string = visibleDeltaFilter.push(event.text);
			if (visibleText.length > 0) {
				sendPlanMessageDelta(runtime.socket, planThreadRequestId, runtime.session, visibleText, operationRequestId, runtime.planId);
			}
			return;
		}
		if (event.type === "tool.call") {
			toolCallCount += 1;
		}
		baseForwarder(event);
	};
	const agentResult = await runProviderAgentStreaming(
		plannerParams,
		options,
		[] satisfies ChatMessage[],
		await createPlannerSystemPrompt(),
		runtime.mcpHost,
		gateway,
		allowedToolNames,
		onEvent,
		abortSignal,
		undefined,
		{
			workspaceId: runtime.session.activeWorkspace?.id,
			editorInstanceId: runtime.session.editorInstanceId,
			sessionId: runtime.session.sessionId,
			requestId: planThreadRequestId,
			clientType: getClientConnection(runtime.socket)?.clientType
		}
	);
	if (agentResult.status === "approval_required") {
		throw new Error(`Plan runner requested approval for ${agentResult.toolName}, which is not allowed.`);
	}
	if (agentResult.status === "tool_budget_required") {
		throw new Error(agentResult.reason);
	}
	if (agentResult.status === "protocol_violation") {
		throw new Error(agentResult.reason);
	}
	if (agentResult.status === "execution_decision") {
		throw new Error("Execution control is not available while generating a plan.");
	}
	if (agentResult.status === "chat_answer") {
		throw new Error("Structured chat completion is not available while generating a plan.");
	}

	const rawDecision: unknown = parseJsonObjectLoose(agentResult.text);
	return {
		decision: normalizePlanDecision(rawDecision, "执行计划"),
		toolCallCount
	};
}

export async function createInitialPlan(
	socket: WebSocket,
	requestId: string,
	session: ClientSession,
	params: AiChatParams,
	options: ProviderChatOptions,
	mcpHost: McpHost,
	turnStartedAt: string,
	abortSignal?: AbortSignal | undefined
): Promise<StoredPlan> {
	if (!session.sessionId) {
		throw new Error("Plan mode requires an active session.");
	}
	const decision: PlanDecision = await createPlanDecision(params, options, [], [], undefined, {
		socket,
		requestId,
		operationRequestId: requestId,
		session,
		mcpHost
	}, abortSignal);
	let metadata: StoredPlanMetadata;
	let markdown: string;
	let assistantMessage: string;
	let eventName: "plan.clarification.required" | "plan.generated";
	if (decision.decision === "needs_clarification") {
		metadata = createPlanMetadata({
			sessionId: session.sessionId,
			requestId,
			status: "clarification_required",
			title: decision.title,
			originalMessage: params.message,
			clarificationQuestion: decision.question,
			recommendedReplies: decision.recommendedReplies
		});
		markdown = "";
		assistantMessage = decision.question;
		eventName = "plan.clarification.required";
	} else {
		markdown = decision.planMarkdown;
		metadata = createPlanMetadata({
			sessionId: session.sessionId,
			requestId,
			status: "ready",
			title: decision.title,
			originalMessage: params.message,
			previewMarkdown: createPlanPreview(markdown)
		});
		assistantMessage = metadata.previewMarkdown;
		eventName = "plan.generated";
	}

	const storedPlan: StoredPlan = await writeStoredPlan(metadata, markdown);
	sendSessionEvent(socket, requestId, session, eventName, {
		...createPlanEventPayload(storedPlan),
		operationRequestId: requestId
	});
	sendPlanMessageDone(socket, requestId, session, metadata.planId, metadata.requestId);
	await waitForSessionEventPersistence(session);
	await appendTranscriptOnlyChatTurnToSession(
		session,
		params.message,
		assistantMessage,
		requestId,
		turnStartedAt,
		new Date().toISOString(),
		cloneAdditionalContextItems(params.additionalContext)
	);
	logger.info("plan", "plan_turn_created", {
		requestId,
		sessionId: session.sessionId,
		planId: metadata.planId,
		status: metadata.status
	});
	return storedPlan;
}

export async function applyPlanClarification(
	plan: StoredPlan,
	reply: string,
	options: ProviderChatOptions,
	runtime: PlanDecisionRuntime,
	abortSignal?: AbortSignal | undefined
): Promise<StoredPlan> {
	const nextClarifications: string[] = [...plan.metadata.clarifications, reply.trim()];
	const decision: PlanDecision = await createPlanDecision(
		{ message: plan.metadata.originalMessage, mode: "plan" },
		options,
		nextClarifications,
		plan.metadata.revisions,
		plan.markdown,
		{
			...runtime,
			requestId: plan.metadata.requestId,
			operationRequestId: runtime.requestId,
			planId: plan.metadata.planId
		},
		abortSignal
	);
	return updateStoredPlan(plan.metadata.sessionId, plan.metadata.planId, (): StoredPlan => {
		if (decision.decision === "needs_clarification") {
			return {
				metadata: {
					...plan.metadata,
					status: "clarification_required",
					title: decision.title,
					clarificationQuestion: decision.question,
					recommendedReplies: decision.recommendedReplies,
					clarifications: nextClarifications
				},
				markdown: ""
			};
		}
		const markdown: string = decision.planMarkdown;
		return {
			metadata: {
				...plan.metadata,
				status: "ready",
				title: decision.title,
				previewMarkdown: createPlanPreview(markdown),
				clarificationQuestion: undefined,
				recommendedReplies: [],
				clarifications: nextClarifications
			},
			markdown
		};
	});
}

export async function applyPlanRevision(
	plan: StoredPlan,
	feedback: string,
	options: ProviderChatOptions,
	runtime: PlanDecisionRuntime,
	abortSignal?: AbortSignal | undefined
): Promise<StoredPlan> {
	const nextRevisions: string[] = [...plan.metadata.revisions, feedback.trim()];
	const decision: PlanDecision = await createPlanDecision(
		{ message: plan.metadata.originalMessage, mode: "plan" },
		options,
		plan.metadata.clarifications,
		nextRevisions,
		plan.markdown,
		{
			...runtime,
			requestId: plan.metadata.requestId,
			operationRequestId: runtime.requestId,
			planId: plan.metadata.planId
		},
		abortSignal
	);
	return updateStoredPlan(plan.metadata.sessionId, plan.metadata.planId, (): StoredPlan => {
		if (decision.decision === "needs_clarification") {
			return {
				metadata: {
					...plan.metadata,
					status: "clarification_required",
					title: decision.title,
					clarificationQuestion: decision.question,
					recommendedReplies: decision.recommendedReplies,
					revisions: nextRevisions
				},
				markdown: plan.markdown
			};
		}
		const markdown: string = decision.planMarkdown;
		return {
			metadata: {
				...plan.metadata,
				status: "ready",
				title: decision.title,
				previewMarkdown: createPlanPreview(markdown),
				clarificationQuestion: undefined,
				recommendedReplies: [],
				revisions: nextRevisions
			},
			markdown
		};
	});
}

export function createApprovedPlanSystemPrompt(markdown: string, originalMessage: string): string {
	return [
		"以下是用户已经批准的 Daedalus Plan。执行阶段必须以该计划为主要约束。",
		"原始用户请求：",
		originalMessage.trim().length > 0 ? originalMessage.trim() : "未提供。",
		"",
		"如果执行中发现计划与实际项目冲突，先说明阻塞点或走正常审批/验证流程，不要擅自扩大范围。",
		"",
		markdown.trim()
	].join("\n");
}

export function createApprovedPlanExecutionParams(
	plan: StoredPlan,
	provider?: ProviderId | undefined,
	model?: string | undefined
): AiChatParams {
	return {
		message: "执行计划。",
		mode: "agent",
		provider,
		model,
		promptId: "godot.assistant",
		systemPrompt: createApprovedPlanSystemPrompt(plan.markdown, plan.metadata.originalMessage),
		options: {
			stream: true,
			toolBudget: "project_edit",
			workflow: "multi_phase"
		}
	};
}
