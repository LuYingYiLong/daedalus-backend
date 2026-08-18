import assert from "node:assert/strict";
import test from "node:test";
import { clientRequestSchema } from "../../../src/protocol/schema.js";

function request(method: string, params?: unknown): Record<string, unknown> {
	return {
		type: "request",
		id: "hooks-contract",
		method,
		...(params === undefined ? {} : { params })
	};
}

test("hooks configuration RPC contracts accept valid targets", (): void => {
	assert.equal(clientRequestSchema.safeParse(request("hooks.config.sources.list", { workspaceId: "workspace-a" })).success, true);
	assert.equal(clientRequestSchema.safeParse(request("hooks.config.get", { scope: "global" })).success, true);
	assert.equal(clientRequestSchema.safeParse(request("hooks.config.get", {
		scope: "source",
		workspaceId: "workspace-a",
		sourceFolderId: "source-a"
	})).success, true);
	assert.equal(clientRequestSchema.safeParse(request("hooks.config.update", {
		scope: "global",
		content: "{\"hooks\":{}}",
		expectedRevision: "a".repeat(64)
	})).success, true);
	assert.equal(clientRequestSchema.safeParse(request("hooks.trust.update", {
		scope: "global",
		fingerprint: "b".repeat(64),
		status: "trusted"
	})).success, true);
	assert.equal(clientRequestSchema.safeParse(request("hooks.runs.list", { limit: 100 })).success, true);
});

test("hooks RPC contracts reject incomplete source targets and unknown trust states", (): void => {
	assert.equal(clientRequestSchema.safeParse(request("hooks.config.get", { scope: "source" })).success, false);
	assert.equal(clientRequestSchema.safeParse(request("hooks.trust.update", {
		scope: "global",
		fingerprint: "b".repeat(64),
		status: "automatic"
	})).success, false);
	assert.equal(clientRequestSchema.safeParse(request("hooks.runs.list", { limit: 101 })).success, false);
});
