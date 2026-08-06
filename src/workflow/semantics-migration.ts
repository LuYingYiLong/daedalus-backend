import type { WorkflowPhase, WorkflowRunState } from "./types.js";

export class WorkflowSemanticsMigrationError extends Error {
	readonly code: string = "workflow_semantics_migration_blocked";

	constructor(message: string) {
		super(message);
		this.name = "WorkflowSemanticsMigrationError";
	}
}

/**
 * Pending runs are executable state, not archival data. Only migrate facts already
 * represented structurally; never derive semantics from titles, prompts, or output.
 */
export function migratePendingWorkflowRunState(state: WorkflowRunState): WorkflowRunState {
	if (state.plan.semanticsVersion === 2) return state;
	for (const phase of state.plan.phases) {
		assertPhaseCanMigrate(phase);
	}
	return {
		...state,
		plan: {
			...state.plan,
			semanticsVersion: 2,
			phases: state.plan.phases.map((phase: WorkflowPhase): WorkflowPhase => ({
				...phase,
				writeRequirement: phase.toolGroup === "write" ? "write" : phase.writeRequirement
			}))
		}
	};
}

function assertPhaseCanMigrate(phase: WorkflowPhase): void {
	for (const target of phase.completionContract?.targets ?? []) {
		if (target.kind === "artifact" && target.targetKind === undefined) {
			throw new WorkflowSemanticsMigrationError(`Pending workflow phase ${phase.id} has an artifact without a structured target kind. Start the request again.`);
		}
	}
	if (phase.toolGroup === "write" && phase.completionContract === undefined) {
		throw new WorkflowSemanticsMigrationError(`Pending workflow write phase ${phase.id} has no structured completion contract. Start the request again.`);
	}
}
