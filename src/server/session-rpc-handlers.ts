import WebSocket from "ws";
import { composeSystemPrompt, listPromptTemplates } from "../prompts/registry.js";
import type { AdditionalContextItem, AiChatParams, ChatMessage, ClientRequest, ModelProfile, ProviderId, ServerEvent } from "../protocol/types.js";
import type { OnToolEvent, ToolEvent } from "../tools/tool-dispatcher.js";
import { parseToolResultSummary } from "../tools/tool-result-parser.js";
import { chatWithDeepSeek, createDeepSeekClient, resolveChatModel, type ProviderChatOptions } from "../providers/deepseek-client.js";
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
import { composeSkillPrompt, getSkill, isSkillId, listSkills } from "../skills/registry.js";
import type { SkillId } from "../skills/registry.js";
import { legacySkillIdToRef } from "../skills/catalog.js";
import {
	createRuntimeWorkspace,
	findWorkspace,
	upsertRuntimeWorkspace
} from "../workspace/registry.js";
import type { WorkspaceConfig } from "../workspace/types.js";
import { hasGodotWorkspaceCapability } from "../workspace/capabilities.js";
import {
	createSession, openSession, listSessions,
	archiveSession, deleteArchivedSession, deleteSession, listArchivedSessions, renameSession, restoreArchivedSession,
	rewindSessionFromRequest,
	readSummary, writeSummary, deleteSummary,
	appendSessionEvent, appendApprovalEvent, appendWorkflowEvent, appendAgentEvent, clearSessionEvents, readApprovalEvents,
	checkSessionIntegrity,
	updateSessionMetadata,
	getSessionTimelineNavigationIndex, openSessionRecentTimeline, openSessionTimelinePage, openSessionTimelinePageAfter,
	type SessionChatMode,
	type SessionMetadata,
	type SessionSummary,
	type StoredMessage,
	type StoredSessionEvent,
	type StoredSessionTimelinePage
} from "../session/session-store.js";
import { listSelectionAskThreads } from "../session/selection-ask-store.js";
import { exportSessionToSqlite } from "../session/session-export.js";
import { importSessionFromSqlite } from "../session/session-import.js";
import {
	clearProviderConfig,
	getProviderConfigStatus,
	getProviderModelsCache,
	loadProviderConfigWithSecret,
	saveProviderConfig,
	type ProviderConfigWithSecret
} from "../providers/provider-config-store.js";
import { listProviderModels } from "../providers/provider-models.js";
import { estimateProviderMessagesTokens, estimateProviderTextTokens } from "../providers/provider-token-estimator.js";
import {
	createCurrentUserMessage,
	getImageAttachments,
	hasImageAttachments,
	modelSupportsImageInput,
	ProviderImageInputError
} from "../providers/provider-image-content.js";
import {
	getProviderAdapterFamily,
	getProviderDefaultBaseUrl,
	getProviderDefaultModel,
	getProviderDisplayName,
	getProviderEndpointTypeForModel,
	isProviderId,
	mergeProviderModelsWithCatalog,
	type ProviderModelInfo
} from "../providers/provider-registry.js";
import { resolveReasoningEffortForModelChange } from "../providers/reasoning-effort.js";
import { classifyProviderError, createProviderStatusEvent } from "../providers/provider-error.js";
import { generateSessionTitle, shouldApplyGeneratedSessionTitle } from "./session-title.js";
import {
	applySessionMetadata,
	applyWorkspaceToSession,
	clearActiveSession,
	createClientSession,
	type ClientSession,
	type PendingAiContinuation,
	type PendingGuide,
	type ThinkingEventBuffer
} from "./client-session.js";
import { getToolPolicy } from "../tools/tool-policy.js";
import type { PendingApproval } from "../tools/approval-gateway.js";
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
import { hydrateMessageQueue, serializeMessageQueue } from "./message-queue.js";
import { bumpWorkbenchRevision, clearWorkbenchNextStepHints, emitWorkbenchUpdated, serializeWorkbench } from "./workbench.js";
import { createRuntimeSessionUiMetadata } from "./session-ui-metadata.js";
import { compressSessionHistory, hydrateSessionContextLedger } from "./session-compression.js";
import { createContextBudgetSnapshot } from "../context/context-budget-manager.js";
import type { ContextBudgetSnapshot } from "../context/context-types.js";
import { clearContextLedger } from "../context/context-ledger.js";
import { CONTEXT_CONTROL_TOOL_DEFINITIONS } from "../tools/context-control.js";
import { createSessionOverview } from "./session-overview.js";

import { normalizeChatParamsForMode, resolveAllowedToolsForChatParams } from "./chat-mode.js";
import { logPromptTrace, logProjectInstructionTrace } from "./prompt-trace.js";
import { isCancellationError, sendAgentCancelled, beginRequestExecution, finishRequestExecution, parseMessage } from "./request-lifecycle.js";
import { estimateTextTokens, estimateMessagesTokens, computeHistoryBudget, appendChatTurnToSession, selectHistoryForModel, createSummaryMessage, loadSessionCompressorPrompt, filterLlmContextMessages, getTokenCounter } from "./token-budget.js";
import { getSessionProjectPath, toChatMessage, clampSessionOpenMessageLimit, createPreviewValue, createTimelinePageResult, startFullSessionLoad, waitForFullSessionLoad } from "./session-preview.js";
import { createProviderChatOptions } from "./provider-chat-options.js";
import { hydrateImageAttachmentContexts } from "../session/session-attachments.js";
import { getUserPrompt } from "../user-prompt-store.js";
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
	loadHydratedPendingApprovalStates,
	createMemoryPendingApprovalStates,
	findPendingApprovalState,
	restorePendingContinuationForApproval,
	validatePendingApprovalBeforeExecution,
	createApprovedWorkflowToolObservation,
	sendContinuedAgentResult
} from "./approval-continuation.js";
import { createAgentToolEventForwarder, createEmptyWorkflowPhaseToolStats, updateWorkflowPhaseToolStats, shouldRequireWorkflowWriteTool, didWorkflowWritePhaseExecute, createWorkflowWriteGuardRetryMessage } from "./workflow/tool-events.js";
import { ensureProviderConfigured } from "../application/provider-session-service.js";
import {
	hydrateAgentRunRuntime,
	serializeAgentRunRuntime
} from "./agent-run-recovery.js";
import { getLatestAgentGoal } from "./goal-controller.js";
import { bindConnectionToSessionRuntime, getClientConnection, getSessionRuntime, getSessionSubscriberInfos, subscribeSocketToSession, unsubscribeSocketFromSession, updateClientConnection } from "./client-connections.js";
import { createSessionBrowserSnapshot } from "./session-browser-snapshot.js";
import { logger } from "../logger.js";
import { resolveSessionCreateWorkspaceId } from "./session-create-workspace.js";
import { synchronizeSessionApprovalMode } from "./approval-mode-sync.js";
import { createGlobalSkillWorkspace, composeSkillCatalogPrompt } from "../skills/runtime.js";
import type { SkillWorkspace } from "../skills/types.js";
import { createWorkspaceToolCatalog, filterToolNamesForWorkspace } from "../tools/tool-catalog.js";
import { SessionSearchError, sessionSearchService } from "../session-search/service.js";

function sessionRpcError(
	error: unknown,
	fallbackCode: string,
	fallbackMessage: string
): { code: string; message: string } {
	const candidate = error as Error & { code?: string };
	if (candidate.code === "session_storage_unavailable" || candidate.code === "session_not_found") {
		return {
			code: candidate.code,
			message: candidate.message
		};
	}
	return {
		code: fallbackCode,
		message: error instanceof Error ? error.message : fallbackMessage
	};
}

function restoreWorkspaceFromSessionMetadata(metadata: SessionMetadata): WorkspaceConfig | undefined {
	if (metadata.workspaceId === undefined || metadata.workspaceRoot === undefined) {
		return undefined;
	}

	const fallbackName: string = path.basename(metadata.workspaceRoot) || metadata.workspaceRoot;
	return upsertRuntimeWorkspace({
		...createRuntimeWorkspace(metadata.workspaceRoot, metadata.godotExecutablePath),
		id: metadata.workspaceId,
		name: metadata.workspaceName ?? fallbackName,
		kind: metadata.workspaceKind ?? "godot"
	});
}

function applyWorkspaceToSessionRuntime(socket: WebSocket, session: ClientSession, workspace: WorkspaceConfig | undefined): void {
	applyWorkspaceToSession(session, workspace);
	if (workspace === undefined) {
		updateClientConnection(socket, {
			workspaceId: null,
			workspaceRoot: null
		});
		return;
	}

	updateClientConnection(socket, {
		workspaceId: workspace.id,
		workspaceRoot: workspace.rootPath
	});
}

function createSessionUiMetadata(params: {
	provider?: ProviderId | undefined;
	model?: string | undefined;
	reasoningEffort?: string | undefined;
	chatMode?: SessionChatMode | undefined;
	approvalMode?: "manual" | "auto-safe" | "full-trust" | undefined;
	workflowTodoCollapsed?: boolean | undefined;
	temporary?: boolean | undefined;
} | undefined): Partial<SessionMetadata> {
	if (params === undefined) {
		return {};
	}

	const metadata: Partial<SessionMetadata> = {};
	if (params.provider !== undefined && isProviderId(params.provider)) {
		metadata.provider = params.provider;
	}
	if (params.model !== undefined) {
		metadata.model = params.model;
	}
	if (params.reasoningEffort !== undefined) {
		metadata.reasoningEffort = params.reasoningEffort;
	}
	if (params.chatMode !== undefined) {
		metadata.chatMode = params.chatMode;
	}
	if (params.approvalMode !== undefined) {
		metadata.approvalMode = params.approvalMode;
	}
	if (params.workflowTodoCollapsed !== undefined) {
		metadata.workflowTodoCollapsed = params.workflowTodoCollapsed;
	}
	if (params.temporary === true) {
		metadata.temporary = true;
	}

	return metadata;
}

async function applySessionApprovalMode(session: ClientSession, _metadata?: Pick<SessionMetadata, "approvalMode"> | undefined): Promise<void> {
	await synchronizeSessionApprovalMode(session);
}

type ContextEstimateSource = "provider" | "local";

type TokenEstimatePart = {
	tokens: number;
	source: ContextEstimateSource;
};

type ContextEstimateParams = {
	message?: string | undefined;
	mode?: "agent" | "ask" | "plan" | "goal" | undefined;
	provider?: ProviderId | undefined;
	model?: string | undefined;
	additionalContext?: AdditionalContextItem[] | undefined;
};

function createProviderRuntimeContextText(provider: ProviderId, model: string): string {
	const providerName: string = getProviderDisplayName(provider);
	return [
		`当前后端实际模型供应商：${providerName}（provider id: ${provider}）。`,
		`当前后端实际模型 ID：${model}。`,
		"如果用户询问“你是什么模型”“来自哪个供应商”“当前用的模型/供应商是什么”，必须优先基于以上运行时事实回答。",
		"回答时可以说明你在产品角色上是 Daedalus Assistant；Godot 是产品强项，但不要用产品角色替代实际模型和供应商信息。"
	].join("\n");
}

async function createContextEstimateProviderOptions(session: ClientSession, provider: ProviderId, model: string): Promise<ProviderChatOptions | null> {
	const config: ProviderConfigWithSecret | null = await loadProviderConfigWithSecret(provider);
	const apiKey: string | undefined = provider === session.activeProvider
		? session.providerApiKey ?? config?.apiKey
		: config?.apiKey;
	if (apiKey === undefined) {
		return null;
	}

	const endpointType = getProviderEndpointTypeForModel(provider, model);
	return {
		provider,
		apiKey,
		model,
		baseUrl: provider === session.activeProvider ? session.providerBaseUrl ?? config?.baseUrl : config?.baseUrl,
		endpointType,
		adapterFamily: getProviderAdapterFamily(provider, endpointType),
		modelProfile: resolveModelProfile(provider, model)
	};
}

async function estimateTextPart(options: ProviderChatOptions | null, text: string): Promise<TokenEstimatePart> {
	if (text.trim().length === 0) {
		return { tokens: 0, source: "local" };
	}
	if (options !== null) {
		try {
			const providerTokens: number | null = await estimateProviderTextTokens(options, text);
			if (providerTokens !== null) {
				return { tokens: providerTokens, source: "provider" };
			}
		} catch {
			// UI 估算不能因为供应商 token estimator 不可用而失败。
		}
	}
	return { tokens: await estimateTextTokens(text), source: "local" };
}

async function estimateCurrentMessagePart(options: ProviderChatOptions | null, params: AiChatParams): Promise<TokenEstimatePart> {
	if (options !== null && hasImageAttachments(params)) {
		try {
			const providerTokens: number | null = await estimateProviderMessagesTokens(options, [createCurrentUserMessage(params)]);
			if (providerTokens !== null) {
				return { tokens: providerTokens, source: "provider" };
			}
		} catch {
			// 继续走本地近似估算。
		}
	}

	const textPart: TokenEstimatePart = await estimateTextPart(options, params.message);
	let imageTokens: number = 0;
	try {
		imageTokens = getImageAttachments(params.additionalContext)
			.reduce((sum: number, image): number => sum + Math.ceil(image.byteSize / 384), 0);
	} catch {
		imageTokens = 0;
	}
	return {
		tokens: textPart.tokens + imageTokens,
		source: textPart.source
	};
}

function createCompressReason(session: ClientSession, activeSession: boolean, messageCount: number, hasCompressionKey: boolean): string | null {
	if (!activeSession) {
		return "No active session";
	}
	if (session.activeRunRequestId !== undefined) {
		return "A run is active";
	}
	if (!hasCompressionKey) {
		return `${getProviderDisplayName(session.activeProvider)} API key not configured`;
	}
	if (messageCount <= 8) {
		return "Not enough messages";
	}
	return null;
}

export async function createContextEstimateResult(session: ClientSession, mcpHost: McpHost, params: ContextEstimateParams | undefined): Promise<Record<string, unknown>> {
	const activeSession: boolean = session.sessionId !== undefined;
	if (activeSession) {
		await waitForFullSessionLoad(session);
	}

	const provider: ProviderId = params?.provider !== undefined && isProviderId(params.provider)
		? params.provider
		: session.activeProvider;
	const model: string = params?.model?.trim() || (provider === session.activeProvider
		? session.providerModel ?? session.modelProfile.model
		: getProviderDefaultModel(provider));
	const profile: ModelProfile = resolveModelProfile(provider, model);
	const providerOptions: ProviderChatOptions | null = await createContextEstimateProviderOptions(session, provider, model);
	const message: string = params?.message ?? session.workbenchComposer.text;
	const mode: "agent" | "ask" | "plan" | "goal" = params?.mode ?? session.workbenchComposer.chatMode ?? "agent";
	const additionalContext: AdditionalContextItem[] = cloneAdditionalContextItems(params?.additionalContext ?? session.workbenchComposer.additionalContext) ?? [];
	const rawChatParams: AiChatParams = { message, mode, additionalContext };
	const chatParams: AiChatParams = activeSession
		? await hydrateImageAttachmentContexts(session.sessionId, rawChatParams)
		: rawChatParams;
	const storedUserPrompt: string = await getUserPrompt();
	const baseSystemPrompt: string = await composeSystemPrompt(
		undefined,
		undefined,
		createProviderRuntimeContextText(provider, model),
		mode
	);
	const systemPrompt: string = await composeSystemPrompt(
		undefined,
		storedUserPrompt.length > 0 ? storedUserPrompt : undefined,
		createProviderRuntimeContextText(provider, model),
		mode
	);
	const additionalContextSection: string = createAdditionalContextPromptSection(chatParams.additionalContext);
	const baseSystemPart = await estimateTextPart(providerOptions, baseSystemPrompt);
	const fullSystemPart = await estimateTextPart(providerOptions, systemPrompt);
	const customInstructionsTokens = Math.max(0, fullSystemPart.tokens - baseSystemPart.tokens);
	const additionalContextPart = await estimateTextPart(providerOptions, additionalContextSection);
	const skillWorkspace: SkillWorkspace = session.activeWorkspace === undefined
		? createGlobalSkillWorkspace()
		: { id: session.activeWorkspace.id, rootPath: session.activeWorkspace.rootPath };
	const skillsPrompt = await composeSkillCatalogPrompt(skillWorkspace);
	const skillsPart = await estimateTextPart(providerOptions, skillsPrompt);
	let mcpContext: string = "";
	try {
		mcpContext = await createMcpSystemContext(mcpHost, session);
	} catch {
		// Context diagnostics should remain available while an optional MCP runtime is unavailable.
		mcpContext = "";
	}
	const mcpContextPart = await estimateTextPart(providerOptions, mcpContext);
	const allowedToolNames = resolveAllowedToolsForChatParams(chatParams, undefined, session.activeWorkspace?.id);
	const toolCatalog = createWorkspaceToolCatalog({
		workspaceId: session.activeWorkspace?.id,
		hasGodotWorkspaceCapability: hasGodotWorkspaceCapability(session.activeWorkspace),
		sessionId: session.sessionId
	});
	const baseToolDefinitions = allowedToolNames === undefined
		? toolCatalog.getDefinitions()
		: toolCatalog.getDefinitionsForNames(filterToolNamesForWorkspace(allowedToolNames, session.activeWorkspace?.id));
	const toolDefinitions = mode === "agent" || mode === "goal"
		? [...baseToolDefinitions, ...CONTEXT_CONTROL_TOOL_DEFINITIONS]
		: baseToolDefinitions;
	const toolDefinitionsPart = await estimateTextPart(providerOptions, JSON.stringify(toolDefinitions));
	const systemAndContextPart: TokenEstimatePart = {
		tokens: baseSystemPart.tokens + customInstructionsTokens + skillsPart.tokens + mcpContextPart.tokens + toolDefinitionsPart.tokens + additionalContextPart.tokens,
		source: fullSystemPart.source === "provider" || mcpContextPart.source === "provider" ? "provider" : "local"
	};
	const currentMessagePart: TokenEstimatePart = await estimateCurrentMessagePart(providerOptions, chatParams);
	const outputReserveTokens: number = profile.defaultOutputReserveTokens;
	const historyBudgetTokens: number = await computeInputBudget({
		profile,
		outputReserveTokens,
		systemPromptTokens: baseSystemPart.tokens + customInstructionsTokens + skillsPart.tokens + additionalContextPart.tokens,
		mcpContextTokens: mcpContextPart.tokens,
		toolDefinitionsTokens: toolDefinitionsPart.tokens,
		currentMessageTokens: currentMessagePart.tokens,
		tokenCounter: await getTokenCounter()
	});
	const historyMessages: ChatMessage[] = activeSession ? await selectHistoryForModel(session, historyBudgetTokens) : [];
	const summaryMessages = historyMessages.filter((item: ChatMessage): boolean => item === session.summaryMessage);
	const ordinaryHistoryMessages = historyMessages.filter((item: ChatMessage): boolean => item !== session.summaryMessage);
	const summaryTokens = await estimateMessagesTokens(summaryMessages);
	const historyTokens: number = await estimateMessagesTokens(ordinaryHistoryMessages);
	const inputTokens: number = Math.max(
		0,
		systemAndContextPart.tokens
		+ currentMessagePart.tokens
		+ historyTokens
		+ summaryTokens
	);
	const contextWindowTokens: number = profile.contextWindowTokens;
	const budget: ContextBudgetSnapshot = createContextBudgetSnapshot({
		inputTokens,
		outputReserveTokens,
		safetyMarginTokens: profile.safetyMarginTokens,
		contextWindowTokens
	});
	const usedTokens: number = budget.committedTokens;
	const availableTokens: number = budget.availableTokens;
	const percent: number = budget.committedPercent;
	const compressionConfig: ProviderConfigWithSecret | null = activeSession ? await loadProviderConfigWithSecret(session.activeProvider) : null;
	const hasCompressionKey: boolean = session.providerApiKey !== undefined || compressionConfig?.apiKey !== undefined;
	const compressReason: string | null = createCompressReason(session, activeSession, session.messages.length, hasCompressionKey);
	const breakdownSource = [
		["base_system", baseSystemPart.tokens],
		["custom_instructions", customInstructionsTokens],
		["skills", skillsPart.tokens],
		["mcp_context", mcpContextPart.tokens],
		["tool_definitions", toolDefinitionsPart.tokens],
		["history", historyTokens],
		["summary", summaryTokens],
		["current_message", currentMessagePart.tokens],
		["additional_context", additionalContextPart.tokens],
		["output_reserve", outputReserveTokens],
		["safety_margin", profile.safetyMarginTokens]
	] as const;
	const breakdown = breakdownSource.map(([kind, tokens]) => ({
		kind,
		tokens,
		percent: usedTokens > 0 ? Math.round((tokens / usedTokens) * 1000) / 10 : 0
	}));

	return {
		usedTokens,
		inputTokens: budget.inputTokens,
		inputPercent: budget.inputPercent,
		committedTokens: budget.committedTokens,
		committedPercent: budget.committedPercent,
		outputReservePercent: budget.outputReservePercent,
		safetyMarginPercent: budget.safetyMarginPercent,
		availablePercent: budget.availablePercent,
		contextWindowTokens,
		percent,
		availableTokens,
		historyTokens,
		summaryTokens,
		currentMessageTokens: currentMessagePart.tokens,
		systemAndContextTokens: systemAndContextPart.tokens,
		outputReserveTokens,
		safetyMarginTokens: profile.safetyMarginTokens,
		breakdown,
		pressure: budget.pressure,
		largestContributor: [...breakdown].sort((left, right): number => right.tokens - left.tokens)[0] ?? null,
		modelLabel: `${getProviderDisplayName(provider)} / ${model}`,
		estimationSource: systemAndContextPart.source === "provider" || currentMessagePart.source === "provider" ? "provider" : "local",
		canCompress: compressReason === null,
		compressReason,
		summaryActive: session.summaryMessage !== undefined,
		contextGeneration: session.contextLedger?.generation ?? 0,
		contextCompressionLevel: session.contextLedger?.activeSummaries.at(-1)?.level ?? null,
		restorableBlockCount: session.contextLedger?.activeSummaries.reduce(
			(total: number, block): number => total + block.coveredBlockIds.length,
			0
		) ?? 0
	};
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
		...serializeAgentRunRuntime(session),
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

export async function handleSessionRequest(socket: WebSocket, request: ClientRequest, session: ClientSession, mcpHost: McpHost): Promise<void> {
	switch (request.method) {
		case "session.reset":
			session.messages = [];
			session.fullSessionLoadPromise = undefined;
			session.summaryMessage = undefined;
			session.summaryCoveredMessageCount = undefined;
			session.contextLedger = undefined;
			session.pendingGuides = [];
			session.queuedMessages = [];
			session.messageQueueNextId = 0;
			session.workbenchComposer = {
				text: "",
				additionalContext: [],
				updatedAt: new Date().toISOString()
			};
			session.workbenchActiveRun = { status: "idle" };
			session.nextStepHintAbortController?.abort();
			session.nextStepHintAbortController = undefined;
			clearWorkbenchNextStepHints(session, undefined, false);
			bumpWorkbenchRevision(session);
			if (session.sessionId) {
				await clearContextLedger(session.sessionId);
				await deleteSummary(session.sessionId);
				await clearSessionEvents(session.sessionId);
			}
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					reset: true,
					historyMessagesStored: session.messages.length,
					messageQueue: serializeMessageQueue(session),
					workbench: serializeWorkbench(session)
				}
			});
			break;

		case "session.info":
			await waitForFullSessionLoad(session);
			{
				const apiKey: string | undefined = await ensureProviderConfigured(session);
				await loadHydratedPendingApprovalStates(session, apiKey);
			}
			if (session.sessionId === undefined) {
				await applySessionApprovalMode(session);
			}
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: createSessionInfoResult(session, mcpHost, await estimateMessagesTokens(session.messages))
			});
			break;

		case "session.create": {
			const requestedWorkspaceId: string | null | undefined = request.params.workspaceId;
			const clientConnection = getClientConnection(socket);
			const shouldUseConnectionWorkspace: boolean = clientConnection?.clientType === "godot_plugin";
			let workspaceId: string | undefined = resolveSessionCreateWorkspaceId({
				requestedWorkspaceId,
				clientType: clientConnection?.clientType,
				activeWorkspaceId: session.activeWorkspace?.id
			});
			if (
				clientConnection?.clientType === "godot_plugin"
				&& session.activeWorkspace !== undefined
				&& requestedWorkspaceId !== undefined
				&& requestedWorkspaceId !== session.activeWorkspace.id
			) {
				logger.warn("session", "godot_workspace_override_ignored", {
					requestedWorkspaceId,
					activeWorkspaceId: session.activeWorkspace.id,
					activeWorkspaceRoot: session.activeWorkspace.rootPath,
					sessionId: session.sessionId
				});
				workspaceId = session.activeWorkspace.id;
			}
			let workspace: WorkspaceConfig | undefined;

			if (workspaceId) {
				workspace = findWorkspace(workspaceId);

				if (!workspace) {
					sendJson(socket, {
						type: "response",
						id: request.id,
						ok: false,
						error: {
							code: "workspace_not_found",
							message: `Workspace not found: ${workspaceId}`
						}
					});
					break;
				}

				try {
					await mcpHost.ensureWorkspace(workspace);
				} catch (error: unknown) {
					sendJson(socket, {
						type: "response",
						id: request.id,
						ok: false,
						error: {
							code: "workspace_switch_failed",
							message: error instanceof Error ? error.message : "Failed to switch MCP workspace"
						}
					});
					break;
				}
			}

			const metadata: SessionMetadata = await createSession(
				request.params.title,
				workspaceId,
				undefined,
				workspace,
				createSessionUiMetadata(request.params)
			);
			session = createClientSession(workspace);
			applySessionMetadata(session, metadata);
			await applySessionApprovalMode(session, metadata);
			session.messages = [];
			session.fullSessionLoadPromise = undefined;
			session.summaryMessage = undefined;
			session.summaryCoveredMessageCount = undefined;
			session.pendingGuides = [];
			session.queuedMessages = [];
			session.messageQueueNextId = 0;
			session.workbenchRevision = 0;
			session.workbenchComposer = {
				text: "",
				chatMode: request.params.chatMode,
				provider: request.params.provider,
				model: request.params.model,
				reasoningEffort: session.workbenchComposer.reasoningEffort,
				additionalContext: [],
				updatedAt: new Date().toISOString()
			};
			session.workbenchActiveRun = { status: "idle" };
			session.nextStepHintAbortController?.abort();
			session.nextStepHintAbortController = undefined;
			clearWorkbenchNextStepHints(session, undefined, false);

			session = bindConnectionToSessionRuntime(socket, metadata.id, session);
			if (workspace !== undefined || requestedWorkspaceId === null || !shouldUseConnectionWorkspace) {
				applyWorkspaceToSessionRuntime(socket, session, workspace);
			}
			subscribeSocketToSession(socket, metadata.id);

			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					...metadata,
					approvalMode: session.approvalGateway.getMode(),
					workbench: serializeWorkbench(session)
				}
			});
			break;
		}

		case "session.open": {
			try {
				const openMessageLimit: number = clampSessionOpenMessageLimit(request.params.limit);
				const timeline = await openSessionRecentTimeline(request.params.sessionId, openMessageLimit);
				const existingRuntime: ClientSession | undefined = getSessionRuntime(request.params.sessionId);
				const reusingRuntime: boolean = existingRuntime !== undefined;
				if (existingRuntime !== undefined) {
					session = bindConnectionToSessionRuntime(socket, request.params.sessionId, existingRuntime);
				}
				let workspace: WorkspaceConfig | undefined;
				let workspaceWarning: string | undefined;

				if (timeline.metadata.workspaceId) {
					workspace = findWorkspace(timeline.metadata.workspaceId)
						?? restoreWorkspaceFromSessionMetadata(timeline.metadata);

					if (!workspace) {
						workspaceWarning = `Session workspace not found: ${timeline.metadata.workspaceId}`;
						logger.warn("session", "workspace_not_found_on_open", {
							sessionId: timeline.metadata.id,
							workspaceId: timeline.metadata.workspaceId
						});
					} else {
						try {
							await mcpHost.ensureWorkspace(workspace);
						} catch (error: unknown) {
							workspaceWarning = error instanceof Error ? error.message : "Failed to switch MCP workspace";
							logger.error("session", "workspace_switch_failed_on_open", error, {
								sessionId: timeline.metadata.id,
								workspaceId: timeline.metadata.workspaceId
							});
							workspace = undefined;
						}
					}
				}

				if (!reusingRuntime) {
					session = createClientSession(workspace);
					applySessionMetadata(session, timeline.metadata);
					await applySessionApprovalMode(session, timeline.metadata);
					session.messages = timeline.messages.map(toChatMessage);
					const storedForGuides: Awaited<ReturnType<typeof openSession>> = await openSession(request.params.sessionId);
					session.pendingGuides = hydratePendingGuides(storedForGuides.events);
					const hydratedQueue = hydrateMessageQueue(storedForGuides.events);
					session.queuedMessages = hydratedQueue.messages;
					session.messageQueueNextId = hydratedQueue.nextId;
					session.workbenchRevision = 0;
					session.workbenchComposer = {
						text: "",
						chatMode: timeline.metadata.chatMode,
						provider: timeline.metadata.provider,
							model: timeline.metadata.model,
							reasoningEffort: session.workbenchComposer.reasoningEffort,
						additionalContext: [],
						updatedAt: new Date().toISOString()
					};
					session.workbenchActiveRun = { status: "idle" };
					session.nextStepHintAbortController?.abort();
					session.nextStepHintAbortController = undefined;
					clearWorkbenchNextStepHints(session, undefined, false);
					startFullSessionLoad(session, timeline.metadata.id);

					const ledgerHydrated: boolean = await hydrateSessionContextLedger(session);
					if (!ledgerHydrated) {
						const summary = await readSummary(request.params.sessionId);
						session.summaryMessage = summary !== null ? createSummaryMessage(summary) : undefined;
						session.summaryCoveredMessageCount = summary?.messageCount;
					}

					session = bindConnectionToSessionRuntime(socket, timeline.metadata.id, session);
				}
				if (timeline.metadata.workspaceId === undefined) {
					applyWorkspaceToSessionRuntime(socket, session, undefined);
				} else {
					applyWorkspaceToSessionRuntime(socket, session, workspace);
				}
				applySessionMetadata(session, timeline.metadata);
				await applySessionApprovalMode(session, timeline.metadata);
				const apiKey: string | undefined = await ensureProviderConfigured(session);
				if (!reusingRuntime) {
					await hydrateAgentRunRuntime(session, apiKey);
					await loadHydratedPendingApprovalStates(session, apiKey);
				}
				subscribeSocketToSession(socket, timeline.metadata.id);
				const godotGoalFallback: boolean = getClientConnection(socket)?.clientType === "godot_plugin"
					&& timeline.metadata.chatMode === "goal";
				const serializedWorkbench = serializeWorkbench(session);
				const clientWorkbench = godotGoalFallback
					? {
						...serializedWorkbench,
						composer: {
							...(serializedWorkbench.composer as Record<string, unknown>),
							chatMode: "agent"
						}
					}
					: serializedWorkbench;

				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: true,
					result: {
						opened: true,
						metadata: {
							...timeline.metadata,
							chatMode: godotGoalFallback ? "agent" : timeline.metadata.chatMode,
							approvalMode: session.approvalGateway.getMode(),
							activeSkillId: undefined,
							legacySkillRefs: timeline.metadata.activeSkillId === undefined
								? []
								: [legacySkillIdToRef(timeline.metadata.activeSkillId)].filter((ref): boolean => ref !== undefined)
						},
						...await createTimelinePageResult(timeline, openMessageLimit),
						pendingGuides: session.pendingGuides.map(serializePendingGuide),
						messageQueue: serializeMessageQueue(session),
						selectionAskThreads: await listSelectionAskThreads(timeline.metadata.id),
						currentGoal: getClientConnection(socket)?.clientType === "godot_plugin"
							? null
							: await getLatestAgentGoal(timeline.metadata.id),
						workbench: clientWorkbench,
						...serializeAgentRunRuntime(session),
						workspaceWarning: workspaceWarning ?? null
					}
				});
			} catch (error: unknown) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: sessionRpcError(error, "session_open_failed", "Failed to open session")
				});
			}
			break;
		}

		case "session.subscribe":
			subscribeSocketToSession(socket, request.params.sessionId);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					subscribed: true,
					sessionId: request.params.sessionId,
					subscribers: getSessionSubscriberInfos(request.params.sessionId)
				}
			});
			break;

		case "session.unsubscribe":
			unsubscribeSocketFromSession(socket, request.params.sessionId);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					unsubscribed: true,
					sessionId: request.params.sessionId,
					subscribers: getSessionSubscriberInfos(request.params.sessionId)
				}
			});
			break;

		case "session.editor.bind": {
			const targetSessionId: string | undefined = request.params.sessionId ?? session.sessionId;
			if (targetSessionId === undefined || targetSessionId !== session.sessionId) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "session_mismatch",
						message: "Editor binding can only be changed for the active session on this connection."
					}
				});
				break;
			}

			session.editorInstanceId = request.params.editorInstanceId;
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					bound: true,
					sessionId: targetSessionId,
					editorInstanceId: session.editorInstanceId
				}
			});
			break;
		}

		case "session.timeline": {
			const sessionId: string | undefined = request.params.sessionId ?? session.sessionId;
			if (sessionId === undefined) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "no_session", message: "No active session" }
				});
				break;
			}

			try {
				const limit: number = clampSessionOpenMessageLimit(request.params.limit);
				const timeline = request.params.afterOffset !== undefined
					? await openSessionTimelinePageAfter(sessionId, request.params.afterOffset, limit)
					: request.params.beforeOffset === undefined
						? await openSessionRecentTimeline(sessionId, limit)
						: await openSessionTimelinePage(sessionId, request.params.beforeOffset, limit);
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: true,
					result: {
						timeline: true,
						sessionId,
						...await createTimelinePageResult(timeline, limit)
					}
				});
			} catch (error: unknown) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: sessionRpcError(error, "session_timeline_error", "Failed to load session timeline")
				});
			}
			break;
		}

		case "session.timeline.search.index":
		case "session.timeline.search.start":
		case "session.timeline.search.page":
		case "session.timeline.search.cancel": {
			if (getClientConnection(socket)?.clientType !== "studio") {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "studio_only",
						message: `${request.method} is only available to Daedalus Studio.`
					}
				});
				break;
			}
			try {
				const connectionId: string = getClientConnection(socket)!.connectionId;
				if (request.method === "session.timeline.search.cancel") {
					sendJson(socket, {
						type: "response",
						id: request.id,
						ok: true,
						result: { cancelled: sessionSearchService.cancel(connectionId, request.params.searchId) }
					});
					break;
				}
				const page = request.method === "session.timeline.search.start"
					? await sessionSearchService.start(connectionId, request.params.sessionId)
					: request.method === "session.timeline.search.page"
						? await sessionSearchService.page(
							connectionId,
							request.params.searchId,
							request.params.afterOffset ?? 0,
							request.params.limit ?? 400
						)
						: await sessionSearchService.compatibilityPage(
							connectionId,
							request.params.sessionId,
							request.params.afterOffset ?? 0,
							request.params.limit ?? 120
						);
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: true,
					result: {
						timelineSearchIndex: true,
						...page
					}
				});
			} catch (error: unknown) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: error instanceof SessionSearchError
						? { code: error.code, message: error.message }
						: sessionRpcError(error, "session_timeline_search_index_error", "Failed to load session search index")
				});
			}
			break;
		}

		case "session.integrity.check": {
			try {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: true,
					result: await checkSessionIntegrity(request.params.sessionId)
				});
			} catch (error: unknown) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: sessionRpcError(error, "session_integrity_check_failed", "Failed to check session integrity")
				});
			}
			break;
		}

		case "session.list":
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: await createSessionBrowserSnapshot(session, mcpHost)
			});
			break;

		case "session.browser.snapshot":
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: await createSessionBrowserSnapshot(session, mcpHost)
			});
			break;

		case "session.archive": {
			if (session.sessionId === request.params.sessionId) {
				await waitForFullSessionLoad(session);
				await waitForSessionEventPersistence(session);
			}

			const metadata: SessionMetadata = await archiveSession(request.params.sessionId);
			if (session.sessionId === request.params.sessionId) {
				clearActiveSession(session);
			}
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: { archived: true, metadata }
			});
			break;
		}

		case "session.archived.list":
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: { archivedSessions: await listArchivedSessions() }
			});
			break;

		case "session.archived.restore": {
			const metadata: SessionMetadata = await restoreArchivedSession(request.params.sessionId);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: { restored: true, metadata }
			});
			break;
		}

		case "session.archived.delete":
			await deleteArchivedSession(request.params.sessionId);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: { deletedArchived: true, sessionId: request.params.sessionId }
			});
			break;

		case "session.export": {
			if (getClientConnection(socket)?.clientType !== "studio") {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "studio_only",
						message: "session.export is only available to Daedalus Studio."
					}
				});
				break;
			}
			if (session.sessionId === request.params.sessionId) {
				await waitForFullSessionLoad(session);
				await waitForSessionEventPersistence(session);
			}
			const result = await exportSessionToSqlite(
				request.params.sessionId,
				request.params.destinationPath
			);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result
			});
			break;
		}

		case "session.import": {
			if (getClientConnection(socket)?.clientType !== "studio") {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "studio_only",
						message: "session.import is only available to Daedalus Studio."
					}
				});
				break;
			}
			try {
				const result = await importSessionFromSqlite(request.params.sourcePath);
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: true,
					result
				});
			} catch (error: unknown) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: sessionRpcError(error, "session_import_failed", "Failed to import session")
				});
			}
			break;
		}

		case "session.save":
			await waitForFullSessionLoad(session);
			if (!session.sessionId) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "no_session", message: "No active session to save. Create one first with session.create." }
				});
				break;
			}
			await waitForSessionEventPersistence(session);
			const sessionUiMetadata: Partial<SessionMetadata> = createSessionUiMetadata(request.params);
			await updateSessionMetadata(session.sessionId, {
				...createRuntimeSessionUiMetadata(session),
				...sessionUiMetadata,
			});
			if (Object.keys(sessionUiMetadata).length > 0) {
				applySessionMetadata(session, {
					id: session.sessionId,
					title: session.sessionTitle ?? "Untitled",
					createdAt: "",
					updatedAt: "",
					...sessionUiMetadata
				});
			}
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: { saved: true, sessionId: session.sessionId, messageCount: session.messages.length }
			});
			break;

		case "session.model.set": {
			await waitForFullSessionLoad(session);
			if (!session.sessionId) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "no_session", message: "No active session to update. Open or create a session first." }
				});
				break;
			}

			const provider: ProviderId = request.params.provider;
			const model: string = request.params.model.trim();
			if (!isProviderId(provider) || model.length === 0) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "invalid_model", message: "Invalid provider or model." }
				});
				break;
			}
			const modelsCache = await getProviderModelsCache(provider);
			const modelEnabled: boolean = mergeProviderModelsWithCatalog(provider, modelsCache?.models ?? [])
				.some((candidate: ProviderModelInfo): boolean => candidate.id === model);
			if (!modelEnabled) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "invalid_model", message: `Model ${model} is not enabled for provider ${provider}.` }
				});
				break;
			}

			const providerChanged: boolean = provider !== session.activeProvider;
			const previousProvider: ProviderId = session.activeProvider;
			const previousModel: string = session.providerModel ?? session.modelProfile.model;
			const reasoningEffort: string | undefined = resolveReasoningEffortForModelChange(
				previousProvider,
				previousModel,
				session.workbenchComposer.reasoningEffort,
				provider,
				model
			);
			session.activeProvider = provider;
			session.providerModel = model;
			session.modelProfile = resolveModelProfile(provider, model);
			session.workbenchComposer.provider = undefined;
			session.workbenchComposer.model = undefined;
			session.workbenchComposer.reasoningEffort = reasoningEffort;
			session.workbenchComposer.updatedAt = new Date().toISOString();
			if (providerChanged) {
				session.providerApiKey = undefined;
				session.providerBaseUrl = undefined;
				session.providerRequestOverrides = undefined;
			}
			bumpWorkbenchRevision(session);
			await waitForSessionEventPersistence(session);
			await updateSessionMetadata(session.sessionId, createRuntimeSessionUiMetadata(session));

			const stored = await openSession(session.sessionId);
			emitWorkbenchUpdated(socket, request.id, session);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					metadata: stored.metadata,
					workbench: serializeWorkbench(session)
				}
			});
			break;
		}

		case "session.delete":
			await deleteSession(request.params.sessionId);
			if (session.sessionId === request.params.sessionId) {
				clearActiveSession(session);
			}
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: { deleted: true, sessionId: request.params.sessionId }
			});
			break;

		case "session.rename": {
			const metadata: SessionMetadata = await renameSession(request.params.sessionId, request.params.title);
			if (session.sessionId === request.params.sessionId) {
				session.sessionTitle = metadata.title;
			}
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: metadata
			});
			break;
		}

		case "session.timeline.index": {
			const sessionId: string | undefined = request.params?.sessionId ?? session.sessionId;
			if (sessionId === undefined) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "no_session", message: "No active session" }
				});
				break;
			}
			try {
				const index = await getSessionTimelineNavigationIndex(sessionId);
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: true,
					result: { timelineIndex: true, ...index }
				});
			} catch (error: unknown) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: sessionRpcError(error, "session_timeline_index_error", "Failed to load session timeline index")
				});
			}
			break;
		}

		case "session.pin.set": {
			const metadata: SessionMetadata = await updateSessionMetadata(request.params.sessionId, {
				pinned: request.params.pinned
			});
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: metadata
			});
			break;
		}

		case "session.context.estimate": {
			try {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: true,
					result: await createContextEstimateResult(session, mcpHost, request.params)
				});
			} catch (error: unknown) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "context_estimate_error",
						message: error instanceof Error ? error.message : "Context estimate failed"
					}
				});
			}
			break;
		}

		case "session.workflow.todo.dismiss": {
			await waitForFullSessionLoad(session);
			if (!session.sessionId) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "no_session", message: "No active session" }
				});
				break;
			}

			const workflowId: string | undefined = request.params?.workflowId;
			const runId: string | undefined = request.params?.runId;
			const dismissedAt: string = new Date().toISOString();
			sendSessionEvent(socket, request.id, session, "workflow.todo.dismissed", {
				...(workflowId !== undefined ? { workflowId } : {}),
				...(runId !== undefined ? { runId } : {}),
				dismissedAt
			});
			await waitForSessionEventPersistence(session);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					dismissed: true,
					workflowId: workflowId ?? null,
					runId: runId ?? null
				}
			});
			break;
		}

		case "session.compress": {
			await waitForFullSessionLoad(session);
			if (!session.sessionId) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "no_session", message: "No active session" }
				});
				break;
			}

			const apiKey: string | undefined = await ensureProviderConfigured(session);
			if (!apiKey) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "no_api_key", message: `${getProviderDisplayName(session.activeProvider)} API key not configured` }
				});
				break;
			}

			try {
				const keepRecent = request.params?.keepRecent ?? 8;
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: true,
					result: await compressSessionHistory(session, apiKey, keepRecent, request.id, {
						compressionSource: "manual"
					})
				});
			} catch (error: unknown) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "compress_error",
						message: error instanceof Error ? error.message : "Compression failed"
					}
				});
			}
			break;
		}

		case "session.summary": {
			if (!session.sessionId) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "no_session", message: "No active session" }
				});
				break;
			}

			const summary = await readSummary(session.sessionId);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: summary ?? { content: null, reason: "No summary yet" }
			});
			break;
		}

		case "session.overview.get": {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: await createSessionOverview({
					sessionId: request.params.sessionId,
					planLimit: request.params.planLimit,
					sourceLimit: request.params.sourceLimit,
					includePlanPreviews: request.params.includePlanPreviews,
					includeSourceImages: request.params.includeSourceImages
				})
			});
			break;
		}

		default:
			throw new Error(`Unsupported session request method: ${request.method}`);
	}
}
