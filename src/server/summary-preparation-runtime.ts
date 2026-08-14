import type WebSocket from "ws";
import type { AgentRunState, AgentSummaryPreparation } from "../workflow/agent-run-state.js";
import { collectUnresolvedExecutionFailures, formatExecutionFailure } from "../workflow/evidence-failures.js";
import type { SummaryPreparationContext, SummaryPreparationInput } from "../tools/summary-control.js";
import type { ClientSession } from "./client-session.js";
import { getAgentRun, updateAgentRun } from "./agent-run-controller.js";
import { sendSessionEvent } from "./session-events.js";

export type SummaryPreparationEvaluation = {
	ready: boolean;
	remainingTodoItems: string[];
	unresolvedFailures: string[];
	warnings: string[];
};

function collectRemainingTodoItems(run: AgentRunState): string[] {
	if (run.todo?.source !== "agent_loop") return [];
	const remaining: string[] = [];
	for (const phase of run.todo.phases) {
		if (phase.status !== "done") remaining.push(phase.title);
	}
	for (const todo of run.todo.todos) {
		if (todo.status !== "done" && !remaining.includes(todo.text)) remaining.push(todo.text);
	}
	return remaining.slice(0, 12);
}

export function evaluateSummaryPreparation(run: AgentRunState): SummaryPreparationEvaluation {
	const remainingTodoItems: string[] = collectRemainingTodoItems(run);
	const unresolvedFailures: string[] = collectUnresolvedExecutionFailures(run.checkpoint.evidence)
		.map(formatExecutionFailure)
		.slice(0, 12);
	const environmentWarnings: string[] = run.checkpoint.evidence
		.filter((item): boolean => item.status === "failed" && item.failure?.category === "environment")
		.map(formatExecutionFailure)
		.slice(0, 12);
	const changedWorkspace: boolean = run.checkpoint.evidence.some((item): boolean => (
		item.status === "succeeded" && (item.risk === "write" || item.risk === "destructive")
	));
	const verified: boolean = run.checkpoint.evidence.some((item): boolean => (
		item.status === "succeeded"
			&& item.risk === "verify"
			&& item.validationStatus !== "not_applicable"
	));
	const warnings: string[] = [];
	warnings.push(...environmentWarnings);
	if (changedWorkspace && !verified) {
		warnings.push("Workspace changes have no successful verification evidence; report them as unverified.");
	}
	if (unresolvedFailures.length > 0) {
		warnings.push("Unresolved tool failures must be explained instead of being presented as successful work.");
	}
	return {
		ready: remainingTodoItems.length === 0 && unresolvedFailures.length === 0,
		remainingTodoItems,
		unresolvedFailures,
		warnings
	};
}

function createPreparationState(
	evaluation: SummaryPreparationEvaluation,
	preparedAt: string
): AgentSummaryPreparation {
	return {
		ready: evaluation.ready,
		remainingTodoItems: [...evaluation.remainingTodoItems],
		unresolvedFailures: [...evaluation.unresolvedFailures],
		warnings: [...evaluation.warnings],
		preparedAt
	};
}

export function createSummaryPreparationControl(params: {
	socket: WebSocket;
	session: ClientSession;
	runId: string;
}): SummaryPreparationContext {
	return {
		async execute(_input: SummaryPreparationInput): Promise<Record<string, unknown>> {
			const run: AgentRunState | undefined = getAgentRun(params.session, params.runId);
			if (run === undefined || run.lane !== "agent_loop" || run.terminal !== null) {
				throw new Error("Summary preparation is not available for the current run.");
			}
			if (run.stage !== "executing" && run.stage !== "verifying") {
				throw new Error(`Summary preparation is not available while the run is ${run.stage}.`);
			}

			const evaluation: SummaryPreparationEvaluation = evaluateSummaryPreparation(run);
			const preparedAt: string = new Date().toISOString();
			const wasReady: boolean = run.summaryPreparation?.ready === true;
			updateAgentRun(params.socket, params.session, params.runId, run.stage, {
				summaryPreparation: createPreparationState(evaluation, preparedAt)
			});

			if (evaluation.ready && !wasReady) {
				sendSessionEvent(params.socket, params.runId, params.session, "agent.summary.started", {
					runId: params.runId,
					stepId: "summarize",
					stepRunId: `${params.runId}:summary`,
					title: "总结前检查",
					foldTitle: "总结前的过程"
				});
			}

			return {
				ok: true,
				ready: evaluation.ready,
				action: evaluation.ready ? "summarize" : "continue_agent_loop",
				remainingTodoItems: evaluation.remainingTodoItems,
				unresolvedFailures: evaluation.unresolvedFailures,
				warnings: evaluation.warnings,
				summary: evaluation.ready
					? "Summary checkpoint passed. Write the final user-facing summary now."
					: "Summary checkpoint found unfinished work. Continue the Agent Loop and do not summarize as complete."
			};
		}
	};
}
