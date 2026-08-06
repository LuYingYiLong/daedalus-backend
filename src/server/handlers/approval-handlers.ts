import WebSocket from "ws";
import { composeSystemPrompt, listPromptTemplates } from "../../prompts/registry.js";
import type { AdditionalContextItem, AiChatParams, ChatMessage, ClientRequest, ModelProfile, ProviderId, ServerEvent } from "../../protocol/types.js";
import type { ProviderAgentResult } from "../../providers/agent-types.js";
import { continueProviderAgent, continueProviderAgentStreaming } from "../../providers/provider-agent.js";
import { removeAgentRunContinuation } from "../../session/agent-run-store.js";
import type { OnToolEvent, ToolEvent } from "../../tools/tool-dispatcher.js";
import { parseTerminalMcpProgress, type TerminalOutputDelta } from "../../mcp/terminal/progress.js";
import { parseToolResultSummary } from "../../tools/tool-result-parser.js";
import { chatWithDeepSeek, createDeepSeekClient, resolveChatModel, type ProviderChatOptions } from "../../providers/deepseek-client.js";
import { McpHost } from "../../mcp/mcp-host.js";
import type { CustomMcpServerRuntimeStatus } from "../../mcp/mcp-host.js";
import {
	addCustomMcpServerConfig,
	listCustomMcpServerSummaries,
	removeCustomMcpServerConfig,
	setCustomMcpServerEnabled,
	type CustomMcpServerSummary
} from "../../mcp/custom-mcp-config-store.js";
import { sendJson } from "../send-json.js";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getDefaultModelProfile, resolveModelProfile } from "../../tokens/model-profiles.js";
import { type TokenCounter } from "../../tokens/token-counter.js";
import { createTokenCounter } from "../../tokens/token-counter-factory.js";
import { computeInputBudget, selectMessagesWithinBudget } from "../../session/session-compressor.js";
import { hydrateImageAttachmentContexts } from "../../session/session-attachments.js";
import { composeSkillPrompt, getSkill, isSkillId, listSkills } from "../../skills/registry.js";
import type { SkillId } from "../../skills/registry.js";
import {
	createRuntimeWorkspace,
	loadWorkspaces,
	findWorkspace,
	getDefaultWorkspace,
	upsertRuntimeWorkspace
} from "../../workspace/registry.js";
import type { WorkspaceConfig } from "../../workspace/types.js";
import {
	createSession, openSession, saveSession, listSessions,
	archiveSession, deleteArchivedSession, deleteSession, listArchivedSessions, renameSession, restoreArchivedSession,
	rewindSessionFromRequest,
	readSummary, writeSummary,
	appendSessionEvent, appendApprovalEvent, appendWorkflowEvent, appendAgentEvent, clearSessionEvents, readApprovalEvents,
	openSessionRecentTimeline, openSessionTimelinePage,
	type SessionMetadata,
	type SessionSummary,
	type StoredMessage,
	type StoredSessionEvent,
	type StoredSessionTimelinePage
} from "../../session/session-store.js";
import {
	clearProviderConfig,
	getProviderConfigStatus,
	loadProviderConfigWithSecret,
	saveProviderConfig,
	type ProviderConfigWithSecret
} from "../../providers/provider-config-store.js";
import { listProviderModels } from "../../providers/provider-models.js";
import { estimateProviderMessagesTokens, estimateProviderTextTokens } from "../../providers/provider-token-estimator.js";
import {
	createCurrentUserMessage,
	getImageAttachments,
	hasImageAttachments,
	modelSupportsImageInput,
	ProviderImageInputError
} from "../../providers/provider-image-content.js";
import { getProviderDefaultBaseUrl, getProviderDefaultModel, getProviderDisplayName } from "../../providers/provider-registry.js";
import { classifyProviderError, createProviderStatusEvent } from "../../providers/provider-error.js";
import { generateSessionTitle, shouldApplyGeneratedSessionTitle } from "../session-title.js";
import { createSingleAnswerPlan, planWorkflow, READ_TOOLS, VERIFY_TOOLS, WRITE_TOOLS } from "../../workflow/planner.js";
import { createLlmWorkflowPlan, reviseLlmWorkflowPlan } from "../../workflow/llm-planner.js";
import {
	applyDeterministicVerificationGate,
	applyToolEventToWorkflowObservations,
	createWorkflowPhaseOutcome,
	createWorkflowPhaseRunId,
	findBlockingOutcomeBeforeSummarize
} from "../../workflow/outcome.js";
import {
	appendPhaseOutput,
	createPhaseMessage,
	createPhaseParams,
	createPhasePrompt,
	createWorkflowTodoSnapshot,
	markRemainingWorkflowTodos,
	updateWorkflowPhaseStatus
} from "../../workflow/runner.js";
import { countWorkflowAutoRepairRounds, insertWorkflowAutoRepairPhases } from "../../workflow/repair.js";
import type { WorkflowPhase, WorkflowPhaseOutput, WorkflowPlan, WorkflowRunState, WorkflowToolObservation } from "../../workflow/types.js";
import {
	addLightweightActionObservation,
	applyToolEventToLightweightActionState,
	LightweightActionScopeExceededError,
	LightweightActionVerificationError
} from "../../workflow/lightweight-action.js";
import {
	clearActiveSession,
	type ClientSession,
	type PendingAiContinuation,
	type PendingGuide,
	type ThinkingEventBuffer
} from "../client-session.js";
import { getToolPolicy, type ApprovalMode } from "../../tools/tool-policy.js";
import type { PendingApproval } from "../../tools/approval-gateway.js";
import { getLlmToolExecutionIdentity } from "../../tools/tool-idempotency.js";
import { resolveToolMapping } from "../../tools/tool-mapping.js";
import {
	createPersistedApprovalRequestedData,
	createRuntimePendingContinuation,
	foldPendingApprovalStates,
	serializePendingApprovalState,
	type PendingApprovalState
} from "../../session/approval-persistence.js";
import { createBackendHealthResult } from "../backend-health.js";
import {
	createSlashCommandListResult,
	handleSlashCommand,
	type SlashCommandResult
} from "../slash-commands.js";

import { normalizeChatParamsForMode, resolveAllowedToolsForChatParams } from "../chat-mode.js";
import { logPromptTrace, logProjectInstructionTrace } from "../prompt-trace.js";
import { awaitWithAbort, isCancellationError, sendAgentCancelled, beginRequestExecution, finishRequestExecution, parseMessage, throwIfAborted } from "../request-lifecycle.js";
import { estimateTextTokens, estimateMessagesTokens, computeHistoryBudget, appendChatTurnToSession, selectHistoryForModel, createSummaryMessage, loadSessionCompressorPrompt } from "../token-budget.js";
import { getSessionProjectPath, toChatMessage, clampSessionOpenMessageLimit, createPreviewValue, createTimelinePageResult, startFullSessionLoad, waitForFullSessionLoad } from "../session-preview.js";
import { createProviderChatOptions } from "../provider-chat-options.js";
import { createGodotRuntimeStatus } from "../godot-runtime-status.js";
import { clipTextByChars, cloneAdditionalContextItems, getAdditionalContextDataRecord, getContextNumber, getContextString, createLineColumnRangeText, appendScriptSelectionPromptLines, appendFilesystemSelectionPromptLines, createAdditionalContextPromptSection } from "../additional-context.js";
import { MAX_GUIDE_TEXT_CHARS, createGuideId, createPendingGuide, serializePendingGuide, findPendingGuideIndexById, findPendingGuideByClientId, readEventDataObject, hydratePendingGuides, persistGuideEvent, formatGuidePromptSection, consumePendingGuideSection } from "../pending-guides.js";
import { DEFAULT_NEXT_STEP_HINT_COUNT, MAX_NEXT_STEP_HINT_COUNT, parseJsonObjectLoose, normalizeNextStepHints, createNextStepHintPrompt, createNextStepHints } from "../next-step-hints.js";
import type { NextStepHint } from "../next-step-hints.js";
import { WorkflowExecutionError } from "../workflow/workflow-error.js";
import type { WorkflowPhaseToolStats, WorkflowPhaseRunResult } from "../workflow/shared-types.js";
import { MAX_WORKFLOW_AUTO_REPAIR_ROUNDS } from "../workflow/limits.js";
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
} from "../session-events.js";

import {
	createPendingAiContinuation,
	persistApprovalRequested,
	registerPendingApprovalContinuation,
	loadHydratedPendingApprovalStates,
	createMemoryPendingApprovalStates,
	findPendingApprovalState,
	restorePendingContinuationForApproval,
	validatePendingApprovalBeforeExecution,
	createApprovedWorkflowToolObservation,
	cancelAgentRunForRejectedApproval,
	sendAgentPaused,
	sendContinuedAgentResult,
	waitForPendingApprovalContinuationRegistration
} from "../approval-continuation.js";
import { createAgentToolEventForwarder, createEmptyWorkflowPhaseToolStats, updateWorkflowPhaseToolStats, shouldRequireWorkflowWriteTool, didWorkflowWritePhaseExecute, createWorkflowWriteGuardRetryMessage } from "../workflow/tool-events.js";
import { persistFileEditBatch } from "../file-edit-batches.js";
import { sendWorkflowEvent, sendWorkflowTodoSnapshot } from "../workflow/events.js";
import { runWorkflowPhase, createWorkflowPhasePrompt } from "../workflow/phase-runner.js";
import { createWorkflowPendingContinuation, continueWorkflowExecution } from "../workflow/continuation.js";
import { startWorkflowExecution } from "../workflow/executor.js";
import { ensureProviderConfigured } from "../../application/provider-session-service.js";
import { findSessionWithPendingApproval } from "../client-connections.js";
import { withMcpRequestContext } from "../../mcp/request-context.js";
import {
	getAgentRun,
	recordAgentRunApprovedToolResult,
	recordAgentRunToolEvent,
	updateAgentRun
} from "../agent-run-controller.js";

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

import { createProviderRuntimeContext, createSafeMarkdownFence, createMcpSystemContext } from "../prompt-context.js";
import { setApprovalMode } from "../../approval-settings-store.js";
import { getActiveConnectionSessions } from "../client-connections.js";
import { emitWorkbenchUpdated, serializeWorkbench, setWorkbenchActiveRun } from "../workbench.js";
import { synchronizeSessionApprovalMode } from "../approval-mode-sync.js";

const FULL_TRUST_CONFIRMATION_TEXT: string = "ENABLE FULL TRUST";

async function applyGlobalApprovalMode(session: ClientSession): Promise<ApprovalMode> {
	return await synchronizeSessionApprovalMode(session);
}

function applyApprovalModeToActiveSessions(mode: ApprovalMode): void {
	for (const activeSession of getActiveConnectionSessions()) {
		activeSession.approvalGateway.setMode(mode);
	}
}

export async function handleApprovalRequest(socket: WebSocket, request: ClientRequest, session: ClientSession, mcpHost: McpHost): Promise<void> {
	switch (request.method) {
	case "approval.list":
	{
		const mode = await applyGlobalApprovalMode(session);
		const hydrated = await loadHydratedPendingApprovalStates(session);
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: {
				pending: hydrated.states.map(serializePendingApprovalState),
				mode,
				workbench: serializeWorkbench(session)
			}
		});
		break;
	}

	case "approval.mode.set":
		if (request.params.mode === "full-trust" && request.params.confirmationText !== FULL_TRUST_CONFIRMATION_TEXT) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "full_trust_confirmation_required",
					message: `Switching to Full Trust requires confirmation text: ${FULL_TRUST_CONFIRMATION_TEXT}`
				}
			});
			break;
		}
		await setApprovalMode(request.params.mode);
		applyApprovalModeToActiveSessions(request.params.mode);
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: {
				mode: request.params.mode,
				pendingApprovals: session.approvalGateway.listPending().length,
				workbench: serializeWorkbench(session)
			}
		});
		break;

	case "approval.approve": {
		const ownerSession: ClientSession | undefined = session.approvalGateway.getPending(request.params.approvalId) !== undefined
			? session
			: findSessionWithPendingApproval(request.params.approvalId);
		if (ownerSession !== undefined && ownerSession !== session) {
			await withMcpRequestContext({
				workspaceId: ownerSession.activeWorkspace?.id,
				editorInstanceId: ownerSession.editorInstanceId
			}, async (): Promise<void> => {
				await handleApprovalRequest(socket, request, ownerSession, mcpHost);
			});
			break;
		}
		const abortController: AbortController = new AbortController();
		session.activeAbortControllers.set(request.id, abortController);
		let continuationRequestId: string = request.id;
		let queueItemId: number | undefined;
		let pendingContinuationForRun: PendingAiContinuation | undefined;
		let approvedPending: PendingApproval | undefined;
		let approvalPersistRequestIdForEvent: string = request.id;
		let approvalRunId: string = request.id;
		let approvalStepRunId: string = request.id;
		let approvalDecisionEmitted: boolean = false;
		let approvedToolExecuted: boolean = false;
		try {
			await synchronizeSessionApprovalMode(session);
			const apiKey: string | undefined = await ensureProviderConfigured(session);
			const hydrated = await loadHydratedPendingApprovalStates(session, apiKey);
			const pending = session.approvalGateway.getPending(request.params.approvalId);
			if (!pending) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "approval_not_found", message: `Approval not found: ${request.params.approvalId}` }
				});
				break;
			}
			approvedPending = pending;
			if (pending.requiredConsent !== undefined) {
				const consentText: string | undefined = request.params.consentText;
				if (consentText !== pending.requiredConsent.expectedText) {
					sendJson(socket, {
						type: "response",
						id: request.id,
						ok: false,
						error: {
							code: "approval_consent_required",
							message: `Approval requires exact consent text: ${pending.requiredConsent.expectedText}`
						}
					});
					break;
				}
				pending.args = {
					...pending.args,
					__daedalusConsentText: consentText
				};
			}

			const validationError: string | null = await validatePendingApprovalBeforeExecution(session, mcpHost, pending);
			if (validationError !== null) {
				if (session.sessionId !== undefined) {
					await appendApprovalEvent(session.sessionId, pending.approvalId, findPendingApprovalState(hydrated.states, pending.approvalId)?.requestId ?? request.id, "failed", {
						message: validationError
					});
				}
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "approval_validation_failed", message: validationError }
				});
				break;
			}

			const pendingState: PendingApprovalState | undefined = findPendingApprovalState(hydrated.states, request.params.approvalId);
			let pendingContinuation: PendingAiContinuation | undefined = await restorePendingContinuationForApproval(session, pendingState, apiKey);
			if (pendingContinuation === undefined && pendingState?.continuation === undefined) {
				pendingContinuation = await waitForPendingApprovalContinuationRegistration(session, request.params.approvalId);
			}
			continuationRequestId = pendingContinuation?.requestId ?? pendingState?.requestId ?? request.id;
			pendingContinuationForRun = pendingContinuation;
			queueItemId = pendingContinuation?.params.options?.queueItemId;
			// continuation 沿用原请求 ID，确保 ai.cancel 能中止执行而非仅中止审批 RPC。
			session.activeAbortControllers.set(continuationRequestId, abortController);
			throwIfAborted(abortController.signal);
			if (pendingState?.continuation !== undefined && pendingContinuation === undefined) {
				const message: string = `当前没有可用的 ${getProviderDisplayName(session.activeProvider)} API key，无法恢复审批后的 LLM continuation。请先配置 provider 后重试。`;
				if (session.sessionId !== undefined) {
					await appendApprovalEvent(session.sessionId, pending.approvalId, pendingState.requestId, "failed", { message });
				}
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "provider_not_configured", message }
				});
				break;
			}
			const approvalPersistRequestId: string = pendingContinuation?.requestId ?? pendingState?.requestId ?? request.id;
			approvalPersistRequestIdForEvent = approvalPersistRequestId;
			approvalRunId = pendingContinuation?.workflowState?.plan.id ?? pendingContinuation?.requestId ?? request.id;
			approvalStepRunId = pendingContinuation?.workflowState?.activePhaseRunId ?? pendingContinuation?.requestId ?? request.id;
			if (session.sessionId !== undefined) {
				await appendApprovalEvent(session.sessionId, pending.approvalId, approvalPersistRequestId, "approved", {
					approvedAt: new Date().toISOString(),
					...(request.params.consentText === undefined ? {} : { consentText: request.params.consentText })
				});
				await appendApprovalEvent(session.sessionId, pending.approvalId, approvalPersistRequestId, "executing", {
					startedAt: new Date().toISOString()
				});
			}
			if (
				pendingContinuation !== undefined
				&& getAgentRun(session, pendingContinuation.requestId)?.stage === "awaiting_approval"
			) {
				updateAgentRun(socket, session, pendingContinuation.requestId, "executing", {
					pause: null
				});
			}
			sendSessionEvent(socket, approvalPersistRequestId, session, "agent.tool.approved", {
				type: "agent.tool.approved",
				runId: approvalRunId,
				stepRunId: approvalStepRunId,
				approvalId: request.params.approvalId,
				toolCallId: pending.toolCallId,
				toolName: pending.llmToolName
			}, approvalPersistRequestId);
			approvalDecisionEmitted = true;
			const approvalProgressForwarder: OnToolEvent = createAgentToolEventForwarder(
				socket,
				approvalPersistRequestId,
				session,
				approvalRunId,
				approvalStepRunId,
				approvalPersistRequestId,
				mcpHost
			);
			const result = await awaitWithAbort(
				session.approvalGateway.approve(request.params.approvalId, mcpHost, {
					abortSignal: abortController.signal,
					onProgress: (progress): void => {
						const terminalOutputDelta: TerminalOutputDelta | null = parseTerminalMcpProgress(progress);
						if (terminalOutputDelta === null) {
							return;
						}
						approvalProgressForwarder({
							type: "tool.progress",
							step: pendingContinuation?.continuation.nextStep ?? 0,
							toolCallId: pending.toolCallId,
							toolName: pending.llmToolName,
							status: "message",
							title: "Terminal output",
							details: "",
							code: "terminal_output",
							terminalOutputDelta
						});
					}
				}),
				abortController.signal
			);
			throwIfAborted(abortController.signal);
			approvedToolExecuted = true;
			const approvedToolObservation: WorkflowToolObservation = createApprovedWorkflowToolObservation(pending, result.content);
			if (session.sessionId !== undefined) {
				await appendApprovalEvent(session.sessionId, pending.approvalId, approvalPersistRequestId, "executed", {
					resultChars: result.content.length,
					cached: result.cached === true,
					executedAt: new Date().toISOString()
				});
			}

			const { fileEditDraft: _fileEditDraft, ...publicApprovalResult } = result;
			setWorkbenchActiveRun(session, {
				status: pendingContinuation !== undefined ? "streaming" : "idle",
				requestId: pendingContinuation?.requestId ?? request.id,
				queueItemId
			});
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					approved: true,
					approvalId: request.params.approvalId,
					result: publicApprovalResult,
					continued: pendingContinuation !== undefined,
					workbench: serializeWorkbench(session)
				}
			});
			emitWorkbenchUpdated(socket, request.id, session);
			const continuationRunId: string = approvalRunId;
			const continuationStepRunId: string = approvalStepRunId;
			const resultPersistRequestId: string = pendingContinuation?.requestId ?? request.id;
			const fileEditBatch = persistFileEditBatch(
				session.sessionId,
				resultPersistRequestId,
				pending.toolCallId,
				pending.llmToolName,
				result.fileEditDraft
			);
			sendSessionEvent(socket, approvalPersistRequestId, session, "agent.tool.result", {
				type: "agent.tool.result",
				runId: continuationRunId,
				stepRunId: continuationStepRunId,
				step: pendingContinuation?.continuation.nextStep ?? 0,
				toolCallId: pending.toolCallId,
				toolName: pending.llmToolName,
				resultChars: result.content.length,
				truncated: false,
				cached: result.cached === true,
				imageGeneration: result.imageGeneration,
				...approvedToolObservation.parsedResult,
				...(fileEditBatch === undefined ? {} : { fileEditBatch })
			}, resultPersistRequestId);

			if (pendingContinuation === undefined) {
				session.messages.push({
					role: "system",
					content: `[工具执行结果] ${pending.llmToolName} 已通过审批并执行完成：\n${result.content.slice(0, 2000)}`
				});
				break;
			}

			recordAgentRunApprovedToolResult(
				socket,
				session,
				pendingContinuation.requestId,
				{
					toolCallId: pending.toolCallId,
					toolName: pending.llmToolName,
					args: pending.args,
					succeeded: true,
					summary: result.content.slice(0, 2000),
					artifactRefs: approvedToolObservation.artifactRefs,
					writeCheckpointCovered: result.fileEditDraft !== undefined
				}
			);
			session.pendingAiContinuations.delete(request.params.approvalId);
			await removeAgentRunContinuation(pendingContinuation.requestId);
			if (pendingContinuation.lightweightActionState !== undefined) {
				addLightweightActionObservation(
					pendingContinuation.lightweightActionState,
					approvedToolObservation
				);
			}
			const forwardToolEvent: OnToolEvent = createAgentToolEventForwarder(
				socket,
				pendingContinuation.requestId,
				session,
				continuationRunId,
				continuationStepRunId,
				pendingContinuation.requestId,
				mcpHost
			);
			const onToolEvent: OnToolEvent = (event: ToolEvent): void => {
				if (pendingContinuation.lightweightActionState !== undefined) {
					applyToolEventToLightweightActionState(
						pendingContinuation.lightweightActionState,
						event
					);
				}
				recordAgentRunToolEvent(socket, session, pendingContinuation.requestId, event);
				if (!(pendingContinuation.chatCompletion?.requireSubmission === true && event.type === "ai.delta")) {
					forwardToolEvent(event);
				}
			};
			const continuationParams: AiChatParams = await awaitWithAbort(
				hydrateImageAttachmentContexts(session.sessionId, pendingContinuation.params),
				abortController.signal
			);
			throwIfAborted(abortController.signal);
			const continuationWorkflowState = pendingContinuation.workflowState !== undefined
				? {
					...pendingContinuation.workflowState,
					originalParams: continuationParams
				}
				: undefined;
			const agentResultPromise: Promise<ProviderAgentResult> = pendingContinuation.stream
				? continueProviderAgentStreaming(
					continuationParams,
					pendingContinuation.options,
					pendingContinuation.continuation,
					{
						toolCallId: pending.toolCallId,
						content: result.content
					},
					mcpHost,
					session.approvalGateway,
					pendingContinuation.allowedToolNames,
					onToolEvent,
					abortController.signal,
					{
						workspaceId: pending.workspaceId ?? session.activeWorkspace?.id,
						editorInstanceId: pending.editorInstanceId ?? session.editorInstanceId,
						sessionId: pending.sessionId ?? session.sessionId,
						requestId: pendingContinuation.requestId,
						executionControl: pendingContinuation.executionControl,
						chatCompletion: pendingContinuation.chatCompletion
					}
				)
				: continueProviderAgent(
					continuationParams,
					pendingContinuation.options,
					pendingContinuation.continuation,
					{
						toolCallId: pending.toolCallId,
						content: result.content
					},
					mcpHost,
					session.approvalGateway,
					pendingContinuation.allowedToolNames,
					onToolEvent,
					abortController.signal,
					{
						workspaceId: pending.workspaceId ?? session.activeWorkspace?.id,
						editorInstanceId: pending.editorInstanceId ?? session.editorInstanceId,
						sessionId: pending.sessionId ?? session.sessionId,
						requestId: pendingContinuation.requestId,
						executionControl: pendingContinuation.executionControl,
						chatCompletion: pendingContinuation.chatCompletion
					}
				);
			const agentResult: ProviderAgentResult = await awaitWithAbort(agentResultPromise, abortController.signal);
			throwIfAborted(abortController.signal);

			if (continuationWorkflowState !== undefined) {
				await awaitWithAbort(continueWorkflowExecution(
					socket,
					pendingContinuation.requestId,
					session,
					mcpHost,
					pendingContinuation.options,
					continuationWorkflowState,
					pendingContinuation.userCreatedAt,
					agentResult,
					pendingContinuation.requestId,
					abortController.signal,
					[approvedToolObservation]
				), abortController.signal);
				throwIfAborted(abortController.signal);
				setWorkbenchActiveRun(session, { status: "idle" });
				const queueHelpers = await import("../chat-orchestrator.js");
				await queueHelpers.finishQueueItemForRun(socket, pendingContinuation.requestId, session, queueItemId);
				void queueHelpers.drainMessageQueue(socket, request.id, session, mcpHost);
				emitWorkbenchUpdated(socket, request.id, session);
				break;
			}

			await sendContinuedAgentResult(
				socket,
				pendingContinuation.requestId,
				session,
				mcpHost,
				agentResult,
				pendingContinuation
			);
			setWorkbenchActiveRun(session, { status: "idle" });
			const queueHelpers = await import("../chat-orchestrator.js");
			await queueHelpers.finishQueueItemForRun(socket, pendingContinuation.requestId, session, queueItemId);
			void queueHelpers.drainMessageQueue(socket, request.id, session, mcpHost);
			emitWorkbenchUpdated(socket, request.id, session);
		} catch (error: unknown) {
			if (
				error instanceof LightweightActionScopeExceededError
				&& pendingContinuationForRun !== undefined
			) {
				const queueHelpers = await import("../chat-orchestrator.js");
				await queueHelpers.escalatePendingContinuationToWorkflow({
					socket,
					session,
					mcpHost,
					pendingContinuation: pendingContinuationForRun,
					abortSignal: abortController.signal,
					reason: error.reason
				});
				setWorkbenchActiveRun(session, { status: "idle" });
				await queueHelpers.finishQueueItemForRun(
					socket,
					pendingContinuationForRun.requestId,
					session,
					queueItemId
				);
				void queueHelpers.drainMessageQueue(socket, request.id, session, mcpHost);
				emitWorkbenchUpdated(socket, request.id, session);
				break;
			}
			if (isCancellationError(error, abortController.signal)) {
				setWorkbenchActiveRun(session, { status: "idle" });
				const queueHelpers = await import("../chat-orchestrator.js");
				await queueHelpers.finishQueueItemForRun(socket, continuationRequestId, session, queueItemId, "cancelled");
				emitWorkbenchUpdated(socket, request.id, session);
				sendAgentCancelled(socket, continuationRequestId, session);
				break;
			}
			setWorkbenchActiveRun(session, { status: "idle" });
			const queueHelpers = await import("../chat-orchestrator.js");
			await queueHelpers.finishQueueItemForRun(socket, continuationRequestId, session, queueItemId, "failed");
			const errorMessage: string = error instanceof Error ? error.message : "Approval failed";
			if (approvalDecisionEmitted && !approvedToolExecuted && approvedPending !== undefined) {
				session.pendingAiContinuations.delete(request.params.approvalId);
				await removeAgentRunContinuation(continuationRequestId);
				sendSessionEvent(socket, approvalPersistRequestIdForEvent, session, "agent.tool.error", {
					type: "agent.tool.error",
					runId: approvalRunId,
					stepRunId: approvalStepRunId,
					step: pendingContinuationForRun?.continuation.nextStep ?? 0,
					toolCallId: approvedPending.toolCallId,
					toolName: approvedPending.llmToolName,
					message: errorMessage
				}, continuationRequestId);
			}
			if (error instanceof WorkflowExecutionError) {
				const workflowErrorMessage: string = error.message.length > 0
					? error.message
					: error.originalError instanceof Error
						? error.originalError.message
						: "Workflow failed";
				sendWorkflowEvent(socket, continuationRequestId, session, "workflow.error", {
					workflowId: error.plan.id,
					requestId: continuationRequestId,
					title: error.plan.title,
					code: "agent_run_error",
					message: workflowErrorMessage,
					sequence: session.workbenchActiveRun.sequence ?? session.workbenchActiveRunSequence
				}, continuationRequestId);
			} else if (error instanceof LightweightActionVerificationError) {
				sendSessionEvent(socket, continuationRequestId, session, "agent.run.error", {
					runId: continuationRequestId,
					requestId: continuationRequestId,
					status: "error",
					code: error.code,
					message: error.message,
					sequence: session.workbenchActiveRun.sequence ?? session.workbenchActiveRunSequence
				}, continuationRequestId);
			} else {
				const approvalErrorStatus = classifyProviderError(error);
				sendSessionEvent(socket, continuationRequestId, session, "agent.run.error", {
					runId: continuationRequestId,
					requestId: continuationRequestId,
					status: "error",
					code: approvalErrorStatus.code,
					message: approvalErrorStatus.message,
					sequence: session.workbenchActiveRun.sequence ?? session.workbenchActiveRunSequence
				}, continuationRequestId);
			}
			emitWorkbenchUpdated(socket, request.id, session);
			if (session.sessionId !== undefined) {
				await appendApprovalEvent(session.sessionId, request.params.approvalId, continuationRequestId, "failed", {
					message: errorMessage,
					approvalAccepted: approvalDecisionEmitted
				});
			}
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: error instanceof LightweightActionVerificationError
						? error.code
						: "approval_error",
					message: errorMessage
				}
			});
		} finally {
			session.activeAbortControllers.delete(request.id);
			session.activeAbortControllers.delete(continuationRequestId);
		}
		break;
	}

	case "approval.reject": {
		const ownerSession: ClientSession | undefined = session.approvalGateway.getPending(request.params.approvalId) !== undefined
			? session
			: findSessionWithPendingApproval(request.params.approvalId);
		if (ownerSession !== undefined && ownerSession !== session) {
			await withMcpRequestContext({
				workspaceId: ownerSession.activeWorkspace?.id,
				editorInstanceId: ownerSession.editorInstanceId
			}, async (): Promise<void> => {
				await handleApprovalRequest(socket, request, ownerSession, mcpHost);
			});
			break;
		}
		try {
			const hydrated = await loadHydratedPendingApprovalStates(session);
			const pendingState: PendingApprovalState | undefined = findPendingApprovalState(hydrated.states, request.params.approvalId);
			const pendingContinuation: PendingAiContinuation | undefined = session.pendingAiContinuations.get(request.params.approvalId);
			const continuationRequestId: string = pendingContinuation?.requestId ?? pendingState?.requestId ?? request.id;
			const queueItemId: number | undefined = pendingContinuation?.params.options?.queueItemId;
			const rejected = session.approvalGateway.reject(request.params.approvalId);
			const cancelledRun = pendingContinuation === undefined
				? undefined
				: cancelAgentRunForRejectedApproval(socket, session, continuationRequestId);
			session.pendingAiContinuations.delete(request.params.approvalId);
			await removeAgentRunContinuation(continuationRequestId);
			if (session.sessionId !== undefined) {
				await appendApprovalEvent(session.sessionId, request.params.approvalId, pendingState?.requestId ?? request.id, "rejected", {
					rejectedAt: new Date().toISOString()
				});
			}
			setWorkbenchActiveRun(session, { status: "idle" });
			const queueHelpers = await import("../chat-orchestrator.js");
			await queueHelpers.finishQueueItemForRun(socket, continuationRequestId, session, queueItemId, "rejected");
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					rejected: true,
					approvalId: request.params.approvalId,
					toolName: rejected.llmToolName,
					workbench: serializeWorkbench(session)
				}
			});
			emitWorkbenchUpdated(socket, request.id, session);
			sendSessionEvent(socket, request.id, session, "agent.tool.rejected", {
				type: "agent.tool.rejected",
				runId: continuationRequestId,
				stepRunId: continuationRequestId,
				approvalId: request.params.approvalId,
				toolName: rejected.llmToolName
			}, continuationRequestId);
			if (pendingContinuation !== undefined) {
				sendAgentCancelled(
					socket,
					continuationRequestId,
					session,
					cancelledRun?.runId ?? continuationRequestId,
					"approval_rejected"
				);
			}
		} catch (error: unknown) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "approval_error",
					message: error instanceof Error ? error.message : "Rejection failed"
				}
			});
		}
		break;
	}

		default:
			throw new Error(`Unsupported approval method: ${request.method}`);
	}
}
