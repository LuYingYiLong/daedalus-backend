import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setApprovalMode } from "../../../src/approval-settings-store.js";
import { synchronizeSessionApprovalMode } from "../../../src/server/approval-mode-sync.js";
import { applySessionMetadata, createClientSession } from "../../../src/server/client-session.js";

async function withTemporaryUserProfile(run: () => Promise<void>): Promise<void> {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const directory: string = await mkdtemp(join(tmpdir(), "daedalus-approval-mode-"));
	process.env.USERPROFILE = directory;
	try {
		await run();
	} finally {
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		await rm(directory, { recursive: true, force: true });
	}
}

test("global approval mode replaces stale session runtime mode before a run", async (): Promise<void> => {
	await withTemporaryUserProfile(async (): Promise<void> => {
		await setApprovalMode("auto-safe");
		const session = createClientSession(undefined);
		applySessionMetadata(session, {
			id: "session-stale-approval-mode",
			title: "Stale approval mode",
			createdAt: "2026-07-27T00:00:00.000Z",
			updatedAt: "2026-07-27T00:00:00.000Z",
			approvalMode: "manual"
		});
		assert.equal(session.approvalGateway.getMode(), "manual");

		const mode = await synchronizeSessionApprovalMode(session);

		assert.equal(mode, "auto-safe");
		assert.equal(session.approvalGateway.getMode(), "auto-safe");
	});
});
