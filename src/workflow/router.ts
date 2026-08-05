import type { AiChatParams } from "../protocol/types.js";
import type { AgentRunIntent, AgentRunLane, AgentRunScope } from "./agent-run-state.js";

export type WorkflowOption = NonNullable<NonNullable<AiChatParams["options"]>["workflow"]>;
export type ExecutionPolicy = NonNullable<NonNullable<AiChatParams["options"]>["executionPolicy"]>;

export type WorkflowRouteDecision = {
	intent: AgentRunIntent;
	scope: AgentRunScope;
	lane: AgentRunLane;
	reason: string;
	planningHint: string;
	forcedByOption?: WorkflowOption | undefined;
	safetyOverride?: "mode_read_only" | "execution_read_only" | undefined;
};

export type WorkflowRouteContext = {
	hasActiveWorkspace: boolean;
};

export function getExecutionPolicy(params: AiChatParams): ExecutionPolicy {
	return params.options?.executionPolicy ?? "auto";
}

/**
 * This is an authorization gate, not an intent classifier. User prose never
 * determines whether write-capable tools become visible.
 */
export function routeWorkflowExecution(
	params: AiChatParams,
	context: WorkflowRouteContext
): WorkflowRouteDecision {
	const executionPolicy: ExecutionPolicy = getExecutionPolicy(params);
	if (params.mode === "ask" || params.mode === "plan") {
		return createReadRoute("The selected chat mode is read-only.", "mode_read_only");
	}
	if (executionPolicy === "read_only") {
		return createReadRoute("The request explicitly uses the read-only execution policy.", "execution_read_only");
	}

	const workflowOption: WorkflowOption = params.options?.workflow ?? "auto";
	if (context.hasActiveWorkspace && (workflowOption === "multi_phase" || workflowOption === "llm_planned")) {
		return {
			intent: "inspect",
			scope: "complex",
			lane: "workflow",
			reason: `Explicit workflow=${workflowOption} starts a workspace workflow.`,
			planningHint: "",
			forcedByOption: workflowOption
		};
	}

	if (context.hasActiveWorkspace && (params.mode ?? "agent") === "agent") {
		return {
			intent: "answer",
			scope: "bounded",
			lane: "tool_assisted",
			reason: "Workspace Agent requests use tool-assisted chat until a structural execution boundary requires workflow.",
			planningHint: ""
		};
	}

	return {
		intent: "answer",
		scope: "bounded",
		lane: "direct",
		reason: context.hasActiveWorkspace
			? "The current mode does not start an agent execution lane."
			: "No active workspace is available for project execution.",
		planningHint: ""
	};
}

function createReadRoute(
	reason: string,
	safetyOverride: NonNullable<WorkflowRouteDecision["safetyOverride"]>
): WorkflowRouteDecision {
	return {
		intent: "inspect",
		scope: "bounded",
		lane: "read",
		reason,
		planningHint: "",
		safetyOverride
	};
}
