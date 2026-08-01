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
