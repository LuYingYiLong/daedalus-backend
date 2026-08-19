import { existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runGit } from "../server/git-utils.js";
import type { SessionWorktreeMetadata } from "./types.js";
import { WorktreeOperationError } from "./worktree-manager.js";
import { readWorktreeSettings } from "./worktree-settings.js";

export type WorktreeHealthStatus = "healthy" | "unavailable" | "recovery-required";

export type WorktreeHealthSnapshot = {
	worktreeId: string;
	status: WorktreeHealthStatus;
	issues: Array<{ code: string; message: string; sourceFolderId?: string | undefined }>;
	diskBytes: number;
	checkedAt: string;
};

async function directorySize(root: string): Promise<number> {
	if (!existsSync(root)) return 0;
	let total: number = 0;
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const path: string = join(root, entry.name);
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) total += await directorySize(path);
		else if (entry.isFile()) total += statSync(path).size;
	}
	return total;
}

export async function inspectWorktreeHealth(metadata: SessionWorktreeMetadata): Promise<WorktreeHealthSnapshot> {
	const issues: WorktreeHealthSnapshot["issues"] = [];
	for (const source of metadata.sources) {
		if (!existsSync(source.worktreePath) || !statSync(source.worktreePath).isDirectory()) {
			issues.push({ code: "worktree_directory_missing", message: `Worktree directory is missing: ${source.worktreePath}`, sourceFolderId: source.sourceFolderId });
			continue;
		}
		if (!existsSync(join(source.worktreePath, ".git"))) {
			issues.push({ code: "worktree_git_pointer_missing", message: `Git worktree pointer is missing: ${source.worktreePath}`, sourceFolderId: source.sourceFolderId });
			continue;
		}
		try {
			const head: string = (await runGit(source.worktreePath, ["rev-parse", "--verify", "HEAD"])).stdout.trim();
			if (head.length === 0) issues.push({ code: "worktree_head_missing", message: "Worktree HEAD is unavailable.", sourceFolderId: source.sourceFolderId });
			const list: string = (await runGit(source.sourcePath, ["worktree", "list", "--porcelain"])).stdout;
			if (!list.toLowerCase().includes(resolve(source.worktreePath).toLowerCase())) issues.push({ code: "worktree_not_registered", message: "Git no longer registers this worktree.", sourceFolderId: source.sourceFolderId });
		} catch (error: unknown) {
			issues.push({ code: "worktree_git_invalid", message: error instanceof Error ? error.message : "Worktree Git metadata is invalid.", sourceFolderId: source.sourceFolderId });
		}
	}
	const root: string = metadata.sources[0] === undefined ? (await readWorktreeSettings()).rootDirectory : resolve(metadata.sources[0].worktreePath, "..");
	return {
		worktreeId: metadata.id,
		status: issues.length === 0 ? "healthy" : issues.some((issue): boolean => issue.code === "worktree_not_registered" || issue.code === "worktree_git_invalid") ? "recovery-required" : "unavailable",
		issues,
		diskBytes: await directorySize(root),
		checkedAt: new Date().toISOString()
	};
}

export async function repairManagedWorktree(metadata: SessionWorktreeMetadata): Promise<WorktreeHealthSnapshot> {
	for (const source of metadata.sources) {
		if (!existsSync(source.sourcePath)) throw new WorktreeOperationError("worktree_source_missing", `Source repository is missing: ${source.sourcePath}`);
		await runGit(source.sourcePath, ["worktree", "repair", source.worktreePath]);
	}
	return await inspectWorktreeHealth(metadata);
}

export async function findOrphanedManagedWorktreeDirectories(knownSessionIds: ReadonlySet<string>): Promise<string[]> {
	const root: string = (await readWorktreeSettings()).rootDirectory;
	if (!existsSync(root)) return [];
	const entries = await readdir(root, { withFileTypes: true });
	return entries.filter((entry): boolean => entry.isDirectory() && !entry.name.startsWith(".") && !knownSessionIds.has(entry.name)).map((entry): string => join(root, entry.name));
}
