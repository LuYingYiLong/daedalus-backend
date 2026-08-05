import assert from "node:assert/strict";
import test from "node:test";
import { enforceGoalEvaluationGates } from "../../../src/server/goal-controller.js";
import { createAgentRunState, type AgentRunState, type ExecutionEvidence } from "../../../src/workflow/agent-run-state.js";
import type { GoalEvaluation } from "../../../src/workflow/agent-goal-state.js";

function evidence(
	toolCallId: string,
	risk: ExecutionEvidence["risk"],
	observedAt: string,
	validationStatus?: ExecutionEvidence["validationStatus"]
): ExecutionEvidence {
	return {
		toolCallId,
		toolName: `tool_${toolCallId}`,
		risk,
		status: "succeeded",
		artifactRefs: ["project.godot"],
		validationStatus,
		observedAt
	};
}

function completedRun(params: {
	runId: string;
	cycle: number;
	intent: AgentRunState["intent"];
	verificationStatus: AgentRunState["verificationStatus"];
	evidence: ExecutionEvidence[];
	lastWriteAt?: string;
	executionDecision?: AgentRunState["executionDecision"];
}): AgentRunState {
	const now = `2026-08-01T00:00:0${params.cycle}.000Z`;
	return {
		...createAgentRunState({
			sessionId: "session-goal",
			requestId: params.runId,
			runId: params.runId,
			goalId: "goal-test",
			goalCycle: params.cycle,
			intent: params.intent,
			now
		}),
		stage: "completed",
		verificationStatus: params.verificationStatus,
		terminal: { resultStatus: "completed", completedAt: now },
		checkpoint: {
			evidence: params.evidence,
			successfulWriteFingerprints: params.intent === "mutate" ? [`write-${params.cycle}`] : [],
			...(params.lastWriteAt === undefined ? {} : { lastWriteAt: params.lastWriteAt })
		},
		executionDecision: params.executionDecision
	};
}

function achieved(...evidenceToolCallIds: string[]): GoalEvaluation {
	return {
		disposition: "achieved",
		summary: "The requested change is complete and verified.",
		evidenceToolCallIds,
		unmetCriteria: [],
		nextAction: null
	};
}

test("Goal completion accepts a write and its later verification from separate runs", () => {
	const writeAt = "2026-08-01T00:00:01.000Z";
	const verifyAt = "2026-08-01T00:00:02.000Z";
	const runs = [
		completedRun({
			runId: "run-write",
			cycle: 1,
			intent: "mutate",
			verificationStatus: "unverified",
			evidence: [evidence("write-call", "write", writeAt)],
			lastWriteAt: writeAt
		}),
		completedRun({
			runId: "run-verify",
			cycle: 2,
			intent: "inspect",
			verificationStatus: "verified",
			evidence: [evidence("verify-call", "verify", verifyAt, "passed")]
		})
	];

	const result = enforceGoalEvaluationGates(achieved("write-call", "verify-call"), runs);
	assert.equal(result.disposition, "achieved");
});

test("Goal completion rejects verification that predates the latest write", () => {
	const verifyAt = "2026-08-01T00:00:01.000Z";
	const writeAt = "2026-08-01T00:00:02.000Z";
	const runs = [
		completedRun({
			runId: "run-verify",
			cycle: 1,
			intent: "inspect",
			verificationStatus: "verified",
			evidence: [evidence("verify-call", "verify", verifyAt, "passed")]
		}),
		completedRun({
			runId: "run-write",
			cycle: 2,
			intent: "mutate",
			verificationStatus: "unverified",
			evidence: [evidence("write-call", "write", writeAt)],
			lastWriteAt: writeAt
		})
	];

	const result = enforceGoalEvaluationGates(achieved("write-call", "verify-call"), runs);
	assert.equal(result.disposition, "continue");
	assert.match(result.unmetCriteria.join(" "), /after the final write/i);
});

test("Goal completion rejects evidence ids that do not belong to any linked run", () => {
	const run = completedRun({
		runId: "run-read",
		cycle: 1,
		intent: "inspect",
		verificationStatus: "verified",
		evidence: [evidence("read-call", "read", "2026-08-01T00:00:01.000Z")]
	});

	const result = enforceGoalEvaluationGates(achieved("invented-call"), [run]);
	assert.equal(result.disposition, "blocked");
	assert.deepEqual(result.evidenceToolCallIds, []);
});

test("Goal evaluation ignores a stale blocked claim when the latest linked run completed", () => {
	const run = completedRun({
		runId: "run-completed",
		cycle: 6,
		intent: "mutate",
		verificationStatus: "verified",
		evidence: [evidence("verify-call", "verify", "2026-08-01T00:00:06.000Z", "passed")]
	});
	const staleEvaluation: GoalEvaluation = {
		disposition: "blocked",
		summary: "The latest linked run is still probing.",
		evidenceToolCallIds: ["verify-call"],
		unmetCriteria: ["The run must complete."],
		nextAction: "Wait for the run to complete."
	};

	const result = enforceGoalEvaluationGates(staleEvaluation, [run]);
	assert.equal(result.disposition, "continue");
	assert.match(result.summary, /authoritative completed AgentRun/i);
});

test("Goal evaluation preserves a structured blocked execution decision", () => {
	const run = completedRun({
		runId: "run-blocked",
		cycle: 2,
		intent: "mutate",
		verificationStatus: "unverified",
		evidence: [],
		executionDecision: {
			disposition: "blocked",
			summary: "A required external service is unavailable.",
			evidenceToolCallIds: [],
			expectedArtifacts: [],
			targetKind: "unknown"
		}
	});
	const blockedEvaluation: GoalEvaluation = {
		disposition: "blocked",
		summary: "A required external service is unavailable.",
		evidenceToolCallIds: [],
		unmetCriteria: ["Restore the external service."],
		nextAction: null
	};

	const result = enforceGoalEvaluationGates(blockedEvaluation, [run]);
	assert.equal(result.disposition, "blocked");
});
