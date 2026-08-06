import type { AiChatParams } from "../protocol/types.js";
import type { AgentRunIntent, AgentRunLane, AgentRunScope } from "./agent-run-state.js";

export type WorkflowOption = NonNullable<NonNullable<AiChatParams["options"]>["workflow"]>;
export type ExecutionPolicy = NonNullable<NonNullable<AiChatParams["options"]>["executionPolicy"]>;
export type OutputTarget = NonNullable<NonNullable<AiChatParams["options"]>["outputTarget"]>;

export type WorkflowRouteDecision = {
	intent: AgentRunIntent;
	scope: AgentRunScope;
	lane: AgentRunLane;
	outputTarget: OutputTarget;
	reason: string;
	planningHint: string;
	forcedByOption?: WorkflowOption | undefined;
	safetyOverride?: "mode_read_only" | "execution_read_only" | "output_chat_only" | undefined;
};

export type WorkflowRouteContext = {
	hasActiveWorkspace: boolean;
};

export function getExecutionPolicy(params: AiChatParams): ExecutionPolicy {
	return params.options?.executionPolicy ?? "auto";
}

/**
 * The output target is an authorization input, not a guess derived from the
 * user's prose. Explicit workflow options remain a structured compatibility
 * signal for older clients that do not send outputTarget yet.
 */
export function getOutputTarget(params: AiChatParams): OutputTarget {
	if (params.options?.outputTarget !== undefined) {
		return params.options.outputTarget;
	}

	const workflowOption: WorkflowOption = params.options?.workflow ?? "auto";
	return workflowOption === "multi_phase"
		|| workflowOption === "llm_planned"
		? "workspace"
		: "chat";
}

export function canWriteToWorkspace(params: AiChatParams): boolean {
	return params.mode !== "ask"
		&& params.mode !== "plan"
		&& getExecutionPolicy(params) !== "read_only"
		&& getOutputTarget(params) === "workspace";
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
	const outputTarget: OutputTarget = getOutputTarget(params);
	if (params.mode === "ask" || params.mode === "plan") {
		return createReadRoute("The selected chat mode is read-only.", "mode_read_only", outputTarget);
	}
	if (executionPolicy === "read_only") {
		return createReadRoute("The request explicitly uses the read-only execution policy.", "execution_read_only", outputTarget);
	}

	const workflowOption: WorkflowOption = params.options?.workflow ?? "auto";
	if (outputTarget === "chat" && (workflowOption === "multi_phase" || workflowOption === "llm_planned")) {
		return createReadRoute(
			"The chat output target does not authorize workspace mutation.",
			"output_chat_only",
			outputTarget
		);
	}
	if (context.hasActiveWorkspace && (workflowOption === "multi_phase" || workflowOption === "llm_planned")) {
		return {
			intent: "inspect",
			scope: "complex",
			lane: "workflow",
			outputTarget,
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
			outputTarget,
			reason: "Workspace Agent requests use tool-assisted chat until a structural execution boundary requires workflow.",
			planningHint: ""
		};
	}

	return {
		intent: "answer",
		scope: "bounded",
		lane: "direct",
		outputTarget,
		reason: context.hasActiveWorkspace
			? "The current mode does not start an agent execution lane."
			: "No active workspace is available for project execution.",
		planningHint: ""
	};
}

function createReadRoute(
	reason: string,
	safetyOverride: NonNullable<WorkflowRouteDecision["safetyOverride"]>,
	outputTarget: OutputTarget
): WorkflowRouteDecision {
	return {
		intent: "inspect",
		scope: "bounded",
		lane: "read",
		outputTarget,
		reason,
		planningHint: "",
		safetyOverride
	};
}
