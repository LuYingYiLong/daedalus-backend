import assert from "node:assert/strict";
import test from "node:test";
import { clientRequestSchema } from "../../../src/protocol/schema.js";

test("worktree RPCs validate Studio payloads strictly", (): void => {
	assert.equal(
		clientRequestSchema.safeParse({
			type: "request",
			id: "worktree-eligibility",
			method: "workspace.worktree.eligibility.get",
			params: { workspaceId: "workspace-main" }
		}).success,
		true
	);

	assert.equal(
		clientRequestSchema.safeParse({
			type: "request",
			id: "worktree-create",
			method: "session.worktree.create",
			params: {
				sessionId: "session-20260819-example",
				workspaceId: "workspace-main"
			}
		}).success,
		true
	);

	assert.equal(
		clientRequestSchema.safeParse({
			type: "request",
			id: "worktree-delete",
			method: "session.worktree.delete",
			params: { sessionId: "session-20260819-example" }
		}).success,
		true
	);

	assert.equal(
		clientRequestSchema.safeParse({
			type: "request",
			id: "worktree-invalid",
			method: "session.worktree.create",
			params: {
				sessionId: "session-20260819-example",
				workspaceId: "workspace-main",
				force: true
			}
		}).success,
		false
	);
});
