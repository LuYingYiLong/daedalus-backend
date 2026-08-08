export const LEGACY_WORKFLOW_REMOVED_CODE = "legacy_workflow_removed" as const;

/**
 * The phase-based workflow was removed from the runtime. Persisted phase
 * records remain readable for history, but they must never reach a provider
 * or a workspace tool again.
 */
export class LegacyWorkflowRemovedError extends Error {
	public readonly code: typeof LEGACY_WORKFLOW_REMOVED_CODE = LEGACY_WORKFLOW_REMOVED_CODE;

	public constructor(message: string = "The legacy phase-based workflow has been removed. Start a new Agent Loop run instead.") {
		super(message);
		this.name = "LegacyWorkflowRemovedError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isLegacyWorkflowRunState(value: unknown): boolean {
	return isRecord(value) && value.lane === "workflow";
}

export function isLegacyWorkflowContinuation(value: unknown): boolean {
	if (!isRecord(value)) {
		return false;
	}
	return isLegacyWorkflowRunState(value.agentRunState)
		|| isLegacyWorkflowRunState(value.workflowState)
		|| value.workflowState !== undefined;
}

export function assertNoLegacyWorkflow(value: unknown, context: string): void {
	if (isLegacyWorkflowRunState(value) || isLegacyWorkflowContinuation(value)) {
		throw new LegacyWorkflowRemovedError(`The legacy workflow in ${context} is no longer executable.`);
	}
}
