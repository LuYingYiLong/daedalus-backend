import type WebSocket from "ws";
import type { AgentRunState } from "../workflow/agent-run-state.js";
import type { ClientSession } from "./client-session.js";
import type { ApprovalMode } from "../tools/tool-policy.js";

export type GoalRunBinding = {
	goalId: string;
	cycle: number;
	rootRequestId: string;
	approvalMode: ApprovalMode;
};

type GoalRunListener = (socket: WebSocket, session: ClientSession, state: AgentRunState) => void;

const bindings = new Map<string, GoalRunBinding>();
let listener: GoalRunListener | null = null;

export function bindGoalRun(requestId: string, binding: GoalRunBinding): void {
	bindings.set(requestId, binding);
}

export function getGoalRunBinding(requestId: string): GoalRunBinding | undefined {
	return bindings.get(requestId);
}

export function releaseGoalRunBinding(requestId: string): void {
	bindings.delete(requestId);
}

export function registerGoalRunListener(next: GoalRunListener): void {
	listener = next;
}

export function notifyGoalRunState(socket: WebSocket, session: ClientSession, state: AgentRunState): void {
	if (state.goalId !== undefined) listener?.(socket, session, state);
}
