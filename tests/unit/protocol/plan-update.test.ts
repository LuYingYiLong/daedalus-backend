import assert from "node:assert/strict";
import test from "node:test";
import { clientRequestSchema } from "../../../src/protocol/schema.js";

test("plan.update requires a scoped revision and nonempty bounded Markdown", (): void => {
	const request = {
		type: "request",
		id: "edit-1",
		method: "plan.update",
		params: { sessionId: "session-a", planId: "plan-a", expectedUpdatedAt: "2026-10-01T00:00:00.000Z", markdown: "# Plan\n" }
	};
	assert.equal(clientRequestSchema.safeParse(request).success, true);
	assert.equal(clientRequestSchema.safeParse({ ...request, params: { ...request.params, sessionId: "" } }).success, false);
	assert.equal(clientRequestSchema.safeParse({ ...request, params: { ...request.params, expectedUpdatedAt: "" } }).success, false);
	assert.equal(clientRequestSchema.safeParse({ ...request, params: { ...request.params, markdown: "   " } }).success, false);
	assert.equal(clientRequestSchema.safeParse({ ...request, params: { ...request.params, markdown: "a".repeat(200_001) } }).success, false);
});
