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
import {
	readAgentRunState,
	removeAgentRunContinuation
} from "../session/agent-run-store.js";
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
	appendSessionEvent, appendApprovalEvent, appendWorkflowEvent, appendAgentEvent, clearSessionEvents, readApprovalEvents, updateSessionMetadata, promoteTemporarySession,
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
import { resolveReasoningEffort, resolveReasoningEffortForModelChange } from "../providers/reasoning-effort.js";
import { classifyProviderError, createProviderStatusEvent } from "../providers/provider-error.js";
import { isFirstSessionUserTurn } from "./session-title.js";
import { planWorkflow, planWorkflowAfterLlmPlannerFailure, READ_TOOLS, VERIFY_TOOLS, WRITE_TOOLS } from "../workflow/planner.js";
import { createLlmWorkflowPlan, reviseLlmWorkflowPlan } from "../workflow/llm-planner.js";
import { createGodotTemplateWorkflowPlan, type GodotTemplateTarget } from "../workflow/godot-template-planner.js";
import { resolveWorkflowExecutionProfile, type WorkflowExecutionProfileId } from "../workflow/execution-profile.js";
import { getExecutionPolicy, routeWorkflowExecution, type WorkflowRouteContext, type WorkflowRouteDecision } from "../workflow/router.js";
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
import type { WorkflowCompletionTarget, WorkflowPhase, WorkflowPhaseOutput, WorkflowPlan, WorkflowRunState, WorkflowToolObservation } from "../workflow/types.js";
import {
	applyToolEventToLightweightActionState,
	collectLightweightActionCompletionStatus,
	createLightweightActionState,
	LightweightActionScopeExceededError,
	LightweightActionVerificationError,
	type LightweightActionState
} from "../workflow/lightweight-action.js";
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
import { ExecutionContractUnresolvedError, type ExecutionControlContext } from "../tools/execution-control.js";
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
import { awaitWithAbort, isCancellationError, sendAgentCancelled, beginRequestExecution, finishRequestExecution, parseMessage, throwIfAborted } from "./request-lifecycle.js";
import {
	findCancellableAgentRun,
	isAgentRunTerminal,
	resolveCancellationTargetRequestId,
	shouldTerminalizeReturnedAgentRun
} from "./run-cancellation.js";
import { estimateTextTokens, estimateMessagesTokens, estimateTextTokensForProvider, estimateCurrentMessageTokensForProvider, computeHistoryBudget, appendChatTurnToSession, appendUserMessageToSession, appendFailedChatTurnToSession, selectHistoryForModel, createSummaryMessage, loadSessionCompressorPrompt, filterSessionLlmContextMessages } from "./token-budget.js";
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
import { createSceneViewToolResultEnricher } from "./workflow/scene-view-enricher.js";

import {
	createPendingAiContinuation,
	cancelPendingApprovalsForRequest,
	loadHydratedPendingApprovalStates,
	createMemoryPendingApprovalStates,
	findPendingApprovalState,
	restorePendingContinuationForApproval,
	validatePendingApprovalBeforeExecution,
	createApprovedWorkflowToolObservation,
	pauseRunForApproval,
	sendContinuedAgentResult
} from "./approval-continuation.js";
import { cancelPendingToolBudgetsForRequest, createPendingToolBudget, createToolBudgetStopReason, registerPendingToolBudget, sendToolBudgetRequired } from "./tool-budget-continuation.js";
import { createAgentToolEventForwarder, createEmptyWorkflowPhaseToolStats, updateWorkflowPhaseToolStats, shouldRequireWorkflowWriteTool, didWorkflowWritePhaseExecute, isWorkflowProposalPhase, createWorkflowWriteGuardRetryMessage } from "./workflow/tool-events.js";
import { sendWorkflowEvent, sendWorkflowTodoSnapshot } from "./workflow/events.js";
import { runWorkflowPhase, createWorkflowPhasePrompt } from "./workflow/phase-runner.js";
import { createWorkflowPendingContinuation, continueWorkflowExecution } from "./workflow/continuation.js";
import { startWorkflowExecution } from "./workflow/executor.js";
import { ensureProviderConfigured } from "../application/provider-session-service.js";
import { beginSessionRun, findSessionWithPendingToolBudget, finishSessionRun, getActiveSessionRunController, getClientConnection, registerSessionRunController } from "./client-connections.js";
import { logger } from "../logger.js";
import { synchronizeSessionApprovalMode } from "./approval-mode-sync.js";
import { createInitialPlan } from "./plan-mode.js";
import { createPlanGetResult, type StoredPlan } from "./plan-store.js";
import { getUserPrompt } from "../user-prompt-store.js";
import { compressSessionHistory } from "./session-compression.js";
import { getWebSearchSettingsStatus, isWebSearchEnabled, isWebSearchToolAvailable } from "../web-search-settings-store.js";
import { withProviderUsageContext } from "../usage/provider-recorder.js";
import {
	beginAgentRun,
	getAgentRun,
	recordAgentRunToolEvent,
	updateAgentRun
} from "./agent-run-controller.js";
import { attachGoalRun, continueAgentGoal, createAgentGoal, getCurrentAgentGoal, pauseAgentGoal } from "./goal-controller.js";
import { getGoalRunBinding } from "./goal-run-observer.js";
import {
	validateExecutionDecisionEvidence,
	type AgentRunState,
	type ExecutionDecision
} from "../workflow/agent-run-state.js";

const WEB_SEARCH_TOOL_NAME: string = "mcp_web_search";

function applyChatRequestModelSnapshot(session: ClientSession, params: AiChatParams): boolean {
	if (params.provider === undefined && params.model === undefined && params.options?.reasoningEffort === undefined) {
		return false;
	}

	const nextProvider: ProviderId = params.provider ?? session.activeProvider;
	if (!isProviderId(nextProvider)) {
		return false;
	}

	const providerChanged: boolean = nextProvider !== session.activeProvider;
	const previousProvider: ProviderId = session.activeProvider;
	const currentModel: string = session.providerModel ?? session.modelProfile.model ?? getProviderDefaultModel(session.activeProvider);
	const requestedModel: string | undefined = params.model?.trim();
	const nextModel: string = requestedModel !== undefined && requestedModel.length > 0
		? requestedModel
		: providerChanged
			? getProviderDefaultModel(nextProvider)
			: currentModel;
	if (!providerChanged && nextModel === currentModel && params.options?.reasoningEffort === undefined) {
		return false;
	}

	session.activeProvider = nextProvider;
	session.providerModel = nextModel;
	session.modelProfile = resolveModelProfile(nextProvider, nextModel);
	session.workbenchComposer.reasoningEffort = params.options?.reasoningEffort === undefined
		? resolveReasoningEffortForModelChange(previousProvider, currentModel, session.workbenchComposer.reasoningEffort, nextProvider, nextModel)
		: resolveReasoningEffort(nextProvider, nextModel, params.options.reasoningEffort);
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

function createWorkflowRouteContext(session: ClientSession): WorkflowRouteContext {
	return { hasActiveWorkspace: session.activeWorkspace !== undefined };
}

function createGodotTemplateTarget(decision: ExecutionDecision | undefined): GodotTemplateTarget | undefined {
	if (decision === undefined || decision.targetKind === "unknown" || decision.expectedArtifacts.length === 0) {
		return undefined;
	}
	return {
		kind: decision.targetKind,
		artifacts: decision.expectedArtifacts
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

function resolveHiddenAnswerToolNames(
	routeDecision: WorkflowRouteDecision,
	allowedToolNames: readonly string[] | undefined,
	session: ClientSession
): readonly string[] {
	if (routeDecision.lane === "direct") {
		return [];
	}

	const sourceToolNames: readonly string[] = allowedToolNames ?? getAllRuntimeToolNames(session);
	if (routeDecision.lane === "lightweight") {
		return sourceToolNames;
	}

	return filterReadOnlyAnswerToolNames(sourceToolNames, session.activeWorkspace?.id);
}

function createExecutionControlContext(
	params: AiChatParams,
	routeDecision: WorkflowRouteDecision
): ExecutionControlContext | undefined {
	if (routeDecision.lane !== "read" && routeDecision.lane !== "probe" && routeDecision.lane !== "lightweight") {
		return undefined;
	}
	return {
		lane: routeDecision.lane,
		allowMutationEscalation: routeDecision.lane === "probe" && getExecutionPolicy(params) === "auto",
		requireDecision: routeDecision.lane === "read" || routeDecision.lane === "probe"
	};
}

function createHiddenAnswerChatParams(params: AiChatParams, routeDecision: WorkflowRouteDecision): AiChatParams {
	if (routeDecision.lane === "direct" || routeDecision.lane === "workflow") {
		return params;
	}

	const options: AiChatParams["options"] & Record<string, unknown> = {
		...(params.options ?? {})
	};
	if (routeDecision.lane === "read" || routeDecision.lane === "probe" || routeDecision.lane === "lightweight") {
		options.requireToolCallOnFirstStep = true;
		options.toolBudget = "simple";
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

function createHiddenAnswerSystemPrompt(
	fullSystemPrompt: string,
	routeDecision: WorkflowRouteDecision,
	executionControl?: ExecutionControlContext | undefined
): string {
	if (routeDecision.lane === "direct" || routeDecision.lane === "workflow") {
		return fullSystemPrompt;
	}

	if (routeDecision.lane === "probe") {
		return [
			fullSystemPrompt,
			[
				"## Daedalus evidence-gated probe",
				"- This is a read-only discovery stage. It never grants mutation permission by itself.",
				"- The execution-decision tool is intentionally unavailable during this first pass. Call at least one suitable read or verify tool before giving any conclusion.",
				"- Use only the minimum read or verify tools needed to establish whether the request is informational, already satisfied, or needs a bounded or workflow mutation.",
				"- Do not write, propose a patch, or claim that a mutation path is authorized during this probe.",
				"- After inspection, return concise factual findings only. Daedalus will open one control-only pass that records the execution decision from the evidence."
			].join("\n")
		].join("\n\n");
	}

	if (routeDecision.intent === "mutate") {
		return [
			fullSystemPrompt,
			[
				"## Daedalus lightweight execution control",
				"- Complete the bounded mutation with at most two logical writes and a matching post-write verification.",
				"- If inspection proves no change is needed, call daedalus_report_execution_decision with disposition=no_change and successful evidence ids.",
				"- If the scope exceeds this lane, stop before expanding it and call daedalus_report_execution_decision with disposition=use_workflow.",
				"- Natural-language promises or future plans never count as completion."
			].join("\n"),
			[
				"## 隐藏轻量操作约束",
				"- 当前执行形态是轻量操作，不创建 Todo，也不是多阶段 Workflow。",
				"- 只处理用户明确要求的单一目标：读取最少必要上下文，最多执行两个逻辑写入，不得顺手重构或扩大修改范围。",
				"- 如果发现必须跨多个文件联动、需要迁移/批量/破坏性修改，或无法在两个写入内安全完成，请停止写入并明确说明需要升级为完整 Workflow。",
				"- 最后一次写入后必须运行与修改对象匹配的最小验证；普通文本或配置可读取目标内容确认，代码使用对应 typecheck、check-only、LSP 或定向测试。",
				"- 不得对无关文件运行验证器，例如不能用 Godot check-only 或 Godot LSP 验证 .gitignore、Markdown 或普通 JSON。",
				"- 若适用验证首次失败，只允许基于失败证据修复一次，然后重新验证；不要反复试错。",
				"- 完成后直接简洁说明修改内容、验证结果和未覆盖风险。"
			].join("\n")
		].join("\n\n");
	}

	const canEscalateMutation: boolean = executionControl?.allowMutationEscalation === true;

	return [
		fullSystemPrompt,
		[
			"## Daedalus structured read contract",
			"- Use the minimum read or verify tools needed to answer from current evidence.",
			"- You must finish by calling daedalus_report_execution_decision exactly once; ordinary prose is not a valid completion.",
			"- Choose complete_read and put the complete user-facing answer in summary only when the request is genuinely informational or diagnostic.",
			canEscalateMutation
				? "- If current-project evidence shows the user expects a fix, choose use_lightweight for at most two logical writes or use_workflow for broader work. Do not promise a future modification in prose."
				: "- Mutation escalation is forbidden in this Ask, Plan, documentation-only, or explicitly read-only context."
		].join("\n"),
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
	runtimeContext?: { activeWorkspace?: WorkspaceConfig | undefined } | undefined,
	target?: GodotTemplateTarget | undefined,
	executionDecision?: ExecutionDecision | undefined
): Promise<WorkflowPlan | null> {
	throwIfAborted(abortSignal);
	const executionProfile: WorkflowExecutionProfileId = await resolveWorkflowExecutionProfileForWorkspace(runtimeContext?.activeWorkspace);
	throwIfAborted(abortSignal);
	if (params.options?.workflow !== "llm_planned" && target !== undefined) {
		const preferredTemplate: WorkflowPlan | null = await awaitWithAbort(
			createGodotTemplateWorkflowPlanForRuntime(params, target, executionProfile),
			abortSignal
		);
		throwIfAborted(abortSignal);
		if (preferredTemplate !== null) {
			return applyExecutionDecisionCompletionContract(preferredTemplate, executionDecision);
		}
	}

	try {
		const plannerOptions: ProviderChatOptions = withProviderUsageContext(
			(await awaitWithAbort(resolveProviderTaskModelOptions("workflowPlanner", options), abortSignal)).options,
			{ operation: "workflow_planner" }
		);
		throwIfAborted(abortSignal);
		const plan: WorkflowPlan | null = await awaitWithAbort(
			createLlmWorkflowPlan(params, plannerOptions, history, planningContext, abortSignal, executionProfile),
			abortSignal
		);
		throwIfAborted(abortSignal);
		if (plan !== null) {
			return applyExecutionDecisionCompletionContract(plan, executionDecision);
		}
	} catch (error: unknown) {
		if (isCancellationError(error, abortSignal)) {
			throw error;
		}
		logger.warn("ai", "llm_workflow_planner_failed_fallback", {
			message: error instanceof Error ? error.message : "LLM planner failed"
		});
	}

	throwIfAborted(abortSignal);
	const fallbackPlan: WorkflowPlan | null = planWorkflowAfterLlmPlannerFailure(params, executionProfile);
	return fallbackPlan === null ? null : applyExecutionDecisionCompletionContract(fallbackPlan, executionDecision);
}

function applyExecutionDecisionCompletionContract(
	plan: WorkflowPlan,
	decision: ExecutionDecision | undefined
): WorkflowPlan {
	if (
		decision === undefined
		|| (decision.disposition !== "use_workflow" && decision.disposition !== "use_lightweight")
		|| decision.expectedArtifacts.length === 0
	) {
		return plan;
	}

	const expectedTargets: WorkflowCompletionTarget[] = decision.expectedArtifacts.map((artifact: string): WorkflowCompletionTarget => (
		decision.targetKind === "project_setting"
			? { kind: "project_setting", key: artifact }
			: { kind: "artifact", path: artifact }
	));
	const firstWritePhaseIndex: number = plan.phases.findIndex((phase: WorkflowPhase): boolean => phase.toolGroup === "write");
	if (firstWritePhaseIndex < 0) {
		return plan;
	}

	const firstWritePhase: WorkflowPhase = plan.phases[firstWritePhaseIndex]!;
	const existingTargets: readonly WorkflowCompletionTarget[] = firstWritePhase.completionContract?.targets ?? [];
	const targetKeys: Set<string> = new Set();
	const targets: WorkflowCompletionTarget[] = [];
	for (const target of [...existingTargets, ...expectedTargets]) {
		const key: string = target.kind === "artifact"
			? `artifact:${target.path.replace(/^res:\/\//iu, "").replace(/\\/g, "/").toLowerCase()}`
			: `project_setting:${target.key.toLowerCase()}`;
		if (targetKeys.has(key)) {
			continue;
		}
		targetKeys.add(key);
		targets.push({ ...target });
	}

	const phases: WorkflowPhase[] = plan.phases.map((phase: WorkflowPhase, index: number): WorkflowPhase => (
		index !== firstWritePhaseIndex
			? phase
			: {
				...phase,
				completionContract: {
					targets,
					requireAll: true
				}
			}
	));
	return { ...plan, phases };
}

async function createGodotTemplateWorkflowPlanForRuntime(
	params: AiChatParams,
	target: GodotTemplateTarget,
	executionProfile: WorkflowExecutionProfileId
): Promise<WorkflowPlan | null> {
	return createGodotTemplateWorkflowPlan(params, target, { isGodotProject: executionProfile === "godot" });
}

async function resolveWorkflowExecutionProfileForWorkspace(workspace: WorkspaceConfig | undefined): Promise<WorkflowExecutionProfileId> {
	return resolveWorkflowExecutionProfile(await hasGodotProjectFile(workspace));
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

type HiddenAnswerExecutionParams = {
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
	mutationToolNames: readonly string[];
	approvalGateway: ApprovalGateway;
	userCreatedAt: string;
	abortSignal?: AbortSignal | undefined;
};

async function runHiddenAnswerExecution(params: HiddenAnswerExecutionParams): Promise<void> {
	throwIfAborted(params.abortSignal);
	const runId: string = params.requestId;
	const stepRunId: string = `${params.requestId}:answer`;
	const chatParams: AiChatParams = createHiddenAnswerChatParams(params.chatParams, params.routeDecision);
	const executionControl: ExecutionControlContext | undefined = createExecutionControlContext(chatParams, params.routeDecision);
	const fullSystemPrompt: string = createHiddenAnswerSystemPrompt(params.fullSystemPrompt, params.routeDecision, executionControl);
	const lightweightActionState: LightweightActionState | undefined = params.routeDecision.intent === "mutate"
		? createLightweightActionState()
		: undefined;
	const forwardToolEvent: OnToolEvent = createAgentToolEventForwarder(
		params.socket,
		params.requestId,
		params.session,
		runId,
		stepRunId,
		params.requestId,
		params.mcpHost
	);
	const onToolEvent: OnToolEvent = (event: ToolEvent): void => {
		if (lightweightActionState !== undefined) {
			applyToolEventToLightweightActionState(lightweightActionState, event, true);
		}
		recordAgentRunToolEvent(params.socket, params.session, runId, event);
		if (!(executionControl?.requireDecision === true && event.type === "ai.delta")) {
			forwardToolEvent(event);
		}
	};
	const executionOptions: ProviderChatOptions = withProviderUsageContext(params.options, {
		operation: params.routeDecision.lane === "direct" ? "direct_answer" : params.routeDecision.lane
	});
	const sceneViewEnricher = createSceneViewToolResultEnricher({
		session: params.session,
		options: executionOptions,
		phaseInstruction: chatParams.message,
		abortSignal: params.abortSignal
	});
	let agentResult: ProviderAgentResult = await awaitWithAbort(runProviderAgentStreaming(
		chatParams,
		executionOptions,
		params.history,
		fullSystemPrompt,
		params.mcpHost,
		params.approvalGateway,
		params.allowedToolNames,
		onToolEvent,
		params.abortSignal,
		sceneViewEnricher.enricher,
		{
			workspaceId: params.session.activeWorkspace?.id,
			editorInstanceId: params.session.editorInstanceId,
			sessionId: params.session.sessionId,
			requestId: params.requestId,
			clientType: getClientConnection(params.socket)?.clientType,
			executionControl,
			executionControlAvailable: params.routeDecision.lane !== "probe"
		}
	), params.abortSignal);
	throwIfAborted(params.abortSignal);
	const capturedAttachments: AdditionalContextItem[] = sceneViewEnricher.getCapturedAttachments();
	const persistedChatParams: AiChatParams = capturedAttachments.length === 0
		? chatParams
		: {
			...chatParams,
			additionalContext: [
				...(chatParams.additionalContext ?? []),
				...capturedAttachments
			]
		};

	if (executionControl?.requireDecision === true && agentResult.status === "completed") {
		const currentRun: AgentRunState | undefined = getAgentRun(params.session, runId);
		const evidenceSummary: string = (currentRun?.checkpoint.evidence ?? [])
			.filter((evidence): boolean => evidence.status === "succeeded")
			.slice(-24)
			.map((evidence): string => [
				`- ${evidence.toolCallId}`,
				`tool=${evidence.toolName}`,
				evidence.applicabilityCode === undefined ? "" : `applicabilityCode=${evidence.applicabilityCode}`,
				evidence.summary === undefined ? "" : `summary=${evidence.summary}`,
				evidence.artifactRefs.length === 0 ? "" : `artifacts=${evidence.artifactRefs.join(", ")}`
			].filter((part: string): boolean => part.length > 0).join("; "))
			.join("\n");
		const repairOptions: AiChatParams["options"] & Record<string, unknown> = {
			...(persistedChatParams.options ?? {}),
			requireToolCallOnFirstStep: true,
			toolBudget: "simple"
		};
		const repairParams: AiChatParams = {
			...persistedChatParams,
			message: [
				"The previous provider turn returned prose without the required execution control call.",
				"Do not answer with prose. Call daedalus_report_execution_decision exactly once now.",
				`Original user request: ${persistedChatParams.message}`,
				`Discarded draft: ${agentResult.text}`,
				evidenceSummary.length === 0 ? "Available evidence: none." : `Available evidence:\n${evidenceSummary}`
			].join("\n\n"),
			options: repairOptions
		};
		agentResult = await awaitWithAbort(runProviderAgentStreaming(
			repairParams,
			executionOptions,
			params.history,
			[
				fullSystemPrompt,
				"## Execution contract repair\nThe read-only inspection pass is complete and the execution-decision tool is now available. Only the internal daedalus_report_execution_decision tool is allowed. Submit one valid evidence-backed decision and no prose."
			].join("\n\n"),
			params.mcpHost,
			params.approvalGateway,
			[],
			onToolEvent,
			params.abortSignal,
			undefined,
			{
				workspaceId: params.session.activeWorkspace?.id,
				editorInstanceId: params.session.editorInstanceId,
				sessionId: params.session.sessionId,
				requestId: params.requestId,
				clientType: getClientConnection(params.socket)?.clientType,
				executionControl
			}
		), params.abortSignal);
		if (agentResult.status === "completed") {
			throw new ExecutionContractUnresolvedError();
		}
	}

	if (agentResult.status === "approval_required") {
		const pendingContinuation: PendingAiContinuation = createPendingAiContinuation(
			persistedChatParams,
			withProviderUsageContext(params.options, {
				operation: "tool_answer"
			}),
			agentResult.continuation,
			params.allowedToolNames,
			chatParams.message,
			params.requestId,
			params.userCreatedAt,
			true,
			undefined,
			lightweightActionState,
			executionControl
		);
		await pauseRunForApproval({
			socket: params.socket,
			requestId: params.requestId,
			session: params.session,
			mcpHost: params.mcpHost,
			runId,
			agentResult,
			pendingContinuation
		});
		return;
	}
	if (agentResult.status === "tool_budget_required") {
		const pendingBudget = createPendingToolBudget({
			agentResult,
			chatParams: persistedChatParams,
			options: withProviderUsageContext(params.options, {
				operation: params.routeDecision.lane === "direct" ? "direct_answer" : params.routeDecision.lane
			}),
			allowedToolNames: params.allowedToolNames,
			userMessage: chatParams.message,
			requestId: params.requestId,
			userCreatedAt: params.userCreatedAt,
			stream: true,
			lightweightActionState,
			executionControl
		});
		registerPendingToolBudget(params.session, pendingBudget);
		sendToolBudgetRequired(params.socket, params.requestId, params.session, runId, pendingBudget);
		return;
	}
	if (agentResult.status === "execution_decision") {
		const latestRun: AgentRunState | undefined = getAgentRun(params.session, runId);
		if (latestRun === undefined) {
			throw new Error(`Execution decision received for unknown run ${runId}.`);
		}
		const executionDecision: ExecutionDecision = validateExecutionDecisionEvidence(latestRun, agentResult.decision);
		updateAgentRun(params.socket, params.session, runId, latestRun.stage, { executionDecision });
		logger.info("ai", "execution_disposition_resolved", {
			requestId: params.requestId,
			sessionId: params.session.sessionId,
			initialIntent: params.routeDecision.intent,
			effectiveLane: params.routeDecision.lane,
			executionDisposition: executionDecision.disposition,
			approvalMode: params.session.approvalGateway.getMode(),
			authorizationScope: params.approvalGateway === params.session.approvalGateway ? "session" : "read_only"
		});
		if (
			(executionDecision.disposition === "use_lightweight" || executionDecision.disposition === "use_workflow")
			&& executionControl?.allowMutationEscalation !== true
		) {
			throw new LightweightActionVerificationError("This execution policy does not permit mutation escalation.");
		}
		if (executionDecision.disposition === "use_lightweight") {
			logger.warn("ai", "read_execution_escalated_to_mutation", {
				requestId: params.requestId,
				sessionId: params.session.sessionId,
				initialIntent: params.routeDecision.intent,
				effectiveLane: "lightweight",
				approvalMode: params.session.approvalGateway.getMode()
			});
			updateAgentRun(params.socket, params.session, runId, "executing", {
				scope: "bounded",
				lane: "lightweight"
			});
			await runHiddenAnswerExecution({
				...params,
				chatParams: persistedChatParams,
				allowedToolNames: params.mutationToolNames,
				approvalGateway: params.session.approvalGateway,
				routeDecision: {
					...params.routeDecision,
					intent: "mutate",
					scope: "bounded",
					lane: "lightweight",
					reason: executionDecision.summary
				}
			});
			return;
		}
		if (executionDecision.disposition === "use_workflow") {
			throw new LightweightActionScopeExceededError("write_scope_exceeded", executionDecision);
		}
		if (executionDecision.disposition === "blocked") {
			throw new LightweightActionVerificationError(executionDecision.summary);
		}
		if (executionDecision.disposition === "complete_read") {
			forwardToolEvent({ type: "ai.delta", text: executionDecision.summary });
			await completeHiddenAnswerExecution(
				params,
				persistedChatParams,
				executionDecision.summary,
				{
					resultStatus: "completed",
					verificationStatus: undefined,
					warnings: [],
					failureMessage: undefined
				}
			);
			return;
		}
		const decisionWasVerified: boolean = latestRun.checkpoint.evidence.some((item): boolean => (
			executionDecision.evidenceToolCallIds.includes(item.toolCallId) && item.risk === "verify"
		));

		forwardToolEvent({ type: "ai.delta", text: executionDecision.summary });
		await completeHiddenAnswerExecution(
			params,
			persistedChatParams,
			executionDecision.summary,
			{
				resultStatus: decisionWasVerified
					? "completed"
					: "completed_with_warnings",
				verificationStatus: decisionWasVerified
					? "verified"
					: "unverified",
				warnings: decisionWasVerified
					? []
					: ["The no-change decision was supported by read evidence but no dedicated verifier was run."],
				failureMessage: undefined
			}
		);
		return;
	}
	if (agentResult.status === "protocol_violation") {
		throw new Error(agentResult.reason);
	}
	if (executionControl?.requireDecision === true) {
		throw new ExecutionContractUnresolvedError();
	}
	if (params.routeDecision.lane === "probe") {
		throw new LightweightActionScopeExceededError("write_intent_not_completed");
	}
	if (
		params.routeDecision.intent === "mutate"
		&& (getAgentRun(params.session, runId)?.checkpoint.successfulWriteFingerprints.length ?? 0) === 0
	) {
		throw new LightweightActionScopeExceededError("write_intent_not_completed");
	}
	const completionStatus = lightweightActionState === undefined
		? {
			resultStatus: "completed" as const,
			verificationStatus: undefined,
			warnings: [] as string[],
			failureMessage: undefined
		}
		: collectLightweightActionCompletionStatus(lightweightActionState);
	if (completionStatus.failureMessage !== undefined) {
		throw new LightweightActionVerificationError(completionStatus.failureMessage);
	}

	await completeHiddenAnswerExecution(params, persistedChatParams, agentResult.text, completionStatus);
}

async function completeHiddenAnswerExecution(
	params: HiddenAnswerExecutionParams,
	chatParams: AiChatParams,
	text: string,
	completionStatus: {
		resultStatus: "completed" | "completed_with_warnings";
		verificationStatus?: "verified" | "unverified" | undefined;
		warnings: string[];
		failureMessage?: string | undefined;
	}
): Promise<void> {
	const runId: string = params.requestId;
	const stepRunId: string = `${params.requestId}:answer`;
	if (getAgentRun(params.session, runId) !== undefined) {
		updateAgentRun(params.socket, params.session, runId, "finalizing", {
			verificationStatus: completionStatus.verificationStatus ?? null,
			warnings: completionStatus.warnings
		});
	}
	await appendChatTurnToSession(
		params.session,
		params.history,
		chatParams.message,
		text,
		params.requestId,
		params.userCreatedAt,
		undefined,
		chatParams.additionalContext,
		chatParams.retryOfRunId === undefined
	);
	sendSessionEvent(params.socket, params.requestId, params.session, "agent.message.done", {
		runId,
		stepRunId,
		text,
		context: {
			historyMessagesStored: params.session.messages.length,
			historyBudgetTokens: params.historyBudgetTokens,
			mcpServers: params.mcpHost.getConnectedServerIds()
		}
	});
	if (getAgentRun(params.session, runId) !== undefined) {
		updateAgentRun(params.socket, params.session, runId, "completed", {
			terminal: {
				resultStatus: completionStatus.resultStatus,
				completedAt: new Date().toISOString()
			},
			verificationStatus: completionStatus.verificationStatus ?? null,
			warnings: completionStatus.warnings
		});
	}
	sendJson(params.socket, {
		type: "response",
		id: params.requestId,
		ok: true,
		result: {
			text,
			context: {
				historyMessagesStored: params.session.messages.length,
				historyBudgetTokens: params.historyBudgetTokens,
				mcpServers: params.mcpHost.getConnectedServerIds()
			}
		}
	});
}

async function runHiddenAnswerExecutionWithEscalation(
	params: HiddenAnswerExecutionParams & {
		planningContext: string;
		guidePromptSection: string;
		webSearchEnabled: boolean;
	}
): Promise<void> {
	let escalationError: LightweightActionScopeExceededError | null = null;
	try {
		await runHiddenAnswerExecution(params);
		return;
	} catch (error: unknown) {
		if (!(error instanceof LightweightActionScopeExceededError)) {
			throw error;
		}
		escalationError = error;
	}

	logger.info("ai", "lightweight_action_escalated", {
		requestId: params.requestId,
		sessionId: params.session.sessionId,
		reason: escalationError.reason
	});
	const escalationDecision: ExecutionDecision | undefined = escalationError.executionDecision
		?? getAgentRun(params.session, params.requestId)?.executionDecision;
	const workflowParams: AiChatParams = {
		...params.chatParams,
		options: {
			...(params.chatParams.options ?? {}),
			workflow: "multi_phase"
		}
	};
	const escalationInstruction: string = escalationError.reason === "write_intent_not_completed"
		? "轻量操作只完成了读取，没有执行用户要求的写入。先复核当前工作区状态，再完成实现和验证；不要把未来计划或下一步描述当成完成结果。"
		: "轻量操作已经完成了部分必要修改，但下一步会超过两个逻辑写入。先检查当前工作区状态，不要重复已成功的写入，然后完成剩余工作和验证。";
	const escalationContext: string = [
		params.planningContext,
		escalationInstruction
	].filter((section: string): boolean => section.length > 0).join("\n\n");
	let workflowPlan: WorkflowPlan | null = await createWorkflowPlanForRoute(
		workflowParams,
		params.options,
		params.history,
		escalationContext,
		params.abortSignal,
		{ activeWorkspace: params.session.activeWorkspace },
		createGodotTemplateTarget(escalationDecision),
		escalationDecision
	);
	if (workflowPlan === null) {
		workflowPlan = planWorkflow(
			workflowParams,
			await resolveWorkflowExecutionProfileForWorkspace(params.session.activeWorkspace)
		);
	}
	if (workflowPlan === null) {
		throw new Error("轻量操作超出范围，但无法创建升级后的 Workflow。");
	}
	if (!params.webSearchEnabled) {
		workflowPlan = filterWebSearchFromWorkflowPlan(workflowPlan);
	}
	await startWorkflowExecution(
		params.socket,
		params.requestId,
		params.session,
		params.mcpHost,
		params.options,
		workflowPlan,
		workflowParams,
		params.history,
		params.historyBudgetTokens,
		params.userCreatedAt,
		escalationContext,
		params.guidePromptSection,
		params.abortSignal
	);
}

export async function escalatePendingContinuationToWorkflow(params: {
	socket: WebSocket;
	session: ClientSession;
	mcpHost: McpHost;
	pendingContinuation: PendingAiContinuation;
	abortSignal: AbortSignal;
	reason: string;
}): Promise<void> {
	const requestId: string = params.pendingContinuation.requestId;
	const workflowParams: AiChatParams = {
		...params.pendingContinuation.params,
		options: {
			...(params.pendingContinuation.params.options ?? {}),
			workflow: "multi_phase"
		}
	};
	const checkpoint = getAgentRun(params.session, requestId)?.checkpoint;
	const planningContext: string = [
		"Continue this mutation as a full Workflow in the same run.",
		"Inspect the current workspace state before writing. Do not replay writes that already succeeded.",
		`Escalation reason: ${params.reason}`,
		checkpoint === undefined
			? ""
			: `Successful write fingerprints: ${checkpoint.successfulWriteFingerprints.join(", ") || "none"}.`
	].filter((item: string): boolean => item.length > 0).join("\n");
	const history: ChatMessage[] = filterSessionLlmContextMessages(params.session)
		.filter((message: ChatMessage): boolean => message.requestId !== requestId);
	let plan: WorkflowPlan | null = await createWorkflowPlanForRoute(
		workflowParams,
		params.pendingContinuation.options,
		history,
		planningContext,
		params.abortSignal,
		{ activeWorkspace: params.session.activeWorkspace }
	);
	if (plan === null) {
		plan = planWorkflow(
			workflowParams,
			await resolveWorkflowExecutionProfileForWorkspace(params.session.activeWorkspace)
		);
	}
	if (plan === null) {
		throw new Error("The lightweight run exceeded its safe scope, but no executable Workflow could be created.");
	}
	const currentRun: AgentRunState | undefined = getAgentRun(params.session, requestId);
	if (currentRun !== undefined) {
		updateAgentRun(params.socket, params.session, requestId, "executing", {
			intent: "mutate",
			scope: "complex",
			lane: "workflow",
			pause: null
		});
	}
	await startWorkflowExecution(
		params.socket,
		requestId,
		params.session,
		params.mcpHost,
		params.pendingContinuation.options,
		plan,
		workflowParams,
		history,
		Math.max(0, params.session.modelProfile.contextWindowTokens - params.session.modelProfile.defaultOutputReserveTokens),
		params.pendingContinuation.userCreatedAt,
		planningContext,
		"",
		params.abortSignal
	);
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
		return filterRequest(filterSessionLlmContextMessages(session));
	}

	const recentSourceMessages: ChatMessage[] = session.summaryCoveredMessageCount !== undefined
		? session.messages.slice(session.summaryCoveredMessageCount)
		: session.messages;
	return [session.summaryMessage, ...filterRequest(filterSessionLlmContextMessages(session, recentSourceMessages))];
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

	await synchronizeSessionApprovalMode(session);
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
	await removeAgentRunContinuation(pending.requestId);
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
		const continuationParams: AiChatParams = await awaitWithAbort(
			hydrateImageAttachmentContexts(session.sessionId, pendingContinuation.params),
			abortController.signal
		);
		throwIfAborted(abortController.signal);
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
			if (pendingContinuation.lightweightActionState !== undefined) {
				applyToolEventToLightweightActionState(
					pendingContinuation.lightweightActionState,
					event
				);
			}
			recordAgentRunToolEvent(socket, session, pending.requestId, event);
			forwardToolEvent(event);
		};

		const toolContext = {
			workspaceId: session.activeWorkspace?.id,
			editorInstanceId: session.editorInstanceId,
			sessionId: session.sessionId,
			requestId: pending.requestId,
			clientType: getClientConnection(socket)?.clientType,
			executionControl: pendingContinuation.executionControl
		};
		const agentResultPromise: Promise<ProviderAgentResult> = decision === "continue"
			? pendingContinuation.stream
				? continueProviderAgentAfterToolBudgetStreaming(
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
				: continueProviderAgentAfterToolBudget(
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
				? finalizeProviderAgentAfterToolBudgetStreaming(
					continuationParams,
					pendingContinuation.options,
					pendingContinuation.continuation,
					pendingContinuation.allowedToolNames,
					createToolBudgetStopReason(pending),
					onToolEvent,
					abortController.signal,
					toolContext
				)
				: finalizeProviderAgentAfterToolBudget(
					continuationParams,
					pendingContinuation.options,
					pendingContinuation.continuation,
					pendingContinuation.allowedToolNames,
					createToolBudgetStopReason(pending),
					onToolEvent,
					abortController.signal,
					toolContext
				);
		const agentResult: ProviderAgentResult = await awaitWithAbort(agentResultPromise, abortController.signal);
		throwIfAborted(abortController.signal);

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
			await awaitWithAbort(continueWorkflowExecution(
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
			), abortController.signal);
			throwIfAborted(abortController.signal);
		} else {
			await awaitWithAbort(sendContinuedAgentResult(
				socket,
				pending.requestId,
				session,
				mcpHost,
				agentResult,
				{
					...pendingContinuation,
					params: continuationParams
				}
			), abortController.signal);
			throwIfAborted(abortController.signal);
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
		if (error instanceof LightweightActionScopeExceededError) {
			await escalatePendingContinuationToWorkflow({
				socket,
				session,
				mcpHost,
				pendingContinuation: pending.continuation,
				abortSignal: abortController.signal,
				reason: error.reason
			});
			setWorkbenchActiveRun(session, { status: "idle" });
			await finishQueueItemForRun(socket, pending.requestId, session, queueItemId);
			shouldDrainQueueAfterRun = true;
			emitWorkbenchUpdated(socket, pending.requestId, session);
			return;
		}
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
		if (error instanceof LightweightActionVerificationError) {
			sendSessionEvent(socket, pending.requestId, session, "agent.run.error", {
				runId,
				requestId: pending.requestId,
				status: "error",
				code: error.code,
				message: error.message,
				sequence: session.workbenchActiveRun.sequence ?? session.workbenchActiveRunSequence
			}, pending.requestId);
			emitWorkbenchUpdated(socket, pending.requestId, session);
			sendJson(socket, {
				type: "response",
				id: pending.requestId,
				ok: false,
				error: {
					code: error.code,
					message: error.message
				}
			});
			return;
		}
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
			const activeGoal = session.sessionId === undefined
				? null
				: await getCurrentAgentGoal(session.sessionId);
			const requestWithController: string | undefined = session.activeAbortControllers.has(request.params.requestId)
				? request.params.requestId
				: undefined;
			const activeSessionRun = getActiveSessionRunController(session.sessionId, request.params.requestId)
				?? getActiveSessionRunController(session.sessionId);
			const targetRequestId: string = resolveCancellationTargetRequestId({
				requestedRequestId: request.params.requestId,
				requestWithController,
				activeSessionRequestId: activeSessionRun?.requestId,
				activeGoalRunId: activeGoal?.activeRunId,
				activeRuntimeRequestId: session.activeRunRequestId
			});
			const controller: AbortController | undefined = session.activeAbortControllers.get(targetRequestId)
				?? (activeSessionRun?.requestId === targetRequestId ? activeSessionRun.controller : undefined);
			if (
				activeGoal?.activeRunId !== null
				&& activeGoal?.activeRunId !== undefined
				&& activeGoal.stage !== "paused"
				&& activeGoal.stage !== "pausing"
			) {
				await pauseAgentGoal(socket, session, activeGoal.goalId, "user_interruption");
			}
			if (controller !== undefined) {
				setWorkbenchActiveRun(session, {
					status: "cancelling",
					requestId: targetRequestId
				});
				emitWorkbenchUpdated(socket, request.id, session);
				controller.abort();
			}
			const cancellationRequestIds: string[] = [...new Set([
				targetRequestId,
				request.params.requestId,
				activeSessionRun?.requestId,
				activeGoal?.activeRunId,
				session.activeRunRequestId
			].filter((candidate: string | null | undefined): candidate is string => typeof candidate === "string" && candidate.length > 0))];
			const cancelledApprovalIds: string[] = [];
			const cancelledToolBudgetIds: string[] = [];
			for (const cancellationRequestId of cancellationRequestIds) {
				cancelledApprovalIds.push(...await cancelPendingApprovalsForRequest(session, cancellationRequestId));
				cancelledToolBudgetIds.push(...cancelPendingToolBudgetsForRequest(session, cancellationRequestId));
			}
			let forcedRunId: string | null = null;
			if (controller === undefined && cancelledApprovalIds.length === 0 && cancelledToolBudgetIds.length === 0) {
				const cancellableRun: AgentRunState | null = await findCancellableAgentRun(session, cancellationRequestIds);
				if (cancellableRun !== null) {
					session.agentRuns.set(cancellableRun.runId, cancellableRun);
					if (!session.agentRunToolCalls.has(cancellableRun.runId)) {
						session.agentRunToolCalls.set(cancellableRun.runId, new Map());
					}
					forcedRunId = cancellableRun.runId;
					sendAgentCancelled(
						socket,
						cancellableRun.requestId,
						session,
						cancellableRun.runId,
						"force_cancelled_by_user"
					);
				}
			}
			// The aborted stream can finish while this cancellation RPC awaits approval cleanup.
			// Treat that terminal race as an accepted, idempotent cancellation instead of
			// reporting a false failure back to the Studio client.
			const persistedTargetRun: AgentRunState | null = forcedRunId !== null
				? null
				: await readAgentRunState(targetRequestId);
			const alreadyFinished: boolean = controller === undefined
				&& cancelledApprovalIds.length === 0
				&& cancelledToolBudgetIds.length === 0
				&& forcedRunId === null
				&& (
					cancellationRequestIds.some((candidate: string): boolean => session.completedRequestIds.has(candidate))
					|| (persistedTargetRun !== null && isAgentRunTerminal(persistedTargetRun))
				);
			if (cancelledApprovalIds.length > 0 || cancelledToolBudgetIds.length > 0 || forcedRunId !== null) {
				if (session.activeRunRequestId !== undefined && cancellationRequestIds.includes(session.activeRunRequestId)) {
					session.activeRunRequestId = undefined;
				}
				for (const cancellationRequestId of cancellationRequestIds) {
					finishSessionRun(session.sessionId, cancellationRequestId);
				}
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
					cancelled: controller !== undefined
						|| cancelledApprovalIds.length > 0
						|| cancelledToolBudgetIds.length > 0
						|| forcedRunId !== null
						|| alreadyFinished,
					cancellationRequested: controller !== undefined,
					forced: forcedRunId !== null,
					forcedRunId,
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

		case "agent.run.retry": {
			await waitForFullSessionLoad(session);
			const interruptedRun: AgentRunState | null =
				getAgentRun(session, request.params.runId)
				?? await readAgentRunState(request.params.runId);
			if (
				interruptedRun === null
				|| interruptedRun.sessionId !== session.sessionId
				|| interruptedRun.stage !== "interrupted"
			) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "agent_run_not_retryable",
						message: "Only an interrupted run in the active session can be retried from a safe checkpoint."
					}
				});
				break;
			}
			const sourceMessage: ChatMessage | undefined = [...session.messages]
				.reverse()
				.find((message: ChatMessage): boolean => (
					message.role === "user"
					&& (
						message.requestId === interruptedRun.rootRequestId
						|| message.requestId === interruptedRun.requestId
					)
				));
			if (sourceMessage === undefined) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "agent_run_retry_source_missing",
						message: "The original user request for this run is no longer available."
					}
				});
				break;
			}
			const retryRequest: ClientRequest = {
				type: "request",
				id: request.id,
				method: "ai.chat",
				params: {
					message: sourceMessage.content,
					mode: session.workbenchComposer.chatMode,
					additionalContext: sourceMessage.additionalContext,
					retryOfRunId: interruptedRun.runId
				}
			};
			await handleChatRequest(socket, retryRequest, session, mcpHost);
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
				message: rawParams.message.length > 0 || rawParams.additionalContext !== undefined
					? rawParams.message
					: session.workbenchComposer.text,
				mode: rawParams.mode ?? session.workbenchComposer.chatMode,
				additionalContext: rawParams.additionalContext ?? session.workbenchComposer.additionalContext
			});
			if (session.sessionId !== undefined) {
				await promoteTemporarySession(session.sessionId);
			}
			const queueItemId: number | undefined = getQueueItemIdFromParams(params);
			const modelSnapshotChanged: boolean = applyChatRequestModelSnapshot(session, params);
			if (modelSnapshotChanged && session.sessionId !== undefined) {
				await updateSessionMetadata(session.sessionId, createRuntimeSessionUiMetadata(session));
			}
			if (params.mode !== "goal" && session.sessionId !== undefined && getGoalRunBinding(request.id) === undefined) {
				const activeGoal = await getCurrentAgentGoal(session.sessionId);
				if (activeGoal !== null && activeGoal.stage !== "paused" && activeGoal.stage !== "pausing") {
					await pauseAgentGoal(socket, session, activeGoal.goalId, "user_interruption");
				}
			}
			if (params.mode === "goal") {
				if (getClientConnection(socket)?.clientType !== "studio") {
					sendJson(socket, {
						type: "response",
						id: request.id,
						ok: false,
						error: {
							code: "goal_mode_studio_only",
							message: "Goal mode is only available to Daedalus Studio."
						}
					});
					break;
				}
				await synchronizeSessionApprovalMode(session);
				try {
					const goal = await createAgentGoal({
						socket,
						session,
						mcpHost,
						runChat: handleChatRequest,
						requestId: request.id,
						chatParams: params
					});
					clearWorkbenchComposer(session, true);
					emitWorkbenchUpdated(socket, request.id, session);
					sendJson(socket, {
						type: "response",
						id: request.id,
						ok: true,
						result: { accepted: true, goalId: goal.goalId }
					});
					continueAgentGoal(goal.goalId);
				} catch (error: unknown) {
					sendJson(socket, {
						type: "response",
						id: request.id,
						ok: false,
						error: {
							code: typeof error === "object" && error !== null && "code" in error
								? String((error as { code?: unknown }).code ?? "goal_start_failed")
								: "goal_start_failed",
							message: error instanceof Error ? error.message : String(error)
						}
					});
				}
				break;
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

			await synchronizeSessionApprovalMode(session);
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
			const goalBinding = getGoalRunBinding(request.id);
			let persistedParams: AiChatParams = params;
			let queuedRunForcedStatus: "failed" | "cancelled" | undefined;
			await setQueueStatusForRun(socket, request.id, session, queueItemId, "sending");
			setWorkbenchActiveRun(session, {
				status: "streaming",
				requestId: request.id,
				startedAt: turnStartedAt,
				queueItemId
			});
			if (runSessionId !== undefined) {
				const retrySourceRun: AgentRunState | undefined = params.retryOfRunId === undefined
					? undefined
					: getAgentRun(session, params.retryOfRunId);
				const startedRun = beginAgentRun({
					socket,
					session,
					sessionId: runSessionId,
					requestId: request.id,
					runId: request.id,
					rootRequestId: goalBinding?.rootRequestId ?? retrySourceRun?.rootRequestId,
					retryOfRunId: retrySourceRun?.runId,
					goalId: goalBinding?.goalId,
					goalCycle: goalBinding?.cycle,
					title: params.message.trim().slice(0, 120) || "Daedalus task"
				});
				await attachGoalRun(startedRun);
				if (retrySourceRun !== undefined) {
					updateAgentRun(socket, session, request.id, "routing", {
						checkpoint: structuredClone(retrySourceRun.checkpoint),
						warnings: [...retrySourceRun.warnings]
					});
				}
			}
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
				const hydratedParams: AiChatParams = await awaitWithAbort(hydrateImageAttachmentContexts(session.sessionId, params), abortController.signal);
				throwIfAborted(abortController.signal);
				const imagePreprocess: ImageRecognitionPreprocessResult = await awaitWithAbort(preprocessImageAttachmentsForTextModel(
					hydratedParams,
					options,
					abortController.signal,
					(progress): void => {
						sendSessionEvent(socket, request.id, session, "ai.status", progress);
					}
				), abortController.signal);
				throwIfAborted(abortController.signal);
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
					if (getAgentRun(session, request.id) !== undefined) {
						updateAgentRun(socket, session, request.id, "executing", {
							intent: "mutate",
							scope: "complex",
							lane: "workflow"
						});
					}
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
				const safeRetryPromptSection: string = effectiveParams.retryOfRunId === undefined
					? ""
					: [
						"## Safe checkpoint retry",
						"This is a new Run linked to an interrupted Run.",
						"Inspect current state before mutating. Do not replay an already successful equivalent write.",
						`Prior successful write fingerprints: ${
							getAgentRun(session, request.id)?.checkpoint.successfulWriteFingerprints.join(", ") || "none"
						}.`
					].join("\n");
				const fullSystemPrompt: string = systemPrompt
					+ (skillPrompt.length > 0 ? `\n\n${skillPrompt}` : "")
					+ (skillCatalogPrompt.length > 0 ? `\n\n${skillCatalogPrompt}` : "")
					+ mcpSystemContext
					+ (additionalContextSection.length > 0 ? `\n\n${additionalContextSection}` : "")
					+ (guidePromptSection.length > 0 ? `\n\n${guidePromptSection}` : "")
					+ (safeRetryPromptSection.length > 0 ? `\n\n${safeRetryPromptSection}` : "");
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
				if (effectiveParams.retryOfRunId === undefined) {
					await appendUserMessageToSession(
						session,
						effectiveParams.message,
						request.id,
						turnStartedAt,
						effectiveParams.additionalContext
					);
				}
				if ((goalBinding?.cycle ?? 1) <= 1) {
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
				}
				const historyBudgetTokens: number = await computeHistoryBudget(
					session.modelProfile,
					options,
					effectiveParams,
					systemPrompt,
					skillPrompt + skillCatalogPrompt + mcpSystemContext + additionalContextSection + guidePromptSection,
					abortController.signal
				);
				const history: ChatMessage[] = (goalBinding?.cycle ?? 1) > 1
					? []
					: await selectHistoryForModel(session, historyBudgetTokens, request.id);
				const planningContext: string = [
					skillPrompt,
					skillCatalogPrompt,
					mcpSystemContext,
					additionalContextSection,
					guidePromptSection,
					safeRetryPromptSection
				].filter((section: string): boolean => section.length > 0).join("\n");
				throwIfAborted(abortController.signal);
				let routeDecision: WorkflowRouteDecision = routeWorkflowExecution(
					effectiveParams,
					createWorkflowRouteContext(session)
				);
				throwIfAborted(abortController.signal);
				logger.info("ai", "workflow_route_decided", {
					requestId: request.id,
					sessionId: session.sessionId,
					intent: routeDecision.intent,
					scope: routeDecision.scope,
					lane: routeDecision.lane,
					reason: routeDecision.reason,
					forcedByOption: routeDecision.forcedByOption ?? null,
					safetyOverride: routeDecision.safetyOverride ?? null
				});
				if (getAgentRun(session, request.id) !== undefined) {
					updateAgentRun(
						socket,
						session,
						request.id,
						routeDecision.lane === "probe" ? "probing" : "executing",
						{
							intent: routeDecision.intent,
							scope: routeDecision.scope,
							lane: routeDecision.lane
						}
					);
				}

				const hiddenAnswerToolNames: readonly string[] = resolveHiddenAnswerToolNames(routeDecision, allowedToolNames, session);
				const mutationToolNames: readonly string[] = allowedToolNames ?? getAllRuntimeToolNames(session);
				const hiddenAnswerApprovalGateway: ApprovalGateway = routeDecision.lane !== "lightweight"
					? new ReadOnlyToolApprovalGateway(session.approvalGateway, hiddenAnswerToolNames)
					: session.approvalGateway;
				{
					if (routeDecision.lane === "workflow") {
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
							throwIfAborted(abortController.signal);
							await awaitWithAbort(startWorkflowExecution(
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
							), abortController.signal);
						} else {
							throw new Error("Workflow routing requires an executable safe fallback plan.");
						}
					} else {
						throwIfAborted(abortController.signal);
						await awaitWithAbort(runHiddenAnswerExecutionWithEscalation({
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
							mutationToolNames,
							approvalGateway: hiddenAnswerApprovalGateway,
							userCreatedAt: turnStartedAt,
							abortSignal: abortController.signal,
							planningContext,
							guidePromptSection,
							webSearchEnabled
						}), abortController.signal);
					}
				}
				const returnedRun: AgentRunState | undefined = getAgentRun(session, request.id);
				if (returnedRun !== undefined && shouldTerminalizeReturnedAgentRun(returnedRun)) {
					const invariantMessage = "Agent execution returned without publishing a terminal run state.";
					queuedRunForcedStatus = "failed";
					logger.error("ai", "agent_run_missing_terminal_state", new Error(invariantMessage), {
						requestId: request.id,
						runId: returnedRun.runId,
						sessionId: runSessionId,
						stage: returnedRun.stage
					});
					sendSessionEvent(socket, request.id, session, "agent.run.error", {
						runId: returnedRun.runId,
						requestId: returnedRun.requestId,
						status: "error",
						code: "agent_run_missing_terminal_state",
						message: invariantMessage,
						sequence: session.workbenchActiveRun.sequence ?? session.workbenchActiveRunSequence
					}, returnedRun.requestId);
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
				if (error instanceof ExecutionContractUnresolvedError) {
					queuedRunForcedStatus = "failed";
					logger.error("ai", "execution_contract_unresolved", error, {
						requestId: request.id,
						sessionId: runSessionId,
						workspaceId: session.activeWorkspace?.id,
						approvalMode: session.approvalGateway.getMode()
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
						{ code: error.code, message: error.message },
						request.id,
						turnStartedAt,
						undefined,
						persistedParams.additionalContext,
						"",
						persistedParams.retryOfRunId === undefined
					);
					sendJson(socket, {
						type: "response",
						id: request.id,
						ok: false,
						error: { code: error.code, message: error.message }
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
				if (error instanceof LightweightActionVerificationError) {
					queuedRunForcedStatus = "failed";
					logger.warn("ai", "lightweight_action_validation_failed", {
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
						persistedParams.additionalContext,
						"",
						persistedParams.retryOfRunId === undefined
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
						persistedParams.additionalContext,
						"",
						persistedParams.retryOfRunId === undefined
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
						workflowErrorMessage,
						persistedParams.retryOfRunId === undefined
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
					persistedParams.additionalContext,
					"",
					persistedParams.retryOfRunId === undefined
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
				if (queuedRunForcedStatus !== "cancelled" && (queueItemId === undefined || !queueItemStillExists)) {
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
