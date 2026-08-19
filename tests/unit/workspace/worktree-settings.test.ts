import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { getDefaultWorktreeSettings, readWorktreeSettings, updateWorktreeSettings } from "../../../src/workspace/worktree-settings.js";

test("worktree settings persist a normalized root and bounded automatic cleanup options", async (): Promise<void> => {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-worktree-settings-"));
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	process.env.USERPROFILE = root;
	try {
		const defaults = getDefaultWorktreeSettings();
		assert.equal(defaults.rootDirectory, join(root, ".daedalus", "worktrees"));
		assert.equal(defaults.fetchBeforeCreate, false);
		assert.equal(defaults.autoDeleteManaged, false);
		assert.equal(defaults.autoDeleteLimit, 10);

		const updated = await updateWorktreeSettings({
			rootDirectory: join(root, "managed", "..", "managed-worktrees"),
			fetchBeforeCreate: true,
			autoDeleteManaged: true,
			autoDeleteLimit: 1000
		});
		assert.equal(updated.rootDirectory, resolve(root, "managed-worktrees"));
		assert.equal(updated.fetchBeforeCreate, true);
		assert.equal(updated.autoDeleteManaged, true);
		assert.equal(updated.autoDeleteLimit, 100);
		assert.deepEqual(await readWorktreeSettings(), updated);

		const reset = await updateWorktreeSettings({ rootDirectory: null });
		assert.equal(reset.rootDirectory, join(root, ".daedalus", "worktrees"));
	} finally {
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
		await rm(root, { recursive: true, force: true });
	}
});
