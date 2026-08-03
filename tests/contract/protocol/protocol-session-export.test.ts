import assert from "node:assert/strict";
import test from "node:test";
import { clientRequestSchema } from "../../../src/protocol/schema.js";

test("session.export validates a session and destination path payload", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "export-session",
		method: "session.export",
		params: {
			sessionId: "session-20260803-export",
			destinationPath: "C:\\Users\\test\\Documents\\session.sqlite"
		}
	}).success, true);

	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "export-session-missing-path",
		method: "session.export",
		params: { sessionId: "session-20260803-export" }
	}).success, false);
});
