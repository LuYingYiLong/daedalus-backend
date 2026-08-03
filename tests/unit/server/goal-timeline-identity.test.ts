import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { createClientSession } from "../../../src/server/client-session.js";
import type { ClientSession } from "../../../src/server/client-session.js";
import { bindGoalRun, releaseGoalRunBinding } from "../../../src/server/goal-run-observer.js";
import { resolveTimelineRequestId, sendSessionEvent } from "../../../src/server/session-events.js";
import { createAgentRunState, transitionAgentRunState } from "../../../src/workflow/agent-run-state.js";

type SocketMock = WebSocket & { sent: Array<Record<string, unknown>> };

function createSocket(): SocketMock {
	const sent: Array<Record<string, unknown>> = [];
	return {
		readyState: WebSocket.OPEN,
		sent,
		send(message: string): void {
			sent.push(JSON.parse(message) as Record<string, unknown>);
		}
	} as SocketMock;
}

test("Goal cycle events use the root request as their live timeline identity", (): void => {
	const requestId: string = "goal-one:cycle:2";
	const session = { agentRuns: new Map() } as unknown as ClientSession;
	bindGoalRun(requestId, {
		goalId: "goal-one",
		cycle: 2,
		rootRequestId: "request-root",
		approvalMode: "auto-safe"
	});
	try {
		assert.deepEqual(resolveTimelineRequestId(session, requestId, requestId, { runId: requestId }), {
			requestId: "request-root",
			persistRequestId: "request-root"
		});
	} finally {
		releaseGoalRunBinding(requestId);
	}
});

test("Goal cycle lifecycle events transition the concrete child Run instead of the terminal root Run", (): void => {
	const rootRequestId = "request-root-terminal";
	const childRequestId = "goal-one:cycle:4";
	const session = createClientSession(undefined);
	let rootRun = createAgentRunState({
		sessionId: "session-goal-lifecycle",
		requestId: rootRequestId,
		runId: rootRequestId,
		title: "Root Goal run"
	});
	rootRun = transitionAgentRunState(rootRun, "executing");
	rootRun = transitionAgentRunState(rootRun, "finalizing");
	rootRun = transitionAgentRunState(rootRun, "completed", {
		terminal: { resultStatus: "completed", completedAt: "2026-08-02T00:00:00.000Z" }
	});
	let childRun = createAgentRunState({
		sessionId: "session-goal-lifecycle",
		requestId: childRequestId,
		runId: childRequestId,
		rootRequestId,
		title: "Goal cycle 4"
	});
	childRun = transitionAgentRunState(childRun, "executing");
	session.agentRuns.set(rootRun.runId, rootRun);
	session.agentRuns.set(childRun.runId, childRun);
	bindGoalRun(childRequestId, {
		goalId: "goal-one",
		cycle: 4,
		rootRequestId,
		approvalMode: "auto-safe"
	});
	try {
		sendSessionEvent(createSocket(), childRequestId, session, "agent.run.error", {
			runId: "workflow-cycle-4",
			message: "Workflow finalization failed"
		}, childRequestId);
		assert.equal(session.agentRuns.get(rootRequestId)?.stage, "completed");
		assert.equal(session.agentRuns.get(childRequestId)?.stage, "failed");
	} finally {
		releaseGoalRunBinding(childRequestId);
	}
});
