import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const GIT_HISTORY_TIMEOUT_MS: number = 15_000;
const MAX_GIT_HISTORY_COMMITS: number = 200;
const GIT_FIELD_SEPARATOR: string = "\u001f";
const GIT_RECORD_SEPARATOR: string = "\u001e";
const SAFE_GIT_REF_PATTERN: RegExp = /^[A-Za-z0-9][A-Za-z0-9._/@^-]{0,127}$/u;

export type WorkspaceGitCommit = {
	hash: string;
	shortHash: string;
	authorDate: string;
	subject: string;
};

export type WorkspaceGitRefs = {
	tags: string[];
	branches: string[];
};

export type WorkspaceGitHistoryResult = {
	ok: boolean;
	/** A missing requested ref is a completed lookup, not a failed command. */
	status: "history" | "reference_unavailable";
	source: "local" | "github_remote" | "unavailable";
	fromRef: string;
	toRef: string;
	commits: WorkspaceGitCommit[];
	truncated: boolean;
	missingRefs?: ("fromRef" | "toRef")[] | undefined;
	availableRefs?: WorkspaceGitRefs | undefined;
	code?: "git_repository_missing" | "git_ref_missing" | "git_command_failed" | undefined;
	message?: string | undefined;
};

type GithubCompareCommit = {
	sha?: unknown;
	commit?: {
		message?: unknown;
		author?: { date?: unknown } | undefined;
	} | undefined;
};

type GithubCompareResponse = {
	total_commits?: unknown;
	commits?: unknown;
};

function assertSafeGitRef(ref: string, field: "fromRef" | "toRef"): string {
	const normalized: string = ref.trim();
	if (!SAFE_GIT_REF_PATTERN.test(normalized) || normalized.includes("..") || normalized.endsWith(".")) {
		throw new Error(`${field} must be a simple Git ref, tag, branch, or HEAD.`);
	}
	return normalized;
}

async function runGit(cwd: string, args: string[], signal?: AbortSignal | undefined): Promise<{ stdout: string; stderr: string }> {
	return execFile("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		timeout: GIT_HISTORY_TIMEOUT_MS,
		windowsHide: true,
		signal
	});
}

function parseCommits(output: string): WorkspaceGitCommit[] {
	return output
		.split(GIT_RECORD_SEPARATOR)
		.map((record: string): WorkspaceGitCommit | null => {
			const fields: string[] = record.trim().split(GIT_FIELD_SEPARATOR);
			if (fields.length !== 4 || fields.some((field: string): boolean => field.length === 0)) {
				return null;
			}
			return {
				hash: fields[0]!,
				shortHash: fields[1]!,
				authorDate: fields[2]!,
				subject: fields[3]!
			};
		})
		.filter((commit: WorkspaceGitCommit | null): commit is WorkspaceGitCommit => commit !== null);
}

function parseRefs(output: string): WorkspaceGitRefs {
	const tags: string[] = [];
	const branches: string[] = [];
	for (const line of output.split(/\r?\n/u)) {
		if (line.startsWith("refs/tags/")) tags.push(line.slice("refs/tags/".length));
		if (line.startsWith("refs/heads/")) branches.push(line.slice("refs/heads/".length));
	}
	return { tags, branches };
}

async function readAvailableRefs(cwd: string, signal?: AbortSignal | undefined): Promise<WorkspaceGitRefs> {
	try {
		const result = await runGit(cwd, [
			"for-each-ref",
			"--count=100",
			"--sort=-version:refname",
			"--format=%(refname)",
			"refs/heads",
			"refs/tags"
		], signal);
		return parseRefs(result.stdout);
	} catch {
		return { tags: [], branches: [] };
	}
}

async function resolvesToCommit(cwd: string, ref: string, signal?: AbortSignal | undefined): Promise<boolean> {
	try {
		await runGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], signal);
		return true;
	} catch {
		return false;
	}
}

async function resolveCommitHash(cwd: string, ref: string, signal?: AbortSignal | undefined): Promise<string | null> {
	try {
		const result = await runGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], signal);
		const hash: string = result.stdout.trim();
		return hash.length > 0 ? hash : null;
	} catch {
		return null;
	}
}

function parseGithubRepository(remoteUrl: string): string | null {
	const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u.exec(remoteUrl.trim());
	return match?.[1] ?? null;
}

async function getGithubRepository(cwd: string, signal?: AbortSignal | undefined): Promise<string | null> {
	try {
		const result = await runGit(cwd, ["config", "--get", "remote.origin.url"], signal);
		return parseGithubRepository(result.stdout);
	} catch {
		return null;
	}
}

function parseGithubCommits(value: unknown): WorkspaceGitCommit[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item: unknown): WorkspaceGitCommit[] => {
		if (typeof item !== "object" || item === null) return [];
		const commit: GithubCompareCommit = item as GithubCompareCommit;
		if (typeof commit.sha !== "string" || typeof commit.commit?.message !== "string") return [];
		return [{
			hash: commit.sha,
			shortHash: commit.sha.slice(0, 7),
			authorDate: typeof commit.commit.author?.date === "string" ? commit.commit.author.date : "",
			subject: commit.commit.message.split(/\r?\n/u, 1)[0] ?? ""
		}];
	});
}

async function readGithubHistory(
	repository: string,
	fromRef: string,
	toRef: string,
	limit: number,
	signal?: AbortSignal | undefined
): Promise<WorkspaceGitHistoryResult | null> {
	const endpoint = `https://api.github.com/repos/${repository}/compare/${encodeURIComponent(fromRef)}...${encodeURIComponent(toRef)}`;
	const pageSize: number = Math.min(limit, 100);
	const commits: WorkspaceGitCommit[] = [];
	let totalCommits: number | null = null;
	const maxPages: number = Math.ceil(limit / pageSize);
	for (let page: number = 1; page <= maxPages && commits.length < limit; page += 1) {
		let response: Response;
		try {
			response = await fetch(`${endpoint}?per_page=${pageSize}&page=${page}`, {
				headers: { Accept: "application/vnd.github+json", "User-Agent": "Daedalus-Studio" },
				signal: signal ?? null
			});
		} catch {
			return null;
		}
		if (!response.ok) return null;
		let payload: GithubCompareResponse;
		try {
			payload = await response.json() as GithubCompareResponse;
		} catch {
			return null;
		}
		if (totalCommits === null && typeof payload.total_commits === "number" && Number.isFinite(payload.total_commits)) {
			totalCommits = payload.total_commits;
		}
		const pageCommits: WorkspaceGitCommit[] = parseGithubCommits(payload.commits);
		commits.push(...pageCommits);
		if (pageCommits.length < pageSize) break;
	}
	return {
		ok: true,
		status: "history",
		source: "github_remote",
		fromRef,
		toRef,
		commits: commits.slice(0, limit),
		truncated: (totalCommits ?? commits.length) > Math.min(commits.length, limit)
	};
}

export async function readWorkspaceGitHistory(input: {
	cwd: string;
	fromRef: string;
	toRef?: string | undefined;
	limit?: number | undefined;
	signal?: AbortSignal | undefined;
}): Promise<WorkspaceGitHistoryResult> {
	const fromRef: string = assertSafeGitRef(input.fromRef, "fromRef");
	const toRef: string = assertSafeGitRef(input.toRef ?? "HEAD", "toRef");
	const limit: number = Math.max(1, Math.min(Math.floor(input.limit ?? 80), MAX_GIT_HISTORY_COMMITS));

	try {
		const repositoryCheck = await runGit(input.cwd, ["rev-parse", "--is-inside-work-tree"], input.signal);
		if (repositoryCheck.stdout.trim() !== "true") {
			return {
				ok: false,
				status: "history",
				source: "unavailable",
				fromRef,
				toRef,
				commits: [],
				truncated: false,
				code: "git_repository_missing",
				message: "The selected source folder is not inside a Git working tree."
			};
		}
	} catch {
		return {
			ok: false,
			status: "history",
			source: "unavailable",
			fromRef,
			toRef,
			commits: [],
			truncated: false,
			code: "git_repository_missing",
			message: "The selected source folder is not inside a Git working tree."
		};
	}

	const [fromRefExists, toRefExists] = await Promise.all([
		resolvesToCommit(input.cwd, fromRef, input.signal),
		resolvesToCommit(input.cwd, toRef, input.signal)
	]);
	if (!fromRefExists || !toRefExists) {
		const missingRefs: ("fromRef" | "toRef")[] = [
			...(!fromRefExists ? ["fromRef" as const] : []),
			...(!toRefExists ? ["toRef" as const] : [])
		];
		const githubRepository: string | null = await getGithubRepository(input.cwd, input.signal);
		const remoteToRef: string = toRefExists
			? (await resolveCommitHash(input.cwd, toRef, input.signal) ?? toRef)
			: toRef;
		const remoteHistory: WorkspaceGitHistoryResult | null = githubRepository === null
			? null
			: await readGithubHistory(githubRepository, fromRef, remoteToRef, limit, input.signal);
		if (remoteHistory !== null) {
			return remoteHistory;
		}
		return {
			// This is an answerable workspace fact. A failed result made agents retry
			// arbitrary tag spellings until their tool budget expired.
			ok: true,
			status: "reference_unavailable",
			source: "unavailable",
			fromRef,
			toRef,
			commits: [],
			truncated: false,
			missingRefs,
			availableRefs: await readAvailableRefs(input.cwd, input.signal),
			code: "git_ref_missing",
			message: `Git could not resolve ${missingRefs.includes("fromRef") ? fromRef : toRef} to a commit. Do not guess another ref or inspect .git files. Report the unavailable baseline and the returned available refs.`
		};
	}

	try {
		const result = await runGit(
			input.cwd,
			["log", `--max-count=${limit + 1}`, "--format=%H%x1f%h%x1f%aI%x1f%s%x1e", `${fromRef}..${toRef}`],
			input.signal
		);
		const commits: WorkspaceGitCommit[] = parseCommits(result.stdout);
		return {
			ok: true,
			status: "history",
			source: "local",
			fromRef,
			toRef,
			commits: commits.slice(0, limit),
			truncated: commits.length > limit
		};
	} catch (error: unknown) {
		return {
			ok: false,
			status: "history",
			source: "unavailable",
			fromRef,
			toRef,
			commits: [],
			truncated: false,
			code: "git_command_failed",
			message: error instanceof Error ? error.message : "Git history query failed."
		};
	}
}
