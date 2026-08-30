import assert from "node:assert/strict";
import test from "node:test";
import { resolveSessionCreateWorkspaceId } from "../../../src/server/session-create-workspace.js";

test("session.create workspace resolution does not let Studio inherit stale active workspace", (): void => {
	assert.equal(resolveSessionCreateWorkspaceId({
		requestedWorkspaceId: undefined
	}), undefined);
});

test("session.create workspace resolution preserves explicit workspace choices", (): void => {
	assert.equal(resolveSessionCreateWorkspaceId({
		requestedWorkspaceId: "workspace-selected"
	}), "workspace-selected");
	assert.equal(resolveSessionCreateWorkspaceId({
		requestedWorkspaceId: null
	}), undefined);
});

test("session.create workspace resolution does not infer a workspace for clients without an explicit choice", (): void => {
	assert.equal(resolveSessionCreateWorkspaceId({
		requestedWorkspaceId: undefined
	}), undefined);
});
