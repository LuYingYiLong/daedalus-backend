import assert from "node:assert/strict";
import test from "node:test";
import type WebSocket from "ws";
import { createClientSession } from "../../../src/server/client-session.js";
import { cancelAgentRunForRejectedApproval, createApprovedWorkflowToolObservation, createPendingAiContinuation } from "../../../src/server/approval-continuation.js";
import { serializeToolFailure } from "../../../src/tools/tool-failure.js";
import { createAgentRunState, transitionAgentRunState } from "../../../src/workflow/agent-run-state.js";

test("rejecting an approval terminalizes only the paused agent turn", (): void => {
	const session = createClientSession(undefined);
	session.sessionId = "session-test";
	const routing = createAgentRunState({
		sessionId: "session-test",
		requestId: "request-test",
		runId: "run-test"
	});
	const probing = transitionAgentRunState(routing, "probing");
	const awaitingApproval = transitionAgentRunState(probing, "awaiting_approval", {
		pause: {
			kind: "approval",
			id: "approval-test",
			toolName: "mcp_workspace_replace_text_in_file",
			reason: "write_requires_approval"
		}
	});
	session.agentRuns.set(awaitingApproval.runId, awaitingApproval);

	const cancelled = cancelAgentRunForRejectedApproval({} as WebSocket, session, "run-test");

	assert.equal(cancelled?.stage, "cancelled");
	assert.equal(cancelled?.pause, null);
	assert.equal(cancelled?.terminal?.resultStatus, "cancelled");
	assert.match(cancelled?.terminal?.message ?? "", /Approval was rejected/u);
	assert.equal(cancelAgentRunForRejectedApproval({} as WebSocket, session, "run-test"), undefined);
});

test("an approval rejection cannot cancel an unrelated active turn", (): void => {
	const session = createClientSession(undefined);
	session.sessionId = "session-test";
	const run = transitionAgentRunState(
		createAgentRunState({ sessionId: "session-test", requestId: "other-request", runId: "other-run" }),
		"probing"
	);
	session.agentRuns.set(run.runId, run);

	assert.equal(cancelAgentRunForRejectedApproval({} as WebSocket, session, "other-run"), undefined);
	assert.equal(session.agentRuns.get("other-run")?.stage, "probing");
});

test("an approved environment failure remains a failed tool observation", (): void => {
	const observation = createApprovedWorkflowToolObservation({
		approvalId: "approval-test",
		toolCallId: "tool-call-test",
		toolName: "mcp_terminal_run_command",
		llmToolName: "mcp_terminal_run_command",
		args: { relativePath: "scripts/verify.gd", sourceFolderId: "godot" },
		reason: "verify",
		createdAt: 0
	}, serializeToolFailure({
		code: "mcp_request_timeout",
		category: "environment",
		message: "Request timed out",
		retryable: true,
		artifactRefs: ["scripts/verify.gd"],
		sourceFolderId: "godot"
	}));

	assert.equal(observation.status, "failed");
	assert.equal(observation.failure?.code, "mcp_request_timeout");
});

test("pending approval continuations clone their subagent identity", (): void => {
	const subagent = {
		graphId: "graph-test",
		nodeId: "node-test",
		workspaceId: "workspace-test"
	};
	const continuation = createPendingAiContinuation(
		{ message: "continue the child run" },
		{ provider: "deepseek", apiKey: "secret" },
		{ messages: [], nextStep: 1, totalToolResultChars: 0 },
		undefined,
		"continue the child run",
		"run-child",
		"2026-09-09T00:00:00.000Z",
		true,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		subagent
	);

	assert.deepEqual(continuation.subagent, subagent);
	assert.notEqual(continuation.subagent, subagent);
});
