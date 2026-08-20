import WebSocket from "ws";
import { composeSystemPrompt, listPromptTemplates } from "../prompts/registry.js";
import { getGeneralSettings } from "../general-settings-store.js";
import { getStudioBrowserControl } from "./studio-browser-context.js";
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
import type { PendingToolBudget } from "../session/pending-tool-budget.js";
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
import { getDefaultModelProfile, resolveModelProfile } from "../tokens/model-profiles.js";
import { type TokenCounter } from "../tokens/token-counter.js";
import { createTokenCounter } from "../tokens/token-counter-factory.js";
import { computeInputBudget, selectMessagesWithinBudget } from "../session/session-compressor.js";
import { composeExplicitSkillPrompt, composeSkillCatalogPrompt, createGlobalSkillWorkspace, createSkillWorkspace, resolveBuiltinToolRestriction, resolveExplicitSkills } from "../skills/runtime.js";
import type { CatalogSkill, SkillWorkspace } from "../skills/types.js";
import {
	createRuntimeWorkspace,
	loadWorkspaces,
	findWorkspace,
	getDefaultWorkspace,
	upsertRuntimeWorkspace
} from "../workspace/registry.js";
import { hasGodotWorkspaceCapability } from "../workspace/capabilities.js";
import {
	createSession, openSession, saveSession, listSessions,
	archiveSession, deleteArchivedSession, deleteSession, listArchivedSessions, renameSession, restoreArchivedSession,
	rewindSessionFromRequest,
	readSummary, writeSummary, deleteSummary,
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
import { clearSessionForkDraft } from "../session/session-fork.js";
import {
	clearPendingSessionModelTransition,
	hasSessionUserTurn,
	readPendingSessionModelTransition,
	recordPendingSessionModelTransition,
	type SessionModelRef,
} from "../session/session-model-transition.js";
import { getProviderDefaultBaseUrl, getProviderDefaultModel, getProviderDisplayName, isProviderId } from "../providers/provider-registry.js";
import { resolveReasoningEffort, resolveReasoningEffortForModelChange } from "../providers/reasoning-effort.js";
import { classifyProviderError, createProviderStatusEvent, type ProviderErrorInfo } from "../providers/provider-error.js";
import { isFirstSessionUserTurn } from "./session-title.js";
import { normalizeProjectSettingKey, normalizeWorkspaceRelativeArtifactPath } from "../workflow/completion-contract.js";
import { getWorkflowToolSemantics, type WorkflowTargetKind } from "../workflow/tool-semantics.js";
import { getExecutionPolicy, routeWorkflowExecution, type WorkflowRouteContext, type WorkflowRouteDecision } from "../workflow/router.js";
import type { WorkflowCompletionContract, WorkflowCompletionTarget } from "../workflow/types.js";
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
import { ensureSessionPluginRuntimes } from "../plugins/runtime/manager.js";
import { ApprovalGateway, ReadOnlyToolApprovalGateway, type PendingApproval } from "../tools/approval-gateway.js";
import { ExecutionContractUnresolvedError, type ExecutionControlContext } from "../tools/execution-control.js";
import { CHAT_COMPLETION_CONTROL_TOOL_NAME, type ChatCompletionContext } from "../tools/chat-completion-control.js";
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
import { bumpWorkbenchRevision, clearWorkbenchComposer, clearWorkbenchNextStepHints, emitWorkbenchUpdated, serializeWorkbench, setWorkbenchActiveRun, setWorkbenchNextStepHints } from "./workbench.js";
import { hookRuntime } from "../hooks/runtime.js";
import type { HookDecision, HookRuntimeEvent } from "../hooks/types.js";

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
import { DEFAULT_NEXT_STEP_HINT_COUNT, MAX_NEXT_STEP_HINT_COUNT, parseJsonObjectLoose, normalizeNextStepHints, createNextStepHintPrompt, createNextStepHints, resolveNextStepHintOptions } from "./next-step-hints.js";
import type { NextStepHint } from "./next-step-hints.js";
import {
	hasProviderConnectionInterruptedError,
	hasProviderResponseStalledError
} from "./workflow/workflow-error.js";
import { assertNoLegacyWorkflow, isLegacyWorkflowRunState, LegacyWorkflowRemovedError } from "./legacy-workflow-guard.js";
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
import { collectUnresolvedExecutionFailures, formatExecutionFailure } from "../workflow/evidence-failures.js";
import {
	createAgentLoopRecoveryController,
	createAgentLoopState,
	type AgentLoopState
} from "../workflow/agent-loop-state.js";

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
import { createAgentToolEventForwarder, shouldRequireWorkflowWriteTool, didWorkflowWritePhaseExecute, createWorkflowWriteGuardRetryMessage } from "./workflow/tool-events.js";
import { ensureProviderConfigured } from "../application/provider-session-service.js";
import { beginSessionRun, findSessionWithPendingToolBudget, finishSessionRun, getActiveSessionRunController, getClientConnection, registerSessionRunController } from "./client-connections.js";
import { logger } from "../logger.js";
import { synchronizeSessionApprovalMode } from "./approval-mode-sync.js";
import { createInitialPlan } from "./plan-mode.js";
import { createPlanGetResult, type StoredPlan } from "./plan-store.js";
import { getUserPrompt } from "../user-prompt-store.js";
import { compressSessionHistory } from "./session-compression.js";
import { clearContextLedger, filterMessagesOutsideContextLedger } from "../context/context-ledger.js";
import { createContextBudgetSnapshot } from "../context/context-budget-manager.js";
import type { ContextBudgetSnapshot } from "../context/context-types.js";
import { createSessionContextControl } from "./context-control-runtime.js";
import { createAgentTodoControl } from "./todo-control-runtime.js";
import { createSummaryPreparationControl } from "./summary-preparation-runtime.js";
import { completeAgentTodoSnapshot } from "../tools/todo-control.js";
import { consumeHookDeveloperContext, runUserPromptSubmitHooks } from "./hook-lifecycle.js";
import { getWebSearchSettingsStatus, isWebSearchEnabled, isWebSearchToolAvailable } from "../web-search-settings-store.js";
import { withProviderUsageContext } from "../usage/provider-recorder.js";
import {
	beginAgentRun,
	getAgentRun,
	recordAgentRunToolEvent,
	updateAgentRun
} from "./agent-run-controller.js";
import { attachGoalRun, continueAgentGoal, createAgentGoal, discardSessionGoalRuntimesForRewind, getCurrentAgentGoal, normalizeGoalAgentLoopParams, pauseAgentGoal } from "./goal-controller.js";
import { getGoalRunBinding } from "./goal-run-observer.js";
import {
	validateExecutionDecisionEvidence,
	type AgentRunLane,
	type AgentRunState,
	type ExecutionEvidence,
	type ExecutionDecision
} from "../workflow/agent-run-state.js";

const WEB_SEARCH_TOOL_NAME: string = "mcp_web_search";
const GODOT_AUTOLOAD_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
	"mcp_godot_propose_set_autoload",
	"mcp_godot_set_autoload",
	"mcp_godot_propose_unset_autoload",
	"mcp_godot_unset_autoload"
]);

type ChatModelSnapshotChange = {
	modelTransition?: {
		from: SessionModelRef;
		to: SessionModelRef;
	} | undefined;
};

function applyChatRequestModelSnapshot(session: ClientSession, params: AiChatParams): ChatModelSnapshotChange | null {
	if (params.provider === undefined && params.model === undefined && params.options?.reasoningEffort === undefined) {
		return null;
	}

	const nextProvider: ProviderId = params.provider ?? session.activeProvider;
	if (!isProviderId(nextProvider)) {
		return null;
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
		return null;
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
		session.providerRequestOverrides = undefined;
	}
	return {
		...(providerChanged || nextModel !== currentModel
			? {
				modelTransition: {
					from: { provider: previousProvider, model: currentModel },
					to: { provider: nextProvider, model: nextModel },
				},
			}
			: {}),
	};
}

function isImageGenerationOnlyToolRestriction(toolNames: readonly string[] | undefined): boolean {
	return toolNames !== undefined && toolNames.length === 1 && toolNames[0] === "mcp_image_generate";
}

function removeWebSearchToolName(allowedToolNames: readonly string[] | undefined, session: ClientSession): readonly string[] {
	const toolNames: readonly string[] = allowedToolNames ?? createWorkspaceToolCatalog({
		workspaceId: session.activeWorkspace?.id,
		hasGodotWorkspaceCapability: hasGodotWorkspaceCapability(session.activeWorkspace),
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

function createWorkflowRouteContext(session: ClientSession): WorkflowRouteContext {
	return { hasActiveWorkspace: session.activeWorkspace !== undefined };
}

function cancelPendingNextStepHintGeneration(session: ClientSession): void {
	session.nextStepHintAbortController?.abort();
	session.nextStepHintAbortController = undefined;
}

function shouldScheduleNextStepHints(params: AiChatParams, goalBinding: ReturnType<typeof getGoalRunBinding>): boolean {
	return params.mode !== "goal" && params.mode !== "plan" && goalBinding === undefined;
}

function maybeScheduleNextStepHints(params: {
	socket: WebSocket;
	requestId: string;
	session: ClientSession;
	options: ProviderChatOptions;
	generation: number;
}): void {
	const sessionId: string | undefined = params.session.sessionId;
	if (sessionId === undefined) {
		return;
	}

	cancelPendingNextStepHintGeneration(params.session);
	const abortController: AbortController = new AbortController();
	params.session.nextStepHintAbortController = abortController;
	logger.debug("ai", "next_step_hints_scheduled", {
		requestId: params.requestId,
		sessionId,
		generation: params.generation
	});
	void (async (): Promise<void> => {
		try {
			const generalSettings = await getGeneralSettings();
			if (!generalSettings.nextStepHintsEnabled || abortController.signal.aborted) {
				return;
			}
			const hintOptions: ProviderChatOptions = withProviderUsageContext(
				await resolveNextStepHintOptions(params.options),
				{ operation: "next_step_hints" }
			);
			const hints: NextStepHint[] = await createNextStepHints(
				params.session,
				hintOptions,
				1,
				"done",
				params.requestId,
				abortController.signal
			);
			if (abortController.signal.aborted || params.session.sessionId !== sessionId) {
				return;
			}
			const updated = setWorkbenchNextStepHints(
				params.session,
				hints,
				"done",
				params.requestId,
				params.generation
			);
			if (updated === undefined) {
				logger.debug("ai", "next_step_hints_discarded_stale", {
					requestId: params.requestId,
					sessionId,
					generation: params.generation
				});
				return;
			}
			emitWorkbenchUpdated(params.socket, params.requestId, params.session);
		} catch (error: unknown) {
			if (!isCancellationError(error, abortController.signal)) {
				logger.warn("ai", "next_step_hints_generation_failed", {
					requestId: params.requestId,
					sessionId,
					message: error instanceof Error ? error.message : String(error)
				});
			}
		} finally {
			if (params.session.nextStepHintAbortController === abortController) {
				params.session.nextStepHintAbortController = undefined;
			}
		}
	})();
}

function selectConcreteTargetKind(families: readonly WorkflowTargetKind[]): WorkflowTargetKind | undefined {
	for (const candidate of ["project_setting", "godot_scene", "godot_script", "workspace_file"] as const) {
		if (families.includes(candidate)) return candidate;
	}
	return undefined;
}

function createPendingWriteExecutionDecision(
	event: Extract<ToolEvent, { type: "tool.call" }>,
	workspaceId: string | undefined
): ExecutionDecision | undefined {
	const targetKind: WorkflowTargetKind | undefined = selectConcreteTargetKind(
		getWorkflowToolSemantics(event.toolName, event.args).repairFamilies ?? []
	);
	if (targetKind === undefined) return undefined;

	const sourceFolderId: string | undefined = typeof event.args.sourceFolderId === "string"
		? event.args.sourceFolderId
		: undefined;
	if (targetKind === "project_setting") {
		const rawKey: unknown = event.args.key;
		const rawAction: unknown = event.args.action;
		const rawAutoloadName: unknown = event.args.name;
		const targetValue: string | undefined = typeof rawKey === "string"
			? rawKey
			: typeof rawAction === "string"
				? `input/${rawAction}`
				: typeof rawAutoloadName === "string" && GODOT_AUTOLOAD_WRITE_TOOL_NAMES.has(event.toolName)
					? `autoload/${rawAutoloadName}`
					: undefined;
		const key: string | undefined = targetValue === undefined ? undefined : normalizeProjectSettingKey(targetValue);
		return key === undefined ? undefined : {
			disposition: "use_workflow",
			summary: "Continue the pending structured project-setting mutation in a target-scoped workflow.",
			evidenceToolCallIds: [],
			expectedArtifacts: [key],
			expectedFileRefs: workspaceId !== undefined && sourceFolderId !== undefined
				? [{ workspaceId, sourceFolderId, relativePath: "project.godot" }]
				: undefined,
			targetKind
		};
	}

	let relativePath: string | undefined;
	for (const key of ["relativePath", "resourcePath", "scenePath", "scriptPath", "path"] as const) {
		const rawValue: unknown = event.args[key];
		if (typeof rawValue !== "string") continue;
		relativePath = normalizeWorkspaceRelativeArtifactPath(rawValue);
		if (relativePath !== undefined) break;
	}
	if (relativePath === undefined) return undefined;
	return {
		disposition: "use_workflow",
		summary: "Continue the pending structured file mutation in a target-scoped workflow.",
		evidenceToolCallIds: [],
		expectedArtifacts: [relativePath],
		expectedFileRefs: workspaceId !== undefined && sourceFolderId !== undefined
			? [{ workspaceId, sourceFolderId, relativePath }]
			: undefined,
		targetKind
	};
}

function createExecutionDecisionCompletionContract(
	decision: ExecutionDecision | undefined
): WorkflowCompletionContract | undefined {
	if (
		decision === undefined
		|| (decision.disposition !== "use_workflow" && decision.disposition !== "use_lightweight")
		|| decision.expectedArtifacts.length === 0
		|| decision.targetKind === "unknown"
	) {
		return undefined;
	}
	const targets: WorkflowCompletionTarget[] = decision.expectedArtifacts.flatMap((artifact: string): WorkflowCompletionTarget[] => {
		if (decision.targetKind === "project_setting") {
			const key: string | undefined = normalizeProjectSettingKey(artifact);
			const sourceFolderId: string | undefined = decision.expectedFileRefs?.length === 1
				? decision.expectedFileRefs[0]?.sourceFolderId
				: undefined;
			return key === undefined ? [] : [{ kind: "project_setting", key, sourceFolderId }];
		}
		const relativePath: string | undefined = normalizeWorkspaceRelativeArtifactPath(artifact);
		if (relativePath === undefined) return [];
		const targetKind: Exclude<WorkflowTargetKind, "project_setting"> = decision.targetKind === "godot_script"
			|| decision.targetKind === "godot_scene"
			? decision.targetKind
			: "workspace_file";
		const matchingFileRefs = (decision.expectedFileRefs ?? []).filter((fileRef): boolean => (
			(normalizeWorkspaceRelativeArtifactPath(fileRef.relativePath) ?? fileRef.relativePath) === relativePath
		));
		return matchingFileRefs.length === 0
			? [{ kind: "artifact", path: relativePath, targetKind }]
			: matchingFileRefs.map((fileRef): WorkflowCompletionTarget => ({
				kind: "artifact",
				path: relativePath,
				targetKind,
				sourceFolderId: fileRef.sourceFolderId,
				fileRef: { ...fileRef, relativePath }
			}));
	});
	return targets.length === 0 ? undefined : { targets, requireAll: true };
}

function getAllRuntimeToolNames(session: ClientSession): readonly string[] {
	if (session.activeWorkspace === undefined) {
		return getNoWorkspaceToolNames();
	}

	return createWorkspaceToolCatalog({
		workspaceId: session.activeWorkspace.id,
		hasGodotWorkspaceCapability: hasGodotWorkspaceCapability(session.activeWorkspace),
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
	params: AiChatParams,
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
	if (
		(routeDecision.lane === "agent_loop" || routeDecision.lane === "tool_assisted")
		&& routeDecision.outputTarget === "workspace"
	) {
		return sourceToolNames;
	}

	const readOnlyToolNames: readonly string[] = filterReadOnlyAnswerToolNames(sourceToolNames, session.activeWorkspace?.id);
	if (
		routeDecision.lane === "probe"
		&& getExecutionPolicy(params) === "auto"
		&& sourceToolNames.includes("mcp_terminal_run_command")
	) {
		return [...readOnlyToolNames, "mcp_terminal_run_command"];
	}
	return readOnlyToolNames;
}

function createExecutionControlContext(
	params: AiChatParams,
	routeDecision: WorkflowRouteDecision
): ExecutionControlContext | undefined {
	if (routeDecision.lane !== "lightweight") {
		return undefined;
	}
	return {
		lane: routeDecision.lane,
		allowMutationEscalation: false,
		requireDecision: false
	};
}

function createChatCompletionContext(routeDecision: WorkflowRouteDecision): ChatCompletionContext | undefined {
	// Native completion tools are useful when a provider supports them, but they
	// must not be a mandatory chat boundary: several otherwise capable providers
	// return their synthesized answer as normal text after a read tool call.
	return undefined;
}

export function createHiddenAnswerChatParams(params: AiChatParams, routeDecision: WorkflowRouteDecision): AiChatParams {
	if (routeDecision.lane === "direct" || routeDecision.lane === "workflow") {
		return params;
	}

	const options: AiChatParams["options"] & Record<string, unknown> = {
		...(params.options ?? {})
	};
	options.outputTarget = routeDecision.outputTarget;
	if (routeDecision.lane === "read" || routeDecision.lane === "probe" || routeDecision.lane === "lightweight") {
		// A workspace-bound agent may still receive general-knowledge questions.
		// Tool evidence is required only when the answer depends on runtime facts.
		delete options.requireToolCallOnFirstStep;
		options.toolBudget = "simple";
		return {
			...params,
			options
		};
	}
	if (routeDecision.lane === "agent_loop") {
		return {
			...params,
			options: {
				...options,
				toolBudget: routeDecision.outputTarget === "workspace"
					? (params.options?.toolBudget ?? "project_edit")
					: (params.options?.toolBudget ?? "normal")
			}
		};
	}
	if (routeDecision.lane === "tool_assisted") {
		return {
			...params,
			options: {
				...options,
				toolBudget: routeDecision.outputTarget === "chat"
					? "simple"
					: (params.options?.toolBudget ?? "normal")
			}
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

export function createHiddenAnswerSystemPrompt(
	fullSystemPrompt: string,
	routeDecision: WorkflowRouteDecision,
	verificationPolicy: NonNullable<NonNullable<AiChatParams["options"]>["verificationPolicy"]> = "best_effort",
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
				"- The execution-decision tool is intentionally unavailable during this first pass.",
				"- Use the minimum read or verify tools when the answer depends on current workspace or runtime facts. For general knowledge that does not depend on this workspace, answer directly without inventing inspection results.",
				"- mcp_terminal_run_command is available only for a needed general command. It follows the configured terminal approval policy: auto-safe commands are reviewed before execution; a denied or uncertain review is returned to you as a tool error. Do not use it when a read or verify tool can establish the answer. Do not use terminal download commands; use the structured workspace downloader only when a workspace file is genuinely needed.",
				"- Do not write, propose a patch, or claim that a mutation path is authorized during this probe.",
				"- After inspection, return concise factual findings only. Daedalus will open one control-only pass that records the execution decision from the evidence."
			].join("\n")
		].join("\n\n");
	}

	if (routeDecision.lane === "agent_loop") {
		const verificationGuidance: string = verificationPolicy === "skip"
			? "- The user selected verificationPolicy=skip. Do not run validation solely to satisfy a framework rule. Clearly distinguish completed edits from unverified behavior."
			: verificationPolicy === "required"
				? "- The user selected verificationPolicy=required. Run proportionate available validation before claiming verified completion. If it cannot run, preserve completed work and report an unverified warning; do not create an automatic repair phase."
				: "- Validation is best effort: run proportionate checks when useful. If checks are unavailable or omitted, preserve completed work and state that it is unverified; do not create an automatic repair phase.";
		return [
			fullSystemPrompt,
			[
				"## Daedalus free Agent Loop",
				"- You own the execution flow. Choose the smallest useful sequence of reading, editing, commands, validation, questions, retries, and explanation for the user's actual request.",
				"- There are no fixed inspect, implement, verify, or summarize phases. Do not report artificial phase completion and do not create a Todo merely to mirror those generic labels.",
				"- For a business implementation request, begin with 1-3 visible sentences that answer the request directly, name the intended scope and preserved behavior, and state the first concrete direction. Do this before any Todo or workspace tool call.",
				"- If you judge that the task has more than three meaningful steps, call daedalus_update_todo_list to show a concise task-specific Todo list. Do not inflate a short task into generic phases just to create a list.",
				"- Todo is optional display metadata, not an execution contract. Update it only when real progress changes; it never grants permission, requires a particular order, replaces user-visible communication, or determines whether the task succeeded.",
				"- For complex problems, use the available workflow-governed read, verify, propose, write, and approval tools to gather evidence and make changes safely. These tools support the free Agent Loop; they do not turn it into a fixed inspect/implement/verify/summarize workflow.",
				"- Call daedalus_prepare_summary only when useful work and proportionate verification are complete and you are about to write the final user-facing summary. Never call it during planning, while announcing progress, or merely to inspect state. If it returns action=continue_agent_loop, keep working or explain the blocker; do not present the task as complete. When it returns action=summarize, write the final answer and follow its warnings.",
				"- Do not ask the user to extend an internal tool-count budget. Continue naturally while useful progress is being made; context pressure is handled by the recoverable context controls.",
				"- If a tool returns agent_loop_no_progress_detected, change the target or approach instead of repeating the call. If it returns agent_loop_no_progress_exhausted or agent_loop_safety_limit_reached, stop requesting equivalent tools and give an honest progress summary.",
				"- Tools are optional. General questions may be answered directly. Workspace claims must come from actual observations, and workspace mutations must use the available policy-governed tools.",
				"- A structured tool failure is an observation, not a request-level crash. Read its code and target, then correct the arguments, gather more context, use another equally authorized approach, ask the user when authority is missing, or continue with unaffected work.",
				"- Never broaden source-folder, path, network, destructive, or approval scope while retrying. A retry_exhausted result means that exact operation must not be repeated; choose a materially different safe approach or explain the limitation.",
				"- Ordinary visible assistant text may complete the turn. Do not call an execution-decision tool and do not end on a progress announcement when useful work remains.",
				routeDecision.outputTarget === "chat"
					? "- The output target is chat: use only read or verify tools and do not mutate the workspace."
					: "- The output target is workspace: read, write, destructive, terminal, and download tools retain their existing policy and approval boundaries.",
				verificationGuidance
			].filter((line: string): boolean => line.length > 0).join("\n")
		].join("\n\n");
	}

	if (routeDecision.lane === "tool_assisted") {
		if (routeDecision.outputTarget === "chat") {
			return [
				fullSystemPrompt,
				[
					"## Read-only chat output contract",
					"- The requested output target is chat. You may read or verify workspace facts when necessary, but you must not create, modify, delete, or otherwise mutate workspace files.",
					"- After any needed tool results, return the complete user-facing answer as normal visible assistant text. Do not leave the answer only in thinking/reasoning content or a progress announcement.",
					"- If the user wants a file changed, stop and explain that the request must be resent with outputTarget=workspace. Do not infer that authorization from prose.",
					"- Code, configuration, or changelog content may be presented in the response without writing it to disk."
				].join("\n")
			].join("\n\n");
		}
		return [
			fullSystemPrompt,
			[
				"## Daedalus tool-assisted chat",
				"- Answer normally when tools are unnecessary. Never invent workspace observations.",
				"- Use the smallest relevant tool call when current workspace facts are needed.",
				"- Read, verify, write, destructive, terminal, and network-download tools retain their normal policy and approval checks. A downloader call only stores a file in the approved workspace path; it never installs or runs the download.",
				"- A single bounded approved change may be completed here. If more work is needed, Daedalus will safely continue it as a workflow.",
				"- This request explicitly targets the workspace. Do not finish with a progress announcement or a promise to make a change later. After inspection, either perform the bounded authorized change, or clearly state that no workspace change was made and why.",
				"- Verification is optional in this chat lane. If no verifier is run after a change, state that the result is unverified."
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
				? "- If current-project evidence shows the user expects a fix, choose use_lightweight for at most two logical writes or use_workflow for broader work. Do not promise a future modification in prose. A terminal command alone does not grant file-mutation permission."
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
	const chatCompletion: ChatCompletionContext | undefined = createChatCompletionContext(params.routeDecision);
	const fullSystemPrompt: string = createHiddenAnswerSystemPrompt(
		params.fullSystemPrompt,
		params.routeDecision,
		chatParams.options?.verificationPolicy ?? "best_effort",
		executionControl
	);
	const agentLoopState: AgentLoopState | undefined = params.routeDecision.lane === "agent_loop"
		? (getAgentRun(params.session, runId)?.agentLoopState ?? createAgentLoopState())
		: undefined;
	const agentLoopRecovery = agentLoopState === undefined
		? undefined
		: createAgentLoopRecoveryController(agentLoopState);
	const lightweightActionState: LightweightActionState | undefined = params.routeDecision.lane === "lightweight"
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
		if (event.type === "tool.call" && params.routeDecision.lane === "tool_assisted") {
			const risk: string | undefined = getToolPolicy(event.toolName, params.session.activeWorkspace?.id)?.risk;
			const hasSuccessfulMutation: boolean = (getAgentRun(params.session, runId)?.checkpoint.evidence ?? [])
				.some((item: ExecutionEvidence): boolean => (
					item.status === "succeeded" && (item.risk === "write" || item.risk === "destructive")
				));
			if (hasSuccessfulMutation && (risk === "write" || risk === "destructive")) {
				throw new LightweightActionScopeExceededError(
					"write_scope_exceeded",
					createPendingWriteExecutionDecision(event, params.session.activeWorkspace?.id)
				);
			}
		}
		if (lightweightActionState !== undefined) {
			applyToolEventToLightweightActionState(lightweightActionState, event, true);
		}
		recordAgentRunToolEvent(params.socket, params.session, runId, event);
		if (
			!(executionControl?.requireDecision === true && event.type === "ai.delta")
			&& !(chatCompletion?.requireSubmission === true && event.type === "ai.delta")
		) {
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
			hasGodotWorkspaceCapability: hasGodotWorkspaceCapability(params.session.activeWorkspace),
			editorInstanceId: params.session.editorInstanceId,
			sessionId: params.session.sessionId,
			requestId: params.requestId,
			clientType: getClientConnection(params.socket)?.clientType,
			browserControl: getStudioBrowserControl(params.socket, params.session.sessionId),
			executionControl,
			executionControlAvailable: params.routeDecision.lane !== "probe",
			chatCompletion,
			agentLoopRecovery,
			contextControl: params.session.sessionId === undefined ? undefined : createSessionContextControl({
				session: params.session,
				apiKey: params.options.apiKey,
				requestId: params.requestId,
				abortSignal: params.abortSignal
			}),
			contextControlAvailable: params.routeDecision.lane === "agent_loop",
			todoControl: params.routeDecision.lane === "agent_loop"
				? createAgentTodoControl({ socket: params.socket, session: params.session, runId })
				: undefined,
			todoControlAvailable: params.routeDecision.lane === "agent_loop",
			summaryPreparation: params.routeDecision.lane === "agent_loop"
				? createSummaryPreparationControl({ socket: params.socket, session: params.session, runId })
				: undefined,
			summaryPreparationAvailable: params.routeDecision.lane === "agent_loop",
			hookContext: {
				model: resolveChatModel(executionOptions),
				approvalMode: params.session.approvalGateway.getMode(),
				chatMode: chatParams.mode
			}
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
				hasGodotWorkspaceCapability: hasGodotWorkspaceCapability(params.session.activeWorkspace),
				editorInstanceId: params.session.editorInstanceId,
				sessionId: params.session.sessionId,
				requestId: params.requestId,
				clientType: getClientConnection(params.socket)?.clientType,
				browserControl: getStudioBrowserControl(params.socket, params.session.sessionId),
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
			executionControl,
			chatCompletion,
			agentLoopState
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
			executionControl,
			chatCompletion,
			agentLoopState
		});
		registerPendingToolBudget(params.session, pendingBudget);
		sendToolBudgetRequired(params.socket, params.requestId, params.session, runId, pendingBudget);
		return;
	}
	if (agentResult.status === "chat_answer") {
		await completeHiddenAnswerExecution(
			params,
			persistedChatParams,
			agentResult.answer.answer,
			{
				resultStatus: "completed",
				verificationStatus: undefined,
				warnings: []
			}
		);
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
		if (chatCompletion?.requireSubmission === true) {
			await completeHiddenAnswerExecution(
				params,
				persistedChatParams,
				"模型没有完成结构化聊天收束，已安全停止；未执行任何工作区写入。请重试，或切换支持工具调用的模型。",
				{
					resultStatus: "completed_with_warnings",
					verificationStatus: undefined,
					warnings: ["The provider did not submit the required structured chat answer."],
					failureMessage: undefined
				}
			);
			return;
		}
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
			...collectToolAssistedCompletionStatus(
				params.session,
				runId,
				params.routeDecision.lane,
				params.routeDecision.outputTarget
			),
			failureMessage: undefined
		}
		: collectLightweightActionCompletionStatus(lightweightActionState);
	if (completionStatus.failureMessage !== undefined) {
		throw new LightweightActionVerificationError(completionStatus.failureMessage);
	}

	await completeHiddenAnswerExecution(params, persistedChatParams, agentResult.text, completionStatus);
}

function collectToolAssistedCompletionStatus(
	session: ClientSession,
	runId: string,
	lane: AgentRunLane,
	outputTarget: WorkflowRouteDecision["outputTarget"]
): {
	resultStatus: "completed" | "completed_with_warnings" | "blocked";
	verificationStatus?: "verified" | "unverified" | undefined;
	warnings: string[];
} {
	if (lane !== "tool_assisted" && lane !== "agent_loop") {
		return { resultStatus: "completed", verificationStatus: undefined, warnings: [] };
	}
	const evidence: readonly ExecutionEvidence[] = getAgentRun(session, runId)?.checkpoint.evidence ?? [];
	const currentRun: AgentRunState | undefined = getAgentRun(session, runId);
	const unresolvedFailures: ExecutionEvidence[] = collectUnresolvedExecutionFailures(evidence);
	const environmentWarnings: string[] = evidence
		.filter((item: ExecutionEvidence): boolean => item.status === "failed" && item.failure?.category === "environment")
		.map(formatExecutionFailure);
	const unresolvedWarnings: string[] = unresolvedFailures.map(formatExecutionFailure);
	const changedWorkspace: boolean = evidence.some((item: ExecutionEvidence): boolean => (
		item.status === "succeeded" && (item.risk === "write" || item.risk === "destructive")
	));
	const verified: boolean = evidence.some((item: ExecutionEvidence): boolean => (
		item.status === "succeeded"
			&& item.risk === "verify"
			&& item.validationStatus !== "not_applicable"
	));
	if (unresolvedFailures.length > 0 && lane === "tool_assisted") {
		return {
			resultStatus: "blocked",
			verificationStatus: "unverified",
			warnings: unresolvedFailures.map(formatExecutionFailure)
		};
	}
	if (lane === "agent_loop" && unresolvedWarnings.length > 0) {
		return {
			resultStatus: "completed_with_warnings",
			verificationStatus: changedWorkspace ? (verified ? "verified" : "unverified") : undefined,
			warnings: [
				...environmentWarnings,
				...unresolvedWarnings,
				...(currentRun?.summaryPreparation?.ready === false
					? ["The summary checkpoint requested more Agent Loop work before a complete summary."]
					: [])
			]
		};
	}
	if (lane === "agent_loop" && currentRun?.summaryPreparation?.ready === false) {
		return {
			resultStatus: "completed_with_warnings",
			verificationStatus: changedWorkspace ? (verified ? "verified" : "unverified") : undefined,
			warnings: [
				...environmentWarnings,
				...currentRun.summaryPreparation.warnings,
				"The summary checkpoint requested more Agent Loop work before a complete summary."
			]
		};
	}
	if (!changedWorkspace) {
		return outputTarget === "workspace" && lane === "tool_assisted"
			? {
				resultStatus: "completed_with_warnings",
				verificationStatus: "unverified",
				warnings: [...environmentWarnings, "The workspace output target completed without a successful write or destructive tool result; no workspace change was recorded."]
			}
			: environmentWarnings.length > 0
				? { resultStatus: "completed_with_warnings", verificationStatus: "unverified", warnings: environmentWarnings }
				: { resultStatus: "completed", verificationStatus: undefined, warnings: [] };
	}
	return verified
		? environmentWarnings.length > 0
			? { resultStatus: "completed_with_warnings", verificationStatus: "verified", warnings: environmentWarnings }
			: { resultStatus: "completed", verificationStatus: "verified", warnings: [] }
		: {
			resultStatus: "completed_with_warnings",
			verificationStatus: "unverified",
			warnings: [...environmentWarnings, "The approved change completed without a successful verification step."]
		};
}

async function completeHiddenAnswerExecution(
	params: HiddenAnswerExecutionParams,
	chatParams: AiChatParams,
	text: string,
	completionStatus: {
		resultStatus: "completed" | "completed_with_warnings" | "blocked";
		verificationStatus?: "verified" | "unverified" | undefined;
		warnings: string[];
		failureMessage?: string | undefined;
	}
): Promise<void> {
	const runId: string = params.requestId;
	const stepRunId: string = `${params.requestId}:answer`;
	const effectiveText: string = text.trim().length > 0
		? text
		: completionStatus.resultStatus === "blocked"
			? `本轮任务未能完成：${completionStatus.warnings[0] ?? "工具执行失败。"}`
			: text;
	const stopDecision: HookDecision = await hookRuntime.run({
		event: "Stop",
		input: {
			stop_hook_active: params.session.stopHookContinuationCount > 0,
			last_assistant_message: effectiveText
		},
		sessionId: params.session.sessionId ?? `temporary:${params.requestId}`,
		turnId: params.requestId,
		model: resolveChatModel(params.options),
		approvalMode: params.session.approvalGateway.getMode(),
		chatMode: chatParams.mode,
		workspace: params.session.activeWorkspace,
		abortSignal: params.abortSignal
	}, (event: HookRuntimeEvent): void => {
		if (event.statusMessage !== undefined) {
			sendSessionEvent(params.socket, params.requestId, params.session, "agent.status", {
				status: "hook",
				message: event.statusMessage
			});
		}
		if (event.systemMessage !== undefined) {
			sendSessionEvent(params.socket, params.requestId, params.session, "agent.status", {
				status: "warning",
				message: event.systemMessage
			});
		}
	});
	if (stopDecision.blocked && params.session.stopHookContinuationCount < 3) {
		params.session.stopHookContinuationCount += 1;
		const continuationPrompt: string = [
			"A trusted Stop hook requested that this turn continue before it can be finalized.",
			stopDecision.reason === undefined ? "Continue the answer and address anything still incomplete." : `Hook feedback: ${stopDecision.reason}`,
			stopDecision.additionalContext === undefined ? "" : `Additional hook context:\n${stopDecision.additionalContext}`,
			"Continue from the existing draft without repeating it. Do not call tools in this continuation."
		].filter((part: string): boolean => part.length > 0).join("\n\n");
		const continuationText: string = await chatWithDeepSeek(
			{
				...chatParams,
				message: continuationPrompt,
				additionalContext: undefined
			},
			withProviderUsageContext(params.options, { operation: "stop_hook_continuation" }),
			[
				...params.history,
				{ role: "user", content: chatParams.message },
				{ role: "assistant", content: effectiveText }
			],
			params.fullSystemPrompt,
			params.abortSignal
		);
		const normalizedContinuation: string = continuationText.trim();
		if (normalizedContinuation.length > 0) {
			sendSessionEvent(params.socket, params.requestId, params.session, "ai.delta", {
				text: `\n\n${normalizedContinuation}`
			});
			await completeHiddenAnswerExecution(
				params,
				chatParams,
				`${effectiveText}\n\n${normalizedContinuation}`,
				completionStatus
			);
			return;
		}
	}
	const stopLimitReached: boolean = stopDecision.blocked && params.session.stopHookContinuationCount >= 3;
	params.session.stopHookContinuationCount = 0;
	const finalWarnings: string[] = stopLimitReached
		? [...completionStatus.warnings, "Stop hook continuation limit reached; the turn was finalized after three continuations."]
		: completionStatus.warnings;
	if (getAgentRun(params.session, runId) !== undefined) {
		const currentRun: AgentRunState = getAgentRun(params.session, runId)!;
		updateAgentRun(params.socket, params.session, runId, "finalizing", {
			todo: currentRun.summaryPreparation?.ready === false
				? currentRun.todo
				: completeAgentTodoSnapshot(currentRun.todo),
			verificationStatus: completionStatus.verificationStatus ?? null,
			warnings: finalWarnings
		});
	}
	await appendChatTurnToSession(
		params.session,
		params.history,
		chatParams.message,
		effectiveText,
		params.requestId,
		params.userCreatedAt,
		undefined,
		chatParams.additionalContext,
		chatParams.retryOfRunId === undefined
	);
	sendSessionEvent(params.socket, params.requestId, params.session, "agent.message.done", {
		runId,
		stepRunId,
		text: effectiveText,
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
				message: completionStatus.resultStatus === "blocked" ? completionStatus.warnings[0] : undefined,
				completedAt: new Date().toISOString()
			},
			verificationStatus: completionStatus.verificationStatus ?? null,
			warnings: finalWarnings
		});
	}
	sendJson(params.socket, {
		type: "response",
		id: params.requestId,
		ok: true,
		result: {
			text: effectiveText,
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
			if (
				(params.routeDecision.lane === "tool_assisted" || params.routeDecision.lane === "read")
				&& !isCancellationError(error, params.abortSignal)
			) {
				logger.warn("ai", "tool_assisted_execution_recovered", {
					requestId: params.requestId,
					sessionId: params.session.sessionId,
					message: error instanceof Error ? error.message : "Unknown provider execution failure"
				});
				await completeHiddenAnswerExecution(
					params,
					params.chatParams,
					"本轮模型响应未能完整恢复，已安全停止；未执行任何未获批准的操作。请直接重试该请求。",
					{
						resultStatus: "completed_with_warnings",
						verificationStatus: undefined,
						warnings: ["The model response ended before a safe completion could be produced."]
					}
				);
				return;
			}
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
	const escalationInstruction: string = escalationError.reason === "write_intent_not_completed"
		? "轻量操作只完成了读取，没有执行用户要求的写入。先复核当前工作区状态，再完成实现和验证；不要把未来计划或下一步描述当成完成结果。"
		: "轻量操作已经完成了部分必要修改，但下一步会超过两个逻辑写入。先检查当前工作区状态，不要重复已成功的写入，然后完成剩余工作和验证。";
	const { workflow: _legacyWorkflow, ...nonWorkflowOptions } = params.chatParams.options ?? {};
	const agentLoopParams: HiddenAnswerExecutionParams = {
		...params,
		chatParams: {
			...params.chatParams,
			options: {
				...nonWorkflowOptions,
				executionPolicy: "auto",
				outputTarget: "workspace",
				toolBudget: params.chatParams.options?.toolBudget ?? "project_edit"
			}
		},
		fullSystemPrompt: [params.fullSystemPrompt, params.planningContext, escalationInstruction]
			.filter((section: string): boolean => section.length > 0)
			.join("\n\n"),
		allowedToolNames: params.mutationToolNames,
		approvalGateway: params.session.approvalGateway,
		routeDecision: {
			...params.routeDecision,
			intent: "mutate",
			scope: "complex",
			lane: "agent_loop",
			outputTarget: "workspace",
			reason: escalationDecision?.summary ?? escalationInstruction,
			planningHint: ""
		}
	};
	const currentRun: AgentRunState | undefined = getAgentRun(params.session, params.requestId);
	if (currentRun !== undefined) {
		updateAgentRun(params.socket, params.session, params.requestId, "executing", {
			intent: "mutate",
			scope: "complex",
			lane: "agent_loop",
			agentLoopState: currentRun.agentLoopState ?? createAgentLoopState(),
			pause: null,
			todo: null,
			planId: null
		});
	}
	await runHiddenAnswerExecution(agentLoopParams);
	return;
}

export async function rejectLegacyWorkflowContinuation(params: {
	pendingContinuation: PendingAiContinuation;
	reason: string;
}): Promise<never> {
	void params;
	throw new LegacyWorkflowRemovedError(
		"Legacy phase-based workflow continuation has been removed. Start a new Agent Loop run instead."
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
	budget: ContextBudgetSnapshot;
};

function getFullContextHistoryMessages(session: ClientSession, excludeRequestId?: string | undefined): ChatMessage[] {
	const filterRequest = (messages: ChatMessage[]): ChatMessage[] => excludeRequestId === undefined
		? messages
		: messages.filter((message: ChatMessage): boolean => message.requestId !== excludeRequestId);
	if (session.summaryMessage === undefined) {
		return filterRequest(filterSessionLlmContextMessages(session));
	}

	const recentSourceMessages: ChatMessage[] = session.contextLedger !== undefined
		? filterMessagesOutsideContextLedger(session.messages, session.contextLedger.coveredMessageKeys)
		: session.summaryCoveredMessageCount !== undefined
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
	const inputTokens: number = Math.max(0, systemPromptTokens + contextPromptTokens + currentMessageTokens + historyTokens);
	const contextWindowTokens: number = session.modelProfile.contextWindowTokens;
	const budget: ContextBudgetSnapshot = createContextBudgetSnapshot({
		inputTokens,
		outputReserveTokens,
		safetyMarginTokens,
		contextWindowTokens
	});
	return {
		usedTokens: budget.committedTokens,
		contextWindowTokens,
		percent: budget.committedPercent,
		availableTokens: budget.availableTokens,
		historyTokens,
		currentMessageTokens,
		systemAndContextTokens: systemPromptTokens + contextPromptTokens,
		outputReserveTokens,
		safetyMarginTokens,
		budget
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
	if (estimate.budget.shouldAutoCompress && session.messages.length > 8) {
		const compressionId: string = `context-compression:${requestId}`;
		sendSessionEvent(socket, requestId, session, "agent.context.compression", {
			compressionId,
			status: "running",
			percent: estimate.percent,
			usedTokens: estimate.usedTokens,
			contextWindowTokens: estimate.contextWindowTokens
		});
		try {
			const compression = await compressSessionHistory(session, apiKey, 8, requestId, {
				abortSignal,
				compressionSource: estimate.budget.shouldEmergencyCompress ? "emergency" : "automatic"
			});
			sendSessionEvent(socket, requestId, session, "agent.context.compression", compression.compressed ? {
				compressionId,
				status: "completed",
				summary: compression.summary,
				source: compression.source,
				oldMessageCount: compression.oldMessageCount,
				keptMessageCount: compression.keptMessageCount,
				beforeTokens: compression.beforeTokens,
				afterTokens: compression.afterTokens,
				savedTokens: compression.savedTokens,
				level: compression.level,
				coveredBlockIds: compression.coveredBlockIds,
				restorableBlockCount: compression.restorableBlockCount,
				warning: compression.warning
			} : {
				compressionId,
				status: "skipped",
				reason: compression.reason
			});
		} catch (error: unknown) {
			if (abortSignal?.aborted === true) throw error;
			sendSessionEvent(socket, requestId, session, "agent.context.compression", {
				compressionId,
				status: "failed",
				reason: error instanceof Error ? error.message : "Context compression failed"
			});
			logger.warn("session", "automatic_context_compression_failed", {
				requestId,
				message: error instanceof Error ? error.message : String(error)
			});
		}
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

function getProviderResponseInterruption(error: unknown): ProviderErrorInfo | null {
	if (hasProviderResponseStalledError(error)) {
		return classifyProviderError({ code: "provider_response_stalled" });
	}
	if (hasProviderConnectionInterruptedError(error)) {
		return classifyProviderError({ code: "provider_connection_interrupted" });
	}
	return null;
}

async function pauseProviderResponseInterruptedRun(params: {
	socket: WebSocket;
	requestId: string;
	session: ClientSession;
	providerError: ProviderErrorInfo;
	userMessage: string;
	userCreatedAt: string;
	additionalContext?: readonly AdditionalContextItem[] | undefined;
}): Promise<boolean> {
	const currentRun: AgentRunState | undefined = getAgentRun(params.session, params.requestId);
	if (currentRun === undefined || currentRun.terminal !== null) {
		return false;
	}
	// A provider-interrupted run can stop before its final summary persists the turn.
	// Save the user request first so the retry RPC and a later “continue” both
	// have one authoritative source request after reconnecting or reopening.
	await appendUserMessageToSession(
		params.session,
		params.userMessage,
		params.requestId,
		params.userCreatedAt,
		params.additionalContext
	);
	if (currentRun.stage !== "interrupted") {
		updateAgentRun(params.socket, params.session, currentRun.runId, "interrupted", {
			pause: null,
			interruptedReason: params.providerError.code
		});
	}
	await waitForSessionEventPersistence(params.session);
	sendJson(params.socket, {
		type: "response",
		id: params.requestId,
		ok: true,
		result: {
			interrupted: true,
			retryable: true,
			runId: currentRun.runId,
			reason: params.providerError.code,
			message: params.providerError.message
		}
	});
	return true;
}

function createTimelineModelRef(modelRef: SessionModelRef): SessionModelRef & { label: string } {
	return {
		...modelRef,
		label: `${getProviderDisplayName(modelRef.provider)}/${modelRef.model}`,
	};
}

async function emitPendingModelChangeDivider(
	socket: WebSocket,
	requestId: string,
	session: ClientSession,
): Promise<void> {
	if (session.sessionId === undefined) {
		return;
	}
	const pending = await readPendingSessionModelTransition(session.sessionId);
	if (pending === null) {
		return;
	}
	sendSessionEvent(socket, requestId, session, "session.model.changed", {
		from: createTimelineModelRef(pending.from),
		to: createTimelineModelRef(pending.to),
	});
	await waitForSessionEventPersistence(session);
	await clearPendingSessionModelTransition(session.sessionId, pending.eventId);
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
	try {
		assertNoLegacyWorkflow(pending.continuation, "tool budget request");
	} catch (error: unknown) {
		if (error instanceof LegacyWorkflowRemovedError) {
			session.pendingToolBudgets.delete(budgetId);
			await removeAgentRunContinuation(pending.requestId);
			sendJson(socket, {
				type: "response",
				id: responseId,
				ok: false,
				error: { code: error.code, message: error.message }
			});
			return;
		}
		throw error;
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
		assertNoLegacyWorkflow(pendingContinuation, "tool budget continuation");
		const continuationParams: AiChatParams = await awaitWithAbort(
			hydrateImageAttachmentContexts(session.sessionId, pendingContinuation.params),
			abortController.signal
		);
		throwIfAborted(abortController.signal);
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
			if (pendingContinuation.lightweightActionState !== undefined) {
				applyToolEventToLightweightActionState(
					pendingContinuation.lightweightActionState,
					event
				);
			}
			recordAgentRunToolEvent(socket, session, pending.requestId, event);
			if (!(pendingContinuation.chatCompletion?.requireSubmission === true && event.type === "ai.delta")) {
				forwardToolEvent(event);
			}
		};

		const toolContext = {
			workspaceId: session.activeWorkspace?.id,
			hasGodotWorkspaceCapability: hasGodotWorkspaceCapability(session.activeWorkspace),
			editorInstanceId: session.editorInstanceId,
			sessionId: session.sessionId,
			requestId: pending.requestId,
			clientType: getClientConnection(socket)?.clientType,
			browserControl: getStudioBrowserControl(socket, session.sessionId),
			executionControl: pendingContinuation.executionControl,
			chatCompletion: pendingContinuation.chatCompletion,
			agentLoopRecovery: pendingContinuation.agentLoopState === undefined
				? undefined
				: createAgentLoopRecoveryController(pendingContinuation.agentLoopState),
			contextControl: session.sessionId === undefined ? undefined : createSessionContextControl({
				session,
				apiKey: pendingContinuation.options.apiKey,
				requestId: pending.requestId,
				abortSignal: abortController.signal
			}),
			contextControlAvailable: pendingContinuation.agentLoopState !== undefined,
			todoControl: pendingContinuation.agentLoopState === undefined
				? undefined
				: createAgentTodoControl({ socket, session, runId: pending.requestId }),
			todoControlAvailable: pendingContinuation.agentLoopState !== undefined,
			summaryPreparation: pendingContinuation.agentLoopState === undefined
				? undefined
				: createSummaryPreparationControl({ socket, session, runId: pending.requestId }),
			summaryPreparationAvailable: pendingContinuation.agentLoopState !== undefined,
			hookContext: {
				model: resolveChatModel(pendingContinuation.options),
				approvalMode: session.approvalGateway.getMode(),
				chatMode: continuationParams.mode
			}
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
			setWorkbenchActiveRun(session, { status: "idle" });
			await finishQueueItemForRun(socket, pending.requestId, session, queueItemId, "failed");
			const legacyError = new LegacyWorkflowRemovedError(
				"The removed lightweight-to-phase workflow escalation was requested. Start a new Agent Loop run instead."
			);
			sendSessionEvent(socket, pending.requestId, session, "agent.run.error", {
				runId,
				requestId: pending.requestId,
				status: "error",
				code: legacyError.code,
				message: legacyError.message,
				sequence: session.workbenchActiveRun.sequence ?? session.workbenchActiveRunSequence
			}, pending.requestId);
			sendJson(socket, {
				type: "response",
				id: pending.requestId,
				ok: false,
				error: { code: legacyError.code, message: legacyError.message }
			});
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
		if (error instanceof LegacyWorkflowRemovedError) {
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
				error: { code: error.code, message: error.message }
			});
			return;
		}
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
			if (isLegacyWorkflowRunState(interruptedRun)) {
				const message: string = "This interrupted run belongs to the removed phase-based workflow and cannot be resumed. Start a new Agent Loop run instead.";
				if (getAgentRun(session, interruptedRun.runId) !== undefined) {
					updateAgentRun(socket, session, interruptedRun.runId, "failed", {
						lane: "agent_loop",
						todo: null,
						planId: null,
						pause: null,
						warnings: [...interruptedRun.warnings, message]
					});
				}
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "legacy_workflow_removed", message }
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
			if (session.worktreeStatus !== undefined && session.worktreeStatus !== "ready") {
				sendJson(socket, { type: "response", id: request.id, ok: false, error: { code: "worktree_not_ready", message: "The worktree must finish setup or be explicitly skipped before starting the Agent." } });
				break;
			}
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
				await ensureSessionPluginRuntimes({
					sessionId: session.sessionId,
					workspaceId: session.activeWorkspace?.id,
					workspaceRoot: session.activeWorkspace?.sourceFolders.find((source): boolean => source.id === session.activeWorkspace?.primarySourceFolderId)?.path
				});
			}
			session.stopHookContinuationCount = 0;
			const promptHookDecision = await runUserPromptSubmitHooks(
				session,
				request.id,
				params.message,
				(event): void => {
					if (event.statusMessage !== undefined) {
						sendSessionEvent(socket, request.id, session, "agent.status", {
							status: "hook",
							message: event.statusMessage
						});
					}
					if (event.systemMessage !== undefined) {
						sendSessionEvent(socket, request.id, session, "agent.status", {
							status: "warning",
							message: event.systemMessage
						});
					}
				}
			);
			if (promptHookDecision.blocked) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "hook_user_prompt_blocked",
						message: promptHookDecision.reason ?? "A UserPromptSubmit hook blocked this message."
					}
				});
				break;
			}
			if (session.sessionId !== undefined) {
				await promoteTemporarySession(session.sessionId);
			}
			const queueItemId: number | undefined = getQueueItemIdFromParams(params);
			if (params.retryFromRequestId !== undefined && session.sessionId !== undefined) {
				const retryTargetExists: boolean = session.messages.some((message: ChatMessage): boolean => (
					message.requestId === params.retryFromRequestId
				));
				if (retryTargetExists) {
					discardSessionGoalRuntimesForRewind(session.sessionId);
				}
				await waitForSessionEventPersistence(session);
				const rewoundMessages: StoredMessage[] = await rewindSessionFromRequest(session.sessionId, params.retryFromRequestId);
				session.messages = rewoundMessages.map(toChatMessage);
				session.fullSessionLoadPromise = undefined;
				session.summaryMessage = undefined;
				session.summaryCoveredMessageCount = undefined;
				session.contextLedger = undefined;
				await clearContextLedger(session.sessionId);
				await deleteSummary(session.sessionId);
			}
			const hadPriorUserTurn: boolean = hasSessionUserTurn(session.messages);
			const modelSnapshotChange: ChatModelSnapshotChange | null = applyChatRequestModelSnapshot(session, params);
			if (modelSnapshotChange !== null && session.sessionId !== undefined) {
				await updateSessionMetadata(session.sessionId, createRuntimeSessionUiMetadata(session));
				if (hadPriorUserTurn && modelSnapshotChange.modelTransition !== undefined) {
					await recordPendingSessionModelTransition(
						session.sessionId,
						modelSnapshotChange.modelTransition.from,
						modelSnapshotChange.modelTransition.to,
					);
				}
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
					if (session.sessionId !== undefined) {
						await clearSessionForkDraft(session.sessionId);
					}
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
			cancelPendingNextStepHintGeneration(session);
			const nextStepHintGeneration: number = clearWorkbenchNextStepHints(session, request.id);
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
				let effectiveParams: AiChatParams = {
					...imagePreprocess.params,
					systemPrompt: imagePreprocess.params.systemPrompt ?? (storedUserPrompt.length > 0 ? storedUserPrompt : undefined)
				};
				if (goalBinding !== undefined) {
					effectiveParams = normalizeGoalAgentLoopParams(effectiveParams);
				}
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
							intent: "inspect",
							scope: "bounded",
							lane: "read"
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
					await emitPendingModelChangeDivider(socket, request.id, session);
					clearWorkbenchComposer(session, true);
					if (session.sessionId !== undefined) {
						await clearSessionForkDraft(session.sessionId);
					}
					emitWorkbenchUpdated(socket, request.id, session);
					sendJson(socket, {
						type: "response",
						id: request.id,
						ok: true,
						result: createPlanGetResult(plan)
					});
					break;
				}
				const skillWorkspace: SkillWorkspace = session.activeWorkspace !== undefined
					? createSkillWorkspace(session.activeWorkspace)
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
				const budgetContextControl = session.sessionId === undefined ? undefined : createSessionContextControl({
					session,
					apiKey,
					requestId: request.id,
					abortSignal: abortController.signal
				});
				const budgetToolCatalog = createWorkspaceToolCatalog({
					workspaceId: session.activeWorkspace?.id,
					hasGodotWorkspaceCapability: hasGodotWorkspaceCapability(session.activeWorkspace),
					editorInstanceId: session.editorInstanceId,
					sessionId: session.sessionId,
					contextControl: budgetContextControl,
					contextControlAvailable: effectiveParams.mode === "agent" || effectiveParams.mode === "goal",
					todoControl: (
						(effectiveParams.mode === "agent" || effectiveParams.mode === "goal")
						&& effectiveParams.options?.executionPolicy !== "read_only"
						&& session.activeWorkspace !== undefined
					)
						? createAgentTodoControl({ socket, session, runId: request.id })
						: undefined,
					todoControlAvailable: (
						(effectiveParams.mode === "agent" || effectiveParams.mode === "goal")
						&& effectiveParams.options?.executionPolicy !== "read_only"
						&& session.activeWorkspace !== undefined
					),
					summaryPreparation: (
						(effectiveParams.mode === "agent" || effectiveParams.mode === "goal")
						&& effectiveParams.options?.executionPolicy !== "read_only"
					)
						? createSummaryPreparationControl({ socket, session, runId: request.id })
						: undefined,
					summaryPreparationAvailable: (
						(effectiveParams.mode === "agent" || effectiveParams.mode === "goal")
						&& effectiveParams.options?.executionPolicy !== "read_only"
					)
				});
				const budgetToolDefinitions = allowedToolNames === undefined
					? budgetToolCatalog.getDefinitions()
					: budgetToolCatalog.getDefinitionsForNames(allowedToolNames);
				const budgetToolDefinitionsSection: string = JSON.stringify(budgetToolDefinitions);
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
				const hookDeveloperContext: string = consumeHookDeveloperContext(session);
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
				const contextBudgetPrompt: string = skillPrompt
					+ skillCatalogPrompt
					+ mcpSystemContext
					+ additionalContextSection
					+ guidePromptSection
					+ budgetToolDefinitionsSection;
				let fullSystemPrompt: string = systemPrompt
					+ (skillPrompt.length > 0 ? `\n\n${skillPrompt}` : "")
					+ (skillCatalogPrompt.length > 0 ? `\n\n${skillCatalogPrompt}` : "")
					+ mcpSystemContext
					+ (additionalContextSection.length > 0 ? `\n\n${additionalContextSection}` : "")
					+ (guidePromptSection.length > 0 ? `\n\n${guidePromptSection}` : "")
					+ (hookDeveloperContext.length > 0 ? `\n\n## Hook context\n${hookDeveloperContext}` : "")
					+ (safeRetryPromptSection.length > 0 ? `\n\n${safeRetryPromptSection}` : "");
				if (effectiveParams.retryOfRunId === undefined) {
					const userMessageAppended: boolean = await appendUserMessageToSession(
						session,
						effectiveParams.message,
						request.id,
						turnStartedAt,
						effectiveParams.additionalContext
					);
					if (userMessageAppended) {
						await emitPendingModelChangeDivider(socket, request.id, session);
					}
				}
				let contextUsageEstimate: ContextUsageEstimate | undefined;
				if ((goalBinding?.cycle ?? 1) <= 1) {
					contextUsageEstimate = await maybeAutoCompressContextBeforeRun(
						socket,
						request.id,
						session,
						apiKey,
						options,
						effectiveParams,
						systemPrompt,
						contextBudgetPrompt,
						abortController.signal
					);
				}
				if (
					contextUsageEstimate?.budget.shouldNudge === true
					&& (effectiveParams.mode === "agent" || effectiveParams.mode === "goal")
				) {
					fullSystemPrompt += [
						"",
						"## Context budget",
						`The committed context is ${contextUsageEstimate.budget.committedPercent.toFixed(1)}% of the model window.`,
						"Context status, compression, search, and bounded retrieval tools are available. Use them only when they help preserve relevant evidence; do not compress the current request or pending work."
					].join("\n");
				}
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
				const historyBudgetTokens: number = await computeHistoryBudget(
					session.modelProfile,
					options,
					effectiveParams,
					systemPrompt,
					contextBudgetPrompt,
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
					outputTarget: routeDecision.outputTarget,
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
							lane: routeDecision.lane,
							agentLoopState: routeDecision.lane === "agent_loop" ? createAgentLoopState() : undefined,
							todo: null,
							planId: null
						}
					);
				}

				const hiddenAnswerToolNames: readonly string[] = resolveHiddenAnswerToolNames(routeDecision, effectiveParams, allowedToolNames, session);
				const mutationToolNames: readonly string[] = allowedToolNames ?? getAllRuntimeToolNames(session);
				const hiddenAnswerApprovalGateway: ApprovalGateway = (
					routeDecision.lane !== "lightweight"
					&& routeDecision.lane !== "tool_assisted"
					&& !(routeDecision.lane === "agent_loop" && routeDecision.outputTarget === "workspace")
				)
					? new ReadOnlyToolApprovalGateway(session.approvalGateway, hiddenAnswerToolNames, {
					delegatedToolNames: routeDecision.lane === "probe" && getExecutionPolicy(effectiveParams) === "auto"
							? ["mcp_terminal_run_command"]
							: []
					})
					: session.approvalGateway;
				{
					if (routeDecision.lane === "workflow") {
						throw new LegacyWorkflowRemovedError(
							"The legacy phase-based workflow was requested. Start a new Agent Loop run instead."
						);
					}
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
				if (session.sessionId !== undefined) {
					await clearSessionForkDraft(session.sessionId);
				}
				emitWorkbenchUpdated(socket, request.id, session);
				if (
					shouldScheduleNextStepHints(params, goalBinding)
					&& returnedRun?.stage === "completed"
					&& returnedRun.terminal?.resultStatus !== "cancelled"
				) {
					maybeScheduleNextStepHints({
						socket,
						requestId: request.id,
						session,
						options,
						generation: nextStepHintGeneration
					});
				}
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
				if (error instanceof LegacyWorkflowRemovedError) {
					queuedRunForcedStatus = "failed";
					logger.warn("ai", "legacy_workflow_removed", {
						requestId: request.id,
						sessionId: runSessionId,
						workspaceId: session.activeWorkspace?.id
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
				const interruptedProviderError: ProviderErrorInfo | null = getProviderResponseInterruption(error);
				if (interruptedProviderError !== null && await pauseProviderResponseInterruptedRun({
					socket,
					requestId: request.id,
					session,
					providerError: interruptedProviderError,
					userMessage: persistedParams.message,
					userCreatedAt: turnStartedAt,
					additionalContext: persistedParams.additionalContext
				})) {
					logger.warn("ai", "provider_response_interrupted", {
						requestId: request.id,
						sessionId: runSessionId,
						workspaceId: session.activeWorkspace?.id,
						durationMs: Date.now() - runStartedAtMs
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
			cancelPendingNextStepHintGeneration(session);
			session.activeAbortControllers.set(request.id, abortController);
			try {
				const baseOptions: ProviderChatOptions = withProviderUsageContext(createProviderChatOptions(session, apiKey), {
					requestId: request.id,
					runId: request.id,
					sessionId: session.sessionId,
					workspaceId: session.activeWorkspace?.id,
					operation: "next_step_hints"
				});
				const hints: NextStepHint[] = await createNextStepHints(
					session,
					await resolveNextStepHintOptions(baseOptions),
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
