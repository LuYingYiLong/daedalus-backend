import {
	listAgentRunStates,
	markActiveAgentRunsInterrupted,
	readAgentRunContinuation,
	removeAgentRunContinuation
} from "../session/agent-run-store.js";
import type { PendingAiContinuation } from "../session/pending-continuation.js";
import type { PendingToolBudget } from "../session/pending-tool-budget.js";
import type { AgentRunState } from "../workflow/agent-run-state.js";
import type { ClientSession } from "./client-session.js";
import { isLegacyWorkflowContinuation, isLegacyWorkflowRunState } from "./legacy-workflow-guard.js";

function restoreApiKey<T extends PendingAiContinuation>(continuation: T, apiKey: string): T {
	return {
		...structuredClone(continuation),
		options: {
			...continuation.options,
			apiKey
		}
	};
}

export async function hydrateAgentRunRuntime(
	session: ClientSession,
	apiKey?: string | undefined
): Promise<AgentRunState[]> {
	const sessionId: string | undefined = session.sessionId;
	if (sessionId === undefined) {
		return [];
	}
	await markActiveAgentRunsInterrupted(sessionId);
	const states: AgentRunState[] = await listAgentRunStates(sessionId);
	session.agentRuns.clear();
	session.agentRunToolCalls.clear();
	for (const state of states) {
		session.agentRuns.set(state.runId, state);
		session.agentRunToolCalls.set(state.runId, new Map());
		if (isLegacyWorkflowRunState(state)) {
			const persistedLegacy = await readAgentRunContinuation(state.runId);
			if (persistedLegacy !== null && isLegacyWorkflowContinuation(
				persistedLegacy.kind === "approval" ? persistedLegacy.continuation : persistedLegacy.pending.continuation
			)) {
				await removeAgentRunContinuation(state.runId);
			}
			continue;
		}
		if (
			apiKey === undefined
			|| (state.stage !== "awaiting_approval" && state.stage !== "awaiting_tool_budget")
		) {
			continue;
		}
		const persisted = await readAgentRunContinuation(state.runId);
		if (persisted?.kind === "approval") {
			session.pendingAiContinuations.set(
				persisted.pauseId,
				restoreApiKey(persisted.continuation, apiKey)
			);
			continue;
		}
		if (persisted?.kind === "tool_budget") {
			const pending: PendingToolBudget = structuredClone(persisted.pending);
			pending.continuation = restoreApiKey(pending.continuation, apiKey);
			session.pendingToolBudgets.set(persisted.pauseId, pending);
		}
	}
	return states;
}

export function serializeAgentRunRuntime(session: ClientSession): {
	agentRuns: AgentRunState[];
	activeAgentRun: AgentRunState | null;
} {
	const agentRuns: AgentRunState[] = [...session.agentRuns.values()]
		.sort((left: AgentRunState, right: AgentRunState): number => left.updatedAt.localeCompare(right.updatedAt))
		.map((state: AgentRunState): AgentRunState => structuredClone(state));
	const activeAgentRun: AgentRunState | null = [...agentRuns]
		.reverse()
		.find((state: AgentRunState): boolean => (
			state.stage !== "completed"
			&& state.stage !== "failed"
			&& state.stage !== "cancelled"
			&& state.stage !== "interrupted"
		)) ?? null;
	return { agentRuns, activeAgentRun };
}
