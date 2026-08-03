import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type WebSocket from "ws";
import { createClientSession } from "../../../src/server/client-session.js";
import {
	dismissAgentGoal,
	emitAgentGoalState,
	getLatestAgentGoal
} from "../../../src/server/goal-controller.js";
import { createAgentGoalState, transitionAgentGoalState } from "../../../src/workflow/agent-goal-state.js";

test("a dismissed terminal Goal ignores late state emissions", async (): Promise<void> => {
	const directory = await mkdtemp(join(tmpdir(), "daedalus-goal-dismissal-"));
	const databasePath = join(directory, "sessions.sqlite3");
	const database = await import("../../../src/session/session-database.js");
	await database.resetSessionDatabaseForTests(databasePath);
	try {
		const { createSession } = await import("../../../src/session/session-store.js");
		const metadata = await createSession("Dismissed Goal");
		const session = createClientSession(undefined);
		session.sessionId = metadata.id;
		const socket = { readyState: 3 } as WebSocket;
		const goal = transitionAgentGoalState(createAgentGoalState({
			goalId: "goal-dismissal-late-event",
			sessionId: metadata.id,
			rootRequestId: "goal-dismissal-root",
			title: "Dismiss me",
			condition: "Dismiss me",
			modelSnapshot: {
				provider: "deepseek",
				model: "deepseek-v4-pro",
				reasoningEffort: null,
				approvalMode: "manual",
				workspaceId: null
			}
		}), "failed");

		emitAgentGoalState(socket, session, goal);
		await session.eventPersistQueue;
		assert.equal((await getLatestAgentGoal(metadata.id))?.goalId, goal.goalId);

		await dismissAgentGoal(goal.goalId);
		assert.equal(await getLatestAgentGoal(metadata.id), null);

		// Simulate an already-scheduled async completion arriving after dismissal.
		emitAgentGoalState(socket, session, goal);
		await session.eventPersistQueue;
		assert.equal(await getLatestAgentGoal(metadata.id), null);
	} finally {
		await database.resetSessionDatabaseForTests();
		await rm(directory, { recursive: true, force: true });
	}
});
