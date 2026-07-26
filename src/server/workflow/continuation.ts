import WebSocket from "ws";
import type { AdditionalContextItem, AiChatParams } from "../../protocol/types.js";
import type { ProviderAgentResult } from "../../providers/agent-types.js";
import type { ProviderChatOptions } from "../../providers/deepseek-client.js";
import { McpHost } from "../../mcp/mcp-host.js";
import { sendJson } from "../send-json.js";
import { createWorkflowPhaseRunId, applyDeterministicVerificationGate, createWorkflowPhaseOutcome } from "../../workflow/outcome.js";
import { appendPhaseOutput, createPhaseMessage, createPhaseParams, updateWorkflowPhaseStatus } from "../../workflow/runner.js";
import type { WorkflowFailedCheck, WorkflowPhase, WorkflowPhaseOutput, WorkflowPlan, WorkflowRunState, WorkflowToolObservation } from "../../workflow/types.js";
import type { ClientSession, PendingAiContinuation } from "../client-session.js";
import { appendChatTurnToSession } from "../token-budget.js";
import { consumePendingGuideSection } from "../pending-guides.js";
import { sendSessionEvent } from "../session-events.js";
import { createPendingAiContinuation, registerPendingApprovalContinuation, sendAgentPaused } from "../approval-continuation.js";
import { createPendingToolBudget, registerPendingToolBudget, sendToolBudgetRequired } from "../tool-budget-continuation.js";
import { reviseLlmWorkflowPlan } from "../../workflow/llm-planner.js";
import { WorkflowExecutionError } from "./workflow-error.js";
import { MAX_WORKFLOW_AUTO_REPAIR_ROUNDS } from "./limits.js";
import type { WorkflowPhaseRunResult, WorkflowPhaseToolStats } from "./shared-types.js";
import {
	createEmptyWorkflowPhaseToolStats,
	createWorkflowWriteGuardRetryMessage,
	didWorkflowWritePhaseExecute,
	getWorkflowWriteGuardRetryAllowedTools,
	shouldRequireWorkflowWriteTool
} from "./tool-events.js";
import { sendWorkflowEvent, sendWorkflowTodoSnapshot } from "./events.js";
import { createRuntimeWorkflowPhase, createWorkflowPhasePrompt, runWorkflowPhase } from "./phase-runner.js";
import { scheduleWorkflowApproval, scheduleWorkflowPhaseOutcome, scheduleWorkflowPhaseStart } from "../../workflow/scheduler.js";
import { logger } from "../../logger.js";
import { withProviderUsageContext } from "../../usage/provider-recorder.js";

const MAX_WORKFLOW_WRITE_GUARD_RETRY_ATTEMPTS: number = 2;

export function collectWorkflowCompletionStatus(
	plan: WorkflowPlan,
	outputs: WorkflowPhaseOutput[]
): {
	resultStatus: "completed" | "completed_with_warnings";
	verificationStatus: "verified" | "unverified";
	warnings: string[];
} {
	const warnings: string[] = [...new Set(outputs.flatMap((output: WorkflowPhaseOutput): string[] => output.warnings ?? []))];
	let lastWriteOutputIndex: number = -1;
	for (let index: number = 0; index < outputs.length; index += 1) {
		const output: WorkflowPhaseOutput | undefined = outputs[index];
		if (output?.toolObservations.some((observation: WorkflowToolObservation): boolean => (
			observation.status === "succeeded"
			&& (observation.risk === "write" || observation.risk === "destructive")
		)) === true) {
			lastWriteOutputIndex = index;
		}
	}

	const hasSuccessfulVerifyAfterWrite: boolean = lastWriteOutputIndex >= 0 && outputs.some((
		output: WorkflowPhaseOutput,
		index: number
	): boolean => {
		if (index <= lastWriteOutputIndex || output.status !== "completed" || output.verificationStatus !== "verified") {
			return false;
		}
		return plan.phases.find((phase: WorkflowPhase): boolean => phase.id === output.phaseId)?.toolGroup === "verify";
	});
	if (lastWriteOutputIndex >= 0 && !hasSuccessfulVerifyAfterWrite) {
		warnings.push("修改已完成，但最后一次写入后没有成功的验证阶段。");
	}

	const uniqueWarnings: string[] = [...new Set(warnings)];
	const verificationStatus: "verified" | "unverified" = lastWriteOutputIndex < 0
		? (uniqueWarnings.length === 0 ? "verified" : "unverified")
		: (hasSuccessfulVerifyAfterWrite && uniqueWarnings.length === 0 ? "verified" : "unverified");
	return {
		resultStatus: uniqueWarnings.length > 0 ? "completed_with_warnings" : "completed",
		verificationStatus,
		warnings: uniqueWarnings
	};
}

export function createFinalSummaryVerificationContext(plan: WorkflowPlan, outputs: WorkflowPhaseOutput[]): string {
	const completionStatus = collectWorkflowCompletionStatus(plan, outputs);
	if (completionStatus.warnings.length === 0) {
		return "";
	}

	return [
		"## 最终交付的验证限制",
		"以下验证限制来自已执行的工具结果。必须在最终总结中用自然、简洁的语言如实说明；不要声称验证已经通过，也不要把这段原文作为系统状态块复述。",
		...completionStatus.warnings.map((warning: string): string => `- ${warning}`)
	].join("\n");
}

function stringifyWorkflowFailedChecks(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value.map((item: unknown): string => String(item)).filter((item: string): boolean => item.length > 0);
}

function createWorkflowWriteGuardOutcome(
	phase: WorkflowPhase,
	phaseRunId: string,
	guardMessage: string,
	agentResultText: string,
	toolObservations: WorkflowToolObservation[]
): WorkflowPhaseOutput {
	const failedChecks: WorkflowFailedCheck[] = [];
	for (const observation of toolObservations) {
		if (observation.status !== "failed") {
			continue;
		}

		const parsedFailedChecks: string[] = stringifyWorkflowFailedChecks(observation.parsedResult?.failedChecks);
		if (parsedFailedChecks.length > 0) {
			for (const message of parsedFailedChecks) {
				failedChecks.push({
					code: "tool_failed_check",
					message,
					toolCallId: observation.toolCallId,
					toolName: observation.toolName,
					artifact: observation.artifactRefs?.[0]
				});
			}
			continue;
		}

		failedChecks.push({
			code: "tool_failed",
			message: observation.error ?? String(observation.parsedResult?.summary ?? `${observation.toolName} failed`),
			toolCallId: observation.toolCallId,
			toolName: observation.toolName,
			artifact: observation.artifactRefs?.[0]
		});
	}

	failedChecks.push({
		code: "write_tool_missing",
		message: guardMessage,
		severity: "error"
	});

	const requiredFixes: string[] = [...new Set(failedChecks.map((check: WorkflowFailedCheck): string => `修复：${check.message}`))];
	return {
		phaseId: phase.id,
		phaseRunId,
		title: phase.title,
		status: "needs_fix",
		summary: guardMessage,
		evidence: failedChecks.map((check: WorkflowFailedCheck): string => check.message),
		failedChecks,
		requiredFixes,
		modifiedArtifacts: [],
		verifiedArtifacts: [],
		toolObservations: toolObservations.map((observation: WorkflowToolObservation): WorkflowToolObservation => ({ ...observation })),
		text: agentResultText
	};
}

function appendCapturedAttachments(state: WorkflowRunState, attachments: AdditionalContextItem[]): WorkflowRunState {
	if (attachments.length === 0) {
		return state;
	}

	const existing: AdditionalContextItem[] = state.capturedAttachments ?? [];
	const ids: Set<string> = new Set(existing.map((attachment: AdditionalContextItem): string => attachment.id));
	const next: AdditionalContextItem[] = [...existing];
	for (const attachment of attachments) {
		if (!ids.has(attachment.id)) {
			next.push(attachment);
			ids.add(attachment.id);
		}
	}
	return { ...state, capturedAttachments: next };
}

export function createWorkflowPendingContinuation(
	phaseParams: AiChatParams,
	options: ProviderChatOptions,
	agentResult: Extract<ProviderAgentResult, { status: "approval_required" }>,
	phase: WorkflowPhase,
	workflowState: WorkflowRunState,
	requestId: string,
	userCreatedAt: string,
	streamPhase: boolean
): PendingAiContinuation {
	return createPendingAiContinuation(
		phaseParams,
		options,
		agentResult.continuation,
		phase.allowedTools,
		workflowState.originalParams.message,
		requestId,
		userCreatedAt,
		streamPhase,
		workflowState
	);
}

export async function continueWorkflowExecution(
	socket: WebSocket,
	requestId: string,
	session: ClientSession,
	mcpHost: McpHost,
	options: ProviderChatOptions,
	workflowState: WorkflowRunState,
	userCreatedAt: string,
	initialAgentResult?: ProviderAgentResult | undefined,
	persistRequestId: string = requestId,
	abortSignal?: AbortSignal | undefined,
	initialToolObservations: WorkflowToolObservation[] = [],
	initialPhaseRunResult?: WorkflowPhaseRunResult | undefined
): Promise<void> {
	let state: WorkflowRunState = workflowState;
	let plan: WorkflowPlan = state.plan;
	let phaseOutputs = state.phaseOutputs;
	let agentResultOverride: ProviderAgentResult | undefined = initialAgentResult;
	let agentResultOverrideToolObservations: WorkflowToolObservation[] = initialToolObservations;
	let phaseRunResultOverride: WorkflowPhaseRunResult | undefined = initialPhaseRunResult;
	const streamFinal: boolean = state.originalParams.options?.stream === true;
	const planningContext: string = state.planningContext ?? "";

	for (let index: number = state.phaseIndex; index < plan.phases.length; index += 1) {
		const candidatePhase: WorkflowPhase | undefined = plan.phases[index];
		if (candidatePhase === undefined) {
			break;
		}
		const phaseRunId: string = createWorkflowPhaseRunId(candidatePhase.id);
		const startCommand = scheduleWorkflowPhaseStart({ ...state, plan, phaseIndex: index, phaseOutputs }, phaseRunId);
		if (startCommand.type === "finish") {
			break;
		}
		if (startCommand.type === "blocked_before_start") {
			state = startCommand.state;
			plan = state.plan;
			phaseOutputs = state.phaseOutputs;
			sendWorkflowEvent(socket, requestId, session, "workflow.phase.outcome", {
				workflowId: plan.id,
				phaseId: startCommand.phase.id,
				phaseRunId,
				outcome: startCommand.outcome
			}, persistRequestId);
			sendWorkflowTodoSnapshot(socket, requestId, session, plan, persistRequestId, phaseOutputs, phaseRunId);
			throw new WorkflowExecutionError(startCommand.outcome.summary, plan, new Error(startCommand.outcome.summary), phaseOutputs);
		}

		const phase: WorkflowPhase = startCommand.phase;
		state = startCommand.state;
		plan = state.plan;
		phaseOutputs = state.phaseOutputs;
		sendWorkflowEvent(socket, requestId, session, "workflow.phase.started", {
			workflowId: plan.id,
			phaseId: phase.id,
			phaseRunId,
			title: phase.title,
			toolGroup: phase.toolGroup ?? null,
			skillId: phase.skillId ?? null,
			acceptanceCriteria: phase.acceptanceCriteria ?? [],
			repairOf: phase.repairOf ?? null,
			repairRound: phase.repairRound ?? 0
		}, persistRequestId);
		sendWorkflowTodoSnapshot(socket, requestId, session, plan, persistRequestId, phaseOutputs, phaseRunId);

		const isFinalPhase: boolean = index >= plan.phases.length - 1;
		if (plan.phases.length > 1 && isFinalPhase && phase.toolGroup === "summarize") {
			sendSessionEvent(socket, requestId, session, "agent.summary.started", {
				runId: plan.id,
				stepId: phase.id,
				stepRunId: phaseRunId,
				title: phase.title,
				foldTitle: "总结前的过程"
			}, persistRequestId);
		}

		const finalSummaryVerificationContext: string = plan.phases.length > 1 && isFinalPhase && phase.toolGroup === "summarize"
			? createFinalSummaryVerificationContext(plan, phaseOutputs)
			: "";
		const phaseMessage: string = [
			createPhaseMessage(state.originalParams, plan, phase, phaseOutputs),
			finalSummaryVerificationContext
		].filter((section: string): boolean => section.length > 0).join("\n\n");
		// 流式请求的所有阶段都走流式通路，避免非最终阶段在长时间推理时完全没有进度事件。
		const streamPhase: boolean = streamFinal;
		const phaseParams: AiChatParams = createPhaseParams(state.originalParams, phase, phaseMessage, streamPhase);
		const carriedGuidePromptSection: string = state.guidePromptSection ?? "";
		state = { ...state, guidePromptSection: undefined };
		const pendingGuidePromptSection: string = consumePendingGuideSection(socket, requestId, session, persistRequestId);
		const guidePromptSection: string = [
			carriedGuidePromptSection,
			pendingGuidePromptSection
		].filter((section: string): boolean => section.length > 0).join("\n\n");
		const runtimePhase: WorkflowPhase = createRuntimeWorkflowPhase(phase, mcpHost, session);
		const fullSystemPrompt: string = await createWorkflowPhasePrompt(runtimePhase, phaseParams, mcpHost, session, requestId, guidePromptSection);
		let agentResult: ProviderAgentResult;
		let phaseToolStats: WorkflowPhaseToolStats = createEmptyWorkflowPhaseToolStats();
		let phaseToolObservations: WorkflowToolObservation[] = [];
		try {
			if (phaseRunResultOverride !== undefined) {
				agentResult = phaseRunResultOverride.agentResult;
				phaseToolStats = phaseRunResultOverride.toolStats;
				phaseToolObservations = phaseRunResultOverride.toolObservations;
				state = appendCapturedAttachments(state, phaseRunResultOverride.capturedAttachments);
				phaseRunResultOverride = undefined;
			} else if (agentResultOverride !== undefined) {
				agentResult = agentResultOverride;
				phaseToolStats.approvalEvents = 1;
				phaseToolStats.writeToolEvents = 1;
				phaseToolStats.successfulWriteToolEvents = 1;
				phaseToolObservations = agentResultOverrideToolObservations.length > 0 ? agentResultOverrideToolObservations : [{
					toolCallId: `${phaseRunId}-approved-continuation`,
					toolName: "approved_tool_continuation",
					risk: "write",
					status: "succeeded",
					parsedResult: {
						ok: true,
						validationStatus: "passed",
						summary: "审批通过后的工具调用已执行，LLM continuation 已恢复。"
					},
					artifactRefs: []
				}];
				agentResultOverrideToolObservations = [];
			} else {
				let phaseRunResult: WorkflowPhaseRunResult = await runWorkflowPhase(
					socket,
					phaseParams,
					options,
					state.history,
					fullSystemPrompt,
					runtimePhase,
					mcpHost,
					session,
					requestId,
					persistRequestId,
					plan.id,
					phaseRunId,
					streamPhase,
					abortSignal
				);
				agentResult = phaseRunResult.agentResult;
				phaseToolStats = phaseRunResult.toolStats;
				phaseToolObservations = phaseRunResult.toolObservations;
				state = appendCapturedAttachments(state, phaseRunResult.capturedAttachments);

				let writeGuardRetryAttempt: number = 0;
				while (
					agentResult.status === "completed"
					&& shouldRequireWorkflowWriteTool(phase)
					&& !didWorkflowWritePhaseExecute(phase, phaseToolStats)
					&& writeGuardRetryAttempt < MAX_WORKFLOW_WRITE_GUARD_RETRY_ATTEMPTS
				) {
					writeGuardRetryAttempt += 1;
					const retryAllowedTools: string[] = getWorkflowWriteGuardRetryAllowedTools(phase);
					const retryPhase: WorkflowPhase = retryAllowedTools.length > 0
						? { ...phase, allowedTools: retryAllowedTools }
						: phase;
					const retryPhaseParams: AiChatParams = createPhaseParams(
						state.originalParams,
						retryPhase,
						createWorkflowWriteGuardRetryMessage(phaseMessage, retryAllowedTools, writeGuardRetryAttempt, agentResult.text),
						false
					);
					retryPhaseParams.options = {
						...(retryPhaseParams.options ?? {}),
						requireToolCallOnFirstStep: true
					} as AiChatParams["options"] & Record<string, unknown>;
					phaseRunResult = await runWorkflowPhase(
						socket,
						retryPhaseParams,
						options,
						state.history,
						fullSystemPrompt,
						retryPhase,
						mcpHost,
						session,
						requestId,
						persistRequestId,
						plan.id,
						phaseRunId,
						false,
						abortSignal
					);
					agentResult = phaseRunResult.agentResult;
					phaseToolStats = phaseRunResult.toolStats;
					phaseToolObservations = phaseRunResult.toolObservations;
					state = appendCapturedAttachments(state, phaseRunResult.capturedAttachments);
				}
			}
		} catch (error: unknown) {
			throw new WorkflowExecutionError(error instanceof Error ? error.message : "Workflow phase failed", plan, error);
		}
		agentResultOverride = undefined;

		if (agentResult.status === "approval_required") {
			const approvalOutcome: WorkflowPhaseOutput = createWorkflowPhaseOutcome(phase, phaseRunId, "", phaseToolObservations);
			const approvalCommand = scheduleWorkflowApproval({ ...state, plan, phaseIndex: index, phaseOutputs }, phase, approvalOutcome, phaseRunId);
			state = approvalCommand.state;
			plan = state.plan;
			phaseOutputs = state.phaseOutputs;
			const pausedState: WorkflowRunState = state;
			const pendingContinuation: PendingAiContinuation = createWorkflowPendingContinuation(
				phaseParams,
				options,
				agentResult,
				phase,
				pausedState,
				persistRequestId,
				userCreatedAt,
				streamPhase
			);
			await registerPendingApprovalContinuation(session, mcpHost, agentResult.approvalId, pendingContinuation);
			sendWorkflowEvent(socket, requestId, session, "workflow.phase.outcome", {
				workflowId: plan.id,
				phaseId: phase.id,
				phaseRunId,
				outcome: approvalCommand.outcome
			}, persistRequestId);
			sendWorkflowTodoSnapshot(socket, requestId, session, plan, persistRequestId, phaseOutputs, phaseRunId);
			sendAgentPaused(socket, requestId, session, plan.id, agentResult, persistRequestId);
			return;
		}

		if (agentResult.status === "tool_budget_required") {
			const budgetOutcome: WorkflowPhaseOutput = {
				...createWorkflowPhaseOutcome(phase, phaseRunId, "", phaseToolObservations),
				status: "approval_required",
				summary: "工具调用预算已达到上限，等待用户决定是否继续。",
				requiredFixes: ["用户需要决定是否追加工具调用预算。"],
				blockedReason: agentResult.reason
			};
			const budgetCommand = scheduleWorkflowApproval({ ...state, plan, phaseIndex: index, phaseOutputs }, phase, budgetOutcome, phaseRunId);
			state = budgetCommand.state;
			plan = state.plan;
			phaseOutputs = state.phaseOutputs;
			const pausedState: WorkflowRunState = state;
			const pendingBudget = createPendingToolBudget({
				agentResult,
				chatParams: phaseParams,
				options,
				allowedToolNames: runtimePhase.allowedTools,
				userMessage: pausedState.originalParams.message,
				requestId: persistRequestId,
				userCreatedAt,
				stream: streamPhase,
				workflowState: pausedState,
				workflowPhaseToolStats: phaseToolStats,
				workflowToolObservations: phaseToolObservations
			});
			registerPendingToolBudget(session, pendingBudget);
			sendWorkflowEvent(socket, requestId, session, "workflow.phase.outcome", {
				workflowId: plan.id,
				phaseId: phase.id,
				phaseRunId,
				outcome: budgetCommand.outcome
			}, persistRequestId);
			sendWorkflowTodoSnapshot(socket, requestId, session, plan, persistRequestId, phaseOutputs, phaseRunId);
			sendToolBudgetRequired(socket, requestId, session, plan.id, pendingBudget, persistRequestId);
			return;
		}

		if (agentResult.status === "protocol_violation") {
			const protocolOutcome: WorkflowPhaseOutput = {
				phaseId: phase.id,
				phaseRunId,
				title: phase.title,
				status: "blocked",
				summary: agentResult.reason,
				evidence: [],
				failedChecks: [{
					code: "protocol_violation",
					message: agentResult.reason,
					severity: "error"
				}],
				requiredFixes: ["模型必须通过 API tool_calls 调用工具，不能在文本中输出 XML/DSML/裸工具标签。"],
				modifiedArtifacts: [],
				verifiedArtifacts: [],
				toolObservations: phaseToolObservations,
				blockedReason: agentResult.reason
			};
			phaseOutputs = appendPhaseOutput(phaseOutputs, phase, protocolOutcome);
			plan = updateWorkflowPhaseStatus(plan, phase.id, "failed");
			sendWorkflowEvent(socket, requestId, session, "workflow.phase.outcome", {
				workflowId: plan.id,
				phaseId: phase.id,
				phaseRunId,
				outcome: protocolOutcome
			}, persistRequestId);
			sendWorkflowTodoSnapshot(socket, requestId, session, plan, persistRequestId, phaseOutputs, phaseRunId);
			throw new WorkflowExecutionError(agentResult.reason, plan, new Error(agentResult.reason), phaseOutputs);
		}

		if (shouldRequireWorkflowWriteTool(phase) && !didWorkflowWritePhaseExecute(phase, phaseToolStats)) {
			const guardMessage: string = `写入阶段「${phase.title}」没有实际调用写入工具或触发审批，已阻止将该 Todo 标记为完成。`;
			const guardOutcome: WorkflowPhaseOutput = createWorkflowWriteGuardOutcome(phase, phaseRunId, guardMessage, agentResult.text, phaseToolObservations);
			const guardCommand = scheduleWorkflowPhaseOutcome(state, phase, guardOutcome, MAX_WORKFLOW_AUTO_REPAIR_ROUNDS);
			state = guardCommand.state;
			plan = state.plan;
			phaseOutputs = state.phaseOutputs;
			if (guardCommand.type === "repair") {
				sendWorkflowEvent(socket, requestId, session, "workflow.phase.outcome", {
					workflowId: plan.id,
					phaseId: phase.id,
					phaseRunId,
					outcome: guardCommand.outcome
				}, persistRequestId);
				sendWorkflowTodoSnapshot(socket, requestId, session, plan, persistRequestId, phaseOutputs);
				continue;
			}
			if (guardCommand.type === "failed") {
				sendWorkflowEvent(socket, requestId, session, "workflow.phase.outcome", {
					workflowId: plan.id,
					phaseId: phase.id,
					phaseRunId,
					outcome: guardCommand.outcome
				}, persistRequestId);
				sendWorkflowTodoSnapshot(socket, requestId, session, plan, persistRequestId, phaseOutputs);
				throw new WorkflowExecutionError(guardCommand.outcome.summary, plan, new Error(guardMessage), phaseOutputs);
			}
			throw new WorkflowExecutionError("Workflow scheduler returned an unexpected write guard command", plan, new Error("workflow_write_guard_unexpected_command"), phaseOutputs);
		}

		const phaseOutcome: WorkflowPhaseOutput = applyDeterministicVerificationGate(
			phase,
			createWorkflowPhaseOutcome(phase, phaseRunId, agentResult.text, phaseToolObservations),
			phaseOutputs
		);
		const outcomeCommand = scheduleWorkflowPhaseOutcome(state, phase, phaseOutcome, MAX_WORKFLOW_AUTO_REPAIR_ROUNDS);
		state = outcomeCommand.state;
		plan = state.plan;
		phaseOutputs = state.phaseOutputs;
		if (outcomeCommand.type === "repair") {
			sendWorkflowEvent(socket, requestId, session, "workflow.phase.outcome", {
				workflowId: plan.id,
				phaseId: phase.id,
				phaseRunId,
				outcome: outcomeCommand.outcome
			}, persistRequestId);
			sendWorkflowTodoSnapshot(socket, requestId, session, plan, persistRequestId, phaseOutputs);
			continue;
		}
		if (outcomeCommand.type === "failed") {
			sendWorkflowEvent(socket, requestId, session, "workflow.phase.outcome", {
				workflowId: plan.id,
				phaseId: phase.id,
				phaseRunId,
				outcome: outcomeCommand.outcome
			}, persistRequestId);
			sendWorkflowTodoSnapshot(socket, requestId, session, plan, persistRequestId, phaseOutputs);
			throw new WorkflowExecutionError(
				outcomeCommand.outcome.summary,
				plan,
				new Error(`${outcomeCommand.outcome.summary}\n\n${outcomeCommand.outcome.requiredFixes.join("\n")}`),
				phaseOutputs
			);
		}
		if (outcomeCommand.type !== "complete_phase") {
			throw new WorkflowExecutionError("Workflow scheduler returned an unexpected command", plan, new Error("workflow_scheduler_unexpected_command"), phaseOutputs);
		}
		sendWorkflowEvent(socket, requestId, session, "workflow.phase.outcome", {
			workflowId: plan.id,
			phaseId: phase.id,
			phaseRunId,
			outcome: outcomeCommand.outcome
		}, persistRequestId);
		sendWorkflowEvent(socket, requestId, session, "workflow.phase.done", {
			workflowId: plan.id,
			phaseId: phase.id,
			phaseRunId,
			title: phase.title
		}, persistRequestId);
		sendWorkflowTodoSnapshot(socket, requestId, session, plan, persistRequestId, phaseOutputs);

		if (isFinalPhase) {
			const completionStatus = collectWorkflowCompletionStatus(plan, phaseOutputs);
			await appendChatTurnToSession(
				session,
				state.history,
				state.originalParams.message,
				agentResult.text,
				persistRequestId,
				userCreatedAt,
				undefined,
				[
					...(state.originalParams.additionalContext ?? []),
					...(state.capturedAttachments ?? [])
				]
			);
			sendWorkflowEvent(socket, requestId, session, "workflow.done", {
				workflowId: plan.id,
				requestId: persistRequestId,
				sequence: session.workbenchActiveRun.sequence ?? session.workbenchActiveRunSequence,
				title: plan.title,
				resultStatus: completionStatus.resultStatus,
				verificationStatus: completionStatus.verificationStatus,
				warnings: completionStatus.warnings
			}, persistRequestId);

			if (streamFinal) {
				sendSessionEvent(socket, requestId, session, "agent.message.done", {
					runId: plan.id,
					stepRunId: phaseRunId,
					text: agentResult.text,
					context: {
						historyMessagesStored: session.messages.length,
						historyBudgetTokens: state.historyBudgetTokens,
						mcpServers: mcpHost.getConnectedServerIds()
					}
				}, persistRequestId);
				sendJson(socket, {
					type: "response",
					id: requestId,
					ok: true,
					result: {
						text: agentResult.text,
						context: {
							historyMessagesStored: session.messages.length,
							historyBudgetTokens: state.historyBudgetTokens,
							mcpServers: mcpHost.getConnectedServerIds()
						}
					}
				});
			} else {
				sendSessionEvent(socket, requestId, session, "agent.message.done", {
					runId: plan.id,
					stepRunId: phaseRunId,
					text: agentResult.text,
					context: {
						historyMessagesStored: session.messages.length,
						historyBudgetTokens: state.historyBudgetTokens,
						mcpServers: mcpHost.getConnectedServerIds()
					}
				}, persistRequestId);
				sendJson(socket, {
					type: "response",
					id: requestId,
					ok: true,
					result: {
						text: agentResult.text,
						context: {
							historyMessagesStored: session.messages.length,
							historyBudgetTokens: state.historyBudgetTokens,
							mcpServers: mcpHost.getConnectedServerIds()
						}
					}
				});
			}
			return;
		}

		if (plan.source === "llm") {
			try {
				const revisionGuidePromptSection: string = consumePendingGuideSection(socket, requestId, session, persistRequestId);
				const revisionPlanningContext: string = [
					planningContext,
					revisionGuidePromptSection
				].filter((section: string): boolean => section.length > 0).join("\n\n");
				if (revisionGuidePromptSection.length > 0) {
					state = {
						...state,
						guidePromptSection: [
							state.guidePromptSection ?? "",
							revisionGuidePromptSection
						].filter((section: string): boolean => section.length > 0).join("\n\n")
					};
				}
				const revisedPlan: WorkflowPlan = await reviseLlmWorkflowPlan(
					plan,
					index,
					state.originalParams,
					phaseOutputs,
					withProviderUsageContext(options, {
						operation: "workflow_planner_revision"
					}),
					state.history,
					revisionPlanningContext,
					abortSignal
				);
				if ((revisedPlan.revision ?? 0) !== (plan.revision ?? 0)) {
					plan = revisedPlan;
					state = { ...state, plan, phaseIndex: index + 1, phaseOutputs };
					sendWorkflowTodoSnapshot(socket, requestId, session, plan, persistRequestId, phaseOutputs);
				}
			} catch (error: unknown) {
				logger.error("workflow", "plan_revision_failed", error, {
					requestId,
					sessionId: session.sessionId,
					workflowId: state.plan.id,
					phaseIndex: index
				}, "Continuing current workflow plan");
			}
		}
	}
}
