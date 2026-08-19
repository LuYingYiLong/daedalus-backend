import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runGit } from "../../../src/server/git-utils.js";
import { createManagedWorktree, deleteManagedWorktree, inspectWorkspaceWorktreeEligibility, restoreManagedWorktreeWorkspace } from "../../../src/workspace/worktree-manager.js";
import { findWorkspace, loadWorkspaces, unregisterSessionRuntimeWorkspace } from "../../../src/workspace/registry.js";
import type { WorkspaceConfig } from "../../../src/workspace/types.js";

async function initializeRepository(root: string, fileName: string): Promise<string> {
	await fs.mkdir(root, { recursive: true });
	await runGit(root, ["init"]);
	await runGit(root, ["config", "user.email", "daedalus-tests@example.invalid"]);
	await runGit(root, ["config", "user.name", "Daedalus Tests"]);
	await fs.writeFile(path.join(root, fileName), "initial\n", "utf8");
	await runGit(root, ["add", "--", fileName]);
	await runGit(root, ["commit", "-m", "initial"]);
	return (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
}

function createWorkspace(root: string): WorkspaceConfig {
	return {
		id: "workspace-worktree-test",
		name: "Worktree Test",
		kind: "godot",
		rootPath: root,
		icon: 0,
		color: 0,
		sourceFolders: [
			{
				id: "source-main",
				path: root,
				capabilities: {
					git: true,
					godot: false
				}
			}
		],
		primarySourceFolderId: "source-main"
	};
}

test("worktree manager validates, creates, restores, and safely deletes managed worktrees", async (): Promise<void> => {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const testRoot: string = await fs.mkdtemp(path.join(os.tmpdir(), "daedalus-worktree-test-"));
	const profileRoot: string = path.join(testRoot, "profile");
	const repositoryRoot: string = path.join(testRoot, "repository");
	process.env.USERPROFILE = profileRoot;

	try {
		const baseCommit: string = await initializeRepository(repositoryRoot, "README.md");
		const workspace: WorkspaceConfig = createWorkspace(repositoryRoot);
		const eligibility = await inspectWorkspaceWorktreeEligibility(workspace);
		assert.equal(eligibility.eligible, true, JSON.stringify(eligibility));
		assert.equal(eligibility.sources[0]?.baseCommit, baseCommit);
		assert.equal(eligibility.sources[0]?.dirty, false);

		await fs.writeFile(path.join(repositoryRoot, "untracked.txt"), "dirty\n", "utf8");
		const dirtyEligibility = await inspectWorkspaceWorktreeEligibility(workspace);
		assert.equal(dirtyEligibility.eligible, false);
		assert.equal(dirtyEligibility.sources[0]?.dirty, true);
		await fs.rm(path.join(repositoryRoot, "untracked.txt"));

		const created = await createManagedWorktree({
			sessionId: "session-worktree-test",
			workspace
		});
		const expectedPath: string = path.join(profileRoot, ".daedalus", "worktrees", "session-worktree-test", "source-main");
		assert.equal(created.metadata.sources[0]?.worktreePath, expectedPath);
		assert.equal(created.workspace.rootPath, expectedPath);
		assert.equal((await runGit(expectedPath, ["rev-parse", "HEAD"])).stdout.trim(), baseCommit);
		assert.equal((await runGit(expectedPath, ["branch", "--show-current"])).stdout.trim(), "");
		assert.equal(findWorkspace(created.metadata.runtimeWorkspaceId)?.rootPath, expectedPath);
		assert.equal(
			loadWorkspaces().some((item): boolean => item.id === created.metadata.runtimeWorkspaceId),
			false
		);

		unregisterSessionRuntimeWorkspace(created.metadata.runtimeWorkspaceId);
		assert.equal(findWorkspace(created.metadata.runtimeWorkspaceId), undefined);
		assert.equal(restoreManagedWorktreeWorkspace(created.metadata, workspace)?.rootPath, expectedPath);

		await fs.writeFile(path.join(expectedPath, "dirty.txt"), "dirty\n", "utf8");
		await assert.rejects(deleteManagedWorktree(created.metadata), /uncommitted changes/u);
		await fs.rm(path.join(expectedPath, "dirty.txt"));

		await fs.writeFile(path.join(expectedPath, "README.md"), "changed\n", "utf8");
		await runGit(expectedPath, ["add", "--", "README.md"]);
		await runGit(expectedPath, ["commit", "-m", "worktree commit"]);
		await assert.rejects(deleteManagedWorktree(created.metadata), /Create a branch/u);
		await runGit(expectedPath, ["branch", "worktree-result"]);

		await deleteManagedWorktree(created.metadata);
		await assert.rejects(fs.stat(expectedPath));
		assert.equal(findWorkspace(created.metadata.runtimeWorkspaceId), undefined);
	} finally {
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		await fs.rm(testRoot, { recursive: true, force: true });
	}
});

test("worktree eligibility rejects nested roots and duplicate repositories", async (): Promise<void> => {
	const testRoot: string = await fs.mkdtemp(path.join(os.tmpdir(), "daedalus-worktree-eligibility-"));
	const repositoryRoot: string = path.join(testRoot, "repository");
	const nestedRoot: string = path.join(repositoryRoot, "nested");

	try {
		await initializeRepository(repositoryRoot, "README.md");
		await fs.mkdir(nestedRoot);
		const nestedWorkspace: WorkspaceConfig = createWorkspace(nestedRoot);
		const nestedEligibility = await inspectWorkspaceWorktreeEligibility(nestedWorkspace);
		assert.equal(nestedEligibility.eligible, false);
		assert.match(nestedEligibility.sources[0]?.reason ?? "", /repository root/u);

		const duplicateWorkspace: WorkspaceConfig = {
			...createWorkspace(repositoryRoot),
			sourceFolders: [
				createWorkspace(repositoryRoot).sourceFolders[0]!,
				{
					...createWorkspace(repositoryRoot).sourceFolders[0]!,
					id: "source-second"
				}
			]
		};
		const duplicateEligibility = await inspectWorkspaceWorktreeEligibility(duplicateWorkspace);
		assert.equal(duplicateEligibility.eligible, false);
		assert.match(duplicateEligibility.sources[1]?.reason ?? "", /different Git repository/u, JSON.stringify(duplicateEligibility));
	} finally {
		await fs.rm(testRoot, { recursive: true, force: true });
	}
});
