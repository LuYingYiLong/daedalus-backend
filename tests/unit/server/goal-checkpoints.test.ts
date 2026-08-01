import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bindGoalRun, releaseGoalRunBinding } from "../../../src/server/goal-run-observer.js";
import { createAgentGoalState, transitionAgentGoalState } from "../../../src/workflow/agent-goal-state.js";

function sha(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

test("goal checkpoints restore a tracked file only while its after hash is unchanged", async (): Promise<void> => {
	const previousUserProfile = process.env.USERPROFILE;
	const profile = await mkdtemp(join(tmpdir(), "daedalus-goal-checkpoint-"));
	const workspaceRoot = join(profile, "workspace");
	const databasePath = join(profile, "sessions.sqlite3");
	process.env.USERPROFILE = profile;
	const database = await import("../../../src/session/session-database.js");
	await database.resetSessionDatabaseForTests(databasePath);
	try {
		await mkdir(workspaceRoot, { recursive: true });
		const { createRuntimeWorkspace, upsertRuntimeWorkspace } = await import("../../../src/workspace/registry.js");
		const workspace = upsertRuntimeWorkspace(createRuntimeWorkspace(workspaceRoot));
		const { createSession } = await import("../../../src/session/session-store.js");
		const session = await createSession("Checkpoint", workspace.id, undefined, workspace);
		const { readAgentGoalState, saveAgentGoalState } = await import("../../../src/session/agent-goal-store.js");
		const goal = createAgentGoalState({
			goalId: "goal-checkpoint-test",
			sessionId: session.id,
			rootRequestId: "goal-checkpoint-run",
			title: "Update a file",
			condition: "Update a file",
			modelSnapshot: {
				provider: "deepseek",
				model: "deepseek-v4-pro",
				reasoningEffort: null,
				approvalMode: "manual",
				workspaceId: workspace.id
			}
		});
		await saveAgentGoalState(transitionAgentGoalState(goal, "running", { activeRunId: "goal-checkpoint-run", cycle: 1 }));

		const target = join(workspaceRoot, "player.gd");
		await writeFile(target, "after", { encoding: "utf8", flag: "w" });
		bindGoalRun("goal-checkpoint-run", {
			goalId: goal.goalId,
			cycle: 1,
			rootRequestId: goal.rootRequestId,
			approvalMode: "auto-safe"
		});
		const { captureGoalFileEditDraft, previewAgentGoalRollback, applyAgentGoalRollback } = await import("../../../src/server/goal-checkpoints.js");
		await captureGoalFileEditDraft("goal-checkpoint-run", {
			workspaceId: workspace.id,
			workspaceRoot,
			edits: [{
				path: "player.gd",
				absolutePath: target,
				workspaceRoot,
				existedBefore: true,
				existsAfter: true,
				beforeText: "before",
				afterText: "after",
				beforeSha256: sha("before"),
				afterSha256: sha("after"),
				additions: 1,
				deletions: 1,
				undoable: true
			}]
		});
		releaseGoalRunBinding("goal-checkpoint-run");
		const captured = await readAgentGoalState(goal.goalId);
		assert.ok(captured !== null);
		const evaluating = transitionAgentGoalState(captured, "evaluating", { activeRunId: null });
		await saveAgentGoalState(transitionAgentGoalState(evaluating, "achieved"));

		const preview = await previewAgentGoalRollback(goal.goalId);
		assert.equal(preview.available, true, preview.reasons.join(", "));
		assert.ok(preview.fingerprint !== null);
		await applyAgentGoalRollback(goal.goalId, preview.fingerprint);
		assert.equal(await readFile(target, "utf8"), "before");
		assert.equal((await readAgentGoalState(goal.goalId))?.checkpoint.status, "rolled_back");
	} finally {
		releaseGoalRunBinding("goal-checkpoint-run");
		await database.resetSessionDatabaseForTests();
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
		await rm(profile, { recursive: true, force: true });
	}
});
