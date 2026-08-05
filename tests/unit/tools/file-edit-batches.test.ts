import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { FileEditBatchDraft } from "../../../src/tools/file-edit-snapshots.js";

async function withTempAppData<T>(fn: (store: typeof import("../../../src/session/session-store.js"), batches: typeof import("../../../src/server/file-edit-batches.js")) => Promise<T>): Promise<T> {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const appDataDir: string = await fs.mkdtemp(path.join(os.tmpdir(), "daedalus-file-edit-batches-"));
	process.env.USERPROFILE = appDataDir;

	try {
		const suffix: string = `${Date.now()}-${Math.random()}`;
		const store = await import(`../../../src/session/session-store.js?case=${suffix}`);
		const batches = await import(`../../../src/server/file-edit-batches.js?case=${suffix}`);
		return await fn(store, batches);
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
}

test("persists full file edit snapshots while returning lightweight summaries", async (): Promise<void> => {
	await withTempAppData(async (store, batches): Promise<void> => {
		const metadata = await store.createSession("File edit test");
		const draft: FileEditBatchDraft = {
			workspaceId: "workspace-a",
			workspaceRoot: "D:/Project",
			edits: [
				{
					path: "scripts/player.gd",
					absolutePath: "D:/Project/scripts/player.gd",
					workspaceRoot: "D:/Project",
					existedBefore: true,
					existsAfter: true,
					beforeText: "old secret text",
					afterText: "new secret text",
					beforeSha256: "old-hash",
					afterSha256: "new-hash",
					additions: 1,
					deletions: 1,
					undoable: true
				}
			]
		};

		const summary = batches.persistFileEditBatch(metadata.id, "request-a", "tool-a", "mcp_godot_overwrite_text_file", draft);
		assert.ok(summary);
		assert.equal(summary.sessionId, metadata.id);
		assert.equal(summary.editedFileCount, 1);
		assert.equal(summary.editedFiles[0]?.path, "scripts/player.gd");
		assert.equal(JSON.stringify(summary).includes("secret text"), false);

		const loaded = await batches.readFileEditBatch(metadata.id, summary.batchId);
		assert.equal(loaded.edits[0]?.beforeText, "old secret text");
		assert.equal(loaded.edits[0]?.afterText, "new secret text");
	});
});

test("rejects invalid file edit batch ids", async (): Promise<void> => {
	await withTempAppData(async (store, batches): Promise<void> => {
		const metadata = await store.createSession("File edit test");
		await assert.rejects(
			batches.readFileEditBatch(metadata.id, "../outside"),
			/Invalid file edit batch id/
		);
	});
});
