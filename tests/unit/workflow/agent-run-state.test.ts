import assert from "node:assert/strict";
import test from "node:test";
import {
	createAgentRunState,
	executionDecisionSchema,
	interruptRecoverableAgentRun,
	transitionAgentRunState,
	validateExecutionDecisionEvidence
} from "../../../src/workflow/agent-run-state.js";

test("agent run revisions are monotonic and terminal transitions happen once", (): void => {
	const initial = createAgentRunState({
		sessionId: "session-test",
		requestId: "request-test",
		runId: "run-test",
		now: "2026-07-29T00:00:00.000Z"
	});
	const executing = transitionAgentRunState(initial, "executing", {
		intent: "mutate",
		scope: "bounded",
		lane: "lightweight"
	}, "2026-07-29T00:00:01.000Z");
	const finalizing = transitionAgentRunState(executing, "finalizing");
	const completed = transitionAgentRunState(finalizing, "completed", {
		terminal: {
			resultStatus: "completed",
			completedAt: "2026-07-29T00:00:02.000Z"
		}
	});

	assert.equal(executing.revision, initial.revision + 1);
	assert.equal(completed.stage, "completed");
	assert.throws((): void => {
		transitionAgentRunState(completed, "completed", {
			terminal: completed.terminal
		});
	}, /already terminal/u);
});

test("illegal run transitions are rejected", (): void => {
	const initial = createAgentRunState({
		sessionId: "session-test",
		requestId: "request-test"
	});
	assert.throws((): void => {
		transitionAgentRunState(initial, "completed", {
			terminal: {
				resultStatus: "completed",
				completedAt: new Date().toISOString()
			}
		});
	}, /Illegal agent run transition/u);
});

test("restart interrupts every active stage but preserves paused runs", (): void => {
	const initial = createAgentRunState({
		sessionId: "session-test",
		requestId: "request-test"
	});
	const executing = transitionAgentRunState(initial, "executing");
	const activeStates = [
		initial,
		transitionAgentRunState(initial, "probing"),
		executing,
		transitionAgentRunState(executing, "verifying"),
		transitionAgentRunState(executing, "finalizing")
	];
	const paused = transitionAgentRunState(executing, "awaiting_tool_budget", {
		pause: { kind: "tool_budget", id: "budget-1", reason: "limit" }
	});

	for (const activeState of activeStates) {
		const interrupted = interruptRecoverableAgentRun(activeState);
		assert.equal(interrupted.stage, "interrupted");
		assert.equal(interrupted.interruptedReason, "backend_restart");
	}
	assert.equal(interruptRecoverableAgentRun(paused).stage, "awaiting_tool_budget");
});

test("no-change decisions require successful read or verify evidence", (): void => {
	const decision = executionDecisionSchema.parse({
		disposition: "no_change",
		summary: "The requested entry already exists.",
		evidenceToolCallIds: ["read-1"],
		expectedArtifacts: [".gitignore"]
	});
	const initial = createAgentRunState({
		sessionId: "session-test",
		requestId: "request-test"
	});
	const probing = transitionAgentRunState(initial, "probing", {
		intent: "mutate",
		scope: "unknown",
		lane: "probe",
		checkpoint: {
			successfulWriteFingerprints: [],
			evidence: [{
				toolCallId: "read-1",
				toolName: "mcp_workspace_read_text_file",
				risk: "read",
				status: "succeeded",
				artifactRefs: [".gitignore"],
				observedAt: "2026-07-29T00:00:00.000Z"
			}]
		}
	});

	assert.deepEqual(validateExecutionDecisionEvidence(probing, decision).evidenceToolCallIds, ["read-1"]);
	assert.throws((): void => {
		validateExecutionDecisionEvidence(probing, {
			...decision,
			evidenceToolCallIds: ["missing"]
		});
	}, /no usable evidence/u);
});

test("execution decisions safely normalize semantic evidence references", (): void => {
	const initial = createAgentRunState({
		sessionId: "session-test",
		requestId: "request-test"
	});
	const probing = transitionAgentRunState(initial, "probing", {
		intent: "mutate",
		scope: "unknown",
		lane: "probe",
		checkpoint: {
			successfulWriteFingerprints: [],
			evidence: [{
				toolCallId: "call-scene-tree",
				toolName: "mcp_godot_inspect_scene_tree",
				risk: "read",
				status: "succeeded",
				artifactRefs: ["scenes/Main.tscn"],
				observedAt: "2026-07-31T00:00:00.000Z"
			}]
		}
	});

	const noChange = executionDecisionSchema.parse({
		disposition: "no_change",
		summary: "The requested scene state already exists.",
		evidenceToolCallIds: ["mcp_godot_inspect_scene_tree:scenes/Main.tscn"],
		expectedArtifacts: ["scenes/Main.tscn"]
	});
	assert.deepEqual(
		validateExecutionDecisionEvidence(probing, noChange).evidenceToolCallIds,
		["call-scene-tree"]
	);

	const workflow = executionDecisionSchema.parse({
		disposition: "use_workflow",
		summary: "The change spans multiple scene artifacts.",
		evidenceToolCallIds: ["fabricated-reference"],
		expectedArtifacts: ["scenes/Main.tscn"]
	});
	assert.deepEqual(validateExecutionDecisionEvidence(probing, workflow).evidenceToolCallIds, []);
});
