import assert from "node:assert/strict";
import test from "node:test";
import { bindGoalRun, releaseGoalRunBinding } from "../../../src/server/goal-run-observer.js";
import { ApprovalGateway } from "../../../src/tools/approval-gateway.js";

test("Goal tool approval uses the mode captured when the Goal was created", async () => {
	const gateway = new ApprovalGateway("full-trust");
	const args = { relativePath: "notes.txt", content: "done" };
	assert.equal((await gateway.evaluate("mcp_godot_create_text_file", args, "ordinary-call")).action, "allow");

	bindGoalRun("goal-request", {
		goalId: "goal-a",
		cycle: 1,
		rootRequestId: "root-a",
		approvalMode: "manual"
	});
	try {
		const decision = await gateway.evaluate(
			"mcp_godot_create_text_file",
			args,
			"goal-call",
			"workspace-a",
			{ requestId: "goal-request", sessionId: "session-a" }
		);
		assert.equal(decision.action, "request_approval");
	} finally {
		releaseGoalRunBinding("goal-request");
	}
});

test("Auto Safe Goal accepts a saved Editor Bridge patch targeting the active scene", async () => {
	const gateway = new ApprovalGateway("manual");
	bindGoalRun("goal-editor-request", {
		goalId: "goal-editor",
		cycle: 1,
		rootRequestId: "root-editor",
		approvalMode: "auto-safe"
	});
	try {
		const args = {
			operations: [{ type: "add_node", parentPath: ".", nodeType: "Node", nodeName: "Child" }]
		};
		const allowed = await gateway.evaluate(
			"mcp_godot_editor_apply_scene_patch",
			args,
			"goal-editor-call",
			"workspace-a",
			{
				requestId: "goal-editor-request",
				sessionId: "session-a",
				activeScenePath: "res://scenes/Main.tscn"
			}
		);
		assert.equal(allowed.action, "allow");

		const missingTarget = await gateway.evaluate(
			"mcp_godot_editor_apply_scene_patch",
			args,
			"goal-editor-call-missing",
			"workspace-a",
			{ requestId: "goal-editor-request", sessionId: "session-a" }
		);
		assert.equal(missingTarget.action, "allow");

		const unsaved = await gateway.evaluate(
			"mcp_godot_editor_apply_scene_patch",
			{ ...args, saveAfter: false },
			"goal-editor-call-unsaved",
			"workspace-a",
			{
				requestId: "goal-editor-request",
				sessionId: "session-a",
				activeScenePath: "res://scenes/Main.tscn"
			}
		);
		assert.equal(unsaved.action, "allow");
	} finally {
		releaseGoalRunBinding("goal-editor-request");
	}
});

test("Auto Safe Goal does not replace runtime policy with a rollback-completeness approval", async () => {
	const gateway = new ApprovalGateway("manual", {
		resolveSandboxAvailability: () => ({ available: true })
	});
	bindGoalRun("goal-untracked-request", {
		goalId: "goal-untracked",
		cycle: 1,
		rootRequestId: "root-untracked",
		approvalMode: "auto-safe"
	});
	try {
		const decision = await gateway.evaluate(
			"mcp_godot_resave_resource",
			{ resourcePath: "res://materials/player.tres" },
			"goal-untracked-call",
			"workspace-a",
			{ requestId: "goal-untracked-request", sessionId: "session-a" }
		);
		assert.equal(decision.action, "allow");

		const dangerousCommand = await gateway.evaluate(
			"mcp_terminal_run_command",
			{ commandLine: "git reset --hard HEAD~1", cwd: "." },
			"goal-dangerous-command",
			"workspace-a",
			{ requestId: "goal-untracked-request", sessionId: "session-a" }
		);
		assert.equal(dangerousCommand.action, "request_approval");
		if (dangerousCommand.action === "request_approval") {
			assert.match(dangerousCommand.reason, /destructive/u);
			assert.doesNotMatch(dangerousCommand.reason, /rollback checkpoint/iu);
		}
	} finally {
		releaseGoalRunBinding("goal-untracked-request");
	}
});
