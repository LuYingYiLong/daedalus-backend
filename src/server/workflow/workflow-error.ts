import type { WorkflowPhaseOutput, WorkflowPlan } from "../../workflow/types.js";
import { ProviderResponseStalledError } from "../../providers/provider-resilience.js";

export class WorkflowExecutionError extends Error {
	readonly plan: WorkflowPlan;
	readonly originalError: unknown;
	readonly phaseOutputs: WorkflowPhaseOutput[];

	constructor(message: string, plan: WorkflowPlan, originalError: unknown, phaseOutputs: WorkflowPhaseOutput[] = []) {
		super(message);
		this.name = "WorkflowExecutionError";
		this.plan = plan;
		this.originalError = originalError;
		this.phaseOutputs = phaseOutputs;
	}
}

/**
 * A provider stream that became silent is a recoverable interruption, even
 * when the workflow layer has wrapped the original provider error. Keep this
 * distinction structural so callers never infer it from an error message.
 */
export function hasProviderResponseStalledError(error: unknown): boolean {
	const seen: Set<object> = new Set<object>();
	let current: unknown = error;
	for (let depth: number = 0; depth < 8; depth += 1) {
		if (current instanceof ProviderResponseStalledError) {
			return true;
		}
		if (typeof current !== "object" || current === null || seen.has(current)) {
			return false;
		}
		seen.add(current);
		if ((current as { code?: unknown }).code === "provider_response_stalled") {
			return true;
		}
		current = current instanceof WorkflowExecutionError
			? current.originalError
			: (current as { cause?: unknown }).cause;
	}
	return false;
}
