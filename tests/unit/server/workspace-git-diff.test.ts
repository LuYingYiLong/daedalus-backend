import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { readWorkspaceGitDiff, type WorkspaceGitDiffResult } from "../../../src/server/workspace-git-diff.js";

const execFileAsync = promisify(execFile);

async function createTempDir(): Promise<string> {
	return await mkdtemp(path.join(tmpdir(), "daedalus-git-diff-"));
}

async function git(cwd: string, args: string[]): Promise<string> {
	const result = await execFileAsync("git", args, {
		cwd,
		windowsHide: true
	});
	return result.stdout;
}

async function initRepo(repoPath: string): Promise<void> {
	await git(repoPath, ["init"]);
	await git(repoPath, ["config", "user.email", "daedalus@example.test"]);
	await git(repoPath, ["config", "user.name", "Daedalus Test"]);
}

async function commitFile(repoPath: string, relativePath: string, content: string): Promise<void> {
	await writeFile(path.join(repoPath, relativePath), content, "utf8");
	await git(repoPath, ["add", relativePath]);
	await git(repoPath, ["commit", "-m", `Add ${relativePath}`]);
}

test("workspace git diff returns non repository state", async (): Promise<void> => {
	const repoPath: string = await createTempDir();
	try {
		const result: WorkspaceGitDiffResult = await readWorkspaceGitDiff("workspace-a", repoPath);

		assert.equal(result.workspaceId, "workspace-a");
		assert.equal(result.hasGitRepository, false);
		assert.equal(result.patch, "");
		assert.equal(result.changedFiles, 0);
	} finally {
		await rm(repoPath, { recursive: true, force: true });
	}
});

test("workspace git diff includes tracked file changes", async (): Promise<void> => {
	const repoPath: string = await createTempDir();
	try {
		await initRepo(repoPath);
		await commitFile(repoPath, "script.gd", "extends Node\n");
		await writeFile(path.join(repoPath, "script.gd"), "extends Node2D\n", "utf8");

		const result: WorkspaceGitDiffResult = await readWorkspaceGitDiff("workspace-a", repoPath);

		assert.equal(result.hasGitRepository, true);
		assert.match(result.patch, /diff --git a\/script\.gd b\/script\.gd/);
		assert.match(result.patch, /-extends Node/);
		assert.match(result.patch, /\+extends Node2D/);
		assert.equal(result.patch.includes(repoPath), false);
		assert.equal(result.additions, 1);
		assert.equal(result.deletions, 1);
		assert.equal(result.changedFiles, 1);
		assert.equal(result.untrackedFiles, 0);
	} finally {
		await rm(repoPath, { recursive: true, force: true });
	}
});

test("workspace git diff includes untracked files", async (): Promise<void> => {
	const repoPath: string = await createTempDir();
	try {
		await initRepo(repoPath);
		await commitFile(repoPath, "project.godot", "[application]\n");
		await writeFile(path.join(repoPath, "new_script.gd"), "extends Node\n", "utf8");

		const result: WorkspaceGitDiffResult = await readWorkspaceGitDiff("workspace-a", repoPath);

		assert.equal(result.hasGitRepository, true);
		assert.match(result.patch, /new file mode/);
		assert.match(result.patch, /diff --git a\/new_script\.gd b\/new_script\.gd/);
		assert.match(result.patch, /\+extends Node/);
		assert.equal(result.patch.includes(repoPath), false);
		assert.equal(result.untrackedFiles, 1);
		assert.equal(result.changedFiles, 1);
		assert.ok(result.additions >= 1);
	} finally {
		await rm(repoPath, { recursive: true, force: true });
	}
});

test("workspace git diff stops scanning an oversized untracked tree", async (): Promise<void> => {
	const repoPath: string = await createTempDir();
	try {
		await initRepo(repoPath);
		await writeFile(path.join(repoPath, "00-first.gd"), "extends Node\n", "utf8");
		await writeFile(path.join(repoPath, "99-last.gd"), "extends Node2D\n", "utf8");

		const result: WorkspaceGitDiffResult = await readWorkspaceGitDiff("workspace-a", repoPath, {
			patchLimitChars: 10_000,
			untrackedFileLimit: 1
		});

		assert.equal(result.truncated, true);
		assert.equal(result.untrackedFiles, 2);
		assert.equal(result.changedFiles, 2);
		assert.match(result.patch, /00-first\.gd/);
		assert.doesNotMatch(result.patch, /99-last\.gd/);
	} finally {
		await rm(repoPath, { recursive: true, force: true });
	}
});

test("workspace git diff truncates oversized patches", async (): Promise<void> => {
	const repoPath: string = await createTempDir();
	try {
		await initRepo(repoPath);
		await commitFile(repoPath, "large.txt", "base\n");
		const largeText: string = Array.from({ length: 120 }, (_value: unknown, index: number): string => `line ${index}`).join("\n") + "\n";
		await writeFile(path.join(repoPath, "large.txt"), largeText, "utf8");

		const result: WorkspaceGitDiffResult = await readWorkspaceGitDiff("workspace-a", repoPath, {
			patchLimitChars: 120
		});

		assert.equal(result.hasGitRepository, true);
		assert.equal(result.truncated, true);
		assert.equal(result.patch.length, 120);
		assert.ok(result.additions > 1);
	} finally {
		await rm(repoPath, { recursive: true, force: true });
	}
});
