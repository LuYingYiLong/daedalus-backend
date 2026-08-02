import { randomUUID } from "node:crypto";

export const AGENT_GOAL_STATE_SCHEMA_VERSION = 1 as const;

export type AgentGoalStage =
	| "readiness"
	| "running"
	| "evaluating"
	| "pausing"
	| "awaiting_approval"
	| "awaiting_tool_budget"
	| "paused"
	| "achieved"
	| "failed"
	| "cancelled";

export type AgentGoalPauseReason =
	| "user_interruption"
	| "backend_restart"
	| "client_disconnected"
	| "budget_exhausted"
	| "readiness_blocked"
	| "no_progress";

export type GoalReadinessCheck = {
	id: string;
	status: "passed" | "warning" | "blocked";
	message: string;
	action?: string | undefined;
};

export type GoalReadinessReport = {
	ready: boolean;
	checks: GoalReadinessCheck[];
	checkedAt: string;
};

export type GoalEvaluation = {
	disposition: "achieved" | "continue" | "blocked";
	summary: string;
	evidenceToolCallIds: string[];
	unmetCriteria: string[];
	nextAction: string | null;
};

export type GoalCheckpointSummary = {
	status: "available" | "partial" | "unavailable" | "rolled_back";
	fileCount: number;
	totalBytes: number;
	unavailableReasons: string[];
};

export type AgentGoalState = {
	schemaVersion: typeof AGENT_GOAL_STATE_SCHEMA_VERSION;
	goalId: string;
	sessionId: string;
	rootRequestId: string;
	revision: number;
	title: string;
	condition: string;
	stage: AgentGoalStage;
	pauseReason: AgentGoalPauseReason | null;
	activeRunId: string | null;
	cycle: number;
	modelSnapshot: {
		provider: string;
		model: string;
		reasoningEffort: string | null;
		approvalMode: string;
		workspaceId: string | null;
	};
	budget: {
		maxCycles: number;
		maxTokens: number;
		maxActiveMinutes: number;
	};
	usage: {
		cycles: number;
		tokens: number;
		activeMilliseconds: number;
		estimatedTokens: boolean;
	};
	readiness: GoalReadinessReport | null;
	evaluation: GoalEvaluation | null;
	checkpoint: GoalCheckpointSummary;
	createdAt: string;
	updatedAt: string;
	completedAt: string | null;
};

export type AgentGoalStatePatch = Partial<Omit<
	AgentGoalState,
	"schemaVersion" | "goalId" | "sessionId" | "rootRequestId" | "revision" | "createdAt" | "updatedAt"
>>;

const TERMINAL_STAGES: ReadonlySet<AgentGoalStage> = new Set(["achieved", "failed", "cancelled"]);
const LEGAL_TRANSITIONS: Readonly<Record<AgentGoalStage, ReadonlySet<AgentGoalStage>>> = {
	readiness: new Set(["running", "paused", "failed", "cancelled"]),
	running: new Set(["evaluating", "pausing", "awaiting_approval", "awaiting_tool_budget", "paused", "failed", "cancelled"]),
	evaluating: new Set(["running", "paused", "achieved", "failed", "cancelled"]),
	pausing: new Set(["paused", "awaiting_approval", "awaiting_tool_budget", "failed", "cancelled"]),
	awaiting_approval: new Set(["running", "pausing", "paused", "failed", "cancelled"]),
	awaiting_tool_budget: new Set(["running", "pausing", "paused", "failed", "cancelled"]),
	paused: new Set(["readiness", "cancelled"]),
	achieved: new Set(),
	failed: new Set(),
	cancelled: new Set()
};

export function isAgentGoalTerminal(stage: AgentGoalStage): boolean {
	return TERMINAL_STAGES.has(stage);
}

export function hasAgentGoalBudget(state: AgentGoalState): boolean {
	return state.usage.cycles < state.budget.maxCycles
		&& state.usage.tokens < state.budget.maxTokens
		&& state.usage.activeMilliseconds < state.budget.maxActiveMinutes * 60_000;
}

export function createAgentGoalState(params: {
	sessionId: string;
	rootRequestId: string;
	title: string;
	condition: string;
	modelSnapshot: AgentGoalState["modelSnapshot"];
	goalId?: string | undefined;
	now?: string | undefined;
}): AgentGoalState {
	const now: string = params.now ?? new Date().toISOString();
	return {
		schemaVersion: AGENT_GOAL_STATE_SCHEMA_VERSION,
		goalId: params.goalId ?? `goal-${randomUUID()}`,
		sessionId: params.sessionId,
		rootRequestId: params.rootRequestId,
		revision: 1,
		title: params.title.trim().slice(0, 160) || "Daedalus goal",
		condition: params.condition.trim(),
		stage: "readiness",
		pauseReason: null,
		activeRunId: null,
		cycle: 0,
		modelSnapshot: structuredClone(params.modelSnapshot),
		budget: { maxCycles: 12, maxTokens: 1_000_000, maxActiveMinutes: 180 },
		usage: { cycles: 0, tokens: 0, activeMilliseconds: 0, estimatedTokens: false },
		readiness: null,
		evaluation: null,
		checkpoint: { status: "available", fileCount: 0, totalBytes: 0, unavailableReasons: [] },
		createdAt: now,
		updatedAt: now,
		completedAt: null
	};
}

export function transitionAgentGoalState(
	current: AgentGoalState,
	nextStage: AgentGoalStage,
	patch: AgentGoalStatePatch = {},
	now: string = new Date().toISOString()
): AgentGoalState {
	if (isAgentGoalTerminal(current.stage) && nextStage !== current.stage) {
		throw new Error(`Agent goal ${current.goalId} is already terminal (${current.stage}).`);
	}
	if (nextStage !== current.stage && !LEGAL_TRANSITIONS[current.stage].has(nextStage)) {
		throw new Error(`Illegal agent goal transition: ${current.stage} -> ${nextStage}.`);
	}
	const terminal: boolean = isAgentGoalTerminal(nextStage);
	return {
		...current,
		...patch,
		stage: nextStage,
		revision: current.revision + 1,
		updatedAt: now,
		completedAt: terminal ? (patch.completedAt ?? current.completedAt ?? now) : null,
		budget: patch.budget === undefined ? { ...current.budget } : { ...patch.budget },
		usage: patch.usage === undefined ? { ...current.usage } : { ...patch.usage },
		modelSnapshot: patch.modelSnapshot === undefined ? { ...current.modelSnapshot } : { ...patch.modelSnapshot },
		checkpoint: patch.checkpoint === undefined
			? { ...current.checkpoint, unavailableReasons: [...current.checkpoint.unavailableReasons] }
			: { ...patch.checkpoint, unavailableReasons: [...patch.checkpoint.unavailableReasons] },
		readiness: patch.readiness === undefined ? current.readiness : structuredClone(patch.readiness),
		evaluation: patch.evaluation === undefined ? current.evaluation : structuredClone(patch.evaluation)
	};
}

export function cloneAgentGoalState(state: AgentGoalState): AgentGoalState {
	return structuredClone(state);
}
