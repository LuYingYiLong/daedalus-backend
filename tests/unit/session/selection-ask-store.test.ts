import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { MessageTextAnchor } from "../../../src/protocol/types.js";

test("selection Ask persists one thread per exact anchor and isolated messages", async (): Promise<void> => {
	const profile: string = await mkdtemp(join(tmpdir(), "daedalus-selection-ask-"));
	const databasePath: string = join(profile, "sessions.sqlite3");
	const { resetSessionDatabaseForTests } = await import("../../../src/session/session-database.js");
	await resetSessionDatabaseForTests(databasePath);
	try {
		const sessions = await import("../../../src/session/session-store.js");
		const selectionAsk = await import("../../../src/session/selection-ask-store.js");
		const metadata = await sessions.createSession("Selection Ask");
		const anchor: MessageTextAnchor = {
			entryId: "assistant-request-1",
			requestId: "request-1",
			role: "assistant",
			segmentKey: "assistant:markdown:0",
			startOffset: 3,
			endOffset: 8,
			quote: "Godot",
			contextBefore: "Use ",
			contextAfter: " here."
		};
		const created = await selectionAsk.createOrReadSelectionAskThread({
			sessionId: metadata.id,
			anchor,
			provider: "deepseek",
			model: "deepseek-v4-pro",
			reasoningEffort: "high",
			baseUrl: "https://example.test/v1"
		});
		const reused = await selectionAsk.createOrReadSelectionAskThread({
			sessionId: metadata.id,
			anchor,
			provider: "openai",
			model: "other-model"
		});
		assert.equal(created.created, true);
		assert.equal(reused.created, false);
		assert.equal(reused.thread.threadId, created.thread.threadId);
		assert.equal(reused.thread.provider, "deepseek");

		const turn = await selectionAsk.appendSelectionAskTurn(created.thread, "ask-request-1", "What does this mean?");
		await assert.rejects(
			selectionAsk.appendSelectionAskTurn(created.thread, "ask-request-2", "Second question"),
			/selection_ask_busy/u
		);
		await selectionAsk.updateSelectionAskAssistantMessage(created.thread.threadId, turn.assistantMessage.messageId, "It is the engine name.", "completed");
		const page = await selectionAsk.readSelectionAskThreadPage(metadata.id, created.thread.threadId, undefined, 10);
		assert.equal(page?.messages.length, 2);
		assert.deepEqual(page?.messages.map((message): string => message.role), ["user", "assistant"]);
		assert.equal(page?.messages[1]?.content, "It is the engine name.");
		assert.equal(page?.thread.status, "idle");
	} finally {
		await resetSessionDatabaseForTests();
		await rm(profile, { recursive: true, force: true });
	}
});

test("selection Ask rows cascade when the owning session is deleted", async (): Promise<void> => {
	const profile: string = await mkdtemp(join(tmpdir(), "daedalus-selection-ask-delete-"));
	const databasePath: string = join(profile, "sessions.sqlite3");
	const database = await import("../../../src/session/session-database.js");
	await database.resetSessionDatabaseForTests(databasePath);
	try {
		const sessions = await import("../../../src/session/session-store.js");
		const selectionAsk = await import("../../../src/session/selection-ask-store.js");
		const metadata = await sessions.createSession("Delete selection Ask");
		await selectionAsk.createOrReadSelectionAskThread({
			sessionId: metadata.id,
			anchor: {
				entryId: "user-1", requestId: "request-1", role: "user", segmentKey: "user:content",
				startOffset: 0, endOffset: 4, quote: "test", contextBefore: "", contextAfter: ""
			},
			provider: "deepseek",
			model: "deepseek-v4-pro"
		});
		await sessions.deleteSession(metadata.id);
		assert.deepEqual(await selectionAsk.listSelectionAskThreads(metadata.id), []);
	} finally {
		await database.resetSessionDatabaseForTests();
		await rm(profile, { recursive: true, force: true });
	}
});

test("selection Ask threads can be deleted individually or all at once", async (): Promise<void> => {
	const profile: string = await mkdtemp(join(tmpdir(), "daedalus-selection-ask-remove-"));
	const databasePath: string = join(profile, "sessions.sqlite3");
	const database = await import("../../../src/session/session-database.js");
	await database.resetSessionDatabaseForTests(databasePath);
	try {
		const sessions = await import("../../../src/session/session-store.js");
		const selectionAsk = await import("../../../src/session/selection-ask-store.js");
		const metadata = await sessions.createSession("Remove selection Ask");
		const createThread = async (requestId: string): Promise<string> => {
			const result = await selectionAsk.createOrReadSelectionAskThread({
				sessionId: metadata.id,
				anchor: {
					entryId: `user-${requestId}`, requestId, role: "user", segmentKey: "user:content",
					startOffset: 0, endOffset: 4, quote: "test", contextBefore: "", contextAfter: ""
				},
				provider: "deepseek",
				model: "deepseek-v4-pro"
			});
			return result.thread.threadId;
		};
		const firstThreadId: string = await createThread("request-1");
		await createThread("request-2");

		assert.equal(await selectionAsk.deleteSelectionAskThread(metadata.id, firstThreadId), true);
		assert.equal(await selectionAsk.deleteSelectionAskThread(metadata.id, firstThreadId), false);
		assert.equal((await selectionAsk.listSelectionAskThreads(metadata.id)).length, 1);
		assert.equal(await selectionAsk.deleteAllSelectionAskThreads(metadata.id), 1);
		assert.deepEqual(await selectionAsk.listSelectionAskThreads(metadata.id), []);
	} finally {
		await database.resetSessionDatabaseForTests();
		await rm(profile, { recursive: true, force: true });
	}
});
