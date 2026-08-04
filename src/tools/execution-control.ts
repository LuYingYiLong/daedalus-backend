import type { ChatCompletionTool } from "openai/resources/chat/completions";
import {
	executionDecisionToolInputSchema,
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
		description: "Report the evidence-backed execution decision for the current Daedalus probe or lightweight action. This is an internal control signal, not a workspace tool. evidenceToolCallIds must contain the exact tool_call ids from this run (for example call_abc123), never tool names, paths, or constructed tool:path labels.",
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
					description: "Exact tool_call ids returned by successful read or verify calls in this run. Use [] unless evidence is needed. Never construct ids from a tool name or artifact path.",
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
					maximum: 64
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
	const decision: ExecutionDecision = executionDecisionToolInputSchema.parse(value);
	const expectedLogicalWrites: number | undefined = decision.expectedLogicalWrites;
	if (decision.disposition === "use_lightweight" && expectedLogicalWrites === undefined) {
		return { ...decision, disposition: "use_workflow" };
	}
	if (decision.disposition === "use_lightweight" && expectedLogicalWrites !== undefined && expectedLogicalWrites > 2) {
		return { ...decision, disposition: "use_workflow", expectedLogicalWrites: undefined };
	}
	if (context.lane === "lightweight" && decision.disposition === "use_lightweight") {
		return { ...decision, disposition: "use_workflow", expectedLogicalWrites: undefined };
	}
	return decision;
}
