import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
	commitOrPushWorkspaceGit,
	createCommitMessageDiffContext,
	generateGitCommitMessageFromDiff,
	resolveGitCommitProviderOptions,
	type CandidateDiff
} from "../../../src/server/workspace-git-commit.js";
import { ProviderTaskModelError } from "../../../src/providers/task-model-routing.js";
import { createClientSession } from "../../../src/server/client-session.js";
import type { ProviderChatOptions } from "../../../src/providers/deepseek-client.js";

const execFileAsync = promisify(execFile);

async function createTempDir(prefix: string): Promise<string> {
	return await mkdtemp(path.join(tmpdir(), prefix));
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

function createCandidateDiff(patch: string, overrides: Partial<CandidateDiff> = {}): CandidateDiff {
	return {
		patch,
		additions: 0,
		deletions: 0,
		changedFiles: 1,
		truncated: false,
		branch: "main",
		...overrides
	};
}

function createGitCommitOptions(): ProviderChatOptions {
	return {
		provider: "deepseek",
		apiKey: "configured-git-commit-key",
		model: "deepseek-v4-pro",
		endpointType: "openai-chat-completions",
		adapterFamily: "openai-compatible",
		modelProfile: {
			provider: "deepseek",
			model: "deepseek-v4-pro",
			contextWindowTokens: 128_000,
			maxOutputTokens: 8_192,
			defaultOutputReserveTokens: 8_192,
			safetyMarginTokens: 2_560
		}
	};
}

test("Git commit message generation disables reasoning for its short structured request", async (): Promise<void> => {
	const calls: Array<{ maxTokens: number | undefined; reasoningMode: string | undefined }> = [];
	const result = await generateGitCommitMessageFromDiff(
		createCandidateDiff([
			"diff --git a/src/server/app.ts b/src/server/app.ts",
			"--- a/src/server/app.ts",
			"+++ b/src/server/app.ts",
			"@@ -1 +1 @@",
			"-const ready = false;",
			"+const ready = true;"
		].join("\n"), { additions: 1, deletions: 1 }),
		createGitCommitOptions(),
		"Generate JSON.",
		undefined,
		{
			chat: async (params, options): Promise<string> => {
				calls.push({
					maxTokens: params.options?.maxTokens,
					reasoningMode: options.reasoningMode
				});
				return '{"subject":"fix(server): update readiness state","body":""}';
			}
		}
	);

	assert.equal(result.generationSource, "llm");
	assert.equal(result.subject, "fix(server): update readiness state");
	assert.deepEqual(calls, [{ maxTokens: 800, reasoningMode: "disabled" }]);
});

test("Git commit message generation retries empty model output once", async (): Promise<void> => {
	let callCount: number = 0;
	let retryPrompt: string = "";
	const result = await generateGitCommitMessageFromDiff(
		createCandidateDiff([
			"diff --git a/src/providers/client.ts b/src/providers/client.ts",
			"--- a/src/providers/client.ts",
			"+++ b/src/providers/client.ts",
			"@@ -1 +1 @@",
			"-const retries = 0;",
			"+const retries = 1;"
		].join("\n"), { additions: 1, deletions: 1 }),
		createGitCommitOptions(),
		"Generate JSON.",
		undefined,
		{
			chat: async (params): Promise<string> => {
				callCount += 1;
				if (callCount === 1) {
					throw new Error("LLM returned empty response");
				}
				retryPrompt = params.message;
				return '{"subject":"fix(providers): retry empty responses","body":"Recover structured generation once."}';
			},
			logWarning: (): void => {}
		}
	);

	assert.equal(callCount, 2);
	assert.equal(result.generationSource, "llm_retry");
	assert.match(retryPrompt, /previous response contained no visible JSON/iu);
	assert.equal(result.warning, undefined);
});

test("Git commit message generation repairs malformed structured output", async (): Promise<void> => {
	let callCount: number = 0;
	let retryPrompt: string = "";
	const result = await generateGitCommitMessageFromDiff(
		createCandidateDiff([
			"diff --git a/src/server/git.ts b/src/server/git.ts",
			"--- a/src/server/git.ts",
			"+++ b/src/server/git.ts",
			"@@ -1 +1 @@",
			"-const stable = false;",
			"+const stable = true;"
		].join("\n")),
		createGitCommitOptions(),
		"Generate JSON.",
		undefined,
		{
			chat: async (params): Promise<string> => {
				callCount += 1;
				if (callCount === 1) {
					return "fix git commit generation";
				}
				retryPrompt = params.message;
				return '{"subject":"fix(git): stabilize commit generation","body":""}';
			},
			logWarning: (): void => {}
		}
	);

	assert.equal(callCount, 2);
	assert.equal(result.generationSource, "llm_retry");
	assert.match(retryPrompt, /fix git commit generation/u);
	assert.equal(result.subject, "fix(git): stabilize commit generation");
});

test("Git commit message generation falls back locally after repeated invalid responses", async (): Promise<void> => {
	let callCount: number = 0;
	const result = await generateGitCommitMessageFromDiff(
		createCandidateDiff([
			"diff --git a/docs/setup.md b/docs/setup.md",
			"--- a/docs/setup.md",
			"+++ b/docs/setup.md",
			"@@ -1 +1 @@",
			"-Old setup",
			"+New setup"
		].join("\n"), { additions: 1, deletions: 1 }),
		createGitCommitOptions(),
		"Generate JSON.",
		undefined,
		{
			chat: async (): Promise<string> => {
				callCount += 1;
				throw new Error("LLM returned empty response");
			},
			logWarning: (): void => {}
		}
	);

	assert.equal(callCount, 2);
	assert.equal(result.generationSource, "fallback");
	assert.equal(result.subject, "docs: update setup.md");
	assert.match(result.warning ?? "", /local fallback/u);
});

test("Git commit generation uses its configured model before reading an unconfigured current provider", async (): Promise<void> => {
	const session = createClientSession(undefined);
	session.activeProvider = "opencode";
	session.providerModel = "kimi-k2.7-code";
	let activeProviderRead: boolean = false;

	const options = await resolveGitCommitProviderOptions(session, undefined, undefined, {
		resolveConfiguredTaskModel: async () => ({
			kind: "gitCommit",
			source: "configured",
			provider: "deepseek",
			model: "deepseek-v4-pro",
			options: createGitCommitOptions()
		}),
		loadProviderConfig: async () => {
			activeProviderRead = true;
			return null;
		}
	});

	assert.equal(options.provider, "deepseek");
	assert.equal(options.apiKey, "configured-git-commit-key");
	assert.equal(activeProviderRead, false);
});

test("Git commit generation falls back to the current model only when no task model is configured", async (): Promise<void> => {
	const session = createClientSession(undefined);
	session.activeProvider = "opencode";
	session.providerModel = "kimi-k2.7-code";

	const options = await resolveGitCommitProviderOptions(session, undefined, undefined, {
		resolveConfiguredTaskModel: async () => {
			throw new ProviderTaskModelError("task_model_not_configured", "No Git commit model configured.");
		},
		loadProviderConfig: async () => ({
			provider: "opencode",
			apiKey: "current-provider-key",
			model: "kimi-k2.7-code"
		})
	});

	assert.equal(options.provider, "opencode");
	assert.equal(options.model, "kimi-k2.7-code");
	assert.equal(options.apiKey, "current-provider-key");
});

test("Git commit generation does not fall back when its configured provider is missing an API key", async (): Promise<void> => {
	const session = createClientSession(undefined);
	session.activeProvider = "opencode";
	let activeProviderRead: boolean = false;

	await assert.rejects(
		async (): Promise<void> => {
			await resolveGitCommitProviderOptions(session, undefined, undefined, {
				resolveConfiguredTaskModel: async () => {
					throw new ProviderTaskModelError("task_model_api_key_missing", "DeepSeek API key is missing.");
				},
				loadProviderConfig: async () => {
					activeProviderRead = true;
					return null;
				}
			});
		},
		/DeepSeek API key is missing/u
	);
	assert.equal(activeProviderRead, false);
});

test("workspace git commit message context omits blank-only changed lines", (): void => {
	const context = createCommitMessageDiffContext(createCandidateDiff([
		"diff --git a/src/app.ts b/src/app.ts",
		"--- a/src/app.ts",
		"+++ b/src/app.ts",
		"@@ -1,5 +1,6 @@",
		"-",
		"+   ",
		"-const name = \"old\";",
		"+const name = \"new\";",
		"+",
		""
	].join("\n")));

	assert.equal(context.omittedWhitespaceLines, 3);
	assert.match(context.text, /\+const name = "new";/u);
	assert.doesNotMatch(context.text, /^\+\s*$/mu);
});

test("workspace git commit message context summarizes lockfiles", (): void => {
	const context = createCommitMessageDiffContext(createCandidateDiff([
		"diff --git a/package-lock.json b/package-lock.json",
		"--- a/package-lock.json",
		"+++ b/package-lock.json",
		"@@ -1,3 +1,3 @@",
		"-  \"version\": \"1.0.0\"",
		"+  \"version\": \"1.0.1\"",
		""
	].join("\n")));

	assert.equal(context.suppressedLargeFiles, 1);
	assert.match(context.text, /changed lines omitted/u);
	assert.doesNotMatch(context.text, /1\.0\.1/u);
});

test("workspace git commit message context caps oversized hunks", (): void => {
	const changedLines: string[] = Array.from({ length: 40 }, (_: unknown, index: number): string => `+const value${index} = ${index};`);
	const context = createCommitMessageDiffContext(createCandidateDiff([
		"diff --git a/src/values.ts b/src/values.ts",
		"--- a/src/values.ts",
		"+++ b/src/values.ts",
		"@@ -1,1 +1,40 @@",
		...changedLines,
		""
	].join("\n")));

	assert.equal(context.truncated, true);
	assert.equal(context.omittedChangedLines, 16);
	assert.match(context.text, /\+const value23 = 23;/u);
	assert.doesNotMatch(context.text, /\+const value24 = 24;/u);
});

test("workspace git commit rejects non repositories", async (): Promise<void> => {
	const repoPath: string = await createTempDir("daedalus-git-commit-nonrepo-");
	try {
		await assert.rejects(
			commitOrPushWorkspaceGit({
				workspaceId: "workspace-a",
				workspaceRoot: repoPath,
				action: "commit",
				message: "Add file",
				includeUnstagedChanges: true
			}),
			/Workspace is not a Git repository/u
		);
	} finally {
		await rm(repoPath, { recursive: true, force: true });
	}
});

test("workspace git commit uses staged changes only when requested", async (): Promise<void> => {
	const repoPath: string = await createTempDir("daedalus-git-commit-staged-");
	try {
		await initRepo(repoPath);
		await commitFile(repoPath, "script.gd", "extends Node\n");
		await writeFile(path.join(repoPath, "script.gd"), "extends Node2D\n", "utf8");
		await git(repoPath, ["add", "script.gd"]);
		await writeFile(path.join(repoPath, "script.gd"), "extends Control\n", "utf8");

		const result = await commitOrPushWorkspaceGit({
			workspaceId: "workspace-a",
			workspaceRoot: repoPath,
			action: "commit",
			message: "Update script base type\n\nUse staged content only.",
			includeUnstagedChanges: false
		});

		assert.equal(result.committed, true);
		assert.equal(result.pushed, false);
		assert.equal(typeof result.commitHash, "string");
		assert.equal((await git(repoPath, ["show", "HEAD:script.gd"])).trim(), "extends Node2D");
		assert.match((await git(repoPath, ["status", "--short"])), / M script\.gd/u);
		assert.equal(result.stdout.includes(repoPath), false);
		assert.equal(result.stderr.includes(repoPath), false);
	} finally {
		await rm(repoPath, { recursive: true, force: true });
	}
});

test("workspace git commit wraps body lines for commitlint-compatible messages", async (): Promise<void> => {
	const repoPath: string = await createTempDir("daedalus-git-commit-body-wrap-");
	try {
		await initRepo(repoPath);
		await commitFile(repoPath, "project.godot", "[application]\n");
		await writeFile(path.join(repoPath, "project.godot"), "[application]\nconfig/name=\"Demo\"\n", "utf8");

		const longBody: string = [
			"Introduce workspace.git.commit.message.generate and workspace.git.commitOrPush methods for the",
			"Commit or Push dialog while keeping the generated message flow deterministic."
		].join(" ");
		const result = await commitOrPushWorkspaceGit({
			workspaceId: "workspace-a",
			workspaceRoot: repoPath,
			action: "commit",
			message: `feat(git): add commit message generation\n\n${longBody}`,
			includeUnstagedChanges: true
		});

		const commitMessage: string = await git(repoPath, ["log", "-1", "--format=%B"]);
		const messageLines: string[] = commitMessage.trimEnd().split(/\r?\n/u);
		assert.equal(result.committed, true);
		assert.equal(messageLines[0], "feat(git): add commit message generation");
		assert.ok(messageLines.some((line: string): boolean => line.includes("workspace.git.commit.message.generate")));
		assert.ok(messageLines.every((line: string): boolean => Array.from(line).length <= 100));
	} finally {
		await rm(repoPath, { recursive: true, force: true });
	}
});

test("workspace git commit can include unstaged and untracked changes", async (): Promise<void> => {
	const repoPath: string = await createTempDir("daedalus-git-commit-all-");
	try {
		await initRepo(repoPath);
		await commitFile(repoPath, "project.godot", "[application]\n");
		await writeFile(path.join(repoPath, "project.godot"), "[application]\nconfig/name=\"Demo\"\n", "utf8");
		await writeFile(path.join(repoPath, "new_script.gd"), "extends Node\n", "utf8");

		const result = await commitOrPushWorkspaceGit({
			workspaceId: "workspace-a",
			workspaceRoot: repoPath,
			action: "commit",
			message: "Add demo project metadata",
			includeUnstagedChanges: true
		});

		assert.equal(result.committed, true);
		assert.equal((await git(repoPath, ["status", "--short"])).trim(), "");
		assert.match(await git(repoPath, ["show", "--name-only", "--format=%s", "HEAD"]), /new_script\.gd/u);
	} finally {
		await rm(repoPath, { recursive: true, force: true });
	}
});

test("workspace git push sets origin upstream when missing", async (): Promise<void> => {
	const repoPath: string = await createTempDir("daedalus-git-push-work-");
	const remotePath: string = await createTempDir("daedalus-git-push-remote-");
	try {
		await git(remotePath, ["init", "--bare"]);
		await initRepo(repoPath);
		await commitFile(repoPath, "project.godot", "[application]\n");
		await git(repoPath, ["remote", "add", "origin", remotePath]);

		const result = await commitOrPushWorkspaceGit({
			workspaceId: "workspace-a",
			workspaceRoot: repoPath,
			action: "push",
			includeUnstagedChanges: false
		});

		assert.equal(result.committed, false);
		assert.equal(result.pushed, true);
		assert.match((await git(repoPath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])).trim(), /^origin\//u);
	} finally {
		await rm(repoPath, { recursive: true, force: true });
		await rm(remotePath, { recursive: true, force: true });
	}
});
