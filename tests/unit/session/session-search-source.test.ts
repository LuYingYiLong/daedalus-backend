import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("session search source revision is transactional and structural changes bump rebuild epoch", async (): Promise<void> => {
	const directory: string = await mkdtemp(join(tmpdir(), "daedalus-search-source-"));
	const databasePath: string = join(directory, "sessions.sqlite");
	const database = await import("../../../src/session/session-database.js");
	const store = await import("../../../src/session/session-store.js");
	await database.resetSessionDatabaseForTests(databasePath);
	try {
		const session = await store.createSession("Search source test");
		assert.deepEqual(await store.readSessionSearchSourceState(session.id), {
			sessionId: session.id,
			revision: 0,
			rebuildEpoch: 0,
			updatedAt: session.updatedAt
		});

		await store.appendMessage(session.id, {
			role: "user",
			requestId: "request-1",
			content: "hello"
		});
		let state = await store.readSessionSearchSourceState(session.id);
		assert.equal(state.revision, 1);
		assert.equal(state.rebuildEpoch, 0);

		await store.appendSessionEvent(session.id, "request-1", "agent.message.done", { text: "world" });
		state = await store.readSessionSearchSourceState(session.id);
		assert.equal(state.revision, 2);
		assert.equal(state.rebuildEpoch, 0);

		await store.appendSessionEvent(session.id, "request-1", "plan.generated", { requestId: "request-root" });
		state = await store.readSessionSearchSourceState(session.id);
		assert.equal(state.revision, 3);
		assert.equal(state.rebuildEpoch, 1);

		await store.clearSessionEvents(session.id);
		state = await store.readSessionSearchSourceState(session.id);
		assert.equal(state.revision > 3, true);
		assert.equal(state.rebuildEpoch > 1, true);
	} finally {
		await database.resetSessionDatabaseForTests();
		await rm(directory, { recursive: true, force: true });
	}
});
