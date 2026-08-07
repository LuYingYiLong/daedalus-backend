import assert from "node:assert/strict";
import test from "node:test";
import {
	collectWorkflowCompletionStatus,
	createFinalSummaryVerificationContext,
	shouldReviseLlmWorkflowPlan
} from "../../../src/server/workflow/continuation.js";
import type { WorkflowPhase, WorkflowPhaseOutput, WorkflowPlan, WorkflowToolObservation } from "../../../src/workflow/types.js";

function phase(id: string, toolGroup: WorkflowPhase["toolGroup"]): WorkflowPhase {
	return {
		id,
		title: id,
		toolGroup,
		toolBudget: toolGroup === "write" ? "project_edit" : "normal",
		allowedTools: [],
		instruction: id
	};
}

function output(
	phaseId: string,
	toolObservations: WorkflowToolObservation[],
	verificationStatus?: WorkflowPhaseOutput["verificationStatus"]
): WorkflowPhaseOutput {
	return {
		phaseId,
		phaseRunId: `run-${phaseId}`,
		title: phaseId,
		status: "completed",
		summary: phaseId,
		evidence: [],
		failedChecks: [],
		requiredFixes: [],
		modifiedArtifacts: [],
		verifiedArtifacts: [],
		toolObservations,
		verificationStatus
	};
}

test("writes without a later verify phase finish as unverified with warnings", (): void => {
	const writeObservation: WorkflowToolObservation = {
		toolCallId: "write-main",
		toolName: "mcp_godot_create_scene",
		risk: "write",
		status: "succeeded",
		artifactRefs: ["scenes/Main.tscn"]
	};
	const plan: WorkflowPlan = {
		id: "workflow-main",
		title: "Create main scene",
		phases: [phase("write", "write"), phase("summarize", "summarize")],
		todos: []
	};

	const result = collectWorkflowCompletionStatus(plan, [
		output("write", [writeObservation]),
		output("summarize", [])
	]);

	assert.equal(result.resultStatus, "completed_with_warnings");
	assert.equal(result.verificationStatus, "unverified");
	assert.equal(result.warnings.length, 1);
});

test("a structured skip policy never reports missing verification as a workflow failure", (): void => {
	const plan: WorkflowPlan = {
		id: "workflow-main",
		title: "Create main scene",
		phases: [phase("write", "write"), phase("summarize", "summarize")],
		todos: [],
		verificationPolicy: "skip"
	};
	const result = collectWorkflowCompletionStatus(plan, [
		output("write", [{
			toolCallId: "write-main",
			toolName: "mcp_godot_create_scene",
			risk: "write",
			status: "succeeded"
		}]),
		output("summarize", [])
	]);
	assert.equal(result.resultStatus, "completed_with_warnings");
	assert.equal(result.verificationStatus, "unverified");
	assert.deepEqual(result.warnings, ["验证已按本次请求的结构化策略跳过。"]);
	assert.match(createFinalSummaryVerificationContext(plan, [
		output("write", [{
			toolCallId: "write-main",
			toolName: "mcp_godot_create_scene",
			risk: "write",
			status: "succeeded"
		}]),
		output("summarize", [])
	]), /结构化执行策略/u);
});

test("only a successful verify after the latest write produces verified completion", (): void => {
	const writeObservation: WorkflowToolObservation = {
		toolCallId: "write-main",
		toolName: "mcp_godot_create_scene",
		risk: "write",
		status: "succeeded",
		artifactRefs: ["scenes/Main.tscn"]
	};
	const plan: WorkflowPlan = {
		id: "workflow-main",
		title: "Create main scene",
		phases: [phase("verify-before", "verify"), phase("write", "write"), phase("verify-after", "verify")],
		todos: []
	};

	const result = collectWorkflowCompletionStatus(plan, [
		output("verify-before", [], "verified"),
		output("write", [writeObservation]),
		output("verify-after", [], "verified")
	]);

	assert.equal(result.resultStatus, "completed");
	assert.equal(result.verificationStatus, "verified");
	assert.deepEqual(result.warnings, []);
});

test("final summary receives unverified completion constraints as prompt context", (): void => {
	const plan: WorkflowPlan = {
		id: "workflow-main",
		title: "Create main scene",
		phases: [phase("write", "write"), phase("summarize", "summarize")],
		todos: []
	};
	const context: string = createFinalSummaryVerificationContext(plan, [
		output("write", [{
			toolCallId: "write-main",
			toolName: "mcp_godot_apply_scene_patch",
			risk: "write",
			status: "succeeded",
			artifactRefs: ["scenes/Main.tscn"]
		}])
	]);

	assert.match(context, /最后一次写入后没有成功的验证阶段/u);
	assert.match(context, /不要声称验证已经通过/u);
});

test("an unresolved business failure completes the request with blocked status and summary context", (): void => {
	const plan: WorkflowPlan = {
		id: "workflow-blocked",
		title: "Edit scene",
		phases: [phase("implement", "write"), phase("summarize", "summarize")],
		todos: []
	};
	const blocked: WorkflowPhaseOutput = {
		...output("implement", []),
		status: "blocked",
		summary: "Signal node was not found.",
		blockedReason: "Signal node was not found.",
		failedChecks: [{
			code: "signal_node_not_found",
			failureCode: "signal_node_not_found",
			message: "Signal source node does not exist.",
			artifact: "scenes/Main.tscn"
		}]
	};
	const result = collectWorkflowCompletionStatus(plan, [blocked]);

	assert.equal(result.resultStatus, "blocked");
	assert.equal(result.verificationStatus, "unverified");
	assert.match(createFinalSummaryVerificationContext(plan, [blocked]), /signal_node_not_found/);
});

test("LLM workflow revision only runs for material outcomes or user guidance", (): void => {
	const completed = output("inspect", []);
	const needsFix: WorkflowPhaseOutput = {
		...completed,
		status: "needs_fix",
		failedChecks: [{ code: "check", message: "changed scope" }],
		requiredFixes: ["fix changed scope"]
	};

	assert.equal(shouldReviseLlmWorkflowPlan(completed, ""), false);
	assert.equal(shouldReviseLlmWorkflowPlan(completed, "用户补充了新约束"), true);
	assert.equal(shouldReviseLlmWorkflowPlan(needsFix, ""), true);
});
