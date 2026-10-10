import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { clientRequestSchema } from "../../../src/protocol/schema.js";
import { readAssistantFeedback, setAssistantFeedback } from "../../../src/session/assistant-feedback.js";
import { resetSessionDatabaseForTests } from "../../../src/session/session-database.js";
import { exportSessionToSqlite } from "../../../src/session/session-export.js";
import { importSessionFromSqlite } from "../../../src/session/session-import.js";
import { appendMessage, createSession, openSessionRecentTimeline, saveSession } from "../../../src/session/session-store.js";
import { createTimelinePageResult } from "../../../src/server/session-preview.js";

test("assistant feedback RPC accepts only a rating or an explicit clear", (): void => {
	const request = { type: "request", id: "rating-1", method: "session.assistant.feedback.set", params: { sessionId: "session-a", requestId: "request-a", rating: "good" } };
	assert.equal(clientRequestSchema.safeParse(request).success, true);
	assert.equal(clientRequestSchema.safeParse({ ...request, params: { ...request.params, rating: null } }).success, true);
	assert.equal(clientRequestSchema.safeParse({ ...request, params: { ...request.params, rating: "neutral" } }).success, false);
	assert.equal(clientRequestSchema.safeParse({ ...request, params: { ...request.params, secret: "unexpected" } }).success, false);
});

test("assistant feedback is exclusive, reversible, session-scoped, and survives export", async (): Promise<void> => {
	const directory = await mkdtemp(join(tmpdir(), "daedalus-assistant-feedback-"));
	await resetSessionDatabaseForTests(join(directory, "source.sqlite"));
	try {
		const session = await createSession("Rated conversation");
		const other = await createSession("Other conversation");
		await appendMessage(session.id, { role: "user", content: "Question", requestId: "rated-request" });
		await appendMessage(session.id, { role: "assistant", content: "Answer", requestId: "rated-request" });
		await assert.rejects(setAssistantFeedback(other.id, "rated-request", "good"), /not found/);
		await assert.rejects(setAssistantFeedback(session.id, "missing-request", "bad"), /not found/);

		assert.equal((await setAssistantFeedback(session.id, "rated-request", "good")).rating, "good");
		assert.equal((await setAssistantFeedback(session.id, "rated-request", "bad")).rating, "bad");
		assert.equal((await readAssistantFeedback(session.id, ["rated-request"])).get("rated-request"), "bad");
		assert.equal((await readAssistantFeedback(other.id, ["rated-request"])).size, 0);
		const page = await createTimelinePageResult(await openSessionRecentTimeline(session.id, 10), 10);
		const rated = (page.timelineBlocks as Array<{ type: string; requestId: string; feedback?: string | null }>)
			.find((block): boolean => block.type === "assistant" && block.requestId === "rated-request");
		assert.equal(rated?.feedback, "bad");

		await setAssistantFeedback(session.id, "rated-request", null);
		assert.equal((await readAssistantFeedback(session.id, ["rated-request"])).size, 0);
		await setAssistantFeedback(session.id, "rated-request", "good");
		const destination = join(directory, "export.sqlite");
		const exported = await exportSessionToSqlite(session.id, destination);
		assert.equal(exported.tableCounts.assistant_feedback, 1);
		await resetSessionDatabaseForTests(join(directory, "imported.sqlite"));
		await importSessionFromSqlite(destination);
		assert.equal((await readAssistantFeedback(session.id, ["rated-request"])).get("rated-request"), "good");
		await saveSession(session.id, []);
		assert.equal((await readAssistantFeedback(session.id, ["rated-request"])).size, 0);
	} finally {
		await resetSessionDatabaseForTests();
		await rm(directory, { recursive: true, force: true });
	}
});

test("session archives without the optional feedback table remain importable", async (): Promise<void> => {
	const directory = await mkdtemp(join(tmpdir(), "daedalus-feedback-legacy-import-"));
	await resetSessionDatabaseForTests(join(directory, "source.sqlite"));
	try {
		const session = await createSession("Legacy archive");
		const destination = join(directory, "export.sqlite");
		await exportSessionToSqlite(session.id, destination);
		const archive = new DatabaseSync(destination);
		try {
			archive.exec("DROP TABLE assistant_feedback");
		} finally {
			archive.close();
		}
		await resetSessionDatabaseForTests(join(directory, "imported.sqlite"));
		assert.equal((await importSessionFromSqlite(destination)).sessionId, session.id);
	} finally {
		await resetSessionDatabaseForTests();
		await rm(directory, { recursive: true, force: true });
	}
});
