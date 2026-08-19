import { spawn } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { runGit } from "../server/git-utils.js";
import type { SessionWorktreeLocation, SessionWorktreeMetadata, WorkspaceConfig } from "./types.js";
import { WorktreeOperationError } from "./worktree-manager.js";
import { readWorktreeSettings } from "./worktree-settings.js";

export type WorktreeHandoffSourcePreview = {
	sourceFolderId: string;
	fromPath: string;
	toPath: string;
	head: string;
	baseCommit: string;
	branch: string | null;
	modifiedFiles: string[];
	newCommits: number;
	blockedReason: string | null;
};

export type WorktreeHandoffPreview = {
	sessionId: string;
	from: SessionWorktreeLocation;
	target: SessionWorktreeLocation;
	allowed: boolean;
	sources: WorktreeHandoffSourcePreview[];
};

async function runGitWithInput(cwd: string, args: string[], input: string): Promise<void> {
	await new Promise<void>((resolvePromise, reject): void => {
		const child = spawn("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		let stderr: string = "";
		child.stderr.on("data", (data: Buffer): void => { stderr += data.toString("utf8"); });
		child.on("error", reject);
		child.on("close", (code: number | null): void => code === 0 ? resolvePromise() : reject(new WorktreeOperationError("worktree_handoff_patch_failed", stderr.trim() || "Failed to apply handoff patch.")));
		child.stdin.end(input, "utf8");
	});
}

function safePath(root: string, relativePath: string): string {
	const target: string = resolve(root, relativePath);
	const relation: string = relative(root, target);
	if (relation.length === 0 || relation.startsWith("..") || isAbsolute(relation)) throw new WorktreeOperationError("worktree_handoff_path_invalid", `Path escapes checkout: ${relativePath}`);
	return target;
}

async function listChangedFiles(root: string): Promise<string[]> {
	return (await runGit(root, ["status", "--porcelain=v1", "--untracked-files=normal"])).stdout.split(/\r?\n/u).filter(Boolean).map((line): string => line.slice(3));
}

function resolvePaths(metadata: SessionWorktreeMetadata, sourceWorkspace: WorkspaceConfig, target: SessionWorktreeLocation, sourceFolderId: string): { fromPath: string; toPath: string } {
	const source = metadata.sources.find((candidate): boolean => candidate.sourceFolderId === sourceFolderId)!;
	const local = sourceWorkspace.sourceFolders.find((candidate): boolean => candidate.id === sourceFolderId);
	if (local === undefined) throw new WorktreeOperationError("worktree_source_missing", `Source folder not found: ${sourceFolderId}`);
	const from: SessionWorktreeLocation = metadata.location ?? "worktree";
	return {
		fromPath: from === "worktree" ? source.worktreePath : local.path,
		toPath: target === "worktree" ? source.worktreePath : local.path
	};
}

export async function previewWorktreeHandoff(params: {
	sessionId: string;
	metadata: SessionWorktreeMetadata;
	sourceWorkspace: WorkspaceConfig;
	target: SessionWorktreeLocation;
	branchBySource?: Record<string, string> | undefined;
}): Promise<WorktreeHandoffPreview> {
	const from: SessionWorktreeLocation = params.metadata.location ?? "worktree";
	const sources: WorktreeHandoffSourcePreview[] = [];
	for (const source of params.metadata.sources) {
		const { fromPath, toPath } = resolvePaths(params.metadata, params.sourceWorkspace, params.target, source.sourceFolderId);
		let blockedReason: string | null = null;
		let head: string = "";
		let branch: string | null = null;
		let newCommits: number = 0;
		let modifiedFiles: string[] = [];
		try {
			if (from === params.target) blockedReason = "Session is already using the requested checkout.";
			else if (!existsSync(fromPath) || !existsSync(toPath)) blockedReason = "Source or target checkout is missing.";
			else {
				head = (await runGit(fromPath, ["rev-parse", "HEAD"])).stdout.trim();
				branch = (await runGit(fromPath, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowedExitCodes: [0, 1] })).stdout.trim() || null;
				newCommits = Number((await runGit(fromPath, ["rev-list", "--count", `${source.baseCommit}..HEAD`])).stdout.trim() || "0");
				modifiedFiles = await listChangedFiles(fromPath);
				if ((await listChangedFiles(toPath)).length > 0) blockedReason = "Target checkout is not clean.";
				const targetHead: string = (await runGit(toPath, ["rev-parse", "HEAD"])).stdout.trim();
				if (newCommits === 0 && targetHead !== head) blockedReason = "Target checkout does not have a compatible baseline.";
				if (newCommits > 0 && !params.branchBySource?.[source.sourceFolderId]) blockedReason = "Create or select a named branch before handing off new commits.";
			}
		} catch (error: unknown) {
			blockedReason = error instanceof Error ? error.message : "Unable to inspect handoff state.";
		}
		sources.push({ sourceFolderId: source.sourceFolderId, fromPath, toPath, head, baseCommit: source.baseCommit, branch, modifiedFiles, newCommits, blockedReason });
	}
	return { sessionId: params.sessionId, from, target: params.target, allowed: sources.length > 0 && sources.every((source): boolean => source.blockedReason === null), sources };
}

async function copyUntracked(fromPath: string, toPath: string): Promise<void> {
	const paths: string[] = (await runGit(fromPath, ["ls-files", "--others", "--exclude-standard", "-z"])).stdout.split("\0").filter(Boolean);
	for (const relativePath of paths) {
		const sourcePath: string = safePath(fromPath, relativePath);
		const targetPath: string = safePath(toPath, relativePath);
		const info = lstatSync(sourcePath);
		if (!info.isFile() || info.isSymbolicLink() || existsSync(targetPath)) continue;
		await mkdir(resolve(targetPath, ".."), { recursive: true });
		await copyFile(sourcePath, targetPath);
	}
}

async function transferChanges(fromPath: string, toPath: string): Promise<void> {
	const staged: string = (await runGit(fromPath, ["diff", "--cached", "--binary", "--full-index"])).stdout;
	const unstaged: string = (await runGit(fromPath, ["diff", "--binary", "--full-index"])).stdout;
	if (staged.length > 0) await runGitWithInput(toPath, ["apply", "--binary", "--index", "-"], staged);
	if (unstaged.length > 0) await runGitWithInput(toPath, ["apply", "--binary", "-"], unstaged);
	await copyUntracked(fromPath, toPath);
}

async function cleanTransferredSource(path: string): Promise<void> {
	await runGit(path, ["reset", "--hard", "HEAD"]);
	await runGit(path, ["clean", "-fd"]);
}

export async function executeWorktreeHandoff(params: {
	sessionId: string;
	metadata: SessionWorktreeMetadata;
	sourceWorkspace: WorkspaceConfig;
	target: SessionWorktreeLocation;
	branchBySource?: Record<string, string> | undefined;
}): Promise<SessionWorktreeMetadata> {
	const preview: WorktreeHandoffPreview = await previewWorktreeHandoff(params);
	if (!preview.allowed) throw new WorktreeOperationError("worktree_handoff_blocked", preview.sources.find((source): boolean => source.blockedReason !== null)?.blockedReason ?? "Handoff is blocked.");
	const snapshotRoot: string = join((await readWorktreeSettings()).rootDirectory, ".handoff", params.sessionId, Date.now().toString(36));
	await mkdir(snapshotRoot, { recursive: true });
	await writeFile(join(snapshotRoot, "preview.json"), `${JSON.stringify(preview, null, 2)}\n`, "utf8");
	const applied: WorktreeHandoffSourcePreview[] = [];
	let succeeded: boolean = false;
	try {
		for (const source of preview.sources) {
			const branch: string | undefined = params.branchBySource?.[source.sourceFolderId];
			if (source.newCommits > 0 && branch !== undefined) {
				const branchHead: string = (await runGit(source.fromPath, ["rev-parse", "--verify", `${branch}^{commit}`])).stdout.trim();
				if (branchHead !== source.head) throw new WorktreeOperationError("worktree_handoff_branch_mismatch", `Branch ${branch} does not point to the source HEAD.`);
				await runGit(source.fromPath, ["switch", "--detach"]);
				await runGit(source.toPath, ["switch", branch]);
			}
			await transferChanges(source.fromPath, source.toPath);
			applied.push(source);
		}
		for (const source of preview.sources) await cleanTransferredSource(source.fromPath);
		succeeded = true;
		return { ...structuredClone(params.metadata), location: params.target, status: "ready" };
	} catch (error: unknown) {
		let recoveryFailed: boolean = false;
		for (const source of [...applied].reverse()) {
			try { await cleanTransferredSource(source.toPath); } catch { recoveryFailed = true; }
		}
		if (recoveryFailed) throw new WorktreeOperationError("worktree_recovery_required", `Handoff failed and rollback was incomplete. Recovery snapshot: ${snapshotRoot}`);
		throw error;
	} finally {
		if (succeeded) await rm(snapshotRoot, { recursive: true, force: true });
	}
}
