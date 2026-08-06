import type { AiChatParams } from "../protocol/types.js";
import { getWorkflowToolsForProfile } from "./execution-profile.js";
import { createVisibleWorkflowTodos } from "./todos.js";
import type { WorkflowExecutionProfileId } from "./execution-profile.js";
import type { WorkflowPhase, WorkflowPlan } from "./types.js";

export type WorkflowVerificationPolicy = "required" | "best_effort" | "skip";

export function getWorkflowVerificationPolicy(params: AiChatParams): WorkflowVerificationPolicy {
	return params.options?.verificationPolicy ?? "best_effort";
}

/**
 * Applies the caller-owned verification policy after every plan source has been
 * normalized. This is deliberately independent of model prose and planner output.
 */
export function applyWorkflowVerificationPolicy(
	plan: WorkflowPlan,
	params: AiChatParams
): WorkflowPlan {
	return applyWorkflowVerificationPolicyValue(plan, getWorkflowVerificationPolicy(params));
}

export function applyWorkflowVerificationPolicyValue(
	plan: WorkflowPlan,
	verificationPolicy: WorkflowVerificationPolicy
): WorkflowPlan {
	const withoutVerify: WorkflowPhase[] = verificationPolicy === "skip"
		? plan.phases.filter((phase: WorkflowPhase): boolean => phase.toolGroup !== "verify")
		: [...plan.phases];
	const phases: WorkflowPhase[] = verificationPolicy === "required"
		? ensureRequiredVerificationPhase(withoutVerify, plan.executionProfile ?? "godot")
		: withoutVerify;
	return {
		...plan,
		verificationPolicy,
		phases,
		todos: createVisibleWorkflowTodos(phases)
	};
}

function ensureRequiredVerificationPhase(
	phases: WorkflowPhase[],
	executionProfile: WorkflowExecutionProfileId
): WorkflowPhase[] {
	const lastWritePhaseIndex: number = phases.reduce((lastIndex: number, phase: WorkflowPhase, index: number): number => (
		phase.toolGroup === "write" ? index : lastIndex
	), -1);
	const hasWritePhase: boolean = lastWritePhaseIndex >= 0;
	const hasVerifyAfterWrite: boolean = phases.some((phase: WorkflowPhase, index: number): boolean => (
		index > lastWritePhaseIndex && phase.toolGroup === "verify"
	));
	if (!hasWritePhase || hasVerifyAfterWrite) {
		return phases;
	}

	const verifyPhase: WorkflowPhase = {
		id: createRequiredVerifyPhaseId(phases),
		title: "Verify change",
		toolGroup: "verify",
		toolBudget: "normal",
		allowedTools: getWorkflowToolsForProfile(executionProfile, "verify"),
		instruction: "Run an applicable non-mutating verification for the completed change. Report any unavailable diagnostic as a warning; do not modify files in this phase.",
		acceptanceCriteria: ["An applicable verification was run after the write, with no unresolved blocking failure."],
		requireToolCallOnFirstStep: true
	};
	const summarizeIndex: number = phases.findIndex((phase: WorkflowPhase): boolean => phase.toolGroup === "summarize");
	return summarizeIndex < 0
		? [...phases, verifyPhase]
		: [...phases.slice(0, summarizeIndex), verifyPhase, ...phases.slice(summarizeIndex)];
}

function createRequiredVerifyPhaseId(phases: WorkflowPhase[]): string {
	const usedIds: Set<string> = new Set(phases.map((phase: WorkflowPhase): string => phase.id));
	let suffix: number = 1;
	let candidate: string = "verify-required";
	while (usedIds.has(candidate)) {
		suffix += 1;
		candidate = `verify-required-${suffix}`;
	}
	return candidate;
}
