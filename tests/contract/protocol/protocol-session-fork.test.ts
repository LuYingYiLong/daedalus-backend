import assert from "node:assert/strict";
import test from "node:test";
import { clientRequestSchema } from "../../../src/protocol/schema.js";

test("session.fork validates Studio fork payloads strictly", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "fork-session",
		method: "session.fork",
		params: {
			sourceSessionId: "session-20260814-source",
			sourceRequestId: "request-2",
			title: "Source · Fork",
		},
	}).success, true);

	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "fork-last-turn",
		method: "session.fork",
		params: {
			sourceSessionId: "session-20260814-source",
			title: "Source · Fork",
		},
	}).success, true);

	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "fork-invalid",
		method: "session.fork",
		params: {
			sourceSessionId: "session-20260814-source",
			title: " ",
			unexpected: true,
		},
	}).success, false);
});
