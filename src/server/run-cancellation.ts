import { readAgentRunState } from "../session/agent-run-store.js";
import type { AgentRunState } from "../workflow/agent-run-state.js";
import type { ClientSession } from "./client-session.js";

export type CancellationTargetContext = {
	requestedRequestId: string;
	requestWithController?: string | undefined;
	activeSessionRequestId?: string | undefined;
	activeGoalRunId?: string | null | undefined;
	activeRuntimeRequestId?: string | undefined;
};

export function isAgentRunTerminal(state: AgentRunState): boolean {
	return state.stage === "completed" || state.stage === "failed" || state.stage === "cancelled";
}

export function canForceCancelAgentRun(state: AgentRunState): boolean {
	return !isAgentRunTerminal(state);
}

export function shouldTerminalizeReturnedAgentRun(state: AgentRunState): boolean {
	return state.stage !== "completed"
		&& state.stage !== "failed"
		&& state.stage !== "cancelled"
		&& state.stage !== "interrupted"
		&& state.stage !== "awaiting_approval"
		&& state.stage !== "awaiting_tool_budget";
}

export function resolveCancellationTargetRequestId(context: CancellationTargetContext): string {
	return context.requestWithController
		?? context.activeSessionRequestId
		?? context.activeGoalRunId
		?? context.activeRuntimeRequestId
		?? context.requestedRequestId;
}

function findMatchingInMemoryRun(session: ClientSession, candidateIds: readonly string[]): AgentRunState | undefined {
	const candidateSet = new Set(candidateIds);
	return [...session.agentRuns.values()]
		.filter((state: AgentRunState): boolean => (
			canForceCancelAgentRun(state)
			&& (
				candidateSet.has(state.runId)
				|| candidateSet.has(state.requestId)
				|| candidateSet.has(state.rootRequestId)
			)
		))
		.sort((left: AgentRunState, right: AgentRunState): number => right.updatedAt.localeCompare(left.updatedAt))[0];
}

export async function findCancellableAgentRun(
	session: ClientSession,
	candidateIds: readonly (string | null | undefined)[]
): Promise<AgentRunState | null> {
	const normalizedIds: string[] = [...new Set(candidateIds.filter(
		(candidateId: string | null | undefined): candidateId is string => typeof candidateId === "string" && candidateId.length > 0
	))];
	const inMemory = findMatchingInMemoryRun(session, normalizedIds);
	if (inMemory !== undefined) return inMemory;

	for (const candidateId of normalizedIds) {
		const persisted: AgentRunState | null = await readAgentRunState(candidateId);
		if (
			persisted !== null
			&& canForceCancelAgentRun(persisted)
			&& (session.sessionId === undefined || persisted.sessionId === session.sessionId)
		) {
			return persisted;
		}
	}
	return null;
}
