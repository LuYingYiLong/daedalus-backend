import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { readWorkspaceGitHistory } from "../../../src/workspace/git-history.js";

const execFile = promisify(execFileCallback);

async function git(cwd: string, args: string[]): Promise<void> {
	await execFile("git", ["-C", cwd, ...args], { windowsHide: true });
}

test("workspace Git history reads a bounded explicit tag range without executing arbitrary commands", async (): Promise<void> => {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-git-history-"));
	try {
		await git(root, ["init"]);
		await git(root, ["config", "user.email", "test@example.invalid"]);
		await git(root, ["config", "user.name", "Daedalus Test"]);
		await writeFile(join(root, "README.md"), "first\n", "utf8");
		await git(root, ["add", "README.md"]);
		await git(root, ["commit", "-m", "Initial release"]);
		await git(root, ["tag", "v1.0.8"]);
		await writeFile(join(root, "README.md"), "second\n", "utf8");
		await git(root, ["add", "README.md"]);
		await git(root, ["commit", "-m", "Improve release notes"]);

		const result = await readWorkspaceGitHistory({ cwd: root, fromRef: "v1.0.8", limit: 10 });
		assert.equal(result.ok, true);
		assert.equal(result.status, "history");
		assert.equal(result.fromRef, "v1.0.8");
		assert.equal(result.toRef, "HEAD");
		assert.deepEqual(result.commits.map((commit) => commit.subject), ["Improve release notes"]);
		assert.equal(result.truncated, false);

		const unavailable = await readWorkspaceGitHistory({ cwd: root, fromRef: "v9.9.9", limit: 10 });
		assert.equal(unavailable.ok, true);
		assert.equal(unavailable.status, "reference_unavailable");
		assert.deepEqual(unavailable.missingRefs, ["fromRef"]);
		assert.deepEqual(unavailable.availableRefs?.tags, ["v1.0.8"]);
		assert.deepEqual(unavailable.commits, []);

		await git(root, ["remote", "add", "origin", "https://github.com/example/daedalus-studio.git"]);
		const originalFetch: typeof fetch = globalThis.fetch;
		let requestedUrl: string = "";
		globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
			requestedUrl = String(input);
			return new Response(JSON.stringify({
				total_commits: 1,
				commits: [{
					sha: "1234567890abcdef",
					commit: {
						message: "Remote release change\n\nDetails",
						author: { date: "2026-08-06T00:00:00Z" }
					}
				}]
			}), { status: 200 });
		};
		try {
			const remote = await readWorkspaceGitHistory({ cwd: root, fromRef: "v9.9.9", limit: 10 });
			assert.equal(remote.ok, true);
			assert.equal(remote.status, "history");
			assert.equal(remote.source, "github_remote");
			assert.deepEqual(remote.commits.map((commit) => commit.subject), ["Remote release change"]);
			assert.match(requestedUrl, /repos\/example\/daedalus-studio\/compare\/v9\.9\.9\.\.\./u);
		} finally {
			globalThis.fetch = originalFetch;
		}

		await assert.rejects(
			() => readWorkspaceGitHistory({ cwd: root, fromRef: "v1.0.8;git status" }),
			/simple Git ref/u
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
