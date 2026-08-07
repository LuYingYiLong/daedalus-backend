import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ToolApplicabilityCode } from "../tools/tool-applicability.js";
import type { WorkflowTodoSnapshot } from "./types.js";
import type { WorkspaceFileRef } from "../workspace/source-context.js";
import type { WorkflowTargetKind, WorkflowValidationCapability } from "./tool-semantics.js";
import type { ToolFailure } from "../tools/tool-failure.js";

export const AGENT_RUN_STATE_SCHEMA_VERSION = 2 as const;

export type AgentRunIntent = "answer" | "inspect" | "mutate";
export type AgentRunScope = "bounded" | "unknown" | "complex";
/** Normal workspace chat: tools are optional and no workflow control signal is required. */
export type AgentRunLane = "direct" | "read" | "tool_assisted" | "probe" | "lightweight" | "workflow";
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
export type AgentRunResultStatus = "completed" | "completed_with_warnings" | "blocked" | "failed" | "cancelled";

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
	artifactFileRefs?: WorkspaceFileRef[] | undefined;
	sourceFolderId?: string | undefined;
	summary?: string | undefined;
	validationStatus?: "passed" | "failed" | "not_applicable" | undefined;
	environmentIssue?: boolean | undefined;
	applicabilityCode?: ToolApplicabilityCode | undefined;
	validationCapabilities?: WorkflowValidationCapability[] | undefined;
	repairFamilies?: WorkflowTargetKind[] | undefined;
	failure?: ToolFailure | undefined;
	/** A completed, approval-governed terminal command may support complete_read only. */
	terminalObservation?: boolean | undefined;
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

export type ExecutionDisposition = "complete_read" | "no_change" | "use_lightweight" | "use_workflow" | "blocked";
export type ExecutionTargetKind = "workspace_file" | "godot_script" | "godot_scene" | "godot_script_scene" | "project_setting" | "unknown";

export type ExecutionDecision = {
	disposition: ExecutionDisposition;
	summary: string;
	evidenceToolCallIds: string[];
	expectedArtifacts: string[];
	expectedFileRefs?: WorkspaceFileRef[] | undefined;
	expectedLogicalWrites?: number | undefined;
	targetKind: ExecutionTargetKind;
};

export const executionDecisionToolInputSchema = z.object({
	disposition: z.enum(["complete_read", "no_change", "use_lightweight", "use_workflow", "blocked"]),
	summary: z.string().trim().min(1).max(2000),
	evidenceToolCallIds: z.array(z.string().trim().min(1).max(200)).max(64).default([]),
	expectedArtifacts: z.array(z.string().trim().min(1).max(1000)).max(64).default([]),
	expectedFileRefs: z.array(z.object({
		workspaceId: z.string().trim().min(1).max(200),
		sourceFolderId: z.string().trim().min(1).max(200),
		relativePath: z.string().trim().min(1).max(1000)
	}).strict()).max(64).optional(),
	expectedLogicalWrites: z.number().int().min(0).max(64).optional(),
	targetKind: z.enum(["workspace_file", "godot_script", "godot_scene", "godot_script_scene", "project_setting", "unknown"]).default("unknown")
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
	if (decision.disposition === "use_lightweight" && decision.targetKind === "unknown") {
		context.addIssue({
			code: "custom",
			path: ["targetKind"],
			message: "use_lightweight requires a concrete target kind."
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
	const evidenceReferences: string[] = decision.evidenceToolCallIds;
	const resolvedIds: string[] = [];
	for (const evidenceReference of evidenceReferences) {
		const exactEvidence: ExecutionEvidence | undefined = evidenceById.get(evidenceReference);
		const evidence: ExecutionEvidence | undefined = exactEvidence;
		if (evidence !== undefined && isEvidenceEligibleForDecision(evidence, decision.disposition) && !resolvedIds.includes(evidence.toolCallId)) {
			resolvedIds.push(evidence.toolCallId);
		}
	}

	const expectedArtifacts: string[] | null = normalizeExpectedArtifacts(decision.expectedArtifacts);
	const normalized: ExecutionDecision = {
		...decision,
		evidenceToolCallIds: resolvedIds,
		expectedArtifacts: expectedArtifacts ?? decision.expectedArtifacts
	};
	if (normalized.disposition === "complete_read") {
		if (expectedArtifacts === null) {
			return createBlockedExecutionDecision(normalized, "The read completion contains an unsafe workspace path.");
		}
		if (decision.evidenceToolCallIds.length > 0 && resolvedIds.length !== decision.evidenceToolCallIds.length) {
			return createBlockedExecutionDecision(normalized, "The read completion cited evidence that was not successfully observed in this run.");
		}
		return {
			...normalized,
			expectedArtifacts: [],
			expectedLogicalWrites: undefined,
			targetKind: "unknown"
		};
	}
	if (expectedArtifacts === null) {
		return createBlockedExecutionDecision(normalized, "The execution target contains an unsafe workspace path.");
	}
	if (normalized.targetKind !== "unknown" && normalized.expectedArtifacts.length === 0) {
		return createBlockedExecutionDecision(normalized, "A declared target kind requires explicit expected artifacts.");
	}
	if (normalized.disposition === "no_change" && resolvedIds.length === 0) {
		return createBlockedExecutionDecision(normalized, "The no-change decision did not cite successful read or verify evidence.");
	}
	if (normalized.disposition !== "use_lightweight") {
		return normalized;
	}
	if (resolvedIds.length === 0) {
		return createBlockedExecutionDecision(normalized, "A lightweight write requires successful read or verify evidence.");
	}
	if (normalized.expectedLogicalWrites === undefined || normalized.expectedLogicalWrites < 1 || normalized.expectedLogicalWrites > 2) {
		return createBlockedExecutionDecision(normalized, "A lightweight write must declare one or two logical writes.");
	}
	if (normalized.expectedArtifacts.length !== 1 || normalized.targetKind === "unknown" || normalized.targetKind === "godot_script_scene") {
		return createBlockedExecutionDecision(normalized, "A lightweight write requires one concrete, bounded target.");
	}
	return normalized;
}

function isReadOrVerifyEvidence(evidence: ExecutionEvidence): boolean {
	return evidence.status === "succeeded"
		&& (evidence.risk === "read" || evidence.risk === "verify")
		&& evidence.environmentIssue !== true
		&& evidence.validationStatus !== "not_applicable";
}

function isEvidenceEligibleForDecision(evidence: ExecutionEvidence, disposition: ExecutionDisposition): boolean {
	if (isReadOrVerifyEvidence(evidence)) {
		return true;
	}
	return disposition === "complete_read"
		&& evidence.terminalObservation === true
		&& evidence.toolName === "mcp_terminal_run_command"
		&& evidence.risk === "write"
		&& evidence.status === "succeeded"
		&& evidence.environmentIssue !== true
		&& evidence.validationStatus !== "not_applicable";
}

function createBlockedExecutionDecision(decision: ExecutionDecision, summary: string): ExecutionDecision {
	return {
		...decision,
		disposition: "blocked",
		summary,
		expectedLogicalWrites: undefined,
		targetKind: "unknown"
	};
}

export function inferExecutionTargetKind(artifacts: readonly string[]): ExecutionTargetKind {
	return artifacts.length > 0 ? "workspace_file" : "unknown";
}

function normalizeExpectedArtifacts(artifacts: readonly string[]): string[] | null {
	const normalized: string[] = [];
	for (const artifact of artifacts) {
		const value: string = artifact.trim().replaceAll("\\", "/").replace(/^res:\/\//iu, "").replace(/^\.\//u, "");
		if (
			value.length === 0
			|| value.startsWith("/")
			|| /^[a-z]:\//iu.test(value)
			|| value.split("/").some((segment: string): boolean => segment === "..")
		) {
			return null;
		}
		normalized.push(value);
	}
	return normalized;
}

export function cloneAgentRunState(state: AgentRunState): AgentRunState {
	return structuredClone(state);
}

function cloneExecutionEvidence(evidence: ExecutionEvidence): ExecutionEvidence {
	return {
		...evidence,
		artifactRefs: [...evidence.artifactRefs],
		artifactFileRefs: evidence.artifactFileRefs?.map((fileRef: WorkspaceFileRef): WorkspaceFileRef => ({ ...fileRef })),
		validationCapabilities: evidence.validationCapabilities === undefined ? undefined : [...evidence.validationCapabilities],
		repairFamilies: evidence.repairFamilies === undefined ? undefined : [...evidence.repairFamilies],
		failure: evidence.failure === undefined ? undefined : {
			...evidence.failure,
			artifactRefs: [...evidence.failure.artifactRefs],
			artifactFileRefs: evidence.failure.artifactFileRefs?.map((fileRef: WorkspaceFileRef): WorkspaceFileRef => ({ ...fileRef })),
			details: evidence.failure.details === undefined ? undefined : { ...evidence.failure.details }
		}
	};
}
