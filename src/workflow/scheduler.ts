import { appendPhaseOutput, updateWorkflowPhaseStatus } from "./runner.js";
import { countWorkflowAutoRepairRounds, insertWorkflowAutoRepairPhases, resolveRepairWriteTools, shouldUseVerifyOnlyRepair } from "./repair.js";
import { scopeVerificationOutcomeToRegisteredTargets } from "./outcome.js";
import type { WorkflowPhase, WorkflowPhaseOutput, WorkflowPlan, WorkflowRunState } from "./types.js";

export type WorkflowSchedulerCommand =
	| { type: "run_phase"; state: WorkflowRunState; phase: WorkflowPhase }
	| { type: "blocked_before_start"; state: WorkflowRunState; phase: WorkflowPhase; outcome: WorkflowPhaseOutput }
	| { type: "pause_for_approval"; state: WorkflowRunState; phase: WorkflowPhase; outcome: WorkflowPhaseOutput }
	| { type: "repair"; state: WorkflowRunState; phase: WorkflowPhase; outcome: WorkflowPhaseOutput }
	| { type: "graceful_blocked"; state: WorkflowRunState; phase: WorkflowPhase; outcome: WorkflowPhaseOutput }
	| { type: "failed"; state: WorkflowRunState; phase: WorkflowPhase; outcome: WorkflowPhaseOutput }
	| { type: "complete_phase"; state: WorkflowRunState; phase: WorkflowPhase; outcome: WorkflowPhaseOutput }
	| { type: "finish"; state: WorkflowRunState };

function createFailureSignature(outcome: WorkflowPhaseOutput): string {
	const checks: string[] = outcome.failedChecks
		.map((check): string => `${check.code}:${check.toolName ?? ""}:${check.artifact ?? ""}:${check.message}`)
		.sort();
	return checks.length > 0 ? checks.join("|") : outcome.summary.trim().toLowerCase();
}

function hasFileMutationProgress(outputs: readonly WorkflowPhaseOutput[], afterIndex: number): boolean {
	return outputs.slice(afterIndex + 1).some((output: WorkflowPhaseOutput): boolean => (
		output.toolObservations.some((observation): boolean => (observation.fileEditFingerprints?.length ?? 0) > 0)
	));
}

function hasRepeatedRepairFailure(state: WorkflowRunState, phase: WorkflowPhase, outcome: WorkflowPhaseOutput): boolean {
	if (phase.toolGroup !== "verify" || phase.repairRound === undefined || countWorkflowAutoRepairRounds(state.plan) < 1) {
		return false;
	}
	const signature: string = createFailureSignature(outcome);
	let previousFailureIndex: number = -1;
	for (let index: number = state.phaseOutputs.length - 1; index >= 0; index -= 1) {
		const previous: WorkflowPhaseOutput = state.phaseOutputs[index]!;
		if (previous.status === "needs_fix" && createFailureSignature(previous) === signature) {
			previousFailureIndex = index;
			break;
		}
	}
	return previousFailureIndex >= 0 && !hasFileMutationProgress(state.phaseOutputs, previousFailureIndex);
}

function completeVerificationWithWarnings(
	state: WorkflowRunState,
	phase: WorkflowPhase,
	outcome: WorkflowPhaseOutput,
	message: string
): Extract<WorkflowSchedulerCommand, { type: "complete_phase" }> {
	const warningDetails: string[] = outcome.failedChecks.map((check): string => (
		`[${check.failureCode ?? check.code}] ${check.message}`
	));
	const completedOutcome: WorkflowPhaseOutput = {
		...outcome,
		status: "completed",
		summary: message,
		failedChecks: [],
		requiredFixes: [],
		verificationStatus: "unverified",
		warnings: [...new Set([...(outcome.warnings ?? []), message, ...warningDetails])],
		blockedReason: undefined
	};
	const plan: WorkflowPlan = updateWorkflowPhaseStatus(state.plan, phase.id, "done");
	return {
		type: "complete_phase",
		phase,
		outcome: completedOutcome,
		state: {
			...state,
			plan,
			phaseIndex: state.phaseIndex + 1,
			phaseOutputs: appendPhaseOutput(state.phaseOutputs, phase, completedOutcome)
		}
	};
}

function scheduleGracefulBlocked(
	state: WorkflowRunState,
	phase: WorkflowPhase,
	outcome: WorkflowPhaseOutput
): Extract<WorkflowSchedulerCommand, { type: "graceful_blocked" }> {
	const blockedOutcome: WorkflowPhaseOutput = {
		...outcome,
		status: "blocked",
		blockedReason: outcome.blockedReason ?? outcome.summary
	};
	const summarizeIndex: number = state.plan.phases.findIndex((candidate: WorkflowPhase, index: number): boolean => (
		index > state.phaseIndex && candidate.toolGroup === "summarize"
	));
	const stopIndex: number = summarizeIndex < 0 ? state.plan.phases.length : summarizeIndex;
	const skippedPhases: WorkflowPhase[] = state.plan.phases.slice(state.phaseIndex + 1, stopIndex);
	const skippedPhaseIds: ReadonlySet<string> = new Set(skippedPhases.map((candidate: WorkflowPhase): string => candidate.id));
	const skippedOutputs: WorkflowPhaseOutput[] = skippedPhases.map((candidate: WorkflowPhase): WorkflowPhaseOutput => ({
		phaseId: candidate.id,
		phaseRunId: `skipped-${candidate.id}`,
		title: candidate.title,
		status: "skipped",
		summary: `Skipped because phase ${phase.title} could not complete.`,
		evidence: [],
		failedChecks: [],
		requiredFixes: [],
		modifiedArtifacts: [],
		verifiedArtifacts: [],
		toolObservations: [],
		sourcePhaseId: phase.id,
		warnings: [blockedOutcome.blockedReason ?? blockedOutcome.summary]
	}));
	const failedPlan: WorkflowPlan = updateWorkflowPhaseStatus(state.plan, phase.id, "failed");
	const plan: WorkflowPlan = {
		...failedPlan,
		todos: failedPlan.todos.map((todo) => skippedPhaseIds.has(todo.phaseId)
			? { ...todo, status: "skipped" }
			: todo)
	};
	return {
		type: "graceful_blocked",
		phase,
		outcome: blockedOutcome,
		state: {
			...state,
			plan,
			phaseIndex: stopIndex,
			phaseOutputs: [
				...appendPhaseOutput(state.phaseOutputs, phase, blockedOutcome),
				...skippedOutputs
			]
		}
	};
}

export function scheduleWorkflowPhaseStart(state: WorkflowRunState, phaseRunId: string): WorkflowSchedulerCommand {
	const phase: WorkflowPhase | undefined = state.plan.phases[state.phaseIndex];
	if (phase === undefined) {
		return { type: "finish", state };
	}

	const plan: WorkflowPlan = updateWorkflowPhaseStatus(state.plan, phase.id, "running");
	return {
		type: "run_phase",
		phase,
		state: { ...state, plan, activePhaseRunId: phaseRunId }
	};
}

export function scheduleWorkflowPhaseOutcome(
	state: WorkflowRunState,
	phase: WorkflowPhase,
	outcome: WorkflowPhaseOutput,
	maxAutoRepairRounds: number
): WorkflowSchedulerCommand {
	outcome = scopeVerificationOutcomeToRegisteredTargets(state.plan, state.phaseOutputs, outcome);
	if (outcome.status === "needs_fix") {
		if (phase.toolGroup !== "write" && phase.toolGroup !== "verify") {
			const message: string = `Phase "${phase.title}" is neither a write nor a verification phase, so its failure cannot be repaired through automatic writes.`;
			const blockedOutcome: WorkflowPhaseOutput = {
				...outcome,
				status: "blocked",
				summary: message,
				blockedReason: message
			};
			return scheduleGracefulBlocked(state, phase, blockedOutcome);
		}
		if (hasRepeatedRepairFailure(state, phase, outcome)) {
			const message: string = `Verification phase "${phase.title}" repeated the same failure without progress, so automatic repair was stopped.`;
			if (phase.toolGroup === "verify") {
				return completeVerificationWithWarnings(state, phase, outcome, message);
			}
			const blockedOutcome: WorkflowPhaseOutput = { ...outcome, status: "blocked", summary: message, blockedReason: message };
			return scheduleGracefulBlocked(state, phase, blockedOutcome);
		}
		if (countWorkflowAutoRepairRounds(state.plan) >= maxAutoRepairRounds) {
			const message: string = `Verification phase "${phase.title}" still has issues requiring repair, and the automatic repair limit has been reached.`;
			if (phase.toolGroup === "verify") {
				return completeVerificationWithWarnings(state, phase, outcome, message);
			}
			const blockedOutcome: WorkflowPhaseOutput = { ...outcome, status: "blocked", summary: message, blockedReason: message };
			return scheduleGracefulBlocked(state, phase, blockedOutcome);
		}
		const repairTools = shouldUseVerifyOnlyRepair(outcome.failedChecks)
			? { tools: [] as string[], reason: "Verification-only failure." }
			: resolveRepairWriteTools(state.plan, state.phaseIndex + 1, phase, outcome.failedChecks);
		if (shouldUseVerifyOnlyRepair(outcome.failedChecks)) {
			const failedPlan: WorkflowPlan = updateWorkflowPhaseStatus(state.plan, phase.id, "failed");
			const plan: WorkflowPlan = insertWorkflowAutoRepairPhases(failedPlan, state.phaseIndex + 1, phase, outcome.summary, outcome.failedChecks);
			return {
				type: "repair",
				phase,
				outcome,
				state: {
					...state,
					plan,
					phaseIndex: state.phaseIndex + 1,
					phaseOutputs: appendPhaseOutput(state.phaseOutputs, phase, outcome)
				}
			};
		}
		if (repairTools.tools.length === 0) {
			const message: string = `Verification phase "${phase.title}" requires a write repair, but no safe tool can be selected without expanding the existing authorization: ${repairTools.reason}`;
			if (phase.toolGroup === "verify") {
				return completeVerificationWithWarnings(state, phase, outcome, message);
			}
			const blockedOutcome: WorkflowPhaseOutput = { ...outcome, status: "blocked", summary: message, blockedReason: message };
			return scheduleGracefulBlocked(state, phase, blockedOutcome);
		}

		const failedPlan: WorkflowPlan = updateWorkflowPhaseStatus(state.plan, phase.id, "failed");
		const plan: WorkflowPlan = insertWorkflowAutoRepairPhases(failedPlan, state.phaseIndex + 1, phase, outcome.summary, outcome.failedChecks, repairTools.tools);
		return {
			type: "repair",
			phase,
			outcome,
			state: {
				...state,
				plan,
				phaseIndex: state.phaseIndex + 1,
				phaseOutputs: appendPhaseOutput(state.phaseOutputs, phase, outcome)
			}
		};
	}

	if (outcome.status === "blocked" || outcome.status === "failed") {
		if (phase.toolGroup === "verify") {
			return completeVerificationWithWarnings(state, phase, outcome, outcome.blockedReason ?? outcome.summary);
		}
		return scheduleGracefulBlocked(state, phase, outcome);
	}

	const plan: WorkflowPlan = updateWorkflowPhaseStatus(state.plan, phase.id, "done");
	return {
		type: "complete_phase",
		phase,
		outcome,
		state: {
			...state,
			plan,
			phaseIndex: state.phaseIndex + 1,
			phaseOutputs: appendPhaseOutput(state.phaseOutputs, phase, outcome)
		}
	};
}

export function scheduleWorkflowApproval(
	state: WorkflowRunState,
	phase: WorkflowPhase,
	outcome: WorkflowPhaseOutput,
	phaseRunId: string
): Extract<WorkflowSchedulerCommand, { type: "pause_for_approval" }> {
	const plan: WorkflowPlan = updateWorkflowPhaseStatus(state.plan, phase.id, "paused");
	return {
		type: "pause_for_approval",
		phase,
		outcome,
		state: {
			...state,
			plan,
			phaseOutputs: appendPhaseOutput(state.phaseOutputs, phase, outcome),
			activePhaseRunId: phaseRunId
		}
	};
}
