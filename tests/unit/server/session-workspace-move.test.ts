import assert from "node:assert/strict";
import test from "node:test";
import type { AdditionalContextItem } from "../../../src/protocol/types.js";
import { clientRequestSchema } from "../../../src/protocol/schema.js";
import { createClientSession } from "../../../src/server/client-session.js";
import { assertSessionWorkspaceMoveAllowed } from "../../../src/server/session-workspace-move.js";

function assertMoveError(error: unknown, code: string): boolean {
	return error instanceof Error
		&& "code" in error
		&& (error as Error & { code: string }).code === code;
}

test("session workspace move protocol accepts only strict identifiers", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "request-move",
		method: "session.workspace.move",
		params: { sessionId: "session-a", workspaceId: "workspace-b" }
	}).success, true);
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "request-move",
		method: "session.workspace.move",
		params: { sessionId: "session-a", workspaceId: "workspace-b", unsafe: true }
	}).success, false);
});

test("session workspace move accepts missing and idle runtimes", (): void => {
	assert.doesNotThrow((): void => assertSessionWorkspaceMoveAllowed(undefined, "request-move"));
	assert.doesNotThrow((): void => assertSessionWorkspaceMoveAllowed(createClientSession(undefined), "request-move"));
});

test("session workspace move rejects active runtime state", (): void => {
	const session = createClientSession(undefined);
	session.messageQueueDrainActive = true;
	assert.throws(
		(): void => assertSessionWorkspaceMoveAllowed(session, "request-move"),
		(error: unknown): boolean => assertMoveError(error, "session_workspace_move_busy")
	);
});

test("session workspace move rejects workspace-bound Composer context", (): void => {
	const session = createClientSession(undefined);
	const context: AdditionalContextItem = {
		id: "context-file",
		kind: "file",
		title: "src/index.ts",
		source: "manual",
		resourcePath: "res://src/index.ts"
	};
	session.workbenchComposer.additionalContext = [context];
	assert.throws(
		(): void => assertSessionWorkspaceMoveAllowed(session, "request-move"),
		(error: unknown): boolean => assertMoveError(error, "session_workspace_context_pending")
	);
});

test("session workspace move preserves non-workspace Composer context", (): void => {
	const session = createClientSession(undefined);
	session.workbenchComposer.additionalContext = [{
		id: "context-web",
		kind: "web_element",
		title: "Example",
		source: "manual",
		data: {
			url: "https://example.com",
			pageTitle: "Example",
			selector: "main",
			tagName: "main",
			role: "main",
			accessibleName: "",
			selectedText: "Example",
			attributes: {},
			annotation: ""
		}
	}];
	assert.doesNotThrow((): void => assertSessionWorkspaceMoveAllowed(session, "request-move"));
});
