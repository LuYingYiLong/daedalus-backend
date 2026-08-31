import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createSession,
	appendMessage,
} from "../../../src/session/session-store.js";
import {
	getSessionDatabase,
	resetSessionDatabaseForTests,
	runSessionTransaction,
} from "../../../src/session/session-database.js";
import { compactSessionActivity } from "../../../src/session/activity-compaction.js";
import {
	compactBrowserActivity,
	getBrowserActivity,
	readBrowserScreenshot,
	recordBrowserActivity,
	saveBrowserScreenshot,
} from "../../../src/session/browser-activity-store.js";

const PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
test("browser evidence stays independent, hides details, and compacts atomically with the eleventh turn", async () => {
	const previous = process.env.USERPROFILE,
		directory = await mkdtemp(join(tmpdir(), "browser-evidence-"));
	process.env.USERPROFILE = directory;
	try {
		const session = await createSession("Browser fixture"),
			db = await getSessionDatabase();
		const scope = {
			connectionId: "connection",
			sessionId: session.id,
			requestId: "turn-1",
			runId: "run-1",
			generation: "generation",
		};
		await recordBrowserActivity({
			scope,
			kind: "proposed",
			detail: { field: "sk-fixtureSecret123456789" },
			summary: { steps: 1 },
		});
		const reference = await saveBrowserScreenshot(scope, PNG);
		assert.equal(reference.source.kind, "browser_activity");
		if (reference.source.kind !== "browser_activity")
			throw new Error("wrong source");
		const id = reference.source.activityId;
		assert.deepEqual(
			await readBrowserScreenshot(session.id, id),
			Buffer.from(PNG.slice(22), "base64"),
		);
		assert.equal(
			(await getBrowserActivity(session.id, false, id)).dataUrl,
			undefined,
		);
		assert.equal((await getBrowserActivity(session.id, true, id)).dataUrl, PNG);
		await assert.rejects(
			readBrowserScreenshot("another-session", id),
			/missing/,
		);
		const before = db
			.prepare(
				"SELECT * FROM browser_activity WHERE session_id=? ORDER BY rowid",
			)
			.all(session.id);
		await assert.rejects(
			saveBrowserScreenshot(scope, PNG, AbortSignal.abort()),
			/abort/i,
		);
		assert.equal(
			db
				.prepare(
					"SELECT COUNT(*) AS n FROM browser_activity WHERE session_id=?",
				)
				.get(session.id)?.n,
			before.length,
		);
		assert.throws(
			() =>
				runSessionTransaction(db, () => {
					assert.ok(compactBrowserActivity(db, session.id, ["turn-1"]) > 0);
					throw new Error("rollback");
				}),
			/rollback/,
		);
		assert.deepEqual(
			db
				.prepare(
					"SELECT * FROM browser_activity WHERE session_id=? ORDER BY rowid",
				)
				.all(session.id),
			before,
		);
		for (let turn = 1; turn <= 11; turn++) {
			await appendMessage(session.id, {
				role: "user",
				content: `User ${turn}`,
				requestId: `turn-${turn}`,
			});
			await appendMessage(session.id, {
				role: "assistant",
				content: `Answer ${turn}`,
				requestId: `turn-${turn}`,
			});
		}
		const result = await compactSessionActivity(session.id);
		assert.deepEqual(result.compactedRequestIds, ["turn-1"]);
		assert.equal(
			(await getBrowserActivity(session.id, true, id)).detailLevel,
			"compacted",
		);
		await assert.rejects(readBrowserScreenshot(session.id, id), /compacted/);
		assert.equal(compactBrowserActivity(db, session.id, ["turn-1"]), 0);
		assert.equal(
			db
				.prepare("SELECT COUNT(*) AS n FROM attachments WHERE session_id=?")
				.get(session.id)?.n,
			0,
		);
	} finally {
		await resetSessionDatabaseForTests();
		if (previous === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previous;
		await rm(directory, { recursive: true, force: true });
	}
});
