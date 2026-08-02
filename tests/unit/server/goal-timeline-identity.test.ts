import assert from "node:assert/strict";
import test from "node:test";
import type { ClientSession } from "../../../src/server/client-session.js";
import { bindGoalRun, releaseGoalRunBinding } from "../../../src/server/goal-run-observer.js";
import { resolveTimelineRequestId } from "../../../src/server/session-events.js";

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
