import type { ChatCompletionTool } from "openai/resources/chat/completions";
import {
	executionDecisionToolInputSchema,
	type AgentRunLane,
	type ExecutionDecision
} from "../workflow/agent-run-state.js";

export const EXECUTION_CONTROL_TOOL_NAME = "daedalus_report_execution_decision";
const READ_COMPLETION_LANES: ReadonlySet<ExecutionControlContext["lane"]> = new Set(["read", "probe"]);

export type ExecutionControlContext = {
	lane: Extract<AgentRunLane, "read" | "probe" | "lightweight">;
	allowMutationEscalation: boolean;
	requireDecision: boolean;
};

export const EXECUTION_CONTROL_TOOL_DEFINITION: ChatCompletionTool = {
	type: "function",
	function: {
		name: EXECUTION_CONTROL_TOOL_NAME,
		description: "Report the evidence-backed execution decision for the current Daedalus read, probe, or lightweight action. This is an internal control signal, not a workspace tool. complete_read is valid for read and probe lanes when the request is informational or diagnostic and needs no mutation. For complete_read, leave expectedArtifacts empty and targetKind unknown. For no_change, evidenceToolCallIds is mandatory: include one or more exact successful read or verify tool_call ids from this run. Never use [] for no_change. Never use tool names, paths, or constructed tool:path labels.",
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["disposition", "summary", "evidenceToolCallIds", "expectedArtifacts"],
			properties: {
				disposition: {
					type: "string",
					enum: ["complete_read", "no_change", "use_lightweight", "use_workflow", "blocked"]
				},
				summary: { type: "string", minLength: 1, maxLength: 2000 },
				evidenceToolCallIds: {
					type: "array",
					description: "Exact tool_call ids returned by successful read or verify calls in this run. Required for no_change; use [] only for complete_read or decisions that do not claim an already-satisfied state. Never construct ids from a tool name or artifact path.",
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
				},
				targetKind: {
					type: "string",
					enum: ["workspace_file", "godot_script", "godot_scene", "godot_script_scene", "project_setting", "unknown"],
					description: "The bounded target category inferred from successful read evidence. Use unknown when no safe category can be established."
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

export class ExecutionContractUnresolvedError extends Error {
	readonly code: string = "execution_contract_unresolved";

	constructor(message: string = "The model did not submit the required structured execution decision.") {
		super(message);
		this.name = "ExecutionContractUnresolvedError";
	}
}

export function parseExecutionDecision(value: unknown, context: ExecutionControlContext): ExecutionDecision {
	const decision: ExecutionDecision = executionDecisionToolInputSchema.parse(value);
	if (decision.disposition === "complete_read" && !READ_COMPLETION_LANES.has(context.lane)) {
		throw new Error("complete_read is only valid in a read or probe lane.");
	}
	if (
		(decision.disposition === "use_lightweight" || decision.disposition === "use_workflow")
		&& !context.allowMutationEscalation
	) {
		throw new Error("Mutation escalation is not allowed for this execution context.");
	}
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
