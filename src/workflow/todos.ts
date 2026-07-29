import type { WorkflowPhase, WorkflowTodoItem } from "./types.js";

export function createVisibleWorkflowTodos(phases: WorkflowPhase[]): WorkflowTodoItem[] {
	const hidesReadPreparation: boolean = phases.some((
		phase: WorkflowPhase
	): boolean => phase.toolGroup === "write");
	return phases
		.filter((phase: WorkflowPhase): boolean => (
			phase.toolGroup !== "summarize"
			&& !(hidesReadPreparation && phase.toolGroup === "read")
		))
		.map((phase: WorkflowPhase): WorkflowTodoItem => ({
			id: `${phase.id}-todo`,
			phaseId: phase.id,
			text: phase.title,
			status: "pending"
		}));
}
