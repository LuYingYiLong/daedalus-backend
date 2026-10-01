import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("manual plan edits update the full Markdown without overwriting newer revisions", async (): Promise<void> => {
	const directory = await mkdtemp(join(tmpdir(), "daedalus-plan-edit-"));
	const previousProfile = process.env.USERPROFILE;
	process.env.USERPROFILE = directory;
	const database = await import("../../../src/session/session-database.js");
	try {
		await database.resetSessionDatabaseForTests(join(directory, "sessions.sqlite"));
		const sessionStore = await import("../../../src/session/session-store.js");
		const planStore = await import("../../../src/server/plan-store.js");
		const session = await sessionStore.createSession("Plan edit test");
		const metadata = planStore.createPlanMetadata({
			sessionId: session.id,
			requestId: "plan-run",
			status: "ready",
			title: "Demo",
			originalMessage: "Make a plan",
			previewMarkdown: "# Original",
		});
		await planStore.writeStoredPlan(metadata, "# Original");
		const edited = await planStore.saveEditedPlan(session.id, metadata.planId, metadata.updatedAt, "# Edited\n\nMore detail");
		assert.equal(edited.markdown, "# Edited\n\nMore detail");
		assert.equal(edited.metadata.previewMarkdown, "# Edited\n\nMore detail");
		assert.notEqual(edited.metadata.updatedAt, metadata.updatedAt);
		await assert.rejects(planStore.saveEditedPlan(session.id, metadata.planId, metadata.updatedAt, "# Stale"), /changed while it was being edited/u);
		assert.equal((await planStore.readStoredPlan(session.id, metadata.planId)).markdown, "# Edited\n\nMore detail");
		await planStore.updateStoredPlan(session.id, metadata.planId, (current) => ({ ...current, metadata: { ...current.metadata, status: "approved" } }));
		await assert.rejects(planStore.saveEditedPlan(session.id, metadata.planId, edited.metadata.updatedAt, "# Too late"), /Only ready plans/u);
	} finally {
		await database.resetSessionDatabaseForTests();
		if (previousProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousProfile;
		await rm(directory, { recursive: true, force: true });
	}
});
