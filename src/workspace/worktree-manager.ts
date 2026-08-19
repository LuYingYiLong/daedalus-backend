import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { runGit, type GitResult } from "../server/git-utils.js";
import { readWorktreeSettings } from "./worktree-settings.js";
import type { SessionWorktreeMetadata, SessionWorktreeSource, WorktreeStartingState, WorkspaceConfig, WorkspaceSourceFolder } from "./types.js";
import { registerSessionRuntimeWorkspace, unregisterSessionRuntimeWorkspace } from "./registry.js";

const WORKTREE_GIT_TIMEOUT_MS: number = 30000;
const WORKTREE_ID_PATTERN: RegExp = /^[A-Za-z0-9._-]+$/u;
const repositoryLocks: Map<string, Promise<void>> = new Map();

export type WorktreeEligibilitySource = {
	sourceFolderId: string;
	sourcePath: string;
	eligible: boolean;
	repositoryRoot: string | null;
	commonDirectory: string | null;
	baseCommit: string | null;
	baseRef: string | null;
	dirty: boolean;
	reasonCode: string | null;
	reason: string | null;
};

export type WorktreeEligibilityResult = {
	workspaceId: string;
	eligible: boolean;
	sources: WorktreeEligibilitySource[];
};

export class WorktreeOperationError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "WorktreeOperationError";
		this.code = code;
	}
}

function normalizePath(value: string): string {
	const normalized: string = resolve(value);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isSameDirectory(left: string, right: string): boolean {
	const leftStats = statSync(left);
	const rightStats = statSync(right);
	return leftStats.dev === rightStats.dev && leftStats.ino === rightStats.ino;
}

function assertManagedPath(rootValue: string, pathValue: string): string {
	const root: string = resolve(rootValue);
	const target: string = resolve(pathValue);
	const relativePath: string = relative(root, target);
	if (relativePath.length === 0 || relativePath.startsWith("..") || isAbsolute(relativePath)) {
		throw new WorktreeOperationError("worktree_path_invalid", "Worktree path is outside the managed root.");
	}
	return target;
}

async function withRepositoryLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
	const previous: Promise<void> = repositoryLocks.get(key) ?? Promise.resolve();
	let release: (() => void) | undefined;
	const current: Promise<void> = new Promise((resolvePromise): void => {
		release = resolvePromise;
	});
	const queued: Promise<void> = previous.then((): Promise<void> => current);
	repositoryLocks.set(key, queued);
	await previous;
	try {
		return await operation();
	} finally {
		release?.();
		if (repositoryLocks.get(key) === queued) {
			repositoryLocks.delete(key);
		}
	}
}

async function inspectSource(source: WorkspaceSourceFolder): Promise<WorktreeEligibilitySource> {
	const unavailable = (reasonCode: string, reason: string): WorktreeEligibilitySource => ({
		sourceFolderId: source.id,
		sourcePath: source.path,
		eligible: false,
		repositoryRoot: null,
		commonDirectory: null,
		baseCommit: null,
		baseRef: null,
		dirty: false,
		reasonCode,
		reason
	});
	try {
		if (!existsSync(source.path) || !statSync(source.path).isDirectory()) {
			return unavailable("source_missing", "Source folder does not exist.");
		}
		const canonicalSource: string = realpathSync(source.path);
		const repositoryRoot: string = realpathSync((await runGit(canonicalSource, ["rev-parse", "--show-toplevel"])).stdout.trim());
		if (!isSameDirectory(repositoryRoot, canonicalSource)) {
			return unavailable("not_repository_root", "Source folder must be the Git repository root.");
		}
		const commonOutput: string = (await runGit(canonicalSource, ["rev-parse", "--git-common-dir"])).stdout.trim();
		const commonPath: string = realpathSync(isAbsolute(commonOutput) ? commonOutput : resolve(canonicalSource, commonOutput));
		const baseCommit: string = (await runGit(canonicalSource, ["rev-parse", "--verify", "HEAD"])).stdout.trim();
		if (baseCommit.length === 0) {
			return unavailable("head_unavailable", "Repository HEAD is unavailable.");
		}
		const branchResult: GitResult = await runGit(canonicalSource, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
			allowedExitCodes: [0, 1]
		});
		const status: string = (await runGit(canonicalSource, ["status", "--porcelain=v1", "--untracked-files=normal"])).stdout;
		const dirty: boolean = status.trim().length > 0;
		return {
			sourceFolderId: source.id,
			sourcePath: canonicalSource,
			eligible: true,
			repositoryRoot,
			commonDirectory: commonPath,
			baseCommit,
			baseRef: branchResult.stdout.trim() || null,
			dirty,
			reasonCode: null,
			reason: null
		};
	} catch (error: unknown) {
		return unavailable("git_unavailable", error instanceof Error ? error.message : "Source folder is not a Git repository.");
	}
}

export async function inspectWorkspaceWorktreeEligibility(workspace: WorkspaceConfig): Promise<WorktreeEligibilityResult> {
	const sources: WorktreeEligibilitySource[] = await Promise.all(workspace.sourceFolders.map(inspectSource));
	const commonDirectories: Set<string> = new Set();
	for (const source of sources) {
		if (source.commonDirectory === null) {
			continue;
		}
		const key: string = normalizePath(source.commonDirectory);
		if (commonDirectories.has(key)) {
			source.eligible = false;
			source.reasonCode = "duplicate_repository";
			source.reason = "Each source folder must belong to a different Git repository.";
		} else {
			commonDirectories.add(key);
		}
	}
	return {
		workspaceId: workspace.id,
		eligible: sources.length > 0 && sources.every((source): boolean => source.eligible),
		sources
	};
}

function createRuntimeWorkspace(workspace: WorkspaceConfig, metadata: SessionWorktreeMetadata): WorkspaceConfig {
	const bySourceId: ReadonlyMap<string, SessionWorktreeSource> = new Map(metadata.sources.map((source): [string, SessionWorktreeSource] => [source.sourceFolderId, source]));
	const sourceFolders: WorkspaceSourceFolder[] = workspace.sourceFolders.map((source): WorkspaceSourceFolder => {
		const worktreeSource: SessionWorktreeSource | undefined = bySourceId.get(source.id);
		if (worktreeSource === undefined) {
			throw new WorktreeOperationError("worktree_metadata_invalid", `Missing worktree source: ${source.id}`);
		}
		return { ...source, path: worktreeSource.worktreePath };
	});
	const primary: WorkspaceSourceFolder | undefined = sourceFolders.find((source): boolean => source.id === workspace.primarySourceFolderId);
	if (primary === undefined) {
		throw new WorktreeOperationError("worktree_metadata_invalid", "Primary worktree source is missing.");
	}
	return {
		...workspace,
		id: metadata.runtimeWorkspaceId,
		rootPath: primary.path,
		sourceFolders
	};
}

export type WorktreeSourceCreationOptions = {
	startingState?: WorktreeStartingState | undefined;
	environmentId?: string | null | undefined;
	environmentFingerprint?: string | null | undefined;
};

function assertSafeRelativePath(root: string, relativePath: string): string {
	const target: string = resolve(root, relativePath);
	const relation: string = relative(root, target);
	if (relation.length === 0 || relation.startsWith("..") || isAbsolute(relation)) {
		throw new WorktreeOperationError("worktree_copy_path_invalid", `Path escapes source root: ${relativePath}`);
	}
	return target;
}

async function copyRegularFile(sourceRoot: string, targetRoot: string, relativePath: string, overwrite: boolean): Promise<number> {
	const sourcePath: string = assertSafeRelativePath(sourceRoot, relativePath);
	const targetPath: string = assertSafeRelativePath(targetRoot, relativePath);
	const info = lstatSync(sourcePath);
	if (!info.isFile() || info.isSymbolicLink()) return 0;
	if (!overwrite && existsSync(targetPath)) return 0;
	await mkdir(resolve(targetPath, ".."), { recursive: true });
	await copyFile(sourcePath, targetPath);
	return info.size;
}

async function runGitWithInput(cwd: string, args: string[], input: string): Promise<void> {
	const { spawn } = await import("node:child_process");
	await new Promise<void>((resolvePromise, reject): void => {
		const child = spawn("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		let stderr: string = "";
		child.stderr.on("data", (data: Buffer): void => { stderr += data.toString("utf8"); });
		child.on("error", reject);
		child.on("close", (code: number | null): void => code === 0 ? resolvePromise() : reject(new WorktreeOperationError("worktree_patch_failed", stderr.trim() || `git ${args.join(" ")} failed.`)));
		child.stdin.end(input, "utf8");
	});
}

async function copyWorkingTreeState(sourceRoot: string, targetRoot: string): Promise<void> {
	const stagedPatch: string = (await runGit(sourceRoot, ["diff", "--cached", "--binary", "--full-index"])).stdout;
	const unstagedPatch: string = (await runGit(sourceRoot, ["diff", "--binary", "--full-index"])).stdout;
	if (stagedPatch.length > 0) await runGitWithInput(targetRoot, ["apply", "--binary", "--index", "-"], stagedPatch);
	if (unstagedPatch.length > 0) await runGitWithInput(targetRoot, ["apply", "--binary", "-"], unstagedPatch);
	const untracked: string[] = (await runGit(sourceRoot, ["ls-files", "--others", "--exclude-standard", "-z"])).stdout.split("\0").filter(Boolean);
	for (const relativePath of untracked) await copyRegularFile(sourceRoot, targetRoot, relativePath, false);
}

function isSensitiveIncludedPath(value: string): boolean {
	return /(^|\/)(?:\.env(?:\.|$)|credentials?(?:\.|$)|secrets?(?:\.|$)|.*\.(?:pem|key|p12|pfx))$/iu.test(value.replaceAll("\\", "/"));
}

function gitIgnorePatternToRegex(pattern: string): RegExp {
	let value: string = pattern.trim().replaceAll("\\", "/");
	const anchored: boolean = value.startsWith("/");
	if (anchored) value = value.slice(1);
	const escaped: string = value.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replaceAll("**", "\0").replaceAll("*", "[^/]*").replaceAll("?", "[^/]").replaceAll("\0", ".*");
	return new RegExp(`${anchored ? "^" : "(?:^|/)"}${escaped}${value.endsWith("/") ? ".*" : "(?:$|/)"}`, "u");
}

async function copyWorktreeIncludes(sourceRoot: string, targetRoot: string): Promise<string[]> {
	const includePath: string = join(sourceRoot, ".worktreeinclude");
	if (!existsSync(includePath)) return [];
	const patterns: RegExp[] = (await readFile(includePath, "utf8")).split(/\r?\n/u)
		.map((line): string => line.trim())
		.filter((line): boolean => line.length > 0 && !line.startsWith("#") && !line.startsWith("!"))
		.map(gitIgnorePatternToRegex);
	if (patterns.length === 0) return [];
	const ignored: string[] = (await runGit(sourceRoot, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])).stdout.split("\0").filter(Boolean);
	let totalBytes: number = 0;
	let copiedCount: number = 0;
	const sensitive: string[] = [];
	for (const relativePath of ignored) {
		if (!patterns.some((pattern): boolean => pattern.test(relativePath.replaceAll("\\", "/")))) continue;
		if (copiedCount >= 500) throw new WorktreeOperationError("worktree_include_limit", ".worktreeinclude matched more than 500 files.");
		const sourcePath: string = assertSafeRelativePath(sourceRoot, relativePath);
		const info = lstatSync(sourcePath);
		if (!info.isFile() || info.isSymbolicLink()) continue;
		if (info.size > 16 * 1024 * 1024 || totalBytes + info.size > 128 * 1024 * 1024) throw new WorktreeOperationError("worktree_include_limit", ".worktreeinclude exceeded the file size limit.");
		totalBytes += await copyRegularFile(sourceRoot, targetRoot, relativePath, false);
		copiedCount += 1;
		if (isSensitiveIncludedPath(relativePath)) sensitive.push(relativePath.replaceAll("\\", "/"));
	}
	return sensitive;
}

export async function createManagedWorktree(params: { sessionId: string; workspace: WorkspaceConfig; sources?: Record<string, WorktreeSourceCreationOptions> | undefined; permanentName?: string | undefined }): Promise<{ metadata: SessionWorktreeMetadata; workspace: WorkspaceConfig }> {
	if (!WORKTREE_ID_PATTERN.test(params.sessionId)) {
		throw new WorktreeOperationError("worktree_session_invalid", "Session id is not safe for a managed worktree.");
	}
	const settings = await readWorktreeSettings();
	if (settings.fetchBeforeCreate) {
		await Promise.all(params.workspace.sourceFolders.map(async (source): Promise<void> => {
			const inspected = await inspectSource(source);
			if (inspected.repositoryRoot !== null && inspected.commonDirectory !== null) {
				await withRepositoryLock(inspected.commonDirectory, async (): Promise<void> => {
					await runGit(inspected.repositoryRoot!, ["fetch", "--all", "--prune"], { timeoutMs: WORKTREE_GIT_TIMEOUT_MS * 4 });
				});
			}
		}));
	}
	const eligibility: WorktreeEligibilityResult = await inspectWorkspaceWorktreeEligibility(params.workspace);
	if (!eligibility.eligible) {
		const reason: string = eligibility.sources.find((source): boolean => !source.eligible)?.reason ?? "Workspace is not eligible for worktrees.";
		throw new WorktreeOperationError("worktree_ineligible", reason);
	}
	const sessionRoot: string = assertManagedPath(settings.rootDirectory, resolve(settings.rootDirectory, params.sessionId));
	const targetPaths: Map<string, string> = new Map();
	for (const source of eligibility.sources) {
		const sourceFolderId: string = source.sourceFolderId;
		if (!WORKTREE_ID_PATTERN.test(sourceFolderId)) {
			throw new WorktreeOperationError("worktree_source_invalid", `Invalid source folder id: ${sourceFolderId}`);
		}
		const worktreePath: string = assertManagedPath(settings.rootDirectory, resolve(sessionRoot, sourceFolderId));
		if (existsSync(worktreePath)) {
			throw new WorktreeOperationError("worktree_path_exists", `Worktree path already exists: ${worktreePath}`);
		}
		targetPaths.set(sourceFolderId, worktreePath);
	}
	await mkdir(sessionRoot, { recursive: true });
	const createdSources: Array<SessionWorktreeSource & { commonDirectory: string }> = [];
	try {
		for (const source of eligibility.sources) {
			if (source.commonDirectory === null || source.baseCommit === null || source.repositoryRoot === null) {
				throw new WorktreeOperationError("worktree_ineligible", source.reason ?? "Git source is unavailable.");
			}
			const worktreePath: string = targetPaths.get(source.sourceFolderId)!;
			const creationOptions: WorktreeSourceCreationOptions = params.sources?.[source.sourceFolderId] ?? {};
			const startingState: WorktreeStartingState = creationOptions.startingState ?? { type: "head" };
			const startingRef: string = startingState.type === "branch" ? startingState.ref : "HEAD";
			const baseCommit: string = (await runGit(source.repositoryRoot, ["rev-parse", "--verify", `${startingRef}^{commit}`])).stdout.trim();
			if (source.dirty && startingState.type !== "working-tree") {
				throw new WorktreeOperationError("worktree_dirty_confirmation_required", "The source checkout has changes. Select working-tree state or explicitly continue without copying changes.");
			}
			await withRepositoryLock(source.commonDirectory, async (): Promise<void> => {
				await runGit(source.repositoryRoot!, ["worktree", "add", "--detach", worktreePath, baseCommit], {
					timeoutMs: WORKTREE_GIT_TIMEOUT_MS
				});
			});
			if (startingState.type === "working-tree") await copyWorkingTreeState(source.sourcePath, worktreePath);
			const sensitiveIncludedPaths: string[] = await copyWorktreeIncludes(source.sourcePath, worktreePath);
			createdSources.push({
				sourceFolderId: source.sourceFolderId,
				sourcePath: source.sourcePath,
				worktreePath,
				baseCommit,
				baseRef: startingState.type === "branch" ? startingState.ref : source.baseRef,
				startingState,
				environmentId: creationOptions.environmentId ?? null,
				environmentFingerprint: creationOptions.environmentFingerprint ?? null,
				setupState: creationOptions.environmentId == null ? "not-required" : "pending-trust",
				sensitiveIncludedPaths,
				commonDirectory: source.commonDirectory
			});
		}
		const metadata: SessionWorktreeMetadata = {
			id: `${params.permanentName === undefined ? "managed" : "permanent"}-${params.sessionId}`,
			sourceWorkspaceId: params.workspace.id,
			sourceWorkspaceName: params.workspace.name,
			runtimeWorkspaceId: `worktree-${params.sessionId}`,
			sources: createdSources.map(({ commonDirectory: _commonDirectory, ...source }): SessionWorktreeSource => source),
			createdAt: new Date().toISOString(),
			location: "worktree",
			status: createdSources.some((source): boolean => source.setupState === "pending-trust") ? "setting-up" : "ready",
			permanent: params.permanentName !== undefined || undefined,
			displayName: params.permanentName
		};
		const workspace: WorkspaceConfig = registerSessionRuntimeWorkspace(createRuntimeWorkspace(params.workspace, metadata));
		return { metadata, workspace };
	} catch (error: unknown) {
		for (const source of [...createdSources].reverse()) {
			try {
				await withRepositoryLock(source.commonDirectory, async (): Promise<void> => {
					await runGit(source.sourcePath, ["worktree", "remove", "--force", source.worktreePath], {
						timeoutMs: WORKTREE_GIT_TIMEOUT_MS
					});
				});
			} catch {
				// 回滚继续清理其他已创建工作树，原始错误优先返回。
			}
		}
		await rm(sessionRoot, { recursive: true, force: true });
		throw error;
	}
}

export function restoreManagedWorktreeWorkspace(metadata: SessionWorktreeMetadata, sourceWorkspace: WorkspaceConfig | undefined): WorkspaceConfig | undefined {
	if ((metadata.location ?? "worktree") === "local") return sourceWorkspace;
	if (
		sourceWorkspace === undefined ||
		metadata.sources.some((source): boolean => !existsSync(source.worktreePath) || !statSync(source.worktreePath).isDirectory() || !existsSync(join(source.worktreePath, ".git")))
	) {
		return undefined;
	}
	try {
		return registerSessionRuntimeWorkspace(createRuntimeWorkspace(sourceWorkspace, metadata));
	} catch {
		return undefined;
	}
}

async function hasReachableNamedRef(worktreePath: string, head: string): Promise<boolean> {
	const refs: string = (await runGit(worktreePath, ["for-each-ref", "--contains", head, "--format=%(refname)", "refs/heads"])).stdout;
	return refs.trim().length > 0;
}

export async function deleteManagedWorktree(metadata: SessionWorktreeMetadata): Promise<void> {
	for (const source of metadata.sources) {
		if (!existsSync(source.worktreePath)) {
			continue;
		}
		const status: string = (await runGit(source.worktreePath, ["status", "--porcelain=v1", "--untracked-files=normal"])).stdout;
		if (status.trim().length > 0) {
			throw new WorktreeOperationError("worktree_dirty", `Worktree has uncommitted changes: ${source.worktreePath}`);
		}
		const head: string = (await runGit(source.worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
		if (head !== source.baseCommit && !(await hasReachableNamedRef(source.worktreePath, head))) {
			throw new WorktreeOperationError("worktree_unreferenced_commits", `Create a branch before deleting this worktree: ${source.worktreePath}`);
		}
	}
	for (const source of [...metadata.sources].reverse()) {
		if (!existsSync(source.worktreePath)) {
			continue;
		}
		const commonOutput: string = (await runGit(source.worktreePath, ["rev-parse", "--git-common-dir"])).stdout.trim();
		const commonDirectory: string = resolve(source.worktreePath, commonOutput);
		await withRepositoryLock(normalizePath(commonDirectory), async (): Promise<void> => {
			await runGit(source.sourcePath, ["worktree", "remove", source.worktreePath], {
				timeoutMs: WORKTREE_GIT_TIMEOUT_MS
			});
		});
	}
	unregisterSessionRuntimeWorkspace(metadata.runtimeWorkspaceId);
	const managedRoot: string = resolve(metadata.sources[0]?.worktreePath ?? ".", "..", "..");
	await rm(assertManagedPath(managedRoot, resolve(managedRoot, metadata.id.replace(/^(?:managed|permanent)-/u, ""))), {
		recursive: true,
		force: true
	});
}
