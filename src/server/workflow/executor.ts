import WebSocket from "ws";
import type { AiChatParams, ChatMessage } from "../../protocol/types.js";
import type { ProviderChatOptions } from "../../providers/deepseek-client.js";
import { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession } from "../client-session.js";
import { isCancellationError, throwIfAborted } from "../request-lifecycle.js";
import { markRemainingWorkflowTodos } from "../../workflow/runner.js";
import type { WorkflowPhase, WorkflowPhaseOutput, WorkflowPlan } from "../../workflow/types.js";
import { canWriteToWorkspace } from "../../workflow/router.js";
import { hasProviderResponseStalledError, WorkflowExecutionError } from "./workflow-error.js";
import { sendWorkflowEvent, sendWorkflowTodoSnapshot } from "./events.js";
import { continueWorkflowExecution } from "./continuation.js";

export async function startWorkflowExecution(
	socket: WebSocket,
	requestId: string,
	session: ClientSession,
	mcpHost: McpHost,
	options: ProviderChatOptions,
	plan: WorkflowPlan,
	originalParams: AiChatParams,
	history: ChatMessage[],
	historyBudgetTokens: number,
	userCreatedAt: string,
	planningContext: string = "",
	guidePromptSection: string = "",
	abortSignal?: AbortSignal | undefined
): Promise<void> {
	throwIfAborted(abortSignal);
	if (!canWriteToWorkspace(originalParams)) {
		throw new Error("Workspace workflow requires structured outputTarget=workspace authorization.");
	}
	sendWorkflowEvent(socket, requestId, session, "workflow.started", {
		workflowId: plan.id,
		requestId,
		sequence: session.workbenchActiveRun.sequence ?? session.workbenchActiveRunSequence,
		title: plan.title,
		source: plan.source ?? "fixed",
		revision: plan.revision ?? 0,
		phases: plan.phases.map((phase: WorkflowPhase) => ({
			id: phase.id,
			title: phase.title,
			toolGroup: phase.toolGroup ?? null,
			skillId: phase.skillId ?? null
		}))
	});
	sendWorkflowTodoSnapshot(socket, requestId, session, plan);
	try {
		await continueWorkflowExecution(socket, requestId, session, mcpHost, options, {
			plan,
			phaseIndex: 0,
			phaseOutputs: [],
			originalParams,
			history,
			historyBudgetTokens,
			planningContext,
			guidePromptSection
		}, userCreatedAt, undefined, requestId, abortSignal);
	} catch (error: unknown) {
		const latestPlan: WorkflowPlan = error instanceof WorkflowExecutionError ? error.plan : plan;
		const latestPhaseOutputs: WorkflowPhaseOutput[] = error instanceof WorkflowExecutionError ? error.phaseOutputs : [];
		if (isCancellationError(error instanceof WorkflowExecutionError ? error.originalError : error, abortSignal)) {
			const pausedPlan: WorkflowPlan = markRemainingWorkflowTodos(latestPlan, "paused");
			sendWorkflowTodoSnapshot(socket, requestId, session, pausedPlan, requestId, latestPhaseOutputs);
			throw error;
		}
		if (hasProviderResponseStalledError(error)) {
			const pausedPlan: WorkflowPlan = markRemainingWorkflowTodos(latestPlan, "paused");
			sendWorkflowTodoSnapshot(socket, requestId, session, pausedPlan, requestId, latestPhaseOutputs);
			throw error;
		}
		const failedPlan: WorkflowPlan = markRemainingWorkflowTodos(latestPlan, "failed");
		sendWorkflowTodoSnapshot(socket, requestId, session, failedPlan, requestId, latestPhaseOutputs);
		sendWorkflowEvent(socket, requestId, session, "workflow.error", {
			workflowId: latestPlan.id,
			requestId,
			sequence: session.workbenchActiveRun.sequence ?? session.workbenchActiveRunSequence,
			title: latestPlan.title,
			code: "agent_run_error",
			message: error instanceof Error ? error.message : "Workflow failed"
		});
		throw error;
	}
}
