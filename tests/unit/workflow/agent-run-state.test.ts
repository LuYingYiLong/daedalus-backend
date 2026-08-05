import assert from "node:assert/strict";
import test from "node:test";
import {
	createAgentRunState,
	executionDecisionSchema,
	interruptRecoverableAgentRun,
	transitionAgentRunState,
	validateExecutionDecisionEvidence
} from "../../../src/workflow/agent-run-state.js";
import { parseExecutionDecision } from "../../../src/tools/execution-control.js";

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

test("an approved run resumes execution before finalizing", (): void => {
	const initial = createAgentRunState({
		sessionId: "session-test",
		requestId: "request-approval"
	});
	const executing = transitionAgentRunState(initial, "executing");
	const waiting = transitionAgentRunState(executing, "awaiting_approval", {
		pause: {
			kind: "approval",
			id: "approval-test",
			toolName: "mcp_godot_editor_apply_scene_patch",
			reason: "Scene patch"
		}
	});
	const resumed = transitionAgentRunState(waiting, "executing", { pause: null });
	const finalizing = transitionAgentRunState(resumed, "finalizing");

	assert.equal(resumed.pause, null);
	assert.equal(finalizing.stage, "finalizing");
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
		requestId: "request-test",
		now: "2026-07-29T00:00:00.000Z"
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
	assert.equal(
		validateExecutionDecisionEvidence(probing, {
			...decision,
			evidenceToolCallIds: ["missing"]
		}).disposition,
		"blocked"
	);
});

test("execution decisions require exact evidence call ids", (): void => {
	const initial = createAgentRunState({
		sessionId: "session-test",
		requestId: "request-test",
		now: "2026-07-31T00:00:00.000Z"
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
	assert.equal(validateExecutionDecisionEvidence(probing, noChange).disposition, "blocked");

	const workflow = executionDecisionSchema.parse({
		disposition: "use_workflow",
		summary: "The change spans multiple scene artifacts.",
		evidenceToolCallIds: ["fabricated-reference"],
		expectedArtifacts: ["scenes/Main.tscn"]
	});
	assert.deepEqual(validateExecutionDecisionEvidence(probing, workflow).evidenceToolCallIds, []);
});

test("no-change tool input blocks when it omits exact current-run evidence", (): void => {
	const initial = createAgentRunState({
		sessionId: "session-test",
		requestId: "request-test",
		now: "2026-08-02T05:00:38.000Z"
	});
	const probing = transitionAgentRunState(initial, "probing", {
		intent: "mutate",
		scope: "unknown",
		lane: "probe",
		checkpoint: {
			successfulWriteFingerprints: [],
			evidence: [{
				toolCallId: "previous-read",
				toolName: "mcp_godot_read_text_file",
				risk: "read",
				status: "succeeded",
				artifactRefs: ["scripts/Main.gd"],
				observedAt: "2026-08-01T14:00:00.000Z"
			}, {
				toolCallId: "current-read",
				toolName: "mcp_godot_read_text_file",
				risk: "read",
				status: "succeeded",
				artifactRefs: ["scripts/Main.gd"],
				observedAt: "2026-08-02T05:00:51.581Z"
			}, {
				toolCallId: "current-verify",
				toolName: "mcp_terminal_run_safe_preset",
				risk: "verify",
				status: "succeeded",
				artifactRefs: ["scripts/Main.gd"],
				observedAt: "2026-08-02T05:00:51.819Z"
			}]
		}
	});
	const decision = parseExecutionDecision({
		disposition: "no_change",
		summary: "The requested state is already present and verified.",
		evidenceToolCallIds: [],
		expectedArtifacts: ["scripts/Main.gd"]
	}, { lane: "probe", allowMutationEscalation: true, requireDecision: true });

	assert.equal(validateExecutionDecisionEvidence(probing, decision).disposition, "blocked");
});

test("complete-read decisions safely close a probe without inheriting write-target constraints", (): void => {
	const initial = createAgentRunState({
		sessionId: "session-test",
		requestId: "request-test",
		now: "2026-08-05T00:00:00.000Z"
	});
	const probing = transitionAgentRunState(initial, "probing", {
		intent: "inspect",
		scope: "unknown",
		lane: "probe",
		checkpoint: {
			successfulWriteFingerprints: [],
			evidence: [{
				toolCallId: "read-workflow",
				toolName: "mcp_workspace_read_text_file",
				risk: "read",
				status: "succeeded",
				artifactRefs: ["src/workflow/router.ts"],
				observedAt: "2026-08-05T00:00:01.000Z"
			}]
		}
	});
	const decision = executionDecisionSchema.parse({
		disposition: "complete_read",
		summary: "The workflow route is deterministic and the request needs no mutation.",
		evidenceToolCallIds: ["read-workflow"],
		expectedArtifacts: [],
		targetKind: "unknown"
	});

	const resolved = validateExecutionDecisionEvidence(probing, decision);
	assert.equal(resolved.disposition, "complete_read");
	assert.deepEqual(resolved.evidenceToolCallIds, ["read-workflow"]);
	assert.deepEqual(resolved.expectedArtifacts, []);
	assert.equal(resolved.targetKind, "unknown");
	assert.equal(
		validateExecutionDecisionEvidence(probing, {
			...decision,
			evidenceToolCallIds: ["fabricated-read"]
		}).disposition,
		"blocked"
	);
});

test("lightweight decisions require a safe evidence-backed bounded target", (): void => {
	const initial = createAgentRunState({ sessionId: "session-test", requestId: "request-test", now: "2026-08-03T00:00:00.000Z" });
	const probing = transitionAgentRunState(initial, "probing", {
		lane: "probe",
		checkpoint: {
			successfulWriteFingerprints: [],
			evidence: [{ toolCallId: "read-script", toolName: "mcp_godot_read_text_file", risk: "read", status: "succeeded", artifactRefs: ["scripts/Main.gd"], observedAt: "2026-08-03T00:00:01.000Z" }]
		}
	});
	const valid = executionDecisionSchema.parse({
		disposition: "use_lightweight", summary: "Update the script.", evidenceToolCallIds: ["read-script"],
		expectedArtifacts: ["res://scripts/Main.gd"], expectedLogicalWrites: 1, targetKind: "godot_script"
	});
	assert.deepEqual(validateExecutionDecisionEvidence(probing, valid).expectedArtifacts, ["scripts/Main.gd"]);
	assert.equal(validateExecutionDecisionEvidence(probing, { ...valid, expectedArtifacts: ["../outside.gd"] }).disposition, "blocked");
	assert.equal(validateExecutionDecisionEvidence(probing, { ...valid, targetKind: "godot_scene" }).disposition, "blocked");
});
