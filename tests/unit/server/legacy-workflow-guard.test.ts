import assert from "node:assert/strict";
import test from "node:test";
import {
	assertNoLegacyWorkflow,
	isLegacyWorkflowContinuation,
	isLegacyWorkflowRunState,
	LegacyWorkflowRemovedError,
	LEGACY_WORKFLOW_REMOVED_CODE
} from "../../../src/server/legacy-workflow-guard.js";

test("only persisted phase runs are classified as legacy workflow", (): void => {
	assert.equal(isLegacyWorkflowRunState({ lane: "workflow", stage: "interrupted" }), true);
	assert.equal(isLegacyWorkflowRunState({ lane: "agent_loop", stage: "interrupted" }), false);
	assert.equal(isLegacyWorkflowRunState({ title: "workflow" }), false);
	assert.equal(isLegacyWorkflowContinuation({ workflowState: { lane: "workflow" } }), true);
	assert.equal(isLegacyWorkflowContinuation({ agentLoopState: { schemaVersion: 1 } }), false);
});

test("legacy continuation guard produces a structured removal error", (): void => {
	assert.throws(
		(): void => assertNoLegacyWorkflow({ lane: "workflow" }, "retry"),
		(error: unknown): boolean => error instanceof LegacyWorkflowRemovedError
			&& error.code === LEGACY_WORKFLOW_REMOVED_CODE
	);
});

test("normal Agent Loop continuation is not blocked", (): void => {
	assert.doesNotThrow((): void => assertNoLegacyWorkflow({
		agentLoopState: { schemaVersion: 1, recoveryEntries: [] }
	}, "approval"));
});
