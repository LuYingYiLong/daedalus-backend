import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function withTempProfile(run: (profile: string) => Promise<void>): Promise<void> {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const profile: string = await mkdtemp(join(tmpdir(), "daedalus-session-export-"));
	process.env.USERPROFILE = profile;
	try {
		await run(profile);
	} finally {
		const { resetSessionDatabaseForTests } = await import("../../../src/session/session-database.js");
		await resetSessionDatabaseForTests();
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		await rm(profile, { recursive: true, force: true });
	}
}

test("exports one session and embeds its attachment payload in a standalone SQLite file", async (): Promise<void> => {
	await withTempProfile(async (profile: string): Promise<void> => {
		const store = await import("../../../src/session/session-store.js");
		const { readTextAttachmentContent, saveTextAttachment } = await import("../../../src/session/session-attachments.js");
		const { getSessionDatabase } = await import("../../../src/session/session-database.js");
		const { exportSessionToSqlite } = await import("../../../src/session/session-export.js");
		const { importSessionFromSqlite } = await import("../../../src/session/session-import.js");
		const first = await store.createSession("Export me", "workspace-a");
		const second = await store.createSession("Do not export", "workspace-b");
		await store.saveSession(first.id, [{
			role: "user",
			content: "first session message",
			requestId: "request-export",
			createdAt: "2026-08-03T10:00:00.000Z"
		}]);
		await store.saveSession(second.id, [{
			role: "user",
			content: "other session message",
			requestId: "request-other",
			createdAt: "2026-08-03T10:01:00.000Z"
		}]);
		const context = await saveTextAttachment({
			sessionId: first.id,
			content: "embedded attachment",
			title: "note.txt"
		});
		assert.equal(context.kind, "text_attachment");
		const attachmentId: string = String((context.data as Record<string, unknown>).attachmentId);

		const source = await getSessionDatabase();
		source.prepare(`
			INSERT INTO summaries(session_id, content, message_count, token_estimate, generated_at)
			VALUES (?, ?, 1, 4, ?)
		`).run(first.id, "summary", "2026-08-03T10:02:00.000Z");
		source.prepare(`
			INSERT INTO plans(plan_id, session_id, request_id, status, metadata_json, markdown, created_at, updated_at)
			VALUES (?, ?, ?, 'completed', '{}', '# Plan', ?, ?)
		`).run("plan-export", first.id, "request-export", "2026-08-03T10:00:00.000Z", "2026-08-03T10:02:00.000Z");

		const destinationPath: string = join(profile, "exports", "single-session.sqlite");
		const result = await exportSessionToSqlite(first.id, destinationPath);
		assert.equal(result.exported, true);
		assert.equal(result.sessionId, first.id);
		assert.equal(result.tableCounts.sessions, 1);
		assert.equal(result.tableCounts.messages, 1);
		assert.equal(result.tableCounts.summaries, 1);
		assert.equal(result.tableCounts.plans, 1);
		assert.equal(result.tableCounts.attachments, 1);
		assert.equal(result.embeddedFileCount, 1);
		assert.equal(result.missingFileCount, 0);

		const { DatabaseSync } = await import("node:sqlite");
		const exported = new DatabaseSync(destinationPath, { readOnly: true });
		try {
			const sessions = exported.prepare("SELECT session_id FROM sessions").all() as Array<{ session_id: string }>;
			assert.deepEqual(sessions.map((row): string => row.session_id), [first.id]);
			const message = exported.prepare("SELECT payload_json FROM messages").get() as { payload_json: string };
			assert.equal(JSON.parse(message.payload_json).content, "first session message");
			const metadata = exported.prepare("SELECT * FROM daedalus_export_metadata").get() as Record<string, unknown>;
			assert.equal(metadata.format, "daedalus-session-sqlite");
			assert.equal(metadata.format_version, 1);
			assert.equal(metadata.session_id, first.id);
			assert.equal(metadata.embedded_file_count, 1);
			const exportedFile = exported.prepare("SELECT relative_path, content FROM daedalus_export_files").get() as {
				relative_path: string;
				content: Uint8Array;
			};
			assert.match(exportedFile.relative_path, /^attachments\/text\//u);
			assert.equal(Buffer.from(exportedFile.content).toString("utf8"), "embedded attachment");
			assert.equal(
				String((exported.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check),
				"ok"
			);
			assert.equal(exported.prepare("PRAGMA foreign_key_check").all().length, 0);
		} finally {
			exported.close();
		}
		assert.equal((await readFile(destinationPath)).subarray(0, 16).toString("utf8"), "SQLite format 3\u0000");

		await store.deleteSession(first.id);
		const importResult = await importSessionFromSqlite(destinationPath);
		assert.equal(importResult.imported, true);
		assert.equal(importResult.sessionId, first.id);
		assert.equal(importResult.title, "Export me");
		assert.equal(importResult.tableCounts.sessions, 1);
		assert.equal(importResult.tableCounts.messages, 1);
		assert.equal(importResult.tableCounts.attachments, 1);
		assert.equal(importResult.restoredFileCount, 1);
		const restored = await store.openSession(first.id);
		assert.equal(restored.metadata.title, "Export me");
		assert.equal(restored.messages[0]?.content, "first session message");
		assert.equal((await readTextAttachmentContent(first.id, attachmentId)).content, "embedded attachment");
	});
});

test("rejects importing a session that already exists", async (): Promise<void> => {
	await withTempProfile(async (profile: string): Promise<void> => {
		const store = await import("../../../src/session/session-store.js");
		const { exportSessionToSqlite } = await import("../../../src/session/session-export.js");
		const { importSessionFromSqlite } = await import("../../../src/session/session-import.js");
		const session = await store.createSession("Already here");
		const destinationPath: string = join(profile, "exports", "already-here.sqlite");
		await exportSessionToSqlite(session.id, destinationPath);

		await assert.rejects(
			importSessionFromSqlite(destinationPath),
			/error importing session|Session already exists/iu
		);
	});
});

test("rejects relative export destinations and the active session database path", async (): Promise<void> => {
	await withTempProfile(async (): Promise<void> => {
		const store = await import("../../../src/session/session-store.js");
		const { exportSessionToSqlite } = await import("../../../src/session/session-export.js");
		const { getSessionsDatabasePath } = await import("../../../src/app-paths.js");
		const session = await store.createSession("Protected destination");

		await assert.rejects(
			exportSessionToSqlite(session.id, "relative.sqlite"),
			/session export destination must be an absolute path/iu
		);
		await assert.rejects(
			exportSessionToSqlite(session.id, getSessionsDatabasePath()),
			/cannot overwrite the active session database/iu
		);
	});
});
