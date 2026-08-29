import type WebSocket from "ws";
import type { AiChatParams, ClientRequest } from "../../protocol/types.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession } from "../client-session.js";
import { sendJson } from "../send-json.js";
import { ensureProviderConfigured } from "../../application/provider-session-service.js";
import { createProviderChatOptions } from "../provider-chat-options.js";
import { getProviderDisplayName } from "../../providers/provider-registry.js";
import {
	createPlanEventPayload,
	createPlanGetResult,
	readStoredPlan,
	type StoredPlan,
	updateStoredPlan
} from "../plan-store.js";
import {
	applyPlanClarification,
	applyPlanRevision,
	createApprovedPlanExecutionParams,
	sendPlanMessageDone,
	type PlanClarificationInput
} from "../plan-mode.js";
import { sendSessionEvent } from "../session-events.js";
import { handleChatRequest } from "../chat-orchestrator.js";
import {
	beginSessionRun,
	finishSessionRun,
	getClientActorSummary,
	getActiveSessionRunRequestId,
	registerSessionRunController
} from "../client-connections.js";
import { logger } from "../../logger.js";
import { updateSessionMetadata } from "../../session/session-store.js";
import { createRuntimeSessionUiMetadata } from "../session-ui-metadata.js";
import { isCancellationError, sendAgentCancelled } from "../request-lifecycle.js";
import { bumpWorkbenchRevision, emitWorkbenchUpdated, serializeWorkbench, setWorkbenchActiveRun } from "../workbench.js";
import { withProviderUsageContext } from "../../usage/provider-recorder.js";
import { hasGodotWorkspaceCapability } from "../../workspace/capabilities.js";

const PLAN_EXECUTION_SLOT_WAIT_TIMEOUT_MS: number = 2000;
const PLAN_EXECUTION_SLOT_WAIT_INTERVAL_MS: number = 25;

type PlanOperationRun = {
	runRequestId: string;
	operationRequestId: string;
	planId: string;
	abortController: AbortController;
};

function sendProviderMissing(socket: WebSocket, requestId: string, session: ClientSession): void {
	sendJson(socket, {
		type: "response",
		id: requestId,
		ok: false,
		error: {
			code: "provider_not_configured",
			message: `${getProviderDisplayName(session.activeProvider)} API key is not configured. Save it with provider.config.set first.`
		}
	});
}

function getActiveSessionId(session: ClientSession, requestedSessionId?: string | undefined): string | undefined {
	if (session.sessionId === undefined) {
		return undefined;
	}
	if (requestedSessionId !== undefined && requestedSessionId !== session.sessionId) {
		return undefined;
	}
	return session.sessionId;
}

function sendPlanResponse(socket: WebSocket, requestId: string, plan: StoredPlan): void {
	sendJson(socket, {
		type: "response",
		id: requestId,
		ok: true,
		result: createPlanGetResult(plan)
	});
}

async function emitPlanUpdate(socket: WebSocket, requestId: string, session: ClientSession, plan: StoredPlan, revised: boolean): Promise<void> {
	const actor = getClientActorSummary(socket);
	const payload: Record<string, unknown> = {
		...createPlanEventPayload(plan),
		operationRequestId: requestId,
		...(actor === undefined ? {} : { actor })
	};
	if (plan.metadata.status === "clarification_required") {
		sendSessionEvent(socket, plan.metadata.requestId, session, "plan.clarification.required", payload);
		sendPlanMessageDone(socket, plan.metadata.requestId, session, plan.metadata.planId, plan.metadata.requestId, requestId);
		return;
	}
	sendSessionEvent(socket, plan.metadata.requestId, session, revised ? "plan.revised" : "plan.generated", payload);
	sendPlanMessageDone(socket, plan.metadata.requestId, session, plan.metadata.planId, plan.metadata.requestId, requestId);
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve: () => void): void => {
		setTimeout(resolve, ms);
	});
}

async function waitForPlanExecutionSlot(session: ClientSession, originalRequestId: string): Promise<boolean> {
	const startedAtMs: number = Date.now();
	while (Date.now() - startedAtMs < PLAN_EXECUTION_SLOT_WAIT_TIMEOUT_MS) {
		const activeRunRequestId: string | undefined = session.activeRunRequestId ?? getActiveSessionRunRequestId(session.sessionId);
		if (activeRunRequestId === undefined) {
			return true;
		}
		if (activeRunRequestId !== originalRequestId) {
			return false;
		}
		await wait(PLAN_EXECUTION_SLOT_WAIT_INTERVAL_MS);
	}

	return false;
}

function beginPlanOperationRun(
	socket: WebSocket,
	requestId: string,
	session: ClientSession,
	plan: StoredPlan
): PlanOperationRun | null {
	const runRequestId: string = plan.metadata.requestId;
	const sessionRun = beginSessionRun(session.sessionId, runRequestId);
	if (!sessionRun.ok) {
		sendJson(socket, {
			type: "response",
			id: requestId,
			ok: false,
			error: {
				code: "session_busy",
				message: `Session is already running request ${sessionRun.activeRequestId}.`
			}
		});
		return null;
	}

	const abortController = new AbortController();
	session.activeAbortControllers.set(requestId, abortController);
	session.activeAbortControllers.set(runRequestId, abortController);
	session.activeRunRequestId = runRequestId;
	registerSessionRunController(session.sessionId, runRequestId, abortController);
	const startedActiveRun = setWorkbenchActiveRun(session, {
		status: "streaming",
		requestId: runRequestId
	});
	sendSessionEvent(socket, runRequestId, session, "agent.run.started", {
		runId: runRequestId,
		requestId: runRequestId,
		status: "streaming",
		sequence: startedActiveRun.sequence,
		operationRequestId: requestId,
		planId: plan.metadata.planId,
		mode: "plan"
	});
	emitWorkbenchUpdated(socket, requestId, session);
	return {
		runRequestId,
		operationRequestId: requestId,
		planId: plan.metadata.planId,
		abortController
	};
}

function finishPlanOperationRun(socket: WebSocket, session: ClientSession, operation: PlanOperationRun): void {
	session.activeAbortControllers.delete(operation.operationRequestId);
	session.activeAbortControllers.delete(operation.runRequestId);
	if (session.activeRunRequestId === operation.runRequestId) {
		session.activeRunRequestId = undefined;
	}
	finishSessionRun(session.sessionId, operation.runRequestId);
	setWorkbenchActiveRun(session, { status: "idle" });
	emitWorkbenchUpdated(socket, operation.operationRequestId, session);
}

export async function handlePlanRequest(socket: WebSocket, request: ClientRequest, session: ClientSession, mcpHost: McpHost): Promise<void> {
	let failedRunRequestId: string | undefined;
	let failedPlanId: string | undefined;
	let failedAbortSignal: AbortSignal | undefined;
	let activePlanOperation: PlanOperationRun | null = null;
	try {
		switch (request.method) {
			case "plan.get": {
				const sessionId: string | undefined = getActiveSessionId(session, request.params.sessionId);
				if (sessionId === undefined) {
					sendJson(socket, {
						type: "response",
						id: request.id,
						ok: false,
						error: {
							code: "session_mismatch",
							message: "Plans can only be read for the active session."
						}
					});
					return;
				}
				const plan: StoredPlan = await readStoredPlan(sessionId, request.params.planId);
				sendPlanResponse(socket, request.id, plan);
				return;
			}

			case "plan.clarify": {
				const sessionId: string | undefined = getActiveSessionId(session);
				if (sessionId === undefined) {
					throw new Error("Plan clarification requires an active session.");
				}
				const apiKey: string | undefined = await ensureProviderConfigured(session);
				if (!apiKey) {
					sendProviderMissing(socket, request.id, session);
					return;
				}
				const plan: StoredPlan = await readStoredPlan(sessionId, request.params.planId);
				failedRunRequestId = plan.metadata.requestId;
				failedPlanId = plan.metadata.planId;
				activePlanOperation = beginPlanOperationRun(socket, request.id, session, plan);
				if (activePlanOperation === null) {
					return;
				}
				failedAbortSignal = activePlanOperation.abortController.signal;
				const options = withProviderUsageContext(createProviderChatOptions(session, apiKey), {
					requestId: request.id,
					runId: activePlanOperation.runRequestId,
					sessionId: session.sessionId,
					workspaceId: session.activeWorkspace?.id,
					operation: "plan_clarify"
				});
				try {
					const clarificationInput: PlanClarificationInput = request.params.skip === true
						? { kind: "skip" }
						: { kind: "reply", reply: request.params.reply! };
					const updatedPlan: StoredPlan = await applyPlanClarification(
						plan,
						clarificationInput,
						options,
						{
							socket,
							requestId: request.id,
							session,
							mcpHost
						},
						activePlanOperation.abortController.signal
					);
					await emitPlanUpdate(socket, request.id, session, updatedPlan, false);
					sendPlanResponse(socket, request.id, updatedPlan);
					sendSessionEvent(socket, activePlanOperation.runRequestId, session, "agent.run.done", {
						runId: activePlanOperation.runRequestId,
						requestId: activePlanOperation.runRequestId,
						status: "done",
						resultStatus: "completed",
						warnings: [],
						sequence: session.workbenchActiveRun.sequence ?? session.workbenchActiveRunSequence,
						operationRequestId: request.id,
						planId: plan.metadata.planId
					});
				} finally {
					finishPlanOperationRun(socket, session, activePlanOperation);
					activePlanOperation = null;
				}
				return;
			}

			case "plan.revise": {
				const sessionId: string | undefined = getActiveSessionId(session);
				if (sessionId === undefined) {
					throw new Error("Plan revision requires an active session.");
				}
				const apiKey: string | undefined = await ensureProviderConfigured(session);
				if (!apiKey) {
					sendProviderMissing(socket, request.id, session);
					return;
				}
				const plan: StoredPlan = await readStoredPlan(sessionId, request.params.planId);
				failedRunRequestId = plan.metadata.requestId;
				failedPlanId = plan.metadata.planId;
				activePlanOperation = beginPlanOperationRun(socket, request.id, session, plan);
				if (activePlanOperation === null) {
					return;
				}
				failedAbortSignal = activePlanOperation.abortController.signal;
				const options = withProviderUsageContext(createProviderChatOptions(session, apiKey), {
					requestId: request.id,
					runId: activePlanOperation.runRequestId,
					sessionId: session.sessionId,
					workspaceId: session.activeWorkspace?.id,
					operation: "plan_revise"
				});
				try {
					const updatedPlan: StoredPlan = await applyPlanRevision(
						plan,
						request.params.feedback,
						options,
						{
							socket,
							requestId: request.id,
							session,
							mcpHost
						},
						activePlanOperation.abortController.signal
					);
					await emitPlanUpdate(socket, request.id, session, updatedPlan, true);
					sendPlanResponse(socket, request.id, updatedPlan);
					sendSessionEvent(socket, activePlanOperation.runRequestId, session, "agent.run.done", {
						runId: activePlanOperation.runRequestId,
						requestId: activePlanOperation.runRequestId,
						status: "done",
						resultStatus: "completed",
						warnings: [],
						sequence: session.workbenchActiveRun.sequence ?? session.workbenchActiveRunSequence,
						operationRequestId: request.id,
						planId: plan.metadata.planId
					});
				} finally {
					finishPlanOperationRun(socket, session, activePlanOperation);
					activePlanOperation = null;
				}
				return;
			}

			case "plan.approve": {
				const sessionId: string | undefined = getActiveSessionId(session);
				if (sessionId === undefined) {
					throw new Error("Plan approval requires an active session.");
				}
				const plan: StoredPlan = await readStoredPlan(sessionId, request.params.planId);
				if (plan.metadata.status !== "ready") {
					sendJson(socket, {
						type: "response",
						id: request.id,
						ok: false,
						error: {
							code: "plan_not_ready",
							message: "Only ready plans can be approved."
						}
					});
					return;
				}

				const approvedAt: string = new Date().toISOString();
				const executionRequestId: string = `plan-exec-${plan.metadata.planId}-${Date.now().toString(36)}`;
				session.workbenchComposer.chatMode = "agent";
				session.workbenchComposer.updatedAt = approvedAt;
				bumpWorkbenchRevision(session);
				await updateSessionMetadata(sessionId, createRuntimeSessionUiMetadata(session));
				emitWorkbenchUpdated(socket, request.id, session);
				const approvedPlan: StoredPlan = await updateStoredPlan(sessionId, plan.metadata.planId, (current: StoredPlan): StoredPlan => ({
					metadata: {
						...current.metadata,
						status: "approved",
						approvedAt
					},
					markdown: current.markdown
				}));
				// sendSessionEvent(socket, plan.metadata.requestId, session, "plan.approved", {
				// 	...createPlanEventPayload(approvedPlan),
				// 	operationRequestId: request.id
				// });
				const executingPlan: StoredPlan = await updateStoredPlan(sessionId, plan.metadata.planId, (current: StoredPlan): StoredPlan => ({
					metadata: {
						...current.metadata,
						status: "executing",
						executedRequestId: executionRequestId
					},
					markdown: current.markdown
				}));
				const decisionActor = getClientActorSummary(socket);
				sendSessionEvent(socket, executionRequestId, session, "plan.execution.started", {
					...createPlanEventPayload(executingPlan),
					executionRequestId,
					originalRequestId: plan.metadata.requestId,
					...(decisionActor === undefined ? {} : { actor: decisionActor })
				});
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: true,
					result: {
						planApproved: true,
						planId: plan.metadata.planId,
						executionRequestId,
						chatMode: "agent",
						workbench: serializeWorkbench(session)
					}
				});

				const executionParams: AiChatParams = createApprovedPlanExecutionParams(
					plan,
					session.activeProvider,
					session.providerModel ?? session.modelProfile.model,
					session.activeWorkspace === undefined ? undefined : hasGodotWorkspaceCapability(session.activeWorkspace)
				);
				const executionRequest: ClientRequest = {
					type: "request",
					id: executionRequestId,
					method: "ai.chat",
					params: executionParams
				};
				setTimeout((): void => {
					void (async (): Promise<void> => {
						const executionSlotAvailable: boolean = await waitForPlanExecutionSlot(session, plan.metadata.requestId);
						if (!executionSlotAvailable) {
							throw new Error("Timed out waiting for the plan authoring run to finish before executing the approved plan.");
						}
						await handleChatRequest(socket, executionRequest, session, mcpHost);
					})().catch((error: unknown): void => {
						const message: string = error instanceof Error ? error.message : String(error);
						sendSessionEvent(socket, executionRequestId, session, "agent.run.error", {
							runId: executionRequestId,
							requestId: executionRequestId,
							status: "error",
							code: "plan_execution_failed",
							message,
							sequence: session.workbenchActiveRun.sequence ?? session.workbenchActiveRunSequence
						});
						logger.error("plan", "approved_plan_execution_failed", error, {
							planId: plan.metadata.planId,
							sessionId,
							executionRequestId
						});
					});
				}, 0);
				return;
			}

			default:
				throw new Error(`Unsupported plan method: ${request.method}`);
		}
	} catch (error: unknown) {
		const message: string = error instanceof Error ? error.message : String(error);
		if (activePlanOperation !== null) {
			finishPlanOperationRun(socket, session, activePlanOperation);
			activePlanOperation = null;
		}
		if (failedRunRequestId !== undefined && isCancellationError(error, failedAbortSignal)) {
			sendAgentCancelled(socket, failedRunRequestId, session);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					cancelled: true,
					requestId: failedRunRequestId,
					planId: failedPlanId ?? null
				}
			});
			return;
		}
		logger.error("plan", "plan_request_failed", error, {
			requestId: request.id,
			method: request.method,
			sessionId: session.sessionId
		});
		if (failedRunRequestId !== undefined) {
			sendSessionEvent(socket, failedRunRequestId, session, "agent.run.error", {
				runId: failedRunRequestId,
				requestId: failedRunRequestId,
				status: "error",
				sequence: session.workbenchActiveRun.sequence ?? session.workbenchActiveRunSequence,
				operationRequestId: request.id,
				planId: failedPlanId ?? null,
				code: "plan_error",
				message
			});
		}
		sendSessionEvent(socket, request.id, session, "plan.error", {
			requestId: failedRunRequestId ?? request.id,
			operationRequestId: request.id,
			planId: failedPlanId ?? null,
			code: "plan_error",
			message
		});
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: false,
			error: {
				code: "plan_error",
				message
			}
		});
	}
}
