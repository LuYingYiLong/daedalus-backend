import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { WorkflowTodoSnapshot } from "./types.js";

export const AGENT_RUN_STATE_SCHEMA_VERSION = 1 as const;

export type AgentRunIntent = "answer" | "inspect" | "mutate";
export type AgentRunScope = "bounded" | "unknown" | "complex";
export type AgentRunLane = "direct" | "read" | "probe" | "lightweight" | "workflow";
export type AgentRunStage =
	| "routing"
	| "probing"
	| "executing"
	| "verifying"
	| "awaiting_approval"
	| "awaiting_tool_budget"
	| "interrupted"
	| "finalizing"
	| "completed"
	| "failed"
	| "cancelled";

export type AgentRunVerificationStatus = "verified" | "unverified" | "failed";
export type AgentRunResultStatus = "completed" | "completed_with_warnings" | "failed" | "cancelled";

export type AgentRunPause =
	| {
		kind: "approval";
		id: string;
		toolName: string;
		reason: string;
	}
	| {
		kind: "tool_budget";
		id: string;
		reason: string;
	};

export type AgentRunTerminal = {
	resultStatus: AgentRunResultStatus;
	message?: string | undefined;
	completedAt: string;
};

export type ExecutionEvidence = {
	toolCallId: string;
	toolName: string;
	risk: "read" | "verify" | "propose" | "write" | "destructive";
	status: "succeeded" | "failed";
	artifactRefs: string[];
	summary?: string | undefined;
	validationStatus?: "passed" | "failed" | "not_applicable" | undefined;
	environmentIssue?: boolean | undefined;
	resultExcerpt?: string | undefined;
	observedAt: string;
};

export type AgentRunCheckpoint = {
	successfulWriteFingerprints: string[];
	evidence: ExecutionEvidence[];
	lastWriteAt?: string | undefined;
};

export type AgentRunState = {
	schemaVersion: typeof AGENT_RUN_STATE_SCHEMA_VERSION;
	runId: string;
	sessionId: string;
	requestId: string;
	rootRequestId: string;
	retryOfRunId?: string | undefined;
	goalId?: string | undefined;
	goalCycle?: number | undefined;
	revision: number;
	intent: AgentRunIntent;
	scope: AgentRunScope;
	lane: AgentRunLane;
	stage: AgentRunStage;
	title: string;
	planId: string | null;
	todo: WorkflowTodoSnapshot | null;
	pause: AgentRunPause | null;
	verificationStatus: AgentRunVerificationStatus | null;
	warnings: string[];
	terminal: AgentRunTerminal | null;
	checkpoint: AgentRunCheckpoint;
	executionDecision?: ExecutionDecision | undefined;
	interruptedReason?: string | undefined;
	createdAt: string;
	updatedAt: string;
};

export type AgentRunStatePatch = Partial<Omit<
	AgentRunState,
	"schemaVersion" | "runId" | "sessionId" | "requestId" | "rootRequestId" | "revision" | "createdAt" | "updatedAt"
>>;

export type ExecutionDisposition = "no_change" | "use_lightweight" | "use_workflow" | "blocked";

export type ExecutionDecision = {
	disposition: ExecutionDisposition;
	summary: string;
	evidenceToolCallIds: string[];
	expectedArtifacts: string[];
	expectedLogicalWrites?: number | undefined;
};

export const executionDecisionToolInputSchema = z.object({
	disposition: z.enum(["no_change", "use_lightweight", "use_workflow", "blocked"]),
	summary: z.string().trim().min(1).max(2000),
	evidenceToolCallIds: z.array(z.string().trim().min(1).max(200)).max(64).default([]),
	expectedArtifacts: z.array(z.string().trim().min(1).max(1000)).max(64).default([]),
	expectedLogicalWrites: z.number().int().min(0).max(2).optional()
}).strict();

export const executionDecisionSchema = executionDecisionToolInputSchema.superRefine((decision, context): void => {
	if (decision.disposition === "no_change" && decision.evidenceToolCallIds.length === 0) {
		context.addIssue({
			code: "custom",
			path: ["evidenceToolCallIds"],
			message: "no_change requires at least one evidence tool call id."
		});
	}
	if (decision.disposition === "use_lightweight" && decision.expectedLogicalWrites === undefined) {
		context.addIssue({
			code: "custom",
			path: ["expectedLogicalWrites"],
			message: "use_lightweight requires expectedLogicalWrites."
		});
	}
});

const TERMINAL_STAGES: ReadonlySet<AgentRunStage> = new Set(["completed", "failed", "cancelled"]);
const LEGAL_STAGE_TRANSITIONS: Readonly<Record<AgentRunStage, ReadonlySet<AgentRunStage>>> = {
	routing: new Set(["probing", "executing", "finalizing", "interrupted", "failed", "cancelled"]),
	probing: new Set(["executing", "finalizing", "awaiting_approval", "awaiting_tool_budget", "interrupted", "failed", "cancelled"]),
	executing: new Set(["verifying", "finalizing", "awaiting_approval", "awaiting_tool_budget", "interrupted", "failed", "cancelled"]),
	verifying: new Set(["executing", "finalizing", "awaiting_approval", "awaiting_tool_budget", "interrupted", "failed", "cancelled"]),
	awaiting_approval: new Set(["executing", "verifying", "interrupted", "failed", "cancelled"]),
	awaiting_tool_budget: new Set(["executing", "verifying", "finalizing", "interrupted", "failed", "cancelled"]),
	interrupted: new Set(["cancelled"]),
	finalizing: new Set(["interrupted", "completed", "failed", "cancelled"]),
	completed: new Set(),
	failed: new Set(),
	cancelled: new Set()
};

export function createAgentRunState(params: {
	sessionId: string;
	requestId: string;
	rootRequestId?: string | undefined;
	retryOfRunId?: string | undefined;
	goalId?: string | undefined;
	goalCycle?: number | undefined;
	intent?: AgentRunIntent | undefined;
	scope?: AgentRunScope | undefined;
	lane?: AgentRunLane | undefined;
	title?: string | undefined;
	runId?: string | undefined;
	now?: string | undefined;
}): AgentRunState {
	const now: string = params.now ?? new Date().toISOString();
	return {
		schemaVersion: AGENT_RUN_STATE_SCHEMA_VERSION,
		runId: params.runId ?? `run-${randomUUID()}`,
		sessionId: params.sessionId,
		requestId: params.requestId,
		rootRequestId: params.rootRequestId ?? params.requestId,
		retryOfRunId: params.retryOfRunId,
		goalId: params.goalId,
		goalCycle: params.goalCycle,
		revision: 1,
		intent: params.intent ?? "answer",
		scope: params.scope ?? "bounded",
		lane: params.lane ?? "direct",
		stage: "routing",
		title: params.title?.trim() || "Daedalus task",
		planId: null,
		todo: null,
		pause: null,
		verificationStatus: null,
		warnings: [],
		terminal: null,
		checkpoint: {
			successfulWriteFingerprints: [],
			evidence: []
		},
		executionDecision: undefined,
		createdAt: now,
		updatedAt: now
	};
}

export function transitionAgentRunState(
	current: AgentRunState,
	nextStage: AgentRunStage,
	patch: AgentRunStatePatch = {},
	now: string = new Date().toISOString()
): AgentRunState {
	if (TERMINAL_STAGES.has(current.stage)) {
		throw new Error(`Agent run ${current.runId} is already terminal (${current.stage}).`);
	}
	if (nextStage !== current.stage && !LEGAL_STAGE_TRANSITIONS[current.stage].has(nextStage)) {
		throw new Error(`Illegal agent run transition: ${current.stage} -> ${nextStage}.`);
	}

	const terminal: AgentRunTerminal | null = patch.terminal ?? current.terminal;
	if (TERMINAL_STAGES.has(nextStage) && terminal === null) {
		throw new Error(`Terminal agent run stage ${nextStage} requires terminal metadata.`);
	}
	if (!TERMINAL_STAGES.has(nextStage) && terminal !== null) {
		throw new Error(`Non-terminal agent run stage ${nextStage} cannot contain terminal metadata.`);
	}

	return {
		...current,
		...patch,
		stage: nextStage,
		revision: current.revision + 1,
		updatedAt: now,
		warnings: patch.warnings === undefined ? [...current.warnings] : [...patch.warnings],
		checkpoint: patch.checkpoint === undefined
			? {
				...current.checkpoint,
				successfulWriteFingerprints: [...current.checkpoint.successfulWriteFingerprints],
				evidence: current.checkpoint.evidence.map(cloneExecutionEvidence)
			}
			: {
				...patch.checkpoint,
				successfulWriteFingerprints: [...patch.checkpoint.successfulWriteFingerprints],
				evidence: patch.checkpoint.evidence.map(cloneExecutionEvidence)
			}
	};
}

export function interruptRecoverableAgentRun(
	current: AgentRunState,
	reason: string = "backend_restart",
	now: string = new Date().toISOString()
): AgentRunState {
	if (TERMINAL_STAGES.has(current.stage) || current.stage === "interrupted") {
		return current;
	}
	if (current.stage === "awaiting_approval" || current.stage === "awaiting_tool_budget") {
		return current;
	}
	return transitionAgentRunState(current, "interrupted", {
		pause: null,
		interruptedReason: reason
	}, now);
}

export function validateExecutionDecisionEvidence(
	run: AgentRunState,
	decision: ExecutionDecision
): ExecutionDecision {
	const currentRunEvidence: ExecutionEvidence[] = run.checkpoint.evidence.filter((evidence: ExecutionEvidence): boolean => (
		evidence.observedAt >= run.createdAt
	));
	const evidenceById: Map<string, ExecutionEvidence> = new Map(
		currentRunEvidence.map((item: ExecutionEvidence): [string, ExecutionEvidence] => [item.toolCallId, item])
	);
	const usableEvidence: ExecutionEvidence[] = currentRunEvidence.filter((evidence: ExecutionEvidence): boolean => (
		evidence.status === "succeeded"
		&& (evidence.risk === "read" || evidence.risk === "verify")
	));
	const resolvedIds: string[] = [];
	for (const evidenceReference of decision.evidenceToolCallIds) {
		const exactEvidence: ExecutionEvidence | undefined = evidenceById.get(evidenceReference);
		const semanticMatches: ExecutionEvidence[] = exactEvidence === undefined
			? usableEvidence.filter((evidence: ExecutionEvidence): boolean => (
				evidence.toolName === evidenceReference
				|| evidence.artifactRefs.some((artifactRef: string): boolean => (
					`${evidence.toolName}:${artifactRef}` === evidenceReference
				))
			))
			: [];
		const evidence: ExecutionEvidence | undefined = exactEvidence ?? (semanticMatches.length === 1 ? semanticMatches[0] : undefined);
		if (
			evidence !== undefined
			&& evidence.status === "succeeded"
			&& (evidence.risk === "read" || evidence.risk === "verify")
			&& !resolvedIds.includes(evidence.toolCallId)
		) {
			resolvedIds.push(evidence.toolCallId);
		}
	}

	if (decision.disposition === "no_change" && decision.evidenceToolCallIds.length === 0) {
		for (const evidence of usableEvidence.slice(-64)) resolvedIds.push(evidence.toolCallId);
	}

	if (decision.disposition === "no_change" && resolvedIds.length === 0) {
		return {
			...decision,
			disposition: "use_workflow",
			evidenceToolCallIds: [],
			expectedLogicalWrites: undefined
		};
	}

	return {
		...decision,
		evidenceToolCallIds: resolvedIds
	};
}

export function cloneAgentRunState(state: AgentRunState): AgentRunState {
	return structuredClone(state);
}

function cloneExecutionEvidence(evidence: ExecutionEvidence): ExecutionEvidence {
	return {
		...evidence,
		artifactRefs: [...evidence.artifactRefs]
	};
}
