import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
	readWorkspaceGitDiff,
	readWorkspaceGitDiffFile,
	readWorkspaceGitDiffSummary,
	type WorkspaceGitDiffResult
} from "../../../src/server/workspace-git-diff.js";

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

test("workspace git diff summary pages file metadata without patches", async (): Promise<void> => {
	const repoPath: string = await createTempDir();
	try {
		await initRepo(repoPath);
		await commitFile(repoPath, "script.gd", "extends Node\n");
		await writeFile(path.join(repoPath, "script.gd"), "extends Node2D\n", "utf8");
		await writeFile(path.join(repoPath, "tiny.gd"), "extends Node\nfunc test():\n", "utf8");
		await writeFile(path.join(repoPath, "large.txt"), "x".repeat(160_000), "utf8");

		const firstPage = await readWorkspaceGitDiffSummary("workspace-a", repoPath, 0, 1);

		assert.equal(firstPage.hasGitRepository, true);
		assert.equal(firstPage.changedFiles, 3);
		assert.equal(firstPage.files.length, 1);
		assert.notEqual(firstPage.nextCursor, null);
		assert.equal("patch" in firstPage.files[0]!, false);
		assert.ok(firstPage.files.some((file) => file.canAutoExpand));

		const secondPage = await readWorkspaceGitDiffSummary("workspace-a", repoPath, firstPage.nextCursor!, 100);
		assert.equal(
			[...firstPage.files, ...secondPage.files].find((file) => file.path === "tiny.gd")?.additions,
			2
		);
		assert.equal(secondPage.files.some((file) => file.path === "large.txt" && !file.canAutoExpand), true);
	} finally {
		await rm(repoPath, { recursive: true, force: true });
	}
});

test("workspace git diff file preview rejects paths outside the workspace and caps oversized files", async (): Promise<void> => {
	const repoPath: string = await createTempDir();
	try {
		await initRepo(repoPath);
		await writeFile(path.join(repoPath, "large.txt"), Array.from({ length: 40_000 }, (_value: unknown, index: number): string => `line ${index}`).join("\n"), "utf8");

		await assert.rejects(async (): Promise<void> => {
			await readWorkspaceGitDiffFile("workspace-a", repoPath, "../outside.txt");
		});

		const result = await readWorkspaceGitDiffFile("workspace-a", repoPath, "large.txt");
		assert.equal(result.tooLargeToRender, true);
		assert.equal(result.patch, "");
	} finally {
		await rm(repoPath, { recursive: true, force: true });
	}
});
