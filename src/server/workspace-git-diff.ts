import { isInsideGitWorkTree, readGitBranch, runGit, type GitResult } from "./git-utils.js";

export type WorkspaceGitDiffResult = {
	workspaceId: string;
	hasGitRepository: boolean;
	branch: string | null;
	patch: string;
	additions: number;
	deletions: number;
	changedFiles: number;
	untrackedFiles: number;
	truncated: boolean;
	generatedAt: string;
};

export type WorkspaceGitDiffOptions = {
	patchLimitChars?: number | undefined;
	untrackedFileLimit?: number | undefined;
};

const DEFAULT_PATCH_LIMIT_CHARS: number = 1024 * 1024;
const DEFAULT_UNTRACKED_FILE_LIMIT: number = 200;

function splitNullTerminated(text: string): string[] {
	return text.split("\0").filter((item: string): boolean => item.length > 0);
}

function joinPatchChunks(chunks: string[]): string {
	return chunks
		.filter((chunk: string): boolean => chunk.length > 0)
		.map((chunk: string): string => chunk.endsWith("\n") ? chunk : `${chunk}\n`)
		.join("");
}

function countChangedLines(patch: string): { additions: number; deletions: number } {
	let additions: number = 0;
	let deletions: number = 0;
	for (const line of patch.split(/\r?\n/u)) {
		if (line.startsWith("+++") || line.startsWith("---")) {
			continue;
		}
		if (line.startsWith("+")) {
			additions += 1;
		} else if (line.startsWith("-")) {
			deletions += 1;
		}
	}
	return { additions, deletions };
}

async function readTrackedPatch(workspaceRoot: string): Promise<string> {
	try {
		return (await runGit(workspaceRoot, ["diff", "--no-color", "--no-ext-diff", "--unified=3", "HEAD", "--"])).stdout;
	} catch {
		// 空仓库或无 HEAD 时仍允许显示未跟踪文件 diff。
		return "";
	}
}

async function listUntrackedFiles(workspaceRoot: string): Promise<string[]> {
	try {
		const result: GitResult = await runGit(workspaceRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
		return splitNullTerminated(result.stdout);
	} catch {
		return [];
	}
}

async function readUntrackedPatch(workspaceRoot: string, relativePath: string): Promise<string> {
	try {
		return (await runGit(
			workspaceRoot,
			["diff", "--no-index", "--no-color", "--no-ext-diff", "--unified=3", "--", "/dev/null", relativePath],
			{ allowedExitCodes: [0, 1] }
		)).stdout;
	} catch {
		return "";
	}
}

async function countChangedFiles(workspaceRoot: string): Promise<number> {
	try {
		const statusOutput: string = (await runGit(workspaceRoot, ["status", "--porcelain=v1"])).stdout;
		return statusOutput.split(/\r?\n/u).filter((line: string): boolean => line.trim().length > 0).length;
	} catch {
		return 0;
	}
}

export async function readWorkspaceGitDiff(
	workspaceId: string,
	workspaceRoot: string,
	options: WorkspaceGitDiffOptions = {}
): Promise<WorkspaceGitDiffResult> {
	const generatedAt: string = new Date().toISOString();
	const hasGitRepository: boolean = await isInsideGitWorkTree(workspaceRoot);
	if (!hasGitRepository) {
		return {
			workspaceId,
			hasGitRepository: false,
			branch: null,
			patch: "",
			additions: 0,
			deletions: 0,
			changedFiles: 0,
			untrackedFiles: 0,
			truncated: false,
			generatedAt
		};
	}

	const branch: string | null = await readGitBranch(workspaceRoot);
	const patchLimitChars: number = Math.max(0, Math.trunc(options.patchLimitChars ?? DEFAULT_PATCH_LIMIT_CHARS));
	const untrackedFileLimit: number = Math.max(0, Math.trunc(options.untrackedFileLimit ?? DEFAULT_UNTRACKED_FILE_LIMIT));
	const chunks: string[] = [await readTrackedPatch(workspaceRoot)];
	let collectedPatchChars: number = chunks[0]?.length ?? 0;
	let truncated: boolean = collectedPatchChars > patchLimitChars;
	const untrackedFiles: string[] = await listUntrackedFiles(workspaceRoot);
	let inspectedUntrackedFiles: number = 0;
	while (
		inspectedUntrackedFiles < untrackedFiles.length
		&& inspectedUntrackedFiles < untrackedFileLimit
		&& !truncated
	) {
		const relativePath: string = untrackedFiles[inspectedUntrackedFiles]!;
		const patch: string = await readUntrackedPatch(workspaceRoot, relativePath);
		chunks.push(patch);
		collectedPatchChars += patch.length;
		inspectedUntrackedFiles += 1;
		truncated = collectedPatchChars > patchLimitChars;
	}
	if (inspectedUntrackedFiles < untrackedFiles.length) {
		truncated = true;
	}

	const collectedPatch: string = joinPatchChunks(chunks);
	const patch: string = truncated ? collectedPatch.slice(0, patchLimitChars) : collectedPatch;
	const counts = countChangedLines(collectedPatch);

	return {
		workspaceId,
		hasGitRepository: true,
		branch,
		patch,
		additions: counts.additions,
		deletions: counts.deletions,
		changedFiles: await countChangedFiles(workspaceRoot),
		untrackedFiles: untrackedFiles.length,
		truncated,
		generatedAt
	};
}
