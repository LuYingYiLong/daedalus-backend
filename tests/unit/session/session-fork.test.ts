import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { StoredMessage, StoredSessionEvent } from "../../../src/session/session-store.js";

test("session fork copies the stable prefix and persists an independent composer draft", async (): Promise<void> => {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const appDataDir: string = await fs.mkdtemp(path.join(os.tmpdir(), "daedalus-session-fork-"));
	process.env.USERPROFILE = appDataDir;
	try {
		const store = await import(`../../../src/session/session-store.js?fork=${Date.now()}`);
		const attachments = await import(`../../../src/session/session-attachments.js?fork=${Date.now()}`);
		const forkStore = await import(`../../../src/session/session-fork.js?fork=${Date.now()}`);
		const source = await store.createSession("Source", "workspace-a", "gdscript.review", undefined, {
			provider: "openai",
			model: "gpt-test",
			reasoningEffort: "high",
			chatMode: "ask",
			approvalMode: "auto-safe",
		});
		const firstAttachment = await attachments.saveTextAttachment({
			sessionId: source.id,
			content: "first attachment",
			title: "first.txt",
		});
		const anchorAttachment = await attachments.saveTextAttachment({
			sessionId: source.id,
			content: "anchor attachment",
			title: "anchor.txt",
		});
		await store.appendMessage(source.id, {
			role: "user",
			content: "First question",
			requestId: "request-1",
			additionalContext: [firstAttachment],
			createdAt: "2026-08-14T00:00:00.000Z",
		});
		await store.appendSessionEvent(source.id, "request-1", "agent.message.done", { text: "First answer" }, {
			eventId: "event-request-1",
			sequence: 1,
			createdAt: "2026-08-14T00:00:01.000Z",
		});
		await store.appendMessage(source.id, {
			role: "assistant",
			content: "First answer",
			requestId: "request-1",
			createdAt: "2026-08-14T00:00:01.000Z",
		});
		await store.appendMessage(source.id, {
			role: "user",
			content: "Compare this model",
			requestId: "request-2",
			additionalContext: [anchorAttachment],
			createdAt: "2026-08-14T00:00:02.000Z",
		});
		await store.appendSessionEvent(source.id, "request-2", "agent.message.done", { text: "Second answer" }, {
			eventId: "event-request-2",
			sequence: 2,
			createdAt: "2026-08-14T00:00:03.000Z",
		});
		await store.appendMessage(source.id, {
			role: "assistant",
			content: "Second answer",
			requestId: "request-2",
			createdAt: "2026-08-14T00:00:03.000Z",
		});
		await store.appendMessage(source.id, {
			role: "user",
			content: "Third question",
			requestId: "request-3",
			createdAt: "2026-08-14T00:00:04.000Z",
		});
		const database = await import("../../../src/session/session-database.js");
		const db = await database.getSessionDatabase();
		db.prepare(`
			INSERT INTO file_edit_batches(
				batch_id, session_id, request_id, tool_call_id, tool_name, payload_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)
		`).run(
			"edit-source-batch",
			source.id,
			"request-1",
			"tool-call-source",
			"write_text_file",
			database.sqlJson({
				schemaVersion: 1,
				batchId: "edit-source-batch",
				requestId: "request-1",
				toolCallId: "tool-call-source",
				toolName: "write_text_file",
				workspaceId: "workspace-a",
				workspaceRoot: "C:/workspace-a",
				createdAt: "2026-08-14T00:00:01.000Z",
				edits: [{ path: "test.gd", undoable: true }],
			}),
			"2026-08-14T00:00:01.000Z",
		);

		const fork = await forkStore.createSessionFork({
			sourceSessionId: source.id,
			sourceRequestId: "request-2",
			title: "Source · Fork",
		});
		const opened = await store.openSession(fork.metadata.id);
		assert.deepEqual(opened.messages.map((message: StoredMessage): string => message.content), ["First question", "First answer"]);
		assert.deepEqual(opened.events.map((event: StoredSessionEvent): string => event.requestId), ["request-1"]);
		assert.equal(fork.draft.text, "Compare this model");
		assert.equal(fork.metadata.provider, "openai");
		assert.equal(fork.metadata.model, "gpt-test");
		assert.equal(fork.metadata.reasoningEffort, "high");
		assert.equal(fork.metadata.chatMode, "ask");
		assert.equal(fork.metadata.approvalMode, "auto-safe");
		assert.equal(fork.metadata.workspaceId, "workspace-a");
		assert.equal(fork.metadata.pinned, undefined);
		assert.deepEqual(fork.metadata.forkedFrom, {
			sessionId: source.id,
			requestId: "request-2",
			sessionTitle: "Source",
			messagePreview: "Compare this model",
		});

		const sourceAnchorId = (anchorAttachment.data as Record<string, unknown>).attachmentId;
		const targetAnchor = fork.draft.additionalContext[0]!;
		const targetAnchorId = (targetAnchor.data as Record<string, unknown>).attachmentId;
		assert.notEqual(targetAnchorId, sourceAnchorId);
		assert.equal(
			(await attachments.readTextAttachmentContent(fork.metadata.id, String(targetAnchorId))).content,
			"anchor attachment",
		);
		assert.deepEqual(await forkStore.readSessionForkDraft(fork.metadata.id), fork.draft);
		const copiedBatch = db.prepare(`
			SELECT batch_id, tool_call_id, payload_json
			FROM file_edit_batches WHERE session_id = ?
		`).get(fork.metadata.id) as Record<string, unknown>;
		assert.match(String(copiedBatch.batch_id), /^edit-[a-z0-9-]+$/u);
		assert.notEqual(copiedBatch.batch_id, "edit-source-batch");
		assert.notEqual(copiedBatch.tool_call_id, "tool-call-source");
		const copiedBatchPayload = database.parseSqlJson<Record<string, unknown>>(copiedBatch.payload_json);
		assert.equal(copiedBatchPayload.batchId, copiedBatch.batch_id);
		assert.equal(copiedBatchPayload.toolCallId, copiedBatch.tool_call_id);
		assert.equal((copiedBatchPayload.edits as Array<Record<string, unknown>>)[0]?.undoable, false);
		await forkStore.updateSessionForkDraft(fork.metadata.id, {
			text: "Edited fork prompt",
			additionalContext: fork.draft.additionalContext,
		});
		assert.equal((await forkStore.readSessionForkDraft(fork.metadata.id))?.text, "Edited fork prompt");
		assert.equal((await store.openSession(source.id)).messages.length, 5);

		const lastQuestionFork = await forkStore.createSessionFork({
			sourceSessionId: source.id,
			title: "Last question fork",
		});
		assert.equal(lastQuestionFork.metadata.forkedFrom?.requestId, "request-3");
		assert.equal(lastQuestionFork.draft.text, "Third question");
		assert.deepEqual(
			(await store.openSession(lastQuestionFork.metadata.id)).messages.map((message: StoredMessage): string => message.content),
			["First question", "First answer", "Compare this model", "Second answer"],
		);
		await assert.rejects(
			forkStore.createSessionFork({
				sourceSessionId: source.id,
				sourceRequestId: "missing-request",
				title: "Invalid anchor",
			}),
			(error: Error & { code?: string }): boolean => error.code === "session_fork_anchor_not_found",
		);
		const emptySource = await store.createSession("Empty source");
		await assert.rejects(
			forkStore.createSessionFork({ sourceSessionId: emptySource.id, title: "Empty fork" }),
			(error: Error & { code?: string }): boolean => error.code === "session_fork_anchor_not_found",
		);
		await assert.rejects(
			forkStore.createSessionFork({ sourceSessionId: "session-20260814-missing", title: "Missing source" }),
			(error: Error & { code?: string }): boolean => error.code === "session_not_found",
		);
		const brokenSource = await store.createSession("Broken attachment source");
		const brokenAttachment = await attachments.saveTextAttachment({
			sessionId: brokenSource.id,
			content: "missing on disk",
			title: "missing.txt",
		});
		await store.appendMessage(brokenSource.id, {
			role: "user",
			content: "Fork should roll back",
			requestId: "broken-request",
			additionalContext: [brokenAttachment],
			createdAt: "2026-08-14T00:01:00.000Z",
		});
		const brokenAttachmentId = String((brokenAttachment.data as Record<string, unknown>).attachmentId);
		await fs.rm(path.join(store.getSessionDir(brokenSource.id), "attachments", "text", `${brokenAttachmentId}.txt`));
		const sessionIdsBeforeFailedFork = new Set((await store.listSessions()).map((item: { id: string }): string => item.id));
		await assert.rejects(forkStore.createSessionFork({
			sourceSessionId: brokenSource.id,
			title: "Failed fork",
		}));
		assert.deepEqual(
			new Set((await store.listSessions()).map((item: { id: string }): string => item.id)),
			sessionIdsBeforeFailedFork,
		);

		await store.deleteSession(source.id);
		assert.equal(
			(await attachments.readTextAttachmentContent(fork.metadata.id, String(targetAnchorId))).content,
			"anchor attachment",
		);
		await forkStore.clearSessionForkDraft(fork.metadata.id);
		assert.equal(await forkStore.readSessionForkDraft(fork.metadata.id), null);
	} finally {
		const { resetSessionDatabaseForTests } = await import("../../../src/session/session-database.js");
		await resetSessionDatabaseForTests();
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		await fs.rm(appDataDir, { recursive: true, force: true });
	}
});
