import WebSocket from "ws";
import { composeSystemPrompt, listPromptTemplates } from "../prompts/registry.js";
import type { AdditionalContextItem, AiChatParams, ChatMessage, ClientRequest, ModelProfile, ProviderId, ServerEvent } from "../protocol/types.js";
import type { OnToolEvent, ToolEvent } from "../tools/tool-dispatcher.js";
import { parseToolResultSummary } from "../tools/tool-result-parser.js";
import { chatWithDeepSeek, createDeepSeekClient, resolveChatModel, type ProviderChatOptions } from "../providers/deepseek-client.js";
import type { ProviderAgentResult } from "../providers/agent-types.js";
import {
	continueProviderAgentAfterToolBudget,
	continueProviderAgentAfterToolBudgetStreaming,
	finalizeProviderAgentAfterToolBudget,
	finalizeProviderAgentAfterToolBudgetStreaming,
	runProviderAgentStreaming
} from "../providers/provider-agent.js";
import type { PendingToolBudget, PendingToolBudgetPhaseStats } from "../session/pending-tool-budget.js";
import { McpHost } from "../mcp/mcp-host.js";
import type { CustomMcpServerRuntimeStatus } from "../mcp/mcp-host.js";
import {
	addCustomMcpServerConfig,
	listCustomMcpServerSummaries,
	removeCustomMcpServerConfig,
	setCustomMcpServerEnabled,
	type CustomMcpServerSummary
} from "../mcp/custom-mcp-config-store.js";
import { sendJson } from "./send-json.js";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getDefaultModelProfile, resolveModelProfile } from "../tokens/model-profiles.js";
import { type TokenCounter } from "../tokens/token-counter.js";
import { createTokenCounter } from "../tokens/token-counter-factory.js";
import { computeInputBudget, selectMessagesWithinBudget } from "../session/session-compressor.js";
import { composeExplicitSkillPrompt, composeSkillCatalogPrompt, createGlobalSkillWorkspace, resolveBuiltinToolRestriction, resolveExplicitSkills } from "../skills/runtime.js";
import type { CatalogSkill, SkillWorkspace } from "../skills/types.js";
import {
	createRuntimeWorkspace,
	loadWorkspaces,
	findWorkspace,
	getDefaultWorkspace,
	upsertRuntimeWorkspace
} from "../workspace/registry.js";
import type { WorkspaceConfig } from "../workspace/types.js";
import {
	createSession, openSession, saveSession, listSessions,
	archiveSession, deleteArchivedSession, deleteSession, listArchivedSessions, renameSession, restoreArchivedSession,
	rewindSessionFromRequest,
	readSummary, writeSummary,
	appendSessionEvent, appendApprovalEvent, appendWorkflowEvent, appendAgentEvent, clearSessionEvents, readApprovalEvents, updateSessionMetadata,
	openSessionRecentTimeline, openSessionTimelinePage,
	type SessionMetadata,
	type SessionSummary,
	type StoredMessage,
	type StoredSessionEvent,
	type StoredSessionTimelinePage
} from "../session/session-store.js";
import {
	clearProviderConfig,
	getProviderConfigStatus,
	loadProviderConfigWithSecret,
	saveProviderConfig,
	type ProviderConfigWithSecret
} from "../providers/provider-config-store.js";
import { listProviderModels } from "../providers/provider-models.js";
import { estimateProviderMessagesTokens, estimateProviderTextTokens } from "../providers/provider-token-estimator.js";
import {
	createCurrentUserMessage,
	hasImageAttachments,
	ProviderImageInputError
} from "../providers/provider-image-content.js";
import { preprocessImageAttachmentsForTextModel, type ImageRecognitionPreprocessResult } from "../providers/image-recognition.js";
import { hydrateImageAttachmentContexts } from "../session/session-attachments.js";
import { resolveProviderTaskModelOptions } from "../providers/task-model-routing.js";
import { getProviderDefaultBaseUrl, getProviderDefaultModel, getProviderDisplayName, isProviderId } from "../providers/provider-registry.js";
import { classifyProviderError, createProviderStatusEvent } from "../providers/provider-error.js";
import { isFirstSessionUserTurn } from "./session-title.js";
import { planWorkflow, planWorkflowAfterLlmPlannerFailure, READ_TOOLS, VERIFY_TOOLS, WRITE_TOOLS } from "../workflow/planner.js";
import { createLlmWorkflowPlan, reviseLlmWorkflowPlan } from "../workflow/llm-planner.js";
import { createGodotTemplateWorkflowPlan } from "../workflow/godot-template-planner.js";
import { createFallbackWorkflowRoute, resolveForcedWorkflowRoute, routeWorkflowExecution, type WorkflowRouteContext, type WorkflowRouteDecision } from "../workflow/router.js";
import {
	applyDeterministicVerificationGate,
	applyToolEventToWorkflowObservations,
	createWorkflowPhaseOutcome,
	createWorkflowPhaseRunId,
	findBlockingOutcomeBeforeSummarize
} from "../workflow/outcome.js";
import {
	appendPhaseOutput,
	createPhaseMessage,
	createPhaseParams,
	createPhasePrompt,
	createWorkflowTodoSnapshot,
	markRemainingWorkflowTodos,
	updateWorkflowPhaseStatus
} from "../workflow/runner.js";
import { countWorkflowAutoRepairRounds, insertWorkflowAutoRepairPhases } from "../workflow/repair.js";
import type { WorkflowPhase, WorkflowPhaseOutput, WorkflowPlan, WorkflowRunState, WorkflowToolObservation } from "../workflow/types.js";
import {
	clearActiveSession,
	type ClientSession,
	type PendingAiContinuation,
	type PendingGuide,
	type ThinkingEventBuffer
} from "./client-session.js";
import { getToolPolicy } from "../tools/tool-policy.js";
import { isPlanSafeDynamicMcpToolName } from "../tools/dynamic-mcp-tools.js";
import { createWorkspaceToolCatalog, filterToolNamesForWorkspace, getNoWorkspaceToolNames } from "../tools/tool-catalog.js";
import { ApprovalGateway, ReadOnlyToolApprovalGateway, type PendingApproval } from "../tools/approval-gateway.js";
import { getLlmToolExecutionIdentity } from "../tools/tool-idempotency.js";
import { resolveToolMapping } from "../tools/tool-mapping.js";
import {
	createPersistedApprovalRequestedData,
	createRuntimePendingContinuation,
	foldPendingApprovalStates,
	serializePendingApprovalState,
	type PendingApprovalState
} from "../session/approval-persistence.js";
import { createBackendHealthResult } from "./backend-health.js";
import {
	createSlashCommandListResult,
	handleSlashCommand,
	type SlashCommandResult
} from "./slash-commands.js";
import {
	createQueuedChatRequest,
	emitMessageQueueUpdated,
	findQueuedMessage,
	getNextRunnableQueuedMessage,
	persistMessageQueueEvent,
	removeQueuedMessage,
	serializeMessageQueue,
	serializeQueuedMessage,
	setQueuedMessageStatus
} from "./message-queue.js";
import { bumpWorkbenchRevision, clearWorkbenchComposer, emitWorkbenchUpdated, serializeWorkbench, setWorkbenchActiveRun, setWorkbenchNextStepHints } from "./workbench.js";

import { normalizeChatParamsForMode, resolveAllowedToolsForChatParams } from "./chat-mode.js";
import { logPromptTrace, logProjectInstructionTrace } from "./prompt-trace.js";
import { isCancellationError, sendAgentCancelled, beginRequestExecution, finishRequestExecution, parseMessage } from "./request-lifecycle.js";
import { estimateTextTokens, estimateMessagesTokens, estimateTextTokensForProvider, estimateCurrentMessageTokensForProvider, computeHistoryBudget, appendChatTurnToSession, appendUserMessageToSession, appendFailedChatTurnToSession, selectHistoryForModel, createSummaryMessage, loadSessionCompressorPrompt, filterLlmContextMessages } from "./token-budget.js";
import { getSessionProjectPath, toChatMessage, clampSessionOpenMessageLimit, createPreviewValue, createTimelinePageResult, startFullSessionLoad, waitForFullSessionLoad } from "./session-preview.js";
import { createProviderChatOptions } from "./provider-chat-options.js";
import { createRuntimeSessionUiMetadata } from "./session-ui-metadata.js";
import { createGodotRuntimeStatus } from "./godot-runtime-status.js";
import { clipTextByChars, cloneAdditionalContextItems, getAdditionalContextDataRecord, getContextNumber, getContextString, createLineColumnRangeText, appendScriptSelectionPromptLines, appendFilesystemSelectionPromptLines, createAdditionalContextPromptSection } from "./additional-context.js";
import { MAX_GUIDE_TEXT_CHARS, createGuideId, createPendingGuide, serializePendingGuide, findPendingGuideIndexById, findPendingGuideByClientId, readEventDataObject, hydratePendingGuides, persistGuideEvent, formatGuidePromptSection, consumePendingGuideSection } from "./pending-guides.js";
import { DEFAULT_NEXT_STEP_HINT_COUNT, MAX_NEXT_STEP_HINT_COUNT, parseJsonObjectLoose, normalizeNextStepHints, createNextStepHintPrompt, createNextStepHints } from "./next-step-hints.js";
import type { NextStepHint } from "./next-step-hints.js";
import { WorkflowExecutionError } from "./workflow/workflow-error.js";
import type { WorkflowPhaseToolStats, WorkflowPhaseRunResult } from "./workflow/shared-types.js";
import { MAX_WORKFLOW_AUTO_REPAIR_ROUNDS } from "./workflow/limits.js";
import {
	shouldPersistSessionEvent,
	getThinkingEventBufferKey,
	getThinkingDeltaText,
	getWorkflowIdFromEventData,
	getAgentRunIdFromEventData,
	enqueueSessionEventWrite,
	flushThinkingEventBuffer,
	flushAllThinkingEventBuffers,
	flushAiDeltaEventBuffer,
	flushAllAiDeltaEventBuffers,
	waitForSessionEventPersistence,
	persistSessionEvent,
	sendSessionEvent,
	sendGlobalEvent,
	maybeScheduleSessionTitleGeneration
} from "./session-events.js";

import {
	createPendingAiContinuation,
	cancelPendingApprovalsForRequest,
	persistApprovalRequested,
	registerPendingApprovalContinuation,
	loadHydratedPendingApprovalStates,
	createMemoryPendingApprovalStates,
	findPendingApprovalState,
	restorePendingContinuationForApproval,
	validatePendingApprovalBeforeExecution,
	createApprovedWorkflowToolObservation,
	sendAgentPaused,
	sendContinuedAgentResult
} from "./approval-continuation.js";
import { cancelPendingToolBudgetsForRequest, createPendingToolBudget, createToolBudgetStopReason, registerPendingToolBudget, sendToolBudgetRequired } from "./tool-budget-continuation.js";
import { createAgentToolEventForwarder, createEmptyWorkflowPhaseToolStats, updateWorkflowPhaseToolStats, shouldRequireWorkflowWriteTool, didWorkflowWritePhaseExecute, isWorkflowProposalPhase, createWorkflowWriteGuardRetryMessage } from "./workflow/tool-events.js";
import { sendWorkflowEvent, mapWorkflowEventToAgentEvent, convertWorkflowSnapshotToAgentSnapshot, sendWorkflowTodoSnapshot } from "./workflow/events.js";
import { runWorkflowPhase, createWorkflowPhasePrompt } from "./workflow/phase-runner.js";
import { createWorkflowPendingContinuation, continueWorkflowExecution } from "./workflow/continuation.js";
import { startWorkflowExecution } from "./workflow/executor.js";
import { ensureProviderConfigured } from "../application/provider-session-service.js";
import { beginSessionRun, findSessionWithPendingToolBudget, finishSessionRun, getActiveSessionRunController, registerSessionRunController } from "./client-connections.js";
import { logger } from "../logger.js";
import { createInitialPlan } from "./plan-mode.js";
import { createPlanGetResult, type StoredPlan } from "./plan-store.js";
import { getUserPrompt } from "../user-prompt-store.js";
import { compressSessionHistory } from "./session-compression.js";
import { getWebSearchSettingsStatus, isWebSearchEnabled, isWebSearchToolAvailable } from "../web-search-settings-store.js";
import { withProviderUsageContext } from "../usage/provider-recorder.js";

const WEB_SEARCH_TOOL_NAME: string = "mcp_web_search";

function applyChatRequestModelSnapshot(session: ClientSession, params: AiChatParams): boolean {
	if (params.provider === undefined && params.model === undefined) {
		return false;
	}

	const nextProvider: ProviderId = params.provider ?? session.activeProvider;
	if (!isProviderId(nextProvider)) {
		return false;
	}

	const providerChanged: boolean = nextProvider !== session.activeProvider;
	const currentModel: string = session.providerModel ?? session.modelProfile.model ?? getProviderDefaultModel(session.activeProvider);
	const requestedModel: string | undefined = params.model?.trim();
	const nextModel: string = requestedModel !== undefined && requestedModel.length > 0
		? requestedModel
		: providerChanged
			? getProviderDefaultModel(nextProvider)
			: currentModel;
	if (!providerChanged && nextModel === currentModel) {
		return false;
	}

	session.activeProvider = nextProvider;
	session.providerModel = nextModel;
	session.modelProfile = resolveModelProfile(nextProvider, nextModel);
	if (providerChanged) {
		session.providerApiKey = undefined;
		session.providerBaseUrl = undefined;
	}
	return true;
}

function isImageGenerationOnlyToolRestriction(toolNames: readonly string[] | undefined): boolean {
	return toolNames !== undefined && toolNames.length === 1 && toolNames[0] === "mcp_image_generate";
}

function removeWebSearchToolName(allowedToolNames: readonly string[] | undefined, session: ClientSession): readonly string[] {
	const toolNames: readonly string[] = allowedToolNames ?? createWorkspaceToolCatalog({
		workspaceId: session.activeWorkspace?.id,
		editorInstanceId: session.editorInstanceId,
		sessionId: session.sessionId
	}).getEntries().map((entry): string => entry.id);
	return toolNames.filter((toolName: string): boolean => toolName !== WEB_SEARCH_TOOL_NAME);
}

async function resolveSearchAwareToolNames(
	allowedToolNames: readonly string[] | undefined,
	session: ClientSession,
	webSearchEnabled: boolean
): Promise<readonly string[] | undefined> {
	if (!webSearchEnabled) {
		return removeWebSearchToolName(allowedToolNames, session);
	}
	if (await isWebSearchToolAvailable()) {
		return allowedToolNames;
	}
	return removeWebSearchToolName(allowedToolNames, session);
}

async function createWebSearchUnavailableMessage(): Promise<string> {
	const status = await getWebSearchSettingsStatus();
	if (!status.selectedSupported) {
		return "The selected web search model does not support provider-native search. Choose a Search-capable model in Search settings.";
	}
	if (!status.configured) {
		return `Configure ${getProviderDisplayName(status.provider)} API key in Provider settings before using web search.`;
	}
	return "Web search is unavailable. Check Search settings and provider configuration.";
}

function filterWebSearchFromWorkflowPlan(plan: WorkflowPlan): WorkflowPlan {
	return {
		...plan,
		phases: plan.phases.map((phase: WorkflowPhase): WorkflowPhase => {
			if (!phase.allowedTools.includes(WEB_SEARCH_TOOL_NAME)) {
				return phase;
			}
			return {
				...phase,
				allowedTools: phase.allowedTools.filter((toolName: string): boolean => toolName !== WEB_SEARCH_TOOL_NAME)
			};
		})
	};
}

function createWorkflowRouteContext(session: ClientSession, mcpHost: McpHost, additionalContext: readonly AdditionalContextItem[] | undefined): WorkflowRouteContext {
	const workspaceSummary: string = session.activeWorkspace === undefined
		? "No active workspace."
		: [
			`id=${session.activeWorkspace.id}`,
			`name=${session.activeWorkspace.name}`,
			`kind=${session.activeWorkspace.kind}`,
			`rootPath=${session.activeWorkspace.rootPath}`
		].join("\n");
	const editorSummary: string = [
		`editorInstanceId=${session.editorInstanceId ?? "none"}`,
		`diagnostics=${JSON.stringify(mcpHost.getDiagnosticsBridge().getCachedStatus())}`,
		`runtime=${JSON.stringify(createGodotRuntimeStatus(session, mcpHost))}`
	].join("\n");
	const additionalContextSummary: string = (additionalContext ?? []).length === 0
		? "No additional context."
		: (additionalContext ?? []).map((item: AdditionalContextItem, index: number): string => {
			const record: Record<string, unknown> = getAdditionalContextDataRecord(item) ?? {};
			const title: string = getContextString(record, "title") ?? getContextString(record, "path") ?? item.kind;
			return `${index + 1}. kind=${item.kind}; title=${clipTextByChars(title, 160)}`;
		}).join("\n");
	return {
		workspaceSummary,
		editorSummary,
		additionalContextSummary
	};
}

function getAllRuntimeToolNames(session: ClientSession): readonly string[] {
	if (session.activeWorkspace === undefined) {
		return getNoWorkspaceToolNames();
	}

	return createWorkspaceToolCatalog({
		workspaceId: session.activeWorkspace.id,
		editorInstanceId: session.editorInstanceId,
		sessionId: session.sessionId
	}).getEntries().map((entry): string => entry.id);
}

function filterReadOnlyAnswerToolNames(toolNames: readonly string[], workspaceId?: string | undefined): readonly string[] {
	return toolNames.filter((toolName: string): boolean => {
		if (isPlanSafeDynamicMcpToolName(toolName, workspaceId)) {
			return true;
		}

		const risk: string | undefined = getToolPolicy(toolName, workspaceId)?.risk;
		return risk === "read" || risk === "verify";
	});
}

function toolNamesIncludeWriteRisk(toolNames: readonly string[], workspaceId?: string | undefined): boolean {
	return toolNames.some((toolName: string): boolean => {
		const risk: string | undefined = getToolPolicy(toolName, workspaceId)?.risk;
		return risk === "write" || risk === "destructive";
	});
}

function messageLooksLikeWriteIntent(message: string): boolean {
	const normalized: string = message.toLowerCase();
	return [
		"创建",
		"新增",
		"添加",
		"修改",
		"生成",
		"create",
		"add",
		"modify",
		"generate"
	].some((keyword: string): boolean => normalized.includes(keyword));
}

function applyExplicitSkillWriteRequirement(
	decision: WorkflowRouteDecision,
	params: AiChatParams,
	builtinToolRestriction: readonly string[] | undefined,
	workspaceId?: string | undefined
): WorkflowRouteDecision {
	if (params.mode === "ask" || builtinToolRestriction === undefined || decision.execution !== "tool_answer" || decision.requiresWrite) {
		return decision;
	}
	if (!messageLooksLikeWriteIntent(params.message) || !toolNamesIncludeWriteRisk(builtinToolRestriction, workspaceId)) {
		return decision;
	}
	return {
		...decision,
		requiresWrite: true,
		reason: `${decision.reason} Explicit write-capable skill requires write tool access.`
	};
}

function resolveHiddenAnswerToolNames(
	routeDecision: WorkflowRouteDecision,
	allowedToolNames: readonly string[] | undefined,
	session: ClientSession
): readonly string[] {
	if (routeDecision.execution === "direct_answer") {
		return [];
	}

	const sourceToolNames: readonly string[] = allowedToolNames ?? getAllRuntimeToolNames(session);
	if (routeDecision.requiresWrite) {
		return sourceToolNames;
	}

	return filterReadOnlyAnswerToolNames(sourceToolNames, session.activeWorkspace?.id);
}

function createHiddenAnswerChatParams(params: AiChatParams, routeDecision: WorkflowRouteDecision): AiChatParams {
	if (routeDecision.execution !== "tool_answer") {
		return params;
	}

	const options: AiChatParams["options"] & Record<string, unknown> = {
		...(params.options ?? {})
	};
	if (routeDecision.requiresWrite) {
		options.requireToolCallOnFirstStep = true;
		return {
			...params,
			options
		};
	}

	return {
		...params,
		options: {
			...options,
			toolBudget: params.options?.toolBudget ?? "simple"
		}
	};
}

function createHiddenAnswerSystemPrompt(fullSystemPrompt: string, routeDecision: WorkflowRouteDecision): string {
	if (routeDecision.execution !== "tool_answer" || routeDecision.requiresWrite) {
		return fullSystemPrompt;
	}

	return [
		fullSystemPrompt,
		[
			"## 隐藏只读回答收束规则",
			"- 当前执行形态是隐藏的只读 tool answer，不是多阶段 workflow。",
			"- 只调用必要的 read/verify 工具；通常 1-3 次，达到工具预算后必须停止并直接回答。",
			"- 优先用搜索结果和小文件定位事实；避免穷举目录或读取大型入口文件，除非用户明确要求。",
			"- 已经获取足够事实后，直接给出结论和建议，不要继续探索。"
		].join("\n")
	].join("\n\n");
}

async function createWorkflowPlanForRoute(
	params: AiChatParams,
	options: ProviderChatOptions,
	history: ChatMessage[],
	planningContext: string,
	abortSignal?: AbortSignal | undefined,
	runtimeContext?: { activeWorkspace?: WorkspaceConfig | undefined } | undefined
): Promise<WorkflowPlan | null> {
	const templateParams: AiChatParams = {
		...params,
		options: {
			...(params.options ?? {}),
			workflow: "auto"
		}
	};
	if (params.options?.workflow !== "llm_planned") {
		const preferredTemplate: WorkflowPlan | null = await createGodotTemplateWorkflowPlanForRuntime(templateParams, runtimeContext);
		if (preferredTemplate !== null) {
			return preferredTemplate;
		}
	}

	try {
		const plannerOptions: ProviderChatOptions = withProviderUsageContext(
			(await resolveProviderTaskModelOptions("workflowPlanner", options)).options,
			{ operation: "workflow_planner" }
		);
		const plan: WorkflowPlan | null = await createLlmWorkflowPlan(params, plannerOptions, history, planningContext, abortSignal);
		if (plan !== null) {
			return plan;
		}
	} catch (error: unknown) {
		logger.warn("ai", "llm_workflow_planner_failed_fallback", {
			message: error instanceof Error ? error.message : "LLM planner failed"
		});
	}

	const templateFallback: WorkflowPlan | null = await createGodotTemplateWorkflowPlanForRuntime(templateParams, runtimeContext);
	if (templateFallback !== null) {
		return templateFallback;
	}

	if (params.options?.workflow === "multi_phase") {
		return planWorkflow({
			...params,
			options: {
				...(params.options ?? {}),
				workflow: "multi_phase"
			}
		});
	}

	return planWorkflowAfterLlmPlannerFailure(params);
}

async function createGodotTemplateWorkflowPlanForRuntime(
	params: AiChatParams,
	runtimeContext?: { activeWorkspace?: WorkspaceConfig | undefined } | undefined
): Promise<WorkflowPlan | null> {
	const isGodotProject: boolean = await hasGodotProjectFile(runtimeContext?.activeWorkspace);
	return createGodotTemplateWorkflowPlan(params, { isGodotProject });
}

async function hasGodotProjectFile(workspace: WorkspaceConfig | undefined): Promise<boolean> {
	if (workspace === undefined) {
		return false;
	}

	try {
		await fs.access(path.join(workspace.rootPath, "project.godot"));
		return true;
	} catch {
		return false;
	}
}

async function runHiddenAnswerExecution(params: {
	socket: WebSocket;
	requestId: string;
	session: ClientSession;
	mcpHost: McpHost;
	options: ProviderChatOptions;
	chatParams: AiChatParams;
	routeDecision: WorkflowRouteDecision;
	history: ChatMessage[];
	historyBudgetTokens: number;
	fullSystemPrompt: string;
	allowedToolNames: readonly string[];
	userCreatedAt: string;
	abortSignal?: AbortSignal | undefined;
}): Promise<void> {
	const runId: string = params.requestId;
	const stepRunId: string = `${params.requestId}:answer`;
	const chatParams: AiChatParams = createHiddenAnswerChatParams(params.chatParams, params.routeDecision);
	const fullSystemPrompt: string = createHiddenAnswerSystemPrompt(params.fullSystemPrompt, params.routeDecision);
	const forwardToolEvent: OnToolEvent = createAgentToolEventForwarder(
		params.socket,
		params.requestId,
		params.session,
		runId,
		stepRunId,
		params.requestId,
		params.mcpHost
	);
	const agentResult: ProviderAgentResult = await runProviderAgentStreaming(
		chatParams,
		withProviderUsageContext(params.options, {
			operation: params.routeDecision.execution === "direct_answer" ? "direct_answer" : "tool_answer"
		}),
		params.history,
		fullSystemPrompt,
		params.mcpHost,
		params.session.approvalGateway,
		params.allowedToolNames,
		forwardToolEvent,
		params.abortSignal,
		undefined,
		{
			workspaceId: params.session.activeWorkspace?.id,
			editorInstanceId: params.session.editorInstanceId,
			sessionId: params.session.sessionId,
			requestId: params.requestId
		}
	);

	if (agentResult.status === "approval_required") {
		throw new Error("Hidden answer execution unexpectedly requested approval.");
	}
	if (agentResult.status === "tool_budget_required") {
		const pendingBudget = createPendingToolBudget({
			agentResult,
			chatParams,
			options: withProviderUsageContext(params.options, {
				operation: params.routeDecision.execution === "direct_answer" ? "direct_answer" : "tool_answer"
			}),
			allowedToolNames: params.allowedToolNames,
			userMessage: chatParams.message,
			requestId: params.requestId,
			userCreatedAt: params.userCreatedAt,
			stream: true
		});
		registerPendingToolBudget(params.session, pendingBudget);
		sendToolBudgetRequired(params.socket, params.requestId, params.session, runId, pendingBudget);
		return;
	}
	if (agentResult.status === "protocol_violation") {
		throw new Error(agentResult.reason);
	}

	await appendChatTurnToSession(
		params.session,
		params.history,
		chatParams.message,
		agentResult.text,
		params.requestId,
		params.userCreatedAt,
		undefined,
		chatParams.additionalContext
	);
	sendSessionEvent(params.socket, params.requestId, params.session, "agent.message.done", {
		runId,
		stepRunId,
		text: agentResult.text,
		context: {
			historyMessagesStored: params.session.messages.length,
			historyBudgetTokens: params.historyBudgetTokens,
			mcpServers: params.mcpHost.getConnectedServerIds()
		}
	});
	sendSessionEvent(params.socket, params.requestId, params.session, "agent.run.done", {
		runId,
		requestId: params.requestId,
		status: "done",
		resultStatus: "completed",
		warnings: [],
		sequence: params.session.workbenchActiveRun.sequence ?? params.session.workbenchActiveRunSequence
	});
	sendJson(params.socket, {
		type: "response",
		id: params.requestId,
		ok: true,
		result: {
			text: agentResult.text,
			context: {
				historyMessagesStored: params.session.messages.length,
				historyBudgetTokens: params.historyBudgetTokens,
				mcpServers: params.mcpHost.getConnectedServerIds()
			}
		}
	});
}

class ContextTooLargeError extends Error {
	readonly code: string = "context_too_large";

	constructor(message: string) {
		super(message);
		this.name = "ContextTooLargeError";
	}
}

type ContextUsageEstimate = {
	usedTokens: number;
	contextWindowTokens: number;
	percent: number;
	availableTokens: number;
	historyTokens: number;
	currentMessageTokens: number;
	systemAndContextTokens: number;
	outputReserveTokens: number;
	safetyMarginTokens: number;
};

function getFullContextHistoryMessages(session: ClientSession, excludeRequestId?: string | undefined): ChatMessage[] {
	const filterRequest = (messages: ChatMessage[]): ChatMessage[] => excludeRequestId === undefined
		? messages
		: messages.filter((message: ChatMessage): boolean => message.requestId !== excludeRequestId);
	if (session.summaryMessage === undefined) {
		return filterRequest(filterLlmContextMessages(session.messages));
	}

	const recentSourceMessages: ChatMessage[] = session.summaryCoveredMessageCount !== undefined
		? session.messages.slice(session.summaryCoveredMessageCount)
		: session.messages;
	return [session.summaryMessage, ...filterRequest(filterLlmContextMessages(recentSourceMessages))];
}

async function estimateFullContextUsage(
	session: ClientSession,
	requestId: string,
	options: ProviderChatOptions,
	params: AiChatParams,
	systemPrompt: string,
	contextPrompt: string,
	abortSignal?: AbortSignal | undefined
): Promise<ContextUsageEstimate> {
	const systemPromptTokens: number = await estimateTextTokensForProvider(options, systemPrompt, abortSignal);
	const contextPromptTokens: number = await estimateTextTokensForProvider(options, contextPrompt, abortSignal);
	const currentMessageTokens: number = await estimateCurrentMessageTokensForProvider(options, params, abortSignal);
	const historyTokens: number = await estimateMessagesTokens(getFullContextHistoryMessages(session, requestId));
	const outputReserveTokens: number = params.options?.maxTokens ?? session.modelProfile.defaultOutputReserveTokens;
	const safetyMarginTokens: number = session.modelProfile.safetyMarginTokens;
	const usedTokens: number = Math.max(0, systemPromptTokens + contextPromptTokens + currentMessageTokens + historyTokens + outputReserveTokens + safetyMarginTokens);
	const contextWindowTokens: number = session.modelProfile.contextWindowTokens;
	const percent: number = contextWindowTokens > 0
		? Math.min(100, Math.round((usedTokens / contextWindowTokens) * 1000) / 10)
		: 0;
	return {
		usedTokens,
		contextWindowTokens,
		percent,
		availableTokens: Math.max(0, contextWindowTokens - usedTokens),
		historyTokens,
		currentMessageTokens,
		systemAndContextTokens: systemPromptTokens + contextPromptTokens,
		outputReserveTokens,
		safetyMarginTokens
	};
}

async function maybeAutoCompressContextBeforeRun(
	socket: WebSocket,
	requestId: string,
	session: ClientSession,
	apiKey: string,
	options: ProviderChatOptions,
	params: AiChatParams,
	systemPrompt: string,
	contextPrompt: string,
	abortSignal?: AbortSignal | undefined
): Promise<ContextUsageEstimate> {
	let estimate: ContextUsageEstimate = await estimateFullContextUsage(session, requestId, options, params, systemPrompt, contextPrompt, abortSignal);
	if (estimate.percent >= 85 && session.messages.length > 8) {
		sendSessionEvent(socket, requestId, session, "ai.status", {
			stage: "context_compress",
			title: "Compressing context",
			details: "Compressing conversation history",
			message: "Compressing conversation history",
			percent: estimate.percent,
			usedTokens: estimate.usedTokens,
			contextWindowTokens: estimate.contextWindowTokens
		});
		const compression = await compressSessionHistory(session, apiKey, 8, requestId);
		sendSessionEvent(socket, requestId, session, "ai.status", {
			stage: "context_compress_done",
			title: compression.compressed ? "Context compressed" : "Context compression skipped",
			details: compression.compressed ? "Conversation history compressed" : compression.reason,
			message: compression.compressed ? "Conversation history compressed" : compression.reason,
			compressed: compression.compressed
		});
		estimate = await estimateFullContextUsage(session, requestId, options, params, systemPrompt, contextPrompt, abortSignal);
	}

	if (estimate.usedTokens > estimate.contextWindowTokens) {
		sendSessionEvent(socket, requestId, session, "ai.status", {
			stage: "context_too_large",
			status: "error",
			title: "Context too large",
			details: "Context is larger than the selected model window",
			message: "Context is larger than the selected model window",
			percent: estimate.percent,
			usedTokens: estimate.usedTokens,
			contextWindowTokens: estimate.contextWindowTokens
		});
		throw new ContextTooLargeError(`当前会话上下文约 ${estimate.usedTokens.toLocaleString()} tokens，超过所选模型窗口 ${estimate.contextWindowTokens.toLocaleString()} tokens。请压缩会话、减少附件或切换到更大上下文模型。`);
	}

	return estimate;
}

function createSessionInfoResult(session: ClientSession, mcpHost: McpHost, historyTokensStored: number | null = null): Record<string, unknown> {
	return {
		provider: session.activeProvider,
		providerDisplayName: getProviderDisplayName(session.activeProvider),
		providerConfigured: session.providerApiKey !== undefined,
		model: session.providerModel ?? session.modelProfile.model,
		historyMessagesStored: session.messages.length,
		historyTokensStored,
		summaryActive: session.summaryMessage !== undefined,
		summaryLength: session.summaryMessage?.content.length ?? 0,
		summaryCoveredMessageCount: session.summaryCoveredMessageCount ?? 0,
		contextWindowTokens: session.modelProfile.contextWindowTokens,
		maxOutputTokens: session.modelProfile.maxOutputTokens,
		defaultOutputReserveTokens: session.modelProfile.defaultOutputReserveTokens,
		safetyMarginTokens: session.modelProfile.safetyMarginTokens,
		approvalMode: session.approvalGateway.getMode(),
		pendingApprovals: session.approvalGateway.listPending().length,
		pendingGuides: session.pendingGuides.length,
		messageQueue: serializeMessageQueue(session),
		workbench: serializeWorkbench(session),
		mcpServers: mcpHost.getConnectedServerIds(session.activeWorkspace?.id),
		customMcpServerStatus: mcpHost.getCustomServerStatusesForWorkspace(session.activeWorkspace?.id),
		godotDiagnostics: mcpHost.getDiagnosticsBridge().getCachedStatus(),
		godotRuntime: createGodotRuntimeStatus(session, mcpHost),
		godotExecutablePath: session.activeWorkspace?.godotExecutablePath ?? session.godotExecutablePath ?? null,
		godotProjectPath: getSessionProjectPath(session) || null,
		activeWorkspace: session.activeWorkspace ? {
			id: session.activeWorkspace.id,
			name: session.activeWorkspace.name,
			kind: session.activeWorkspace.kind,
			rootPath: session.activeWorkspace.rootPath,
			godotExecutablePath: session.activeWorkspace.godotExecutablePath ?? null
		} : null,
		activeSkillId: null
	};
}

import { createProviderRuntimeContext, createSafeMarkdownFence, createMcpSystemContext } from "./prompt-context.js";

type ToolBudgetDecision = "continue" | "stop";

function cloneToolBudgetPhaseStats(stats: PendingToolBudgetPhaseStats | undefined): PendingToolBudgetPhaseStats {
	const fallback: PendingToolBudgetPhaseStats = createEmptyWorkflowPhaseToolStats();
	if (stats === undefined) {
		return fallback;
	}

	return {
		...fallback,
		...stats,
		toolCallRisks: { ...(stats.toolCallRisks ?? {}) }
	};
}

function getQueueItemIdFromParams(params: AiChatParams): number | undefined {
	return params.options?.queueItemId;
}

function hasPendingContinuationForRequest(session: ClientSession, requestId: string): boolean {
	for (const pendingContinuation of session.pendingAiContinuations.values()) {
		if (pendingContinuation.requestId === requestId) {
			return true;
		}
	}
	return false;
}

function hasPendingToolBudgetForRequest(session: ClientSession, requestId: string): boolean {
	for (const pendingBudget of session.pendingToolBudgets.values()) {
		if (pendingBudget.requestId === requestId) {
			return true;
		}
	}
	return false;
}

async function setQueueStatusForRun(
	socket: WebSocket,
	requestId: string,
	session: ClientSession,
	queueItemId: number | undefined,
	status: "sending" | "approval" | "failed" | "cancelled" | "rejected"
): Promise<void> {
	if (queueItemId === undefined) {
		return;
	}
	const result = setQueuedMessageStatus(session, queueItemId, status);
	if (result.item === undefined || !result.changed) {
		return;
	}
	await persistMessageQueueEvent(session, requestId, "message.queue.status", {
		type: "message.queue.status",
		queueId: queueItemId,
		status,
		updatedAt: result.item.updatedAt
	});
	bumpWorkbenchRevision(session);
	emitMessageQueueUpdated(socket, requestId, session);
	emitWorkbenchUpdated(socket, requestId, session);
}

async function removeQueueItemForCompletedRun(
	socket: WebSocket,
	requestId: string,
	session: ClientSession,
	queueItemId: number | undefined
): Promise<void> {
	if (queueItemId === undefined || findQueuedMessage(session, queueItemId) === undefined) {
		return;
	}
	const removed: boolean = removeQueuedMessage(session, queueItemId);
	if (!removed) {
		return;
	}
	await persistMessageQueueEvent(session, requestId, "message.queue.removed", {
		type: "message.queue.removed",
		queueId: queueItemId,
		removedAt: new Date().toISOString()
	});
	bumpWorkbenchRevision(session);
	emitMessageQueueUpdated(socket, requestId, session);
	emitWorkbenchUpdated(socket, requestId, session);
}

export async function finishQueueItemForRun(
	socket: WebSocket,
	requestId: string,
	session: ClientSession,
	queueItemId: number | undefined,
	forcedStatus?: "failed" | "cancelled" | "rejected" | undefined
): Promise<void> {
	if (queueItemId === undefined || findQueuedMessage(session, queueItemId) === undefined) {
		return;
	}
	if (forcedStatus !== undefined) {
		await setQueueStatusForRun(socket, requestId, session, queueItemId, forcedStatus);
		return;
	}
	if (hasPendingContinuationForRequest(session, requestId) || hasPendingToolBudgetForRequest(session, requestId)) {
		await setQueueStatusForRun(socket, requestId, session, queueItemId, "approval");
		return;
	}
	await removeQueueItemForCompletedRun(socket, requestId, session, queueItemId);
}

function createQueueRunRequestId(queueItemId: number): string {
	return `queue-${queueItemId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function drainMessageQueue(socket: WebSocket, requestId: string, session: ClientSession, mcpHost: McpHost): Promise<void> {
	if (session.messageQueueDrainActive || session.activeRunRequestId !== undefined) {
		return;
	}
	if (session.approvalGateway.listPending().length > 0 || session.pendingToolBudgets.size > 0) {
		return;
	}

	session.messageQueueDrainActive = true;
	try {
		while (session.activeRunRequestId === undefined && session.approvalGateway.listPending().length === 0 && session.pendingToolBudgets.size === 0) {
			const nextMessage = getNextRunnableQueuedMessage(session);
			if (nextMessage === undefined) {
				return;
			}
			const queueRequestId: string = createQueueRunRequestId(nextMessage.id);
			await setQueueStatusForRun(socket, requestId, session, nextMessage.id, "sending");
			await handleChatRequest(socket, createQueuedChatRequest(nextMessage, queueRequestId), session, mcpHost);
		}
	} finally {
		session.messageQueueDrainActive = false;
	}
}

async function handleToolBudgetDecision(
	socket: WebSocket,
	responseId: string,
	session: ClientSession,
	mcpHost: McpHost,
	budgetId: string,
	decision: ToolBudgetDecision
): Promise<void> {
	const pending: PendingToolBudget | undefined = session.pendingToolBudgets.get(budgetId);
	if (pending === undefined) {
		sendJson(socket, {
			type: "response",
			id: responseId,
			ok: false,
			error: {
				code: "tool_budget_not_found",
				message: `Tool budget continuation not found: ${budgetId}`
			}
		});
		return;
	}

	const sessionRun = beginSessionRun(session.sessionId, pending.requestId);
	if (!sessionRun.ok) {
		sendJson(socket, {
			type: "response",
			id: responseId,
			ok: false,
			error: {
				code: "session_busy",
				message: `Session is already running request ${sessionRun.activeRequestId}.`
			}
		});
		return;
	}

	const abortController: AbortController = new AbortController();
	const runId: string = pending.continuation.workflowState?.plan.id ?? pending.requestId;
	const stepRunId: string = pending.continuation.workflowState?.activePhaseRunId ?? pending.requestId;
	const queueItemId: number | undefined = getQueueItemIdFromParams(pending.continuation.params);
	session.activeAbortControllers.set(pending.requestId, abortController);
	session.activeRunRequestId = pending.requestId;
	session.pendingToolBudgets.delete(budgetId);
	registerSessionRunController(session.sessionId, pending.requestId, abortController);
	setWorkbenchActiveRun(session, {
		status: "streaming",
		requestId: pending.requestId,
		startedAt: pending.continuation.userCreatedAt,
		queueItemId
	});
	sendSessionEvent(socket, pending.requestId, session, "agent.run.tool_budget.resolved", {
		runId,
		budgetId,
		decision
	}, pending.requestId);
	emitWorkbenchUpdated(socket, pending.requestId, session);
	sendJson(socket, {
		type: "response",
		id: responseId,
		ok: true,
		result: {
			budgetId,
			accepted: true,
			continued: decision === "continue",
			stopped: decision === "stop",
			requestId: pending.requestId,
			workbench: serializeWorkbench(session)
		}
	});

	void runToolBudgetDecisionContinuation({
		socket,
		session,
		mcpHost,
		pending,
		budgetId,
		decision,
		abortController,
		runId,
		stepRunId,
		queueItemId
	});
}

async function runToolBudgetDecisionContinuation(params: {
	socket: WebSocket;
	session: ClientSession;
	mcpHost: McpHost;
	pending: PendingToolBudget;
	budgetId: string;
	decision: ToolBudgetDecision;
	abortController: AbortController;
	runId: string;
	stepRunId: string;
	queueItemId: number | undefined;
}): Promise<void> {
	const {
		socket,
		session,
		mcpHost,
		pending,
		budgetId,
		decision,
		abortController,
		runId,
		stepRunId,
		queueItemId
	} = params;
	let shouldDrainQueueAfterRun: boolean = false;

	try {
		const pendingContinuation: PendingAiContinuation = pending.continuation;
		const continuationParams: AiChatParams = await hydrateImageAttachmentContexts(session.sessionId, pendingContinuation.params);
		const toolStats: PendingToolBudgetPhaseStats = cloneToolBudgetPhaseStats(pending.workflowPhaseToolStats);
		let toolObservations: WorkflowToolObservation[] = pending.workflowToolObservations?.map((observation: WorkflowToolObservation): WorkflowToolObservation => ({ ...observation })) ?? [];
		const forwardToolEvent: OnToolEvent = createAgentToolEventForwarder(
			socket,
			pending.requestId,
			session,
			runId,
			stepRunId,
			pending.requestId,
			mcpHost
		);
		const onToolEvent: OnToolEvent = (event: ToolEvent): void => {
			if (pendingContinuation.workflowState !== undefined) {
				updateWorkflowPhaseToolStats(toolStats, event);
				toolObservations = applyToolEventToWorkflowObservations(toolObservations, event);
			}
			forwardToolEvent(event);
		};

		const toolContext = {
			workspaceId: session.activeWorkspace?.id,
			editorInstanceId: session.editorInstanceId,
			sessionId: session.sessionId,
			requestId: pending.requestId
		};
		const agentResult: ProviderAgentResult = decision === "continue"
			? pendingContinuation.stream
				? await continueProviderAgentAfterToolBudgetStreaming(
					continuationParams,
					pendingContinuation.options,
					pendingContinuation.continuation,
					mcpHost,
					session.approvalGateway,
					pendingContinuation.allowedToolNames,
					onToolEvent,
					abortController.signal,
					toolContext
				)
				: await continueProviderAgentAfterToolBudget(
					continuationParams,
					pendingContinuation.options,
					pendingContinuation.continuation,
					mcpHost,
					session.approvalGateway,
					pendingContinuation.allowedToolNames,
					onToolEvent,
					abortController.signal,
					toolContext
				)
			: pendingContinuation.stream
				? await finalizeProviderAgentAfterToolBudgetStreaming(
					continuationParams,
					pendingContinuation.options,
					pendingContinuation.continuation,
					pendingContinuation.allowedToolNames,
					createToolBudgetStopReason(pending),
					onToolEvent,
					abortController.signal,
					toolContext
				)
				: await finalizeProviderAgentAfterToolBudget(
					continuationParams,
					pendingContinuation.options,
					pendingContinuation.continuation,
					pendingContinuation.allowedToolNames,
					createToolBudgetStopReason(pending),
					onToolEvent,
					abortController.signal,
					toolContext
				);

		if (pendingContinuation.workflowState !== undefined) {
			const continuationWorkflowState: WorkflowRunState = {
				...pendingContinuation.workflowState,
				originalParams: continuationParams
			};
			const phaseRunResult: WorkflowPhaseRunResult = {
				agentResult,
				toolStats,
				toolObservations,
				capturedAttachments: []
			};
			await continueWorkflowExecution(
				socket,
				pending.requestId,
				session,
				mcpHost,
				pendingContinuation.options,
				continuationWorkflowState,
				pendingContinuation.userCreatedAt,
				undefined,
				pending.requestId,
				abortController.signal,
				[],
				phaseRunResult
			);
		} else {
			await sendContinuedAgentResult(
				socket,
				pending.requestId,
				session,
				mcpHost,
				agentResult,
				{
					...pendingContinuation,
					params: continuationParams
				}
			);
		}

		if (session.approvalGateway.listPending().length > 0 || session.pendingToolBudgets.size > 0) {
			emitWorkbenchUpdated(socket, pending.requestId, session);
			return;
		}

		setWorkbenchActiveRun(session, { status: "idle" });
		await finishQueueItemForRun(socket, pending.requestId, session, queueItemId);
		shouldDrainQueueAfterRun = findQueuedMessage(session, queueItemId ?? 0) === undefined;
		emitWorkbenchUpdated(socket, pending.requestId, session);
	} catch (error: unknown) {
		if (isCancellationError(error, abortController.signal)) {
			setWorkbenchActiveRun(session, { status: "idle" });
			await finishQueueItemForRun(socket, pending.requestId, session, queueItemId, "cancelled");
			emitWorkbenchUpdated(socket, pending.requestId, session);
			sendAgentCancelled(socket, pending.requestId, session);
			sendJson(socket, {
				type: "response",
				id: pending.requestId,
				ok: true,
				result: {
					cancelled: true,
					requestId: pending.requestId,
					budgetId
				}
			});
			return;
		}
		setWorkbenchActiveRun(session, { status: "idle" });
		await finishQueueItemForRun(socket, pending.requestId, session, queueItemId, "failed");
		if (error instanceof WorkflowExecutionError) {
			const workflowErrorMessage: string = error.message.length > 0
				? error.message
				: error.originalError instanceof Error
					? error.originalError.message
					: "Workflow failed";
			sendWorkflowEvent(socket, pending.requestId, session, "workflow.error", {
				workflowId: error.plan.id,
				requestId: pending.requestId,
				title: error.plan.title,
				code: "agent_run_error",
				message: workflowErrorMessage,
				sequence: session.workbenchActiveRun.sequence ?? session.workbenchActiveRunSequence
			}, pending.requestId);
			emitWorkbenchUpdated(socket, pending.requestId, session);
			sendJson(socket, {
				type: "response",
				id: pending.requestId,
				ok: false,
				error: {
					code: "agent_run_error",
					message: workflowErrorMessage
				}
			});
			return;
		}
		emitWorkbenchUpdated(socket, pending.requestId, session);
		const toolBudgetErrorStatus = classifyProviderError(error);
		sendSessionEvent(socket, pending.requestId, session, "agent.run.error", {
			runId,
			requestId: pending.requestId,
			status: "error",
			code: toolBudgetErrorStatus.code,
			message: toolBudgetErrorStatus.message,
			sequence: session.workbenchActiveRun.sequence ?? session.workbenchActiveRunSequence
		}, pending.requestId);
		sendJson(socket, {
			type: "response",
			id: pending.requestId,
			ok: false,
			error: {
				code: toolBudgetErrorStatus.code,
				message: toolBudgetErrorStatus.message
			}
		});
	} finally {
		session.activeAbortControllers.delete(pending.requestId);
		if (session.activeRunRequestId === pending.requestId) {
			session.activeRunRequestId = undefined;
		}
		finishSessionRun(session.sessionId, pending.requestId);
		if (shouldDrainQueueAfterRun) {
			void drainMessageQueue(socket, pending.requestId, session, mcpHost);
		}
	}
}

export async function handleChatRequest(socket: WebSocket, request: ClientRequest, session: ClientSession, mcpHost: McpHost): Promise<void> {
	switch (request.method) {
		case "ai.cancel": {
			const activeSessionRun = getActiveSessionRunController(session.sessionId, request.params.requestId)
				?? getActiveSessionRunController(session.sessionId);
			const targetRequestId: string = session.activeAbortControllers.has(request.params.requestId)
				? request.params.requestId
				: activeSessionRun?.requestId ?? request.params.requestId;
			const controller: AbortController | undefined = session.activeAbortControllers.get(targetRequestId)
				?? activeSessionRun?.controller;
			if (controller !== undefined) {
				setWorkbenchActiveRun(session, {
					status: "cancelling",
					requestId: targetRequestId
				});
				emitWorkbenchUpdated(socket, request.id, session);
				controller.abort();
			}
			const cancelledApprovalIds: string[] = await cancelPendingApprovalsForRequest(session, targetRequestId);
			const cancelledToolBudgetIds: string[] = cancelPendingToolBudgetsForRequest(session, targetRequestId);
			// The aborted stream can finish while this cancellation RPC awaits approval cleanup.
			// Treat that terminal race as an accepted, idempotent cancellation instead of
			// reporting a false failure back to the Studio client.
			const alreadyFinished: boolean = controller === undefined
				&& cancelledApprovalIds.length === 0
				&& cancelledToolBudgetIds.length === 0
				&& session.completedRequestIds.has(targetRequestId);
			if (cancelledApprovalIds.length > 0 || cancelledToolBudgetIds.length > 0) {
				session.activeRunRequestId = session.activeRunRequestId === targetRequestId
					? undefined
					: session.activeRunRequestId;
				finishSessionRun(session.sessionId, targetRequestId);
				setWorkbenchActiveRun(session, {
					status: "idle",
					requestId: targetRequestId
				});
				emitWorkbenchUpdated(socket, request.id, session);
			}
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					cancelled: controller !== undefined || cancelledApprovalIds.length > 0 || cancelledToolBudgetIds.length > 0,
					cancellationRequested: controller !== undefined,
					alreadyFinished,
					requestId: targetRequestId,
					cancelledApprovalIds,
					cancelledToolBudgetIds
				}
			});
			break;
		}

		case "ai.toolBudget.continue":
		case "ai.toolBudget.stop": {
			const ownerSession: ClientSession | undefined = session.pendingToolBudgets.has(request.params.budgetId)
				? session
				: findSessionWithPendingToolBudget(request.params.budgetId);
			if (ownerSession !== undefined && ownerSession !== session) {
				await handleChatRequest(socket, request, ownerSession, mcpHost);
				break;
			}
			await handleToolBudgetDecision(
				socket,
				request.id,
				session,
				mcpHost,
				request.params.budgetId,
				request.method === "ai.toolBudget.continue" ? "continue" : "stop"
			);
			break;
		}

		case "ai.chat": {
			await waitForFullSessionLoad(session);
			const slashCommandResult: SlashCommandResult = await handleSlashCommand({
				socket,
				request,
				session,
				mcpHost,
				createSessionInfo: createSessionInfoResult
			});
			if (slashCommandResult.type === "handled") {
				break;
			}

			const rawParams: AiChatParams = slashCommandResult.type === "ai"
				? slashCommandResult.params
				: request.params;
			const params: AiChatParams = normalizeChatParamsForMode({
				...rawParams,
				message: rawParams.message.length > 0 ? rawParams.message : session.workbenchComposer.text,
				mode: rawParams.mode ?? session.workbenchComposer.chatMode,
				additionalContext: rawParams.additionalContext ?? session.workbenchComposer.additionalContext
			});
			const queueItemId: number | undefined = getQueueItemIdFromParams(params);
			const modelSnapshotChanged: boolean = applyChatRequestModelSnapshot(session, params);
			if (modelSnapshotChanged && session.sessionId !== undefined) {
				await updateSessionMetadata(session.sessionId, createRuntimeSessionUiMetadata(session));
			}
			const webSearchEnabled: boolean = await isWebSearchEnabled();
			const webSearchAvailable: boolean = webSearchEnabled ? await isWebSearchToolAvailable() : false;
			if (webSearchEnabled && !webSearchAvailable) {
				await finishQueueItemForRun(socket, request.id, session, queueItemId, "failed");
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "web_search_unavailable",
						message: await createWebSearchUnavailableMessage()
					}
				});
				break;
			}
			const apiKey: string | undefined = await ensureProviderConfigured(session);

			if (!apiKey) {
				await finishQueueItemForRun(socket, request.id, session, queueItemId, "failed");
				logger.warn("ai", "provider_not_configured", {
					requestId: request.id,
					sessionId: session.sessionId,
					workspaceId: session.activeWorkspace?.id,
					provider: session.activeProvider
				});
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "provider_not_configured",
						message: `${getProviderDisplayName(session.activeProvider)} API key is not configured. Save it with provider.config.set first.`
					}
				});
				break;
			}

			const runSessionId: string | undefined = session.sessionId;
			const sessionRun = beginSessionRun(runSessionId, request.id);
			if (session.activeRunRequestId !== undefined || !sessionRun.ok) {
				const activeRequestId: string = session.activeRunRequestId ?? (sessionRun.ok ? request.id : sessionRun.activeRequestId);
				await finishQueueItemForRun(socket, request.id, session, queueItemId, "failed");
				logger.warn("ai", "session_busy", {
					requestId: request.id,
					sessionId: session.sessionId,
					workspaceId: session.activeWorkspace?.id,
					activeRequestId
				});
				sendSessionEvent(socket, request.id, session, "session.run.busy", {
					sessionId: session.sessionId ?? null,
					activeRequestId,
					rejectedRequestId: request.id
				});
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "session_busy",
						message: "This session already has an active AI run."
					}
				});
				break;
			}

			const abortController: AbortController = new AbortController();
			session.activeAbortControllers.set(request.id, abortController);
			session.activeRunRequestId = request.id;
			registerSessionRunController(runSessionId, request.id, abortController);
			const runStartedAtMs: number = Date.now();
			const turnStartedAt: string = new Date().toISOString();
			let persistedParams: AiChatParams = params;
			let queuedRunForcedStatus: "failed" | "cancelled" | undefined;
			await setQueueStatusForRun(socket, request.id, session, queueItemId, "sending");
			const startedActiveRun = setWorkbenchActiveRun(session, {
				status: "streaming",
				requestId: request.id,
				startedAt: turnStartedAt,
				queueItemId
			});
			sendSessionEvent(socket, request.id, session, "agent.run.started", {
				runId: request.id,
				requestId: request.id,
				status: "streaming",
				sequence: startedActiveRun.sequence
			});
			emitWorkbenchUpdated(socket, request.id, session);

			try {
				const options: ProviderChatOptions = withProviderUsageContext(createProviderChatOptions(session, apiKey), {
					requestId: request.id,
					runId: request.id,
					sessionId: session.sessionId,
					workspaceId: session.activeWorkspace?.id,
					operation: "chat"
				});
				const isFirstUserTurn: boolean = isFirstSessionUserTurn(session.messages, request.id);
				maybeScheduleSessionTitleGeneration(socket, request.id, session, params, options, isFirstUserTurn);
				const hydratedParams: AiChatParams = await hydrateImageAttachmentContexts(session.sessionId, params);
				const imagePreprocess: ImageRecognitionPreprocessResult = await preprocessImageAttachmentsForTextModel(
					hydratedParams,
					options,
					abortController.signal,
					(progress): void => {
						sendSessionEvent(socket, request.id, session, "ai.status", progress);
					}
				);
				const storedUserPrompt: string = await getUserPrompt();
				await mcpHost.ensureGlobalCustomServers();
				const effectiveParams: AiChatParams = {
					...imagePreprocess.params,
					systemPrompt: imagePreprocess.params.systemPrompt ?? (storedUserPrompt.length > 0 ? storedUserPrompt : undefined)
				};
				persistedParams = effectiveParams;
				logger.info("ai", "chat_started", {
					requestId: request.id,
					sessionId: session.sessionId,
					workspaceId: session.activeWorkspace?.id,
					editorInstanceId: session.editorInstanceId,
					provider: options.provider,
					model: resolveChatModel(options),
					mode: effectiveParams.mode,
					messageChars: effectiveParams.message.length,
					additionalContextCount: effectiveParams.additionalContext?.length ?? 0,
					hasImages: hasImageAttachments(effectiveParams),
					imageRecognized: imagePreprocess.recognized,
					retryFromRequestId: effectiveParams.retryFromRequestId
				});
				const requestHasImages: boolean = hasImageAttachments(effectiveParams);
				if (effectiveParams.mode === "plan") {
					const plan: StoredPlan = await createInitialPlan(
						socket,
						request.id,
						session,
						effectiveParams,
						options,
						mcpHost,
						turnStartedAt,
						abortController.signal
					);
					sendJson(socket, {
						type: "response",
						id: request.id,
						ok: true,
						result: createPlanGetResult(plan)
					});
					break;
				}
				const skillWorkspace: SkillWorkspace = session.activeWorkspace !== undefined
					? { id: session.activeWorkspace.id, rootPath: session.activeWorkspace.rootPath }
					: createGlobalSkillWorkspace();
				const explicitSkills: CatalogSkill[] = await resolveExplicitSkills(skillWorkspace, effectiveParams.skillRefs ?? []);
				const builtinToolRestriction: readonly string[] | undefined = resolveBuiltinToolRestriction(explicitSkills);
				const imageGenerationOnly: boolean = isImageGenerationOnlyToolRestriction(builtinToolRestriction);
				let allowedToolNames: readonly string[] | undefined = resolveAllowedToolsForChatParams(effectiveParams, builtinToolRestriction, session.activeWorkspace?.id);
				if (imageGenerationOnly) {
					allowedToolNames = builtinToolRestriction;
				}
				if (allowedToolNames !== undefined && !allowedToolNames.includes("mcp_skills_load")) {
					allowedToolNames = [...allowedToolNames, "mcp_skills_load"];
				}
				if (session.activeWorkspace === undefined) {
					allowedToolNames = allowedToolNames !== undefined
						? filterToolNamesForWorkspace(allowedToolNames, undefined)
						: getNoWorkspaceToolNames();
				}
				allowedToolNames = await resolveSearchAwareToolNames(allowedToolNames, session, webSearchEnabled);
				const promptId = effectiveParams.promptId ?? explicitSkills.find((skill): boolean => skill.defaultPromptId !== undefined)?.defaultPromptId;
				const systemPrompt: string = await composeSystemPrompt(
					promptId,
					effectiveParams.systemPrompt,
					createProviderRuntimeContext(session),
					effectiveParams.mode
				);
				const skillPrompt: string = composeExplicitSkillPrompt(explicitSkills);
				const skillCatalogPrompt: string = await composeSkillCatalogPrompt(skillWorkspace);
				const mcpSystemContext: string = await createMcpSystemContext(mcpHost, session);
				const additionalContextSection: string = createAdditionalContextPromptSection(effectiveParams.additionalContext);
				const guidePromptSection: string = consumePendingGuideSection(socket, request.id, session);
				const fullSystemPrompt: string = systemPrompt
					+ (skillPrompt.length > 0 ? `\n\n${skillPrompt}` : "")
					+ (skillCatalogPrompt.length > 0 ? `\n\n${skillCatalogPrompt}` : "")
					+ mcpSystemContext
					+ (additionalContextSection.length > 0 ? `\n\n${additionalContextSection}` : "")
					+ (guidePromptSection.length > 0 ? `\n\n${guidePromptSection}` : "");
				logPromptTrace({
					requestId: request.id,
					promptId,
					skillId: effectiveParams.skillRefs?.join(","),
					customInstructions: effectiveParams.systemPrompt,
					systemPrompt,
					skillPrompt,
					mcpSystemContext,
					additionalContextSection,
					guidePromptSection,
					fullSystemPrompt
				});
				if (effectiveParams.retryFromRequestId !== undefined && session.sessionId !== undefined) {
					await waitForSessionEventPersistence(session);
					const rewoundMessages: StoredMessage[] = await rewindSessionFromRequest(session.sessionId, effectiveParams.retryFromRequestId);
					session.messages = rewoundMessages.map(toChatMessage);
					session.fullSessionLoadPromise = undefined;
					session.summaryMessage = undefined;
					session.summaryCoveredMessageCount = undefined;
				}
				await appendUserMessageToSession(
					session,
					effectiveParams.message,
					request.id,
					turnStartedAt,
					effectiveParams.additionalContext
				);
				await maybeAutoCompressContextBeforeRun(
					socket,
					request.id,
					session,
					apiKey,
					options,
					effectiveParams,
					systemPrompt,
					skillPrompt + skillCatalogPrompt + mcpSystemContext + additionalContextSection + guidePromptSection,
					abortController.signal
				);
				const historyBudgetTokens: number = await computeHistoryBudget(
					session.modelProfile,
					options,
					effectiveParams,
					systemPrompt,
					skillPrompt + skillCatalogPrompt + mcpSystemContext + additionalContextSection + guidePromptSection,
					abortController.signal
				);
				const history: ChatMessage[] = await selectHistoryForModel(session, historyBudgetTokens, request.id);
				const planningContext: string = skillPrompt + skillCatalogPrompt + mcpSystemContext + additionalContextSection + guidePromptSection;
				let routeDecision: WorkflowRouteDecision;
				const forcedRoute: WorkflowRouteDecision | null = resolveForcedWorkflowRoute(effectiveParams);
				if (forcedRoute !== null) {
					routeDecision = forcedRoute;
				} else if (builtinToolRestriction !== undefined && (effectiveParams.mode !== "ask" || imageGenerationOnly)) {
					const skillRestrictionRequiresWrite: boolean = effectiveParams.mode !== "ask"
						&& toolNamesIncludeWriteRisk(builtinToolRestriction, session.activeWorkspace?.id);
					routeDecision = {
						execution: "tool_answer",
						reason: "Explicit skill tool restriction uses hidden single-turn tool execution.",
						requiresTools: true,
						requiresWrite: skillRestrictionRequiresWrite,
						planningHint: ""
					};
				} else if (requestHasImages) {
					routeDecision = {
						execution: "direct_answer",
						reason: "Image attachments were preprocessed before routing; answer without workflow todos.",
						requiresTools: false,
						requiresWrite: false,
						planningHint: ""
					};
				} else {
					try {
						const routerOptions: ProviderChatOptions = withProviderUsageContext(
							(await resolveProviderTaskModelOptions("workflowPlanner", options)).options,
							{ operation: "workflow_router" }
						);
						routeDecision = await routeWorkflowExecution(
							effectiveParams,
							routerOptions,
							history,
							createWorkflowRouteContext(session, mcpHost, effectiveParams.additionalContext),
							abortController.signal
						);
					} catch (error: unknown) {
						logger.warn("ai", "workflow_router_failed_fallback", {
							requestId: request.id,
							sessionId: session.sessionId,
							message: error instanceof Error ? error.message : "Workflow router failed"
						});
						routeDecision = createFallbackWorkflowRoute(effectiveParams, error instanceof Error ? error.message : "Workflow router failed.");
					}
				}
				routeDecision = applyExplicitSkillWriteRequirement(
					routeDecision,
					effectiveParams,
					builtinToolRestriction,
					session.activeWorkspace?.id
				);
				logger.info("ai", "workflow_route_decided", {
					requestId: request.id,
					sessionId: session.sessionId,
					execution: routeDecision.execution,
					reason: routeDecision.reason,
					requiresTools: routeDecision.requiresTools,
					requiresWrite: routeDecision.requiresWrite,
					forcedByOption: routeDecision.forcedByOption ?? null,
					safetyOverride: routeDecision.safetyOverride ?? null
				});

				const originalApprovalGateway: ApprovalGateway = session.approvalGateway;
				const hiddenAnswerToolNames: readonly string[] = resolveHiddenAnswerToolNames(routeDecision, allowedToolNames, session);
				if (routeDecision.execution !== "workflow" && !routeDecision.requiresWrite) {
					session.approvalGateway = new ReadOnlyToolApprovalGateway(hiddenAnswerToolNames);
				} else if (effectiveParams.mode === "ask" && !imageGenerationOnly) {
					session.approvalGateway = new ReadOnlyToolApprovalGateway(allowedToolNames ?? []);
				}
				try {
					if (routeDecision.execution === "workflow") {
						let workflowPlan: WorkflowPlan | null = await createWorkflowPlanForRoute(
							effectiveParams,
							options,
							history,
							[planningContext, routeDecision.planningHint].filter((section: string): boolean => section.length > 0).join("\n\n"),
							abortController.signal,
							{ activeWorkspace: session.activeWorkspace }
						);
						if (workflowPlan !== null && !webSearchEnabled) {
							workflowPlan = filterWebSearchFromWorkflowPlan(workflowPlan);
						}
						if (workflowPlan !== null) {
							logger.info("ai", "workflow_planned", {
								requestId: request.id,
								sessionId: session.sessionId,
								workflowSource: workflowPlan.source ?? null,
								workflowPhaseCount: workflowPlan.phases.length,
								workflowPhaseIds: workflowPlan.phases.map((phase: WorkflowPhase): string => phase.id),
								historyMessages: history.length,
								historyBudgetTokens,
								allowedToolCount: allowedToolNames?.length ?? null
							});
							await startWorkflowExecution(
								socket,
								request.id,
								session,
								mcpHost,
								options,
								workflowPlan,
								effectiveParams,
								history,
								historyBudgetTokens,
								turnStartedAt,
								planningContext,
								guidePromptSection,
								abortController.signal
							);
						} else {
							routeDecision = createFallbackWorkflowRoute(effectiveParams, "Workflow planner returned no executable plan.");
							await runHiddenAnswerExecution({
								socket,
								requestId: request.id,
								session,
								mcpHost,
								options,
								chatParams: effectiveParams,
								routeDecision,
								history,
								historyBudgetTokens,
								fullSystemPrompt,
								allowedToolNames: resolveHiddenAnswerToolNames(routeDecision, allowedToolNames, session),
								userCreatedAt: turnStartedAt,
								abortSignal: abortController.signal
							});
						}
					} else {
						await runHiddenAnswerExecution({
							socket,
							requestId: request.id,
							session,
							mcpHost,
							options,
							chatParams: effectiveParams,
							routeDecision,
							history,
							historyBudgetTokens,
							fullSystemPrompt,
							allowedToolNames: hiddenAnswerToolNames,
							userCreatedAt: turnStartedAt,
							abortSignal: abortController.signal
						});
					}
				} finally {
					session.approvalGateway = originalApprovalGateway;
				}
				logger.info("ai", "chat_finished", {
					requestId: request.id,
					sessionId: runSessionId,
					workspaceId: session.activeWorkspace?.id,
					durationMs: Date.now() - runStartedAtMs
				});
				clearWorkbenchComposer(session, true);
				emitWorkbenchUpdated(socket, request.id, session);
				break;
			} catch (error: unknown) {
				if (isCancellationError(error, abortController.signal)) {
					queuedRunForcedStatus = "cancelled";
					logger.warn("ai", "chat_cancelled", {
						requestId: request.id,
						sessionId: runSessionId,
						workspaceId: session.activeWorkspace?.id,
						durationMs: Date.now() - runStartedAtMs
					});
					sendAgentCancelled(socket, request.id, session);
					sendJson(socket, {
						type: "response",
						id: request.id,
						ok: true,
						result: {
							cancelled: true,
							requestId: request.id
						}
					});
					break;
				}
				if (error instanceof ProviderImageInputError) {
					queuedRunForcedStatus = "failed";
					logger.warn("ai", "image_input_rejected", {
						requestId: request.id,
						sessionId: session.sessionId,
						code: error.code,
						message: error.message
					});
					sendSessionEvent(socket, request.id, session, "agent.run.error", {
						runId: request.id,
						requestId: request.id,
						status: "error",
						code: error.code,
						message: error.message,
						sequence: session.workbenchActiveRun.sequence ?? session.workbenchActiveRunSequence
					});
					sendJson(socket, {
						type: "response",
						id: request.id,
						ok: false,
						error: {
							code: error.code,
							message: error.message
						}
					});
					break;
				}
				if (error instanceof ContextTooLargeError) {
					queuedRunForcedStatus = "failed";
					logger.warn("ai", "context_too_large", {
						requestId: request.id,
						sessionId: runSessionId,
						workspaceId: session.activeWorkspace?.id,
						message: error.message
					});
					sendSessionEvent(socket, request.id, session, "agent.run.error", {
						runId: request.id,
						requestId: request.id,
						status: "error",
						code: error.code,
						message: error.message,
						sequence: session.workbenchActiveRun.sequence ?? session.workbenchActiveRunSequence
					});
					await waitForSessionEventPersistence(session);
					await appendFailedChatTurnToSession(
						session,
						persistedParams.message,
						{
							code: error.code,
							message: error.message
						},
						request.id,
						turnStartedAt,
						undefined,
						persistedParams.additionalContext
					);
					sendJson(socket, {
						type: "response",
						id: request.id,
						ok: false,
						error: {
							code: error.code,
							message: error.message
						}
					});
					break;
				}
				if (error instanceof WorkflowExecutionError) {
					queuedRunForcedStatus = "failed";
					const workflowErrorMessage: string = error.message.length > 0
						? error.message
						: error.originalError instanceof Error
							? error.originalError.message
							: "Workflow failed";
					logger.error("ai", "workflow_failed", error, {
						requestId: request.id,
						sessionId: runSessionId,
						workspaceId: session.activeWorkspace?.id,
						durationMs: Date.now() - runStartedAtMs
					});
					sendSessionEvent(socket, request.id, session, "agent.run.error", {
						runId: error.plan.id,
						requestId: request.id,
						status: "error",
						title: error.plan.title,
						code: "agent_run_error",
						message: workflowErrorMessage,
						sequence: session.workbenchActiveRun.sequence ?? session.workbenchActiveRunSequence
					});
					await waitForSessionEventPersistence(session);
					await appendFailedChatTurnToSession(
						session,
						persistedParams.message,
						{
							code: "agent_run_error",
							message: workflowErrorMessage
						},
						request.id,
						turnStartedAt,
						undefined,
						persistedParams.additionalContext,
						workflowErrorMessage
					);
					sendJson(socket, {
						type: "response",
						id: request.id,
						ok: false,
						error: {
							code: "agent_run_error",
							message: workflowErrorMessage
						}
					});
					break;
				}
				queuedRunForcedStatus = "failed";
				const providerError = classifyProviderError(error);
				logger.error("ai", "chat_failed", error, {
					requestId: request.id,
					sessionId: runSessionId,
					workspaceId: session.activeWorkspace?.id,
					code: providerError.code,
					durationMs: Date.now() - runStartedAtMs
				});
				sendSessionEvent(socket, request.id, session, "agent.run.error", {
					runId: request.id,
					requestId: request.id,
					status: "error",
					code: providerError.code,
					message: providerError.message,
					sequence: session.workbenchActiveRun.sequence ?? session.workbenchActiveRunSequence
				});
				await waitForSessionEventPersistence(session);
				await appendFailedChatTurnToSession(
					session,
					persistedParams.message,
					{
						code: providerError.code,
						message: providerError.message
					},
					request.id,
					turnStartedAt,
					undefined,
					persistedParams.additionalContext
				);
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: providerError.code,
						message: providerError.message
					}
				});
			} finally {
				const ownsActiveRun: boolean = session.activeRunRequestId === request.id
					|| session.workbenchActiveRun.requestId === request.id;
				session.activeAbortControllers.delete(request.id);
				if (session.activeRunRequestId === request.id) {
					session.activeRunRequestId = undefined;
				}
				if (ownsActiveRun) {
					setWorkbenchActiveRun(session, {
						status: session.approvalGateway.listPending().length > 0 ? "approval" : "idle",
						requestId: request.id,
						queueItemId
					});
					emitWorkbenchUpdated(socket, request.id, session);
				}
				finishSessionRun(runSessionId, request.id);
				await finishQueueItemForRun(socket, request.id, session, queueItemId, queuedRunForcedStatus);
				const queueItemStillExists: boolean = queueItemId !== undefined && findQueuedMessage(session, queueItemId) !== undefined;
				if (queueItemId === undefined || !queueItemStillExists) {
					void drainMessageQueue(socket, request.id, session, mcpHost);
				}
			}
			break;
		}

		case "ai.next_step_hints": {
			await waitForFullSessionLoad(session);
			if (request.params?.sessionId !== undefined && request.params.sessionId !== session.sessionId) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "session_mismatch",
						message: "Next-step hints can only be generated for the active session."
					}
				});
				break;
			}
			if (!session.sessionId) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "no_session", message: "No active session for next-step hints." }
				});
				break;
			}

			const apiKey: string | undefined = await ensureProviderConfigured(session);
			if (!apiKey) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "provider_not_configured",
						message: `${getProviderDisplayName(session.activeProvider)} API key is not configured. Save it with provider.config.set first.`
					}
				});
				break;
			}

			const abortController: AbortController = new AbortController();
			session.activeAbortControllers.set(request.id, abortController);
			try {
				const hints: NextStepHint[] = await createNextStepHints(
					session,
					withProviderUsageContext(createProviderChatOptions(session, apiKey), {
						requestId: request.id,
						runId: request.id,
						sessionId: session.sessionId,
						workspaceId: session.activeWorkspace?.id,
						operation: "next_step_hints"
					}),
					request.params?.maxHints ?? DEFAULT_NEXT_STEP_HINT_COUNT,
					request.params?.trigger ?? "done",
					request.params?.anchorRequestId,
					abortController.signal
				);
				setWorkbenchNextStepHints(session, hints, request.params?.trigger ?? "done", request.params?.anchorRequestId);
				emitWorkbenchUpdated(socket, request.id, session);
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: true,
					result: {
						nextStepHints: true,
						sessionId: session.sessionId,
						anchorRequestId: request.params?.anchorRequestId ?? null,
						hints,
						generatedAt: new Date().toISOString()
					}
				});
			} catch (error: unknown) {
				if (isCancellationError(error, abortController.signal)) {
					sendJson(socket, {
						type: "response",
						id: request.id,
						ok: true,
						result: {
							cancelled: true,
							requestId: request.id
						}
					});
					break;
				}
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "next_step_hints_error",
						message: error instanceof Error ? error.message : "Failed to generate next-step hints"
					}
				});
			} finally {
				session.activeAbortControllers.delete(request.id);
			}
			break;
		}


		default:
			throw new Error(`Unsupported chat request method: ${request.method}`);
	}
}
