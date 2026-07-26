import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { isInsideGitWorkTree, readGitBranch, runGit, type GitResult } from "./git-utils.js";

export type WorkspaceGitDiffFileType = "add" | "delete" | "modify" | "rename" | "copy";

export type WorkspaceGitDiffFileSummary = {
	path: string;
	oldPath?: string | undefined;
	type: WorkspaceGitDiffFileType;
	additions: number | null;
	deletions: number | null;
	sizeBytes: number | null;
	isBinary: boolean;
	isUntracked: boolean;
	canAutoExpand: boolean;
};

export type WorkspaceGitDiffSummaryResult = {
	workspaceId: string;
	hasGitRepository: boolean;
	branch: string | null;
	additions: number;
	deletions: number;
	changedFiles: number;
	untrackedFiles: number;
	files: WorkspaceGitDiffFileSummary[];
	nextCursor: number | null;
	generatedAt: string;
};

export type WorkspaceGitDiffFileResult = {
	workspaceId: string;
	path: string;
	patch: string;
	isBinary: boolean;
	tooLargeToRender: boolean;
	generatedAt: string;
};

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
const DEFAULT_DIFF_SUMMARY_PAGE_SIZE: number = 100;
const MAX_DIFF_SUMMARY_PAGE_SIZE: number = 100;
const AUTO_EXPAND_MAX_FILE_BYTES: number = 128 * 1024;
const AUTO_EXPAND_MAX_CHANGED_LINES: number = 800;
const MAX_FILE_DIFF_PREVIEW_BYTES: number = 256 * 1024;
const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
	"7z", "bmp", "dds", "dll", "exe", "gif", "ico", "jar", "jpeg", "jpg", "mp3", "mp4", "ogg", "otf", "pdf", "png", "so", "ttf", "wav", "webm", "webp", "zip"
]);

function splitNullTerminated(text: string): string[] {
	return text.split("\0").filter((item: string): boolean => item.length > 0);
}

function isSafeRelativePath(value: string): boolean {
	return value.length > 0
		&& !path.isAbsolute(value)
		&& !value.split(/[\\/]/u).some((segment: string): boolean => segment === ".." || segment.length === 0 && value !== "");
}

function resolveWorkspaceRelativePath(workspaceRoot: string, relativePath: string): string {
	if (!isSafeRelativePath(relativePath)) {
		throw new Error("Git diff path must be a workspace-relative path.");
	}

	const resolvedRoot: string = path.resolve(workspaceRoot);
	const resolvedPath: string = path.resolve(resolvedRoot, relativePath);
	const relativeToRoot: string = path.relative(resolvedRoot, resolvedPath);
	if (relativeToRoot === "" || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {
		throw new Error("Git diff path escapes the workspace.");
	}
	return resolvedPath;
}

function getExtension(relativePath: string): string {
	const extension: string = path.extname(relativePath).slice(1).toLowerCase();
	return extension;
}

function isLikelyBinaryPath(relativePath: string): boolean {
	return BINARY_EXTENSIONS.has(getExtension(relativePath));
}

function parseStatusType(status: string): WorkspaceGitDiffFileType {
	if (status.startsWith("A")) {
		return "add";
	}
	if (status.startsWith("D")) {
		return "delete";
	}
	if (status.startsWith("R")) {
		return "rename";
	}
	if (status.startsWith("C")) {
		return "copy";
	}
	return "modify";
}

type DiffNumstat = {
	additions: number | null;
	deletions: number | null;
	isBinary: boolean;
};

function parseNumstatCount(value: string): number | null {
	if (value === "-") {
		return null;
	}
	const parsed: number = Number.parseInt(value, 10);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseNumstatByPath(text: string): Map<string, DiffNumstat> {
	const tokens: string[] = splitNullTerminated(text);
	const result: Map<string, DiffNumstat> = new Map();
	for (let index: number = 0; index < tokens.length; index += 1) {
		const token: string = tokens[index]!;
		const parts: string[] = token.split("\t");
		if (parts.length < 3) {
			continue;
		}
		const additions: number | null = parseNumstatCount(parts[0]!);
		const deletions: number | null = parseNumstatCount(parts[1]!);
		const stats: DiffNumstat = { additions, deletions, isBinary: additions === null || deletions === null };
		const firstPath: string = parts.slice(2).join("\t");
		if (firstPath.length > 0) {
			result.set(firstPath, stats);
			continue;
		}
		const oldPath: string | undefined = tokens[index + 1];
		const newPath: string | undefined = tokens[index + 2];
		if (oldPath !== undefined) {
			result.set(oldPath, stats);
		}
		if (newPath !== undefined) {
			result.set(newPath, stats);
		}
		index += 2;
	}
	return result;
}

type GitNameStatus = {
	path: string;
	oldPath?: string | undefined;
	type: WorkspaceGitDiffFileType;
};

function parseNameStatus(text: string): GitNameStatus[] {
	const tokens: string[] = splitNullTerminated(text);
	const result: GitNameStatus[] = [];
	for (let index: number = 0; index < tokens.length; index += 1) {
		const status: string = tokens[index] ?? "";
		const firstPath: string | undefined = tokens[index + 1];
		if (firstPath === undefined) {
			break;
		}
		const type: WorkspaceGitDiffFileType = parseStatusType(status);
		if (type === "rename" || type === "copy") {
			const secondPath: string | undefined = tokens[index + 2];
			if (secondPath === undefined) {
				break;
			}
			result.push({ path: secondPath, oldPath: firstPath, type });
			index += 2;
			continue;
		}
		result.push({ path: firstPath, type });
		index += 1;
	}
	return result;
}

async function readWorkingFileSize(workspaceRoot: string, relativePath: string): Promise<number | null> {
	try {
		const filePath: string = resolveWorkspaceRelativePath(workspaceRoot, relativePath);
		const info = await stat(filePath);
		return info.isFile() ? info.size : null;
	} catch {
		return null;
	}
}

async function countTextFileLines(workspaceRoot: string, relativePath: string): Promise<number | null> {
	try {
		const filePath: string = resolveWorkspaceRelativePath(workspaceRoot, relativePath);
		let newlineCount: number = 0;
		let hasContent: boolean = false;
		let endsWithNewline: boolean = false;
		for await (const chunk of createReadStream(filePath)) {
			const bytes: Buffer = chunk as Buffer;
			if (bytes.length === 0) {
				continue;
			}
			hasContent = true;
			for (const byte of bytes) {
				if (byte === 0x0a) {
					newlineCount += 1;
				}
			}
			endsWithNewline = bytes[bytes.length - 1] === 0x0a;
		}
		return hasContent ? newlineCount + (endsWithNewline ? 0 : 1) : 0;
	} catch {
		return null;
	}
}

function shouldAutoExpand(file: Pick<WorkspaceGitDiffFileSummary, "sizeBytes" | "additions" | "deletions" | "isBinary">): boolean {
	if (file.isBinary || (file.sizeBytes !== null && file.sizeBytes > AUTO_EXPAND_MAX_FILE_BYTES)) {
		return false;
	}
	const changedLines: number = (file.additions ?? 0) + (file.deletions ?? 0);
	return changedLines <= AUTO_EXPAND_MAX_CHANGED_LINES;
}

function compareSummaryFiles(left: WorkspaceGitDiffFileSummary, right: WorkspaceGitDiffFileSummary): number {
	if (left.canAutoExpand !== right.canAutoExpand) {
		return left.canAutoExpand ? -1 : 1;
	}
	const leftWeight: number = (left.sizeBytes ?? Number.MAX_SAFE_INTEGER) + ((left.additions ?? 0) + (left.deletions ?? 0)) * 80;
	const rightWeight: number = (right.sizeBytes ?? Number.MAX_SAFE_INTEGER) + ((right.additions ?? 0) + (right.deletions ?? 0)) * 80;
	if (leftWeight !== rightWeight) {
		return leftWeight - rightWeight;
	}
	return left.path.localeCompare(right.path);
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

async function readTrackedDiffMetadata(workspaceRoot: string): Promise<{ files: GitNameStatus[]; statsByPath: Map<string, DiffNumstat> }> {
	try {
		const [nameStatus, numstat] = await Promise.all([
			runGit(workspaceRoot, ["diff", "--name-status", "-z", "-M", "HEAD", "--"]),
			runGit(workspaceRoot, ["diff", "--numstat", "-z", "-M", "HEAD", "--"])
		]);
		return {
			files: parseNameStatus(nameStatus.stdout),
			statsByPath: parseNumstatByPath(numstat.stdout)
		};
	} catch {
		return { files: [], statsByPath: new Map() };
	}
}

export async function readWorkspaceGitDiffSummary(
	workspaceId: string,
	workspaceRoot: string,
	cursor: number = 0,
	limit: number = DEFAULT_DIFF_SUMMARY_PAGE_SIZE
): Promise<WorkspaceGitDiffSummaryResult> {
	const generatedAt: string = new Date().toISOString();
	const hasGitRepository: boolean = await isInsideGitWorkTree(workspaceRoot);
	if (!hasGitRepository) {
		return {
			workspaceId,
			hasGitRepository: false,
			branch: null,
			additions: 0,
			deletions: 0,
			changedFiles: 0,
			untrackedFiles: 0,
			files: [],
			nextCursor: null,
			generatedAt
		};
	}

	const [branch, tracked, untrackedFiles] = await Promise.all([
		readGitBranch(workspaceRoot),
		readTrackedDiffMetadata(workspaceRoot),
		listUntrackedFiles(workspaceRoot)
	]);
	const trackedFiles: WorkspaceGitDiffFileSummary[] = await Promise.all(tracked.files.map(async (file: GitNameStatus): Promise<WorkspaceGitDiffFileSummary> => {
		const stats: DiffNumstat | undefined = tracked.statsByPath.get(file.path) ?? (file.oldPath === undefined ? undefined : tracked.statsByPath.get(file.oldPath));
		const sizeBytes: number | null = await readWorkingFileSize(workspaceRoot, file.path);
		const isBinary: boolean = stats?.isBinary === true || isLikelyBinaryPath(file.path);
		const summary: WorkspaceGitDiffFileSummary = {
			path: file.path,
			oldPath: file.oldPath,
			type: file.type,
			additions: stats?.additions ?? null,
			deletions: stats?.deletions ?? null,
			sizeBytes,
			isBinary,
			isUntracked: false,
			canAutoExpand: false
		};
		return { ...summary, canAutoExpand: shouldAutoExpand(summary) };
	}));
	const untrackedSummaries: WorkspaceGitDiffFileSummary[] = await Promise.all(untrackedFiles.map(async (relativePath: string): Promise<WorkspaceGitDiffFileSummary> => {
		const sizeBytes: number | null = await readWorkingFileSize(workspaceRoot, relativePath);
		const isBinary: boolean = isLikelyBinaryPath(relativePath);
		const additions: number | null = isBinary ? null : await countTextFileLines(workspaceRoot, relativePath);
		const summary: WorkspaceGitDiffFileSummary = {
			path: relativePath,
			type: "add",
			additions,
			deletions: 0,
			sizeBytes,
			isBinary,
			isUntracked: true,
			canAutoExpand: false
		};
		return { ...summary, canAutoExpand: shouldAutoExpand(summary) };
	}));
	const files: WorkspaceGitDiffFileSummary[] = [...trackedFiles, ...untrackedSummaries].sort(compareSummaryFiles);
	const safeCursor: number = Math.max(0, Math.trunc(cursor));
	const pageSize: number = Math.min(MAX_DIFF_SUMMARY_PAGE_SIZE, Math.max(1, Math.trunc(limit)));
	const page: WorkspaceGitDiffFileSummary[] = files.slice(safeCursor, safeCursor + pageSize);
	const nextCursor: number | null = safeCursor + page.length < files.length ? safeCursor + page.length : null;
	const additions: number = [...trackedFiles, ...untrackedSummaries].reduce(
		(total: number, file: WorkspaceGitDiffFileSummary): number => total + (file.additions ?? 0),
		0
	);
	const deletions: number = [...trackedFiles, ...untrackedSummaries].reduce(
		(total: number, file: WorkspaceGitDiffFileSummary): number => total + (file.deletions ?? 0),
		0
	);

	return {
		workspaceId,
		hasGitRepository: true,
		branch,
		additions,
		deletions,
		changedFiles: files.length,
		untrackedFiles: untrackedFiles.length,
		files: page,
		nextCursor,
		generatedAt
	};
}

function looksLikeBinaryPatch(patch: string): boolean {
	return patch.includes("Binary files ") || patch.includes("GIT binary patch");
}

export async function readWorkspaceGitDiffFile(
	workspaceId: string,
	workspaceRoot: string,
	relativePath: string
): Promise<WorkspaceGitDiffFileResult> {
	resolveWorkspaceRelativePath(workspaceRoot, relativePath);
	const generatedAt: string = new Date().toISOString();
	const hasGitRepository: boolean = await isInsideGitWorkTree(workspaceRoot);
	if (!hasGitRepository) {
		throw new Error("Workspace is not a Git repository.");
	}

	const tracked: GitResult = await runGit(
		workspaceRoot,
		["diff", "--no-color", "--no-ext-diff", "--unified=3", "HEAD", "--", relativePath],
		{ maxStdoutBytes: MAX_FILE_DIFF_PREVIEW_BYTES }
	).catch((): GitResult => ({ stdout: "", stderr: "", exitCode: null, stdoutTruncated: false }));
	if (tracked.stdoutTruncated) {
		return { workspaceId, path: relativePath, patch: "", isBinary: false, tooLargeToRender: true, generatedAt };
	}
	if (tracked.stdout.length > 0) {
		return {
			workspaceId,
			path: relativePath,
			patch: tracked.stdout,
			isBinary: looksLikeBinaryPatch(tracked.stdout),
			tooLargeToRender: false,
			generatedAt
		};
	}

	const untracked: GitResult = await runGit(
		workspaceRoot,
		["diff", "--no-index", "--no-color", "--no-ext-diff", "--unified=3", "--", "/dev/null", relativePath],
		{ allowedExitCodes: [0, 1], maxStdoutBytes: MAX_FILE_DIFF_PREVIEW_BYTES }
	).catch((): GitResult => ({ stdout: "", stderr: "", exitCode: null, stdoutTruncated: false }));
	if (untracked.stdoutTruncated) {
		return { workspaceId, path: relativePath, patch: "", isBinary: false, tooLargeToRender: true, generatedAt };
	}
	if (untracked.stdout.length === 0) {
		throw new Error(`No Git diff found for ${relativePath}.`);
	}
	return {
		workspaceId,
		path: relativePath,
		patch: untracked.stdout,
		isBinary: looksLikeBinaryPatch(untracked.stdout),
		tooLargeToRender: false,
		generatedAt
	};
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
