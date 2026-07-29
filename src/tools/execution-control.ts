import type { ChatCompletionTool } from "openai/resources/chat/completions";
import {
	executionDecisionSchema,
	type AgentRunLane,
	type ExecutionDecision
} from "../workflow/agent-run-state.js";

export const EXECUTION_CONTROL_TOOL_NAME = "daedalus_report_execution_decision";

export type ExecutionControlContext = {
	lane: Extract<AgentRunLane, "probe" | "lightweight">;
};

export const EXECUTION_CONTROL_TOOL_DEFINITION: ChatCompletionTool = {
	type: "function",
	function: {
		name: EXECUTION_CONTROL_TOOL_NAME,
		description: "Report the evidence-backed execution decision for the current Daedalus probe or lightweight action. This is an internal control signal, not a workspace tool.",
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["disposition", "summary", "evidenceToolCallIds", "expectedArtifacts"],
			properties: {
				disposition: {
					type: "string",
					enum: ["no_change", "use_lightweight", "use_workflow", "blocked"]
				},
				summary: { type: "string", minLength: 1, maxLength: 2000 },
				evidenceToolCallIds: {
					type: "array",
					maxItems: 64,
					items: { type: "string", minLength: 1, maxLength: 200 }
				},
				expectedArtifacts: {
					type: "array",
					maxItems: 64,
					items: { type: "string", minLength: 1, maxLength: 1000 }
				},
				expectedLogicalWrites: {
					type: "integer",
					minimum: 0,
					maximum: 2
				}
			}
		}
	}
};

export class ExecutionDecisionSignal extends Error {
	readonly decision: ExecutionDecision;

	constructor(decision: ExecutionDecision) {
		super(`Execution decision: ${decision.disposition}`);
		this.name = "ExecutionDecisionSignal";
		this.decision = decision;
	}
}

export function parseExecutionDecision(value: unknown, context: ExecutionControlContext): ExecutionDecision {
	const decision: ExecutionDecision = executionDecisionSchema.parse(value);
	if (context.lane === "lightweight" && decision.disposition === "use_lightweight") {
		throw new Error("A lightweight action cannot request the lightweight lane again.");
	}
	return decision;
}

