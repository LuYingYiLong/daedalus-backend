import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	dismissAgentGoalState,
	listAgentGoalRunIds,
	markActiveAgentGoalsPaused,
	readAgentGoalState,
	readCurrentAgentGoal,
	readLatestAgentGoal,
	saveAgentGoalState
} from "../../../src/session/agent-goal-store.js";
import { saveAgentRunState } from "../../../src/session/agent-run-store.js";
import { createAgentGoalState, transitionAgentGoalState } from "../../../src/workflow/agent-goal-state.js";
import { createAgentRunState } from "../../../src/workflow/agent-run-state.js";

test("agent goal state, run links and restart pause persist", async (): Promise<void> => {
	const directory = await mkdtemp(join(tmpdir(), "daedalus-agent-goal-store-"));
	const databasePath = join(directory, "sessions.sqlite3");
	const database = await import("../../../src/session/session-database.js");
	await database.resetSessionDatabaseForTests(databasePath);
	try {
		const { createSession } = await import("../../../src/session/session-store.js");
		const metadata = await createSession("Goal persistence");
		const goal = createAgentGoalState({
			goalId: "goal-store",
			sessionId: metadata.id,
			rootRequestId: "goal-root",
			title: "Persist this goal",
			condition: "Persist this goal",
			modelSnapshot: {
				provider: "deepseek",
				model: "deepseek-v4-pro",
				reasoningEffort: null,
				approvalMode: "manual",
				workspaceId: null
			}
		});
		const running = transitionAgentGoalState(goal, "running", { activeRunId: "goal-run-1", cycle: 1 });
		await saveAgentGoalState(running);

		const run = createAgentRunState({
			sessionId: metadata.id,
			requestId: "goal-run-1",
			runId: "goal-run-1",
			goalId: goal.goalId,
			goalCycle: 1
		});
		await saveAgentRunState(run);
		const { linkAgentGoalRun } = await import("../../../src/session/agent-goal-store.js");
		await linkAgentGoalRun(goal.goalId, run.runId, 1);

		assert.equal((await readCurrentAgentGoal(metadata.id))?.goalId, goal.goalId);
		assert.deepEqual(await listAgentGoalRunIds(goal.goalId), [run.runId]);
		const paused = await markActiveAgentGoalsPaused("backend_restart");
		assert.equal(paused[0]?.pauseReason, "backend_restart");
		assert.equal((await readAgentGoalState(goal.goalId))?.stage, "paused");
		const cancelled = transitionAgentGoalState(paused[0]!, "cancelled", { pauseReason: null, activeRunId: null });
		await saveAgentGoalState(cancelled);
		assert.equal(await dismissAgentGoalState(goal.goalId), true);
		assert.equal(await readLatestAgentGoal(metadata.id), null);
		assert.equal((await readAgentGoalState(goal.goalId))?.stage, "cancelled");
	} finally {
		await database.resetSessionDatabaseForTests();
		await rm(directory, { recursive: true, force: true });
	}
});
