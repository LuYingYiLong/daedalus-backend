import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, cp, open, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { getGodotDocumentationRoot } from "../app-paths.js";
import { logger } from "../logger.js";
import { hasActiveSessionRuns } from "../server/client-connections.js";
import type { DocumentationIndexSummary } from "./indexer.js";
import { buildDocumentationIndexInProcess, deepCheckDocumentationInProcess } from "./indexer-client.js";
import {
	checkDocumentationRecordFast,
	listRollbackGenerationIds,
	sha256File
} from "./health.js";
import {
	compareDocumentationBranches,
	createGodotDocumentationId,
	createGodotDocumentationState,
	getGodotDocumentationBranchCachePath,
	getGodotDocumentationGenerationDir,
	getGodotDocumentationIndexPath,
	getGodotDocumentationPackageDir,
	getGodotDocumentationSnapshot,
	getGodotDocumentationStagingRoot,
	getGodotDocumentationTrashRoot,
	initializeGodotDocumentationStore,
	updateGodotDocumentationSettings
} from "./store.js";
import {
	cacheGodotDocumentationArchive,
	cacheGodotDocumentationTree,
	cleanupGodotDocumentationSourceStaging,
	getGodotDocumentationCachedSourcePath,
	hasGodotDocumentationSource,
	pruneGodotDocumentationSourceCache,
	touchGodotDocumentationSource
} from "./source-cache.js";
import type {
	GodotDocumentationBranch,
	GodotDocumentationGenerationManifest,
	GodotDocumentationJob,
	GodotDocumentationRecord,
	GodotDocumentationSourceRef,
	GodotDocumentationState
} from "./types.js";

const GITHUB_API_ORIGIN: string = "https://api.github.com";
const GITHUB_REPOSITORY: string = "godotengine/godot-docs";
const BRANCH_CACHE_TTL_MS: number = 15 * 60 * 1000;
const MAX_DOWNLOAD_BYTES: number = 512 * 1024 * 1024;
const MAX_EXTRACTED_BYTES: number = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: number = 50_000;
const MAX_REDIRECTS: number = 5;
const DOWNLOAD_TIMEOUT_MS: number = 10 * 60 * 1000;
const MAX_NETWORK_RETRIES: number = 2;
const DEEP_HEALTH_CHECK_INTERVAL_MS: number = 24 * 60 * 60 * 1000;
const INITIAL_MAINTENANCE_DELAY_MS: number = 15_000;

type BranchCache = {
	schemaVersion: 1;
	etag: string | null;
	fetchedAt: string;
	branches: Array<{ name: string; commitSha: string }>;
};

type BranchListResult = {
	branches: GodotDocumentationBranch[];
	recommendedBranch: string | null;
	stale: boolean;
	error?: string | undefined;
};

type ActiveJobRuntime = {
	snapshot: GodotDocumentationJob;
	controller: AbortController;
	localSourcePath: string | null;
	allowNetwork: boolean;
	deepCheck: boolean;
	background: boolean;
};

let activeJob: ActiveJobRuntime | null = null;
const completedJobs: Map<string, GodotDocumentationJob> = new Map();
let maintenanceTimer: NodeJS.Timeout | null = null;

function cloneJob(job: GodotDocumentationJob): GodotDocumentationJob {
	return structuredClone(job);
}

function setJobProgress(
	runtime: ActiveJobRuntime,
	stage: GodotDocumentationJob["stage"],
	progress: number | null,
	message: string
): void {
	runtime.snapshot.stage = stage;
	runtime.snapshot.progress = progress === null ? null : Math.max(0, Math.min(100, Math.round(progress)));
	runtime.snapshot.message = message;
	runtime.snapshot.updatedAt = new Date().toISOString();
}

function finishJob(runtime: ActiveJobRuntime, stage: "completed" | "failed" | "cancelled", error: string | null): void {
	runtime.snapshot.stage = stage;
	runtime.snapshot.progress = stage === "completed" ? 100 : runtime.snapshot.progress;
	runtime.snapshot.error = error;
	runtime.snapshot.message = stage === "completed"
		? runtime.snapshot.unchanged ? "Documentation is already up to date." : "Documentation is ready."
		: stage === "cancelled" ? "Documentation operation cancelled." : "Documentation operation failed.";
	runtime.snapshot.updatedAt = new Date().toISOString();
	runtime.snapshot.completedAt = runtime.snapshot.updatedAt;
	completedJobs.set(runtime.snapshot.jobId, cloneJob(runtime.snapshot));
	while (completedJobs.size > 20) {
		const firstKey: string | undefined = completedJobs.keys().next().value;
		if (firstKey === undefined) {
			break;
		}
		completedJobs.delete(firstKey);
	}
	if (activeJob?.snapshot.jobId === runtime.snapshot.jobId) {
		activeJob = null;
	}
}

function assertOfficialBranchName(branch: string): string {
	const normalizedBranch: string = branch.trim();
	if (
		normalizedBranch.length === 0
		|| normalizedBranch.length > 120
		|| /[\u0000-\u001f\u007f\s\\]/u.test(normalizedBranch)
		|| normalizedBranch.startsWith("/")
		|| normalizedBranch.endsWith("/")
		|| normalizedBranch.includes("..")
		|| normalizedBranch.includes("@{")
		|| normalizedBranch.endsWith(".lock")
	) {
		throw new Error("Invalid godot-docs branch name.");
	}
	return normalizedBranch;
}

function assertCommitSha(value: unknown): string {
	if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) {
		throw new Error("GitHub returned an invalid godot-docs commit.");
	}
	return value;
}

async function readBranchCache(): Promise<BranchCache | null> {
	try {
		const value: unknown = JSON.parse(await readFile(getGodotDocumentationBranchCachePath(), "utf8")) as unknown;
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			return null;
		}
		const candidate = value as Partial<BranchCache>;
		if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.branches) || typeof candidate.fetchedAt !== "string") {
			return null;
		}
		const branches: BranchCache["branches"] = candidate.branches.flatMap((branch): BranchCache["branches"] => {
			if (
				branch === null
				|| typeof branch !== "object"
				|| typeof branch.name !== "string"
				|| typeof branch.commitSha !== "string"
				|| !/^[0-9a-f]{40}$/u.test(branch.commitSha)
			) {
				return [];
			}
			return [{ name: branch.name, commitSha: branch.commitSha }];
		});
		return {
			schemaVersion: 1,
			etag: typeof candidate.etag === "string" ? candidate.etag : null,
			fetchedAt: candidate.fetchedAt,
			branches
		};
	} catch {
		return null;
	}
}

async function writeBranchCache(cache: BranchCache): Promise<void> {
	await mkdir(dirname(getGodotDocumentationBranchCachePath()), { recursive: true });
	await writeFile(getGodotDocumentationBranchCachePath(), `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

function isAllowedRemoteUrl(url: URL): boolean {
	return url.protocol === "https:" && (
		url.hostname === "api.github.com"
		|| url.hostname === "github.com"
		|| url.hostname === "codeload.github.com"
	);
}

function describeNetworkError(error: unknown): string {
	const parts: string[] = [];
	let current: unknown = error;
	for (let depth: number = 0; depth < 3 && current instanceof Error; depth += 1) {
		const code: unknown = (current as Error & { code?: unknown }).code;
		const description: string = typeof code === "string"
			? `${code}: ${current.message}`
			: current.message;
		if (description.length > 0 && !parts.includes(description)) {
			parts.push(description);
		}
		current = current.cause;
	}
	return parts.join(" <- ") || String(error);
}

function isRetryableNetworkError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	const code: unknown = (error as Error & { code?: unknown }).code;
	if (
		typeof code === "string"
		&& [
			"ECONNRESET",
			"ECONNREFUSED",
			"ENETDOWN",
			"ENETUNREACH",
			"EHOSTUNREACH",
			"ETIMEDOUT",
			"EAI_AGAIN",
			"UND_ERR_CONNECT_TIMEOUT",
			"UND_ERR_HEADERS_TIMEOUT",
			"UND_ERR_BODY_TIMEOUT",
			"UND_ERR_SOCKET"
		].includes(code)
	) {
		return true;
	}
	if (
		error.name === "TimeoutError"
		|| error.message === "fetch failed"
		|| error.message === "terminated"
	) {
		return true;
	}
	return error.cause !== undefined && isRetryableNetworkError(error.cause);
}

async function waitForNetworkRetry(attempt: number, signal: AbortSignal, retryAfterMs?: number): Promise<void> {
	const delayMs: number = Math.max(250, Math.min(15_000, retryAfterMs ?? 1_000 * (2 ** attempt)));
	await new Promise<void>((resolvePromise, rejectPromise): void => {
		const timer = setTimeout((): void => {
			signal.removeEventListener("abort", handleAbort);
			resolvePromise();
		}, delayMs);
		const handleAbort = (): void => {
			clearTimeout(timer);
			signal.removeEventListener("abort", handleAbort);
			rejectPromise(new Error("Documentation import cancelled."));
		};
		if (signal.aborted) {
			handleAbort();
			return;
		}
		signal.addEventListener("abort", handleAbort, { once: true });
	});
}

function getRetryAfterMs(response: Response): number | undefined {
	const value: string | null = response.headers.get("retry-after");
	if (value === null) {
		return undefined;
	}
	const seconds: number = Number.parseFloat(value);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return seconds * 1000;
	}
	const date: number = Date.parse(value);
	return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

async function fetchOfficial(
	url: string,
	init: RequestInit,
	signal: AbortSignal,
	redirectCount: number = 0,
	attempt: number = 0,
	retryNetwork: boolean = true
): Promise<Response> {
	const parsedUrl: URL = new URL(url);
	if (!isAllowedRemoteUrl(parsedUrl)) {
		throw new Error(`Documentation download was redirected to a disallowed host: ${parsedUrl.hostname}`);
	}
	let response: Response;
	try {
		response = await fetch(parsedUrl, {
			...init,
			redirect: "manual",
			signal: AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)])
		});
	} catch (error: unknown) {
		if (retryNetwork && !signal.aborted && attempt < MAX_NETWORK_RETRIES && isRetryableNetworkError(error)) {
			await waitForNetworkRetry(attempt, signal);
			return fetchOfficial(url, init, signal, redirectCount, attempt + 1, retryNetwork);
		}
		throw new Error(`Official Godot documentation request failed: ${describeNetworkError(error)}`, {
			cause: error
		});
	}
	if (response.status >= 300 && response.status < 400) {
		if (redirectCount >= MAX_REDIRECTS) {
			throw new Error("Too many redirects while downloading godot-docs.");
		}
		const location: string | null = response.headers.get("location");
		if (location === null) {
			throw new Error("Godot documentation redirect did not include a destination.");
		}
		return fetchOfficial(
			new URL(location, parsedUrl).toString(),
			init,
			signal,
			redirectCount + 1,
			0,
			retryNetwork
		);
	}
	if (
		retryNetwork
		&&
		(response.status === 429 || response.status === 500 || response.status === 502 || response.status === 503 || response.status === 504)
		&& attempt < MAX_NETWORK_RETRIES
	) {
		const retryAfterMs: number | undefined = getRetryAfterMs(response);
		await response.body?.cancel().catch((): void => undefined);
		await waitForNetworkRetry(attempt, signal, retryAfterMs);
		return fetchOfficial(url, init, signal, redirectCount, attempt + 1, retryNetwork);
	}
	return response;
}

async function resolveBranch(branch: string, signal: AbortSignal): Promise<{ name: string; commitSha: string }> {
	const normalizedBranch: string = assertOfficialBranchName(branch);
	const response: Response = await fetchOfficial(
		`${GITHUB_API_ORIGIN}/repos/${GITHUB_REPOSITORY}/branches/${encodeURIComponent(normalizedBranch)}`,
		{
			headers: {
				Accept: "application/vnd.github+json",
				"User-Agent": "Daedalus-Studio"
			}
		},
		signal
	);
	if (!response.ok) {
		throw new Error(response.status === 404
			? `godot-docs branch does not exist: ${normalizedBranch}`
			: `Failed to resolve godot-docs branch (${response.status}).`);
	}
	const value: unknown = await response.json();
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("GitHub returned an invalid branch response.");
	}
	const record = value as { name?: unknown; commit?: { sha?: unknown } };
	return {
		name: typeof record.name === "string" ? record.name : normalizedBranch,
		commitSha: assertCommitSha(record.commit?.sha)
	};
}

async function fetchBranchPages(signal: AbortSignal, etag: string | null): Promise<{ cache: BranchCache | null; notModified: boolean }> {
	const branches: BranchCache["branches"] = [];
	let nextEtag: string | null = null;
	for (let page: number = 1; page <= 5; page += 1) {
		const headers: Record<string, string> = {
			Accept: "application/vnd.github+json",
			"User-Agent": "Daedalus-Studio"
		};
		if (page === 1 && etag !== null) {
			headers["If-None-Match"] = etag;
		}
		const response: Response = await fetchOfficial(
			`${GITHUB_API_ORIGIN}/repos/${GITHUB_REPOSITORY}/branches?per_page=100&page=${page}`,
			{ headers },
			signal
		);
		if (page === 1 && response.status === 304) {
			return { cache: null, notModified: true };
		}
		if (!response.ok) {
			throw new Error(`Failed to list godot-docs branches (${response.status}).`);
		}
		nextEtag ??= response.headers.get("etag");
		const value: unknown = await response.json();
		if (!Array.isArray(value)) {
			throw new Error("GitHub returned an invalid branch list.");
		}
		for (const item of value) {
			if (
				item !== null
				&& typeof item === "object"
				&& typeof item.name === "string"
				&& (item.name === "master" || /^\d+\.\d+$/u.test(item.name))
			) {
				branches.push({
					name: item.name,
					commitSha: assertCommitSha((item as { commit?: { sha?: unknown } }).commit?.sha)
				});
			}
		}
		if (value.length < 100) {
			break;
		}
	}
	branches.sort((left, right): number => compareDocumentationBranches(right.name, left.name));
	return {
		notModified: false,
		cache: {
			schemaVersion: 1,
			etag: nextEtag,
			fetchedAt: new Date().toISOString(),
			branches
		}
	};
}

function mapBranchList(cache: BranchCache, stale: boolean, error?: string): BranchListResult {
	const installedBranches: Set<string> = new Set(
		Object.values(getGodotDocumentationSnapshot().documents).map((record: GodotDocumentationRecord): string => record.branch)
	);
	return {
		branches: cache.branches.map((branch): GodotDocumentationBranch => ({
			...branch,
			installed: installedBranches.has(branch.name)
		})),
		recommendedBranch: cache.branches.find((branch): boolean => /^\d+\.\d+$/u.test(branch.name))?.name
			?? cache.branches[0]?.name
			?? null,
		stale,
		...(error === undefined ? {} : { error })
	};
}

export async function listGodotDocumentationBranches(refresh: boolean = false): Promise<BranchListResult> {
	const cached: BranchCache | null = await readBranchCache();
	const cacheAge: number = cached === null ? Number.POSITIVE_INFINITY : Date.now() - Date.parse(cached.fetchedAt);
	if (!refresh && cached !== null && Number.isFinite(cacheAge) && cacheAge < BRANCH_CACHE_TTL_MS) {
		return mapBranchList(cached, false);
	}
	const controller: AbortController = new AbortController();
	try {
		const fetched = await fetchBranchPages(controller.signal, cached?.etag ?? null);
		if (fetched.notModified && cached !== null) {
			const nextCache: BranchCache = { ...cached, fetchedAt: new Date().toISOString() };
			await writeBranchCache(nextCache);
			return mapBranchList(nextCache, false);
		}
		if (fetched.cache === null) {
			throw new Error("GitHub did not return a branch list.");
		}
		await writeBranchCache(fetched.cache);
		return mapBranchList(fetched.cache, false);
	} catch (error: unknown) {
		if (cached !== null) {
			return mapBranchList(cached, true, error instanceof Error ? error.message : "Failed to refresh branches.");
		}
		throw error;
	}
}

async function downloadArchiveAttempt(commitSha: string, destination: string, runtime: ActiveJobRuntime): Promise<void> {
	const response: Response = await fetchOfficial(
		`https://codeload.github.com/godotengine/godot-docs/zip/${commitSha}`,
		{ headers: { "User-Agent": "Daedalus-Studio" } },
		runtime.controller.signal,
		0,
		0,
		false
	);
	if (!response.ok || response.body === null) {
		throw new Error(`Failed to download godot-docs (${response.status}).`);
	}
	const contentLength: number = Number.parseInt(response.headers.get("content-length") ?? "", 10);
	if (Number.isFinite(contentLength) && contentLength > MAX_DOWNLOAD_BYTES) {
		throw new Error(
			`Godot documentation archive is ${Math.ceil(contentLength / 1024 / 1024)} MiB; `
			+ `the safety limit is ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MiB.`
		);
	}
	const file = await open(destination, "w");
	let received: number = 0;
	const reader = response.body.getReader();
	try {
		for (;;) {
			if (runtime.controller.signal.aborted) {
				throw new Error("Documentation import cancelled.");
			}
			const part = await reader.read();
			if (part.done) {
				break;
			}
			received += part.value.byteLength;
			if (received > MAX_DOWNLOAD_BYTES) {
				throw new Error(
					`Godot documentation archive exceeded the ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MiB safety limit.`
				);
			}
			await file.write(part.value);
			setJobProgress(
				runtime,
				"downloading",
				Number.isFinite(contentLength) && contentLength > 0 ? (received / contentLength) * 35 : null,
				"Downloading godot-docs..."
			);
		}
	} finally {
		await reader.cancel().catch((): void => undefined);
		await file.close();
	}
}

async function downloadArchive(commitSha: string, destination: string, runtime: ActiveJobRuntime): Promise<void> {
	let lastError: unknown = null;
	for (let attempt: number = 0; attempt <= MAX_NETWORK_RETRIES; attempt += 1) {
		try {
			await downloadArchiveAttempt(commitSha, destination, runtime);
			return;
		} catch (error: unknown) {
			lastError = error;
			if (
				runtime.controller.signal.aborted
				|| attempt >= MAX_NETWORK_RETRIES
				|| !isRetryableNetworkError(error)
			) {
				break;
			}
			setJobProgress(
				runtime,
				"downloading",
				null,
				`Download interrupted; retrying (${attempt + 2}/${MAX_NETWORK_RETRIES + 1})...`
			);
			await waitForNetworkRetry(attempt, runtime.controller.signal);
		}
	}
	if (runtime.controller.signal.aborted) {
		throw new Error("Documentation import cancelled.");
	}
	throw new Error(
		`Failed to download official Godot documentation after ${MAX_NETWORK_RETRIES + 1} attempts: `
		+ describeNetworkError(lastError),
		{ cause: lastError }
	);
}

async function runProcess(
	command: string,
	args: string[],
	signal: AbortSignal,
	additionalEnv: Readonly<Record<string, string>> = {}
): Promise<string> {
	return new Promise<string>((resolvePromise, rejectPromise): void => {
		const child = spawn(command, args, {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			signal,
			env: {
				...process.env,
				...additionalEnv
			}
		});
		let stdout: string = "";
		let stderr: string = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string): void => {
			stdout = `${stdout}${chunk}`.slice(-2_000_000);
		});
		child.stderr.on("data", (chunk: string): void => {
			stderr = `${stderr}${chunk}`.slice(-20_000);
		});
		child.once("error", rejectPromise);
		child.once("close", (code: number | null): void => {
			if (code === 0) {
				resolvePromise(stdout);
				return;
			}
			rejectPromise(new Error((stderr.trim() || stdout.trim() || `Archive process exited with ${code}`).slice(0, 2000)));
		});
	});
}

export async function inspectGodotDocumentationArchive(zipPath: string): Promise<void> {
	const archive = await open(zipPath, "r");
	try {
		const archiveStats = await archive.stat();
		if (archiveStats.size < 22 || archiveStats.size > MAX_DOWNLOAD_BYTES) {
			throw new Error("Godot documentation archive has an invalid size.");
		}
		const tailLength: number = Math.min(65_557, archiveStats.size);
		const tailStart: number = archiveStats.size - tailLength;
		const tail: Buffer = Buffer.allocUnsafe(tailLength);
		const tailRead = await archive.read(tail, 0, tailLength, tailStart);
		if (tailRead.bytesRead !== tailLength) {
			throw new Error("Godot documentation archive could not be read completely.");
		}
		let endOffsetInTail: number = -1;
		for (let offset: number = tail.length - 22; offset >= 0; offset -= 1) {
			if (
				tail.readUInt32LE(offset) === 0x06054b50
				&& offset + 22 + tail.readUInt16LE(offset + 20) === tail.length
			) {
				endOffsetInTail = offset;
				break;
			}
		}
		if (endOffsetInTail < 0) {
			throw new Error("Godot documentation archive has no valid ZIP directory.");
		}
		const endOffset: number = tailStart + endOffsetInTail;
		const entryCount: number = tail.readUInt16LE(endOffsetInTail + 10);
		const centralDirectorySize: number = tail.readUInt32LE(endOffsetInTail + 12);
		const centralDirectoryOffset: number = tail.readUInt32LE(endOffsetInTail + 16);
		if (
			entryCount === 0
			|| entryCount === 0xffff
			|| entryCount > MAX_ARCHIVE_ENTRIES
			|| centralDirectorySize === 0xffffffff
			|| centralDirectoryOffset === 0xffffffff
			|| centralDirectorySize > 64 * 1024 * 1024
			|| centralDirectoryOffset + centralDirectorySize > endOffset
		) {
			throw new Error("Godot documentation archive has an invalid ZIP directory.");
		}

		const centralDirectory: Buffer = Buffer.allocUnsafe(centralDirectorySize);
		const directoryRead = await archive.read(
			centralDirectory,
			0,
			centralDirectorySize,
			centralDirectoryOffset
		);
		if (directoryRead.bytesRead !== centralDirectorySize) {
			throw new Error("Godot documentation ZIP directory could not be read completely.");
		}
		let cursor: number = 0;
		let totalUncompressedBytes: number = 0;
		for (let index: number = 0; index < entryCount; index += 1) {
			if (
				cursor + 46 > centralDirectory.length
				|| centralDirectory.readUInt32LE(cursor) !== 0x02014b50
			) {
				throw new Error("Godot documentation archive contains an invalid ZIP entry.");
			}
			const flags: number = centralDirectory.readUInt16LE(cursor + 8);
			const uncompressedSize: number = centralDirectory.readUInt32LE(cursor + 24);
			const fileNameLength: number = centralDirectory.readUInt16LE(cursor + 28);
			const extraLength: number = centralDirectory.readUInt16LE(cursor + 30);
			const commentLength: number = centralDirectory.readUInt16LE(cursor + 32);
			const externalAttributes: number = centralDirectory.readUInt32LE(cursor + 38);
			const nextCursor: number = cursor + 46 + fileNameLength + extraLength + commentLength;
			if (
				(flags & 0x1) !== 0
				|| uncompressedSize === 0xffffffff
				|| fileNameLength === 0
				|| nextCursor > centralDirectory.length
			) {
				throw new Error("Godot documentation archive uses an unsupported ZIP entry.");
			}
			const entry: string = centralDirectory
				.subarray(cursor + 46, cursor + 46 + fileNameLength)
				.toString("utf8");
			const normalizedEntry: string = entry.replaceAll("\\", "/");
			const unixMode: number = externalAttributes >>> 16;
			if (
				/[\u0000-\u001f\u007f]/u.test(normalizedEntry)
				|| normalizedEntry.startsWith("/")
				|| /^[A-Za-z]:/u.test(normalizedEntry)
				|| normalizedEntry.split("/").some((part: string): boolean => part === "..")
				|| (unixMode & 0o170000) === 0o120000
			) {
				throw new Error(`Unsafe path or symbolic link in documentation archive: ${entry}`);
			}
			totalUncompressedBytes += uncompressedSize;
			if (totalUncompressedBytes > MAX_EXTRACTED_BYTES) {
				throw new Error("Godot documentation archive exceeds the uncompressed size limit.");
			}
			cursor = nextCursor;
		}
		if (cursor > centralDirectory.length) {
			throw new Error("Godot documentation archive has an inconsistent ZIP directory.");
		}
	} finally {
		await archive.close();
	}
}

export async function extractGodotDocumentationArchive(
	zipPath: string,
	destination: string,
	signal: AbortSignal
): Promise<void> {
	await inspectGodotDocumentationArchive(zipPath);
	await mkdir(destination, { recursive: true });
	if (process.platform === "win32") {
		// Expand-Archive can report success while extracting no files from the
		// large godot-docs archive. Windows bsdtar handles the same ZIP reliably.
		await runProcess("tar.exe", ["-xf", zipPath, "-C", destination], signal);
	} else {
		await runProcess("unzip", ["-q", zipPath, "-d", destination], signal);
	}
	await validateExtractedTree(destination, signal);
}

async function extractArchive(zipPath: string, destination: string, runtime: ActiveJobRuntime): Promise<void> {
	setJobProgress(runtime, "extracting", 40, "Extracting godot-docs...");
	await extractGodotDocumentationArchive(zipPath, destination, runtime.controller.signal);
}

async function validateExtractedTree(root: string, signal: AbortSignal): Promise<void> {
	const queue: string[] = [root];
	let entryCount: number = 0;
	let totalBytes: number = 0;
	while (queue.length > 0) {
		if (signal.aborted) {
			throw new Error("Documentation import cancelled.");
		}
		const current: string = queue.shift()!;
		const entries: Dirent[] = await readdir(current, { withFileTypes: true });
		for (const entry of entries) {
			entryCount += 1;
			if (entryCount > MAX_ARCHIVE_ENTRIES) {
				throw new Error("Extracted documentation contains too many entries.");
			}
			const candidate: string = resolve(current, entry.name);
			const relativePath: string = relative(root, candidate);
			if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
				throw new Error("Extracted documentation escaped its staging directory.");
			}
			const stats = await stat(candidate);
			if (entry.isSymbolicLink() || stats.isSymbolicLink()) {
				throw new Error(`Symbolic links are not allowed in documentation archives: ${relativePath}`);
			}
			if (stats.isDirectory()) {
				queue.push(candidate);
			} else if (stats.isFile()) {
				totalBytes += stats.size;
				if (totalBytes > MAX_EXTRACTED_BYTES) {
					throw new Error("Extracted documentation exceeds the size limit.");
				}
			}
		}
	}
	if (entryCount === 0) {
		throw new Error("Godot documentation archive extraction produced no files.");
	}
}

async function hashLocalDocumentationTree(root: string, signal: AbortSignal): Promise<string> {
	const hash = createHash("sha1");
	const queue: string[] = [root];
	while (queue.length > 0) {
		if (signal.aborted) {
			throw new Error("Documentation import cancelled.");
		}
		const current: string = queue.shift()!;
		const entries: Dirent[] = (await readdir(current, { withFileTypes: true }))
			.sort((left: Dirent, right: Dirent): number => left.name.localeCompare(right.name));
		for (const entry of entries) {
			const candidate: string = join(current, entry.name);
			if (entry.isDirectory()) {
				queue.push(candidate);
				continue;
			}
			if (!entry.isFile() || (entry.name !== "conf.py" && !entry.name.endsWith(".rst"))) {
				continue;
			}
			hash.update(relative(root, candidate).replaceAll("\\", "/"));
			hash.update("\0");
			hash.update(await readFile(candidate));
			hash.update("\0");
		}
	}
	return hash.digest("hex");
}

function isPathInside(root: string, candidate: string): boolean {
	const relativePath: string = relative(root, candidate);
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

async function prepareLocalDocumentationSource(runtime: ActiveJobRuntime, stagingRoot: string): Promise<{
	extractedRoot: string;
	sourcePath: string;
	commitSha: string;
	sourceRef: GodotDocumentationSourceRef;
}> {
	if (runtime.localSourcePath === null || !isAbsolute(runtime.localSourcePath)) {
		throw new Error("Local documentation source must be an absolute path.");
	}
	setJobProgress(runtime, "resolving", 0, "Inspecting local Godot documentation...");
	const sourcePath: string = await realpath(runtime.localSourcePath);
	const documentationRoot: string = resolve(getGodotDocumentationRoot());
	if (isPathInside(documentationRoot, sourcePath)) {
		throw new Error("Local documentation source cannot be inside Daedalus documentation storage.");
	}
	const sourceStats = await stat(sourcePath);
	const extractedRoot: string = join(stagingRoot, "source");
	let sourceRef: GodotDocumentationSourceRef;
	if (sourceStats.isFile()) {
		if (!sourcePath.toLowerCase().endsWith(".zip")) {
			throw new Error("Local documentation source must be a godot-docs folder or ZIP archive.");
		}
		const archivePath: string = join(stagingRoot, "godot-docs.zip");
		await copyFile(sourcePath, archivePath);
		sourceRef = await cacheGodotDocumentationArchive(archivePath, "local_zip");
		await extractArchive(archivePath, extractedRoot, runtime);
	} else if (sourceStats.isDirectory()) {
		setJobProgress(runtime, "extracting", 15, "Copying local Godot documentation...");
		await validateExtractedTree(sourcePath, runtime.controller.signal);
		await cp(sourcePath, extractedRoot, {
			recursive: true,
			dereference: false,
			force: false,
			errorOnExist: true
		});
		await validateExtractedTree(extractedRoot, runtime.controller.signal);
		sourceRef = await cacheGodotDocumentationTree(extractedRoot);
	} else {
		throw new Error("Local documentation source must be a folder or ZIP archive.");
	}
	return {
		extractedRoot,
		sourcePath,
		commitSha: await hashLocalDocumentationTree(extractedRoot, runtime.controller.signal),
		sourceRef
	};
}

async function persistAttribution(
	generationDir: string,
	branch: string,
	commitSha: string,
	source: "official" | "local",
	sourcePath?: string
): Promise<void> {
	await writeFile(join(generationDir, "attribution.json"), `${JSON.stringify({
		source: source === "official" ? `https://github.com/${GITHUB_REPOSITORY}/tree/${commitSha}` : "local",
		...(sourcePath === undefined ? {} : { sourcePath }),
		branch,
		commitSha,
		manualLicense: "CC BY 3.0",
		classReferenceLicense: "MIT",
		licenseUrl: source === "official"
			? `https://github.com/${GITHUB_REPOSITORY}/blob/${commitSha}/LICENSE.txt`
			: `https://github.com/${GITHUB_REPOSITORY}/blob/master/LICENSE.txt`
	}, null, 2)}\n`, "utf8");
}

async function buildAndActivateDocumentation(params: {
	runtime: ActiveJobRuntime;
	stagingRoot: string;
	extractedRoot: string;
	branch: string;
	commitSha: string;
	currentRecord: GodotDocumentationRecord | undefined;
	source: "official" | "local";
	sourcePath?: string | undefined;
	sourceRef: GodotDocumentationSourceRef;
}): Promise<void> {
	const documentId: string = params.currentRecord?.id ?? createGodotDocumentationId(params.branch);
	const generationId: string = `${params.commitSha}-${randomUUID().slice(0, 12)}`;
	const generationDir: string = join(params.stagingRoot, generationId);
	const indexPath: string = join(generationDir, "index.sqlite");
	await mkdir(generationDir, { recursive: true });
	setJobProgress(params.runtime, "indexing", 45, "Indexing Godot documentation...");
	const summary: DocumentationIndexSummary = await buildDocumentationIndexInProcess({
		extractedRoot: params.extractedRoot,
		indexPath,
		branch: params.branch,
		commitSha: params.commitSha,
		signal: params.runtime.controller.signal,
		onProgress(progress: number): void {
			setJobProgress(params.runtime, "indexing", 45 + progress * 50, "Indexing Godot documentation...");
		}
	});
	await persistAttribution(
		generationDir,
		params.branch,
		params.commitSha,
		params.source,
		params.sourcePath
	);
	const builtAt: string = new Date().toISOString();
	const manifest: GodotDocumentationGenerationManifest = {
		schemaVersion: 1,
		indexFormatVersion: 1,
		generationId,
		branch: params.branch,
		commitSha: params.commitSha,
		sourceSha256: params.sourceRef.sha256,
		sqliteSha256: await sha256File(indexPath),
		...summary,
		builtAt,
		verifiedAt: builtAt
	};
	await writeFile(join(generationDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	setJobProgress(params.runtime, "validating", 96, "Validating the documentation index...");
	await deepCheckDocumentationInProcess({
		generationDir,
		branch: params.branch,
		commitSha: params.commitSha,
		signal: params.runtime.controller.signal
	});

	setJobProgress(params.runtime, "finalizing", 97, "Activating the documentation index...");
	const targetGenerationDir: string = join(getGodotDocumentationPackageDir(documentId), generationId);
	await mkdir(dirname(targetGenerationDir), { recursive: true });
	await rename(generationDir, targetGenerationDir);
	const now: string = new Date().toISOString();
	const nextRecord: GodotDocumentationRecord = {
		id: documentId,
		branch: params.branch,
		commitSha: params.commitSha,
		source: params.source,
		...(params.sourcePath === undefined ? {} : { sourcePath: params.sourcePath }),
		sourceRef: params.sourceRef,
		activeGenerationId: generationId,
		health: { status: "ready", code: null, message: null, checkedAt: new Date().toISOString() },
		repairAvailability: "none",
		installedAt: params.currentRecord?.installedAt ?? now,
		updatedAt: now,
		...summary
	};
	await updateGodotDocumentationSettings((draft): void => {
		draft.documents[documentId] = nextRecord;
		if (params.currentRecord === undefined && Object.keys(draft.documents).length === 1) {
			draft.enabled = true;
		}
	});
	await touchGodotDocumentationSource(params.sourceRef);
	await cleanupOrphanedGenerations();
}

async function runDocumentationJob(runtime: ActiveJobRuntime): Promise<void> {
	const stagingRoot: string = join(getGodotDocumentationStagingRoot(), runtime.snapshot.jobId);
	try {
		await mkdir(stagingRoot, { recursive: true });
		setJobProgress(runtime, "resolving", 0, "Resolving the selected godot-docs branch...");
		const resolvedBranch = await resolveBranch(runtime.snapshot.branch, runtime.controller.signal);
		runtime.snapshot.branch = resolvedBranch.name;
		const currentRecord: GodotDocumentationRecord | undefined = runtime.snapshot.documentId === null
			? undefined
			: getGodotDocumentationSnapshot().documents[runtime.snapshot.documentId];
		if (currentRecord?.commitSha === resolvedBranch.commitSha && currentRecord.health.status === "ready") {
			runtime.snapshot.unchanged = true;
			finishJob(runtime, "completed", null);
			return;
		}

		const archivePath: string = join(stagingRoot, "godot-docs.zip");
		const extractedRoot: string = join(stagingRoot, "source");
		await downloadArchive(resolvedBranch.commitSha, archivePath, runtime);
		const sourceRef: GodotDocumentationSourceRef = await cacheGodotDocumentationArchive(archivePath, "official_zip");
		await extractArchive(archivePath, extractedRoot, runtime);

		await buildAndActivateDocumentation({
			runtime,
			stagingRoot,
			extractedRoot,
			branch: resolvedBranch.name,
			commitSha: resolvedBranch.commitSha,
			currentRecord,
			source: "official",
			sourceRef
		});
		finishJob(runtime, "completed", null);
	} catch (error: unknown) {
		const cancelled: boolean = runtime.controller.signal.aborted;
		const message: string = error instanceof Error ? error.message : "Documentation operation failed.";
		logger.warn("godot_documentation", cancelled ? "job_cancelled" : "job_failed", {
			jobId: runtime.snapshot.jobId,
			branch: runtime.snapshot.branch,
			stage: runtime.snapshot.stage,
			error: message
		});
		finishJob(runtime, cancelled ? "cancelled" : "failed", cancelled ? null : message);
	} finally {
		await rm(stagingRoot, { recursive: true, force: true }).catch((): void => undefined);
	}
}

async function runLocalDocumentationJob(runtime: ActiveJobRuntime): Promise<void> {
	const stagingRoot: string = join(getGodotDocumentationStagingRoot(), runtime.snapshot.jobId);
	try {
		await mkdir(stagingRoot, { recursive: true });
		const prepared = await prepareLocalDocumentationSource(runtime, stagingRoot);
		const currentRecord: GodotDocumentationRecord | undefined = runtime.snapshot.documentId === null
			? undefined
			: getGodotDocumentationSnapshot().documents[runtime.snapshot.documentId];
		if (currentRecord?.commitSha === prepared.commitSha && currentRecord.source === "local" && currentRecord.health.status === "ready") {
			runtime.snapshot.unchanged = true;
			finishJob(runtime, "completed", null);
			return;
		}
		await buildAndActivateDocumentation({
			runtime,
			stagingRoot,
			extractedRoot: prepared.extractedRoot,
			branch: runtime.snapshot.branch,
			commitSha: prepared.commitSha,
			currentRecord,
			source: "local",
			sourcePath: prepared.sourcePath,
			sourceRef: prepared.sourceRef
		});
		finishJob(runtime, "completed", null);
	} catch (error: unknown) {
		const cancelled: boolean = runtime.controller.signal.aborted;
		const message: string = error instanceof Error ? error.message : "Documentation operation failed.";
		logger.warn("godot_documentation", cancelled ? "local_job_cancelled" : "local_job_failed", {
			jobId: runtime.snapshot.jobId,
			branch: runtime.snapshot.branch,
			stage: runtime.snapshot.stage,
			error: message
		});
		finishJob(runtime, cancelled ? "cancelled" : "failed", cancelled ? null : message);
	} finally {
		await rm(stagingRoot, { recursive: true, force: true }).catch((): void => undefined);
	}
}

async function resolveRepairAvailability(record: GodotDocumentationRecord): Promise<GodotDocumentationRecord["repairAvailability"]> {
	if ((await listRollbackGenerationIds(record)).length > 0) return "rollback";
	if (await hasGodotDocumentationSource(record.sourceRef)) return "cached_source";
	return record.source === "official" ? "network_required" : "source_required";
}

async function setDocumentHealth(
	documentId: string,
	health: GodotDocumentationRecord["health"],
	repairAvailability?: GodotDocumentationRecord["repairAvailability"] | undefined
): Promise<void> {
	await updateGodotDocumentationSettings((draft): void => {
		const record = draft.documents[documentId];
		if (record === undefined) return;
		record.health = health;
		if (repairAvailability !== undefined) record.repairAvailability = repairAvailability;
	});
}

async function runHealthCheckJob(runtime: ActiveJobRuntime): Promise<void> {
	try {
		const documentId: string = runtime.snapshot.documentId!;
		const record = getGodotDocumentationSnapshot().documents[documentId];
		if (record === undefined) throw new Error(`Unknown Godot documentation item: ${documentId}`);
		await setDocumentHealth(documentId, {
			status: "checking",
			code: null,
			message: null,
			checkedAt: record.health.checkedAt
		});
		setJobProgress(runtime, "validating", 15, "Checking the documentation index...");
		const fastHealth = await checkDocumentationRecordFast(record);
		if (fastHealth.status !== "ready") {
			throw Object.assign(new Error(fastHealth.message ?? "Documentation index check failed."), {
				code: fastHealth.code ?? "documentation_index_corrupt"
			});
		}
		if (runtime.deepCheck) {
			setJobProgress(runtime, "validating", 50, "Running a deep documentation index check...");
			await deepCheckDocumentationInProcess({
				generationDir: getGodotDocumentationGenerationDir(record),
				branch: record.branch,
				commitSha: record.commitSha,
				signal: runtime.controller.signal
			});
		}
		await setDocumentHealth(documentId, {
			status: "ready",
			code: null,
			message: null,
			checkedAt: new Date().toISOString()
		}, "none");
		finishJob(runtime, "completed", null);
	} catch (error: unknown) {
		const cancelled: boolean = runtime.controller.signal.aborted;
		const message: string = error instanceof Error ? error.message : String(error);
		const code: string = error !== null && typeof error === "object" && "code" in error
			? String(error.code)
			: "documentation_index_corrupt";
		const documentId: string | null = runtime.snapshot.documentId;
		if (!cancelled && documentId !== null) {
			const record = getGodotDocumentationSnapshot().documents[documentId];
			if (record !== undefined) {
				await setDocumentHealth(documentId, {
					status: record.activeGenerationId === null ? "unavailable" : "degraded",
					code,
					message,
					checkedAt: new Date().toISOString()
				}, await resolveRepairAvailability(record));
			}
		}
		finishJob(runtime, cancelled ? "cancelled" : "failed", cancelled ? null : message);
	}
}

async function activateRollbackGeneration(
	runtime: ActiveJobRuntime,
	record: GodotDocumentationRecord,
	generationId: string
): Promise<boolean> {
	const generationDir: string = join(getGodotDocumentationPackageDir(record.id), generationId);
	setJobProgress(runtime, "rolling_back", 20, "Checking the previous healthy documentation generation...");
	try {
		const manifest = await deepCheckDocumentationInProcess({
			generationDir,
			branch: record.branch,
			commitSha: (await readFile(join(generationDir, "manifest.json"), "utf8").then((text): string => {
				return (JSON.parse(text) as GodotDocumentationGenerationManifest).commitSha;
			})),
			signal: runtime.controller.signal
		});
		await updateGodotDocumentationSettings((draft): void => {
			const current = draft.documents[record.id];
			if (current === undefined) return;
			current.activeGenerationId = generationId;
			current.commitSha = manifest.commitSha;
			current.documentCount = manifest.documentCount;
			current.chunkCount = manifest.chunkCount;
			current.classCount = manifest.classCount;
			current.sizeBytes = manifest.sizeBytes;
			current.updatedAt = new Date().toISOString();
			current.health = { status: "ready", code: null, message: null, checkedAt: new Date().toISOString() };
			current.repairAvailability = "none";
		});
		return true;
	} catch {
		return false;
	}
}

async function runRepairJob(runtime: ActiveJobRuntime): Promise<void> {
	const stagingRoot: string = join(getGodotDocumentationStagingRoot(), runtime.snapshot.jobId);
	try {
		await mkdir(stagingRoot, { recursive: true });
		const documentId: string = runtime.snapshot.documentId!;
		const record = getGodotDocumentationSnapshot().documents[documentId];
		if (record === undefined) throw new Error(`Unknown Godot documentation item: ${documentId}`);
		await setDocumentHealth(documentId, {
			status: "repairing",
			code: record.health.code,
			message: record.health.message,
			checkedAt: record.health.checkedAt
		});

		for (const generationId of await listRollbackGenerationIds(record)) {
			if (await activateRollbackGeneration(runtime, record, generationId)) {
				finishJob(runtime, "completed", null);
				return;
			}
		}

		let sourceRef: GodotDocumentationSourceRef | null = record.sourceRef;
		let extractedRoot: string;
		if (await hasGodotDocumentationSource(sourceRef)) {
			setJobProgress(runtime, "extracting", 25, "Preparing the cached documentation source...");
			await touchGodotDocumentationSource(sourceRef!);
			if (sourceRef!.kind === "local_tree") {
				extractedRoot = getGodotDocumentationCachedSourcePath(sourceRef!);
			} else {
				extractedRoot = join(stagingRoot, "source");
				await extractArchive(getGodotDocumentationCachedSourcePath(sourceRef!), extractedRoot, runtime);
			}
		} else if (record.source === "official" && runtime.allowNetwork) {
			setJobProgress(runtime, "resolving", 0, "Resolving the selected godot-docs branch...");
			const resolved = await resolveBranch(record.branch, runtime.controller.signal);
			const archivePath: string = join(stagingRoot, "godot-docs.zip");
			await downloadArchive(resolved.commitSha, archivePath, runtime);
			sourceRef = await cacheGodotDocumentationArchive(archivePath, "official_zip");
			extractedRoot = join(stagingRoot, "source");
			await extractArchive(archivePath, extractedRoot, runtime);
			record.commitSha = resolved.commitSha;
		} else {
			const code: string = record.source === "official" ? "documentation_network_required" : "documentation_source_required";
			throw Object.assign(new Error(record.source === "official"
				? "Repair requires downloading the official Godot documentation again."
				: "Repair requires selecting the local Godot documentation source again."), { code });
		}

		await buildAndActivateDocumentation({
			runtime,
			stagingRoot,
			extractedRoot,
			branch: record.branch,
			commitSha: record.commitSha,
			currentRecord: record,
			source: record.source,
			...(record.sourcePath === undefined ? {} : { sourcePath: record.sourcePath }),
			sourceRef: sourceRef!
		});
		finishJob(runtime, "completed", null);
	} catch (error: unknown) {
		const cancelled: boolean = runtime.controller.signal.aborted;
		const message: string = error instanceof Error ? error.message : String(error);
		const code: string = error !== null && typeof error === "object" && "code" in error
			? String(error.code)
			: "documentation_index_corrupt";
		const documentId = runtime.snapshot.documentId;
		if (!cancelled && documentId !== null) {
			const record = getGodotDocumentationSnapshot().documents[documentId];
			if (record !== undefined) {
				await setDocumentHealth(documentId, {
					status: "unavailable",
					code,
					message,
					checkedAt: new Date().toISOString()
				}, await resolveRepairAvailability(record));
			}
		}
		logger.warn("godot_documentation", cancelled ? "repair_cancelled" : "repair_failed", {
			documentId,
			branch: runtime.snapshot.branch,
			error: message
		});
		finishJob(runtime, cancelled ? "cancelled" : "failed", cancelled ? null : message);
	} finally {
		await rm(stagingRoot, { recursive: true, force: true }).catch((): void => undefined);
	}
}

function startJob(
	operation: GodotDocumentationJob["operation"],
	branch: string,
	documentId: string | null,
	localSourcePath: string | null = null,
	options: { allowNetwork?: boolean; deepCheck?: boolean; background?: boolean } = {}
): GodotDocumentationJob {
	if (activeJob !== null) {
		if (activeJob.background && options.background !== true) {
			activeJob.controller.abort();
			activeJob = null;
		} else {
			throw new Error(`A documentation operation is already running for ${activeJob.snapshot.branch}.`);
		}
	}
	const now: string = new Date().toISOString();
	const runtime: ActiveJobRuntime = {
		controller: new AbortController(),
		localSourcePath,
		allowNetwork: options.allowNetwork === true,
		deepCheck: options.deepCheck === true,
		background: options.background === true,
		snapshot: {
			jobId: `godot-docs-${randomUUID()}`,
			operation,
			branch,
			documentId,
			stage: "resolving",
			progress: 0,
			message: "Preparing documentation operation...",
			error: null,
			startedAt: now,
			updatedAt: now,
			completedAt: null,
			unchanged: false
		}
	};
	activeJob = runtime;
	void (operation === "check"
		? runHealthCheckJob(runtime)
		: operation === "repair"
			? runRepairJob(runtime)
			: localSourcePath === null ? runDocumentationJob(runtime) : runLocalDocumentationJob(runtime));
	return cloneJob(runtime.snapshot);
}

export async function initializeGodotDocumentationManager(): Promise<void> {
	await initializeGodotDocumentationStore();
	await Promise.all([
		rm(getGodotDocumentationStagingRoot(), { recursive: true, force: true }),
		rm(getGodotDocumentationTrashRoot(), { recursive: true, force: true }),
		cleanupGodotDocumentationSourceStaging()
	]).catch((): void => undefined);
	await cleanupOrphanedGenerations();
	const records = Object.values(getGodotDocumentationSnapshot().documents);
	for (const record of records) {
		const health = await checkDocumentationRecordFast(record);
		const availability = health.status === "ready" ? "none" : await resolveRepairAvailability(record);
		await setDocumentHealth(record.id, health, availability);
	}
	await pruneGodotDocumentationSourceCache().catch((error: unknown): void => {
		logger.warn("godot_documentation", "source_cache_prune_failed", {
			error: error instanceof Error ? error.message : String(error)
		});
	});
	scheduleDocumentationMaintenance(INITIAL_MAINTENANCE_DELAY_MS);
}

function scheduleDocumentationMaintenance(delayMs: number): void {
	if (maintenanceTimer !== null) clearTimeout(maintenanceTimer);
	maintenanceTimer = setTimeout((): void => {
		maintenanceTimer = null;
		void runDocumentationMaintenance();
	}, delayMs);
	maintenanceTimer.unref();
}

async function runDocumentationMaintenance(): Promise<void> {
	if (activeJob !== null || hasActiveSessionRuns()) {
		scheduleDocumentationMaintenance(5_000);
		return;
	}
	const records = Object.values(getGodotDocumentationSnapshot().documents);
	for (const record of records) {
		if (record.health.status !== "ready" && await hasGodotDocumentationSource(record.sourceRef)) {
			startJob("repair", record.branch, record.id, null, { allowNetwork: false, background: true });
			scheduleDocumentationMaintenance(60_000);
			return;
		}
	}
	const now: number = Date.now();
	const due = records.find((record): boolean => {
		const checkedAt: number = record.health.checkedAt === null ? 0 : Date.parse(record.health.checkedAt);
		return !Number.isFinite(checkedAt) || now - checkedAt >= DEEP_HEALTH_CHECK_INTERVAL_MS;
	});
	if (due !== undefined) {
		startJob("check", due.branch, due.id, null, { deepCheck: true, background: true });
		scheduleDocumentationMaintenance(60_000);
		return;
	}
	scheduleDocumentationMaintenance(DEEP_HEALTH_CHECK_INTERVAL_MS);
}

export function getGodotDocumentationState(): GodotDocumentationState {
	return createGodotDocumentationState(activeJob === null ? null : cloneJob(activeJob.snapshot));
}

export function installGodotDocumentation(branch: string): GodotDocumentationJob {
	const normalizedBranch: string = assertOfficialBranchName(branch);
	if (Object.values(getGodotDocumentationSnapshot().documents).some((record): boolean => record.branch === normalizedBranch)) {
		throw new Error(`Documentation for branch ${normalizedBranch} is already installed.`);
	}
	return startJob("install", normalizedBranch, null);
}

export function importLocalGodotDocumentation(branch: string, sourcePath: string): GodotDocumentationJob {
	const normalizedBranch: string = assertOfficialBranchName(branch);
	const existing = Object.values(getGodotDocumentationSnapshot().documents)
		.find((record): boolean => record.branch === normalizedBranch);
	if (existing !== undefined && existing.source !== "local") {
		throw new Error(`Documentation for branch ${normalizedBranch} is already installed from the official source.`);
	}
	if (sourcePath.trim().length === 0 || sourcePath.length > 32_768) {
		throw new Error("Local documentation source path is invalid.");
	}
	return startJob("import", normalizedBranch, existing?.id ?? null, sourcePath);
}

export function updateGodotDocumentation(documentId: string): GodotDocumentationJob {
	const record: GodotDocumentationRecord | undefined = getGodotDocumentationSnapshot().documents[documentId];
	if (record === undefined) {
		throw new Error(`Unknown Godot documentation item: ${documentId}`);
	}
	if (record.source === "local") {
		if (record.health.status !== "ready" && awaitableSourceAvailable(record)) {
			return startJob("repair", record.branch, record.id, null, { allowNetwork: false });
		}
		if (record.sourcePath === undefined) {
			throw new Error(`Local Godot documentation item ${documentId} has no source path.`);
		}
		return startJob("update", record.branch, record.id, record.sourcePath);
	}
	if (record.health.status !== "ready") {
		return startJob("repair", record.branch, record.id, null, { allowNetwork: true });
	}
	return startJob("update", record.branch, record.id);
}

function awaitableSourceAvailable(record: GodotDocumentationRecord): boolean {
	return record.sourceRef !== null;
}

export function checkGodotDocumentationHealth(documentId: string, deep: boolean = false): GodotDocumentationJob {
	const record = getGodotDocumentationSnapshot().documents[documentId];
	if (record === undefined) throw new Error(`Unknown Godot documentation item: ${documentId}`);
	return startJob("check", record.branch, record.id, null, { deepCheck: deep });
}

export function repairGodotDocumentation(documentId: string, allowNetwork: boolean): GodotDocumentationJob {
	const record = getGodotDocumentationSnapshot().documents[documentId];
	if (record === undefined) throw new Error(`Unknown Godot documentation item: ${documentId}`);
	if (record.source === "official" && record.repairAvailability === "network_required" && !allowNetwork) {
		throw new Error("documentation_network_required: Repair requires explicit permission to download the official documentation.");
	}
	return startJob("repair", record.branch, record.id, null, { allowNetwork });
}

export async function reportGodotDocumentationQueryFailure(code: string): Promise<void> {
	if (!["documentation_index_missing", "documentation_index_corrupt", "documentation_index_incompatible"].includes(code)) {
		return;
	}
	for (const record of Object.values(getGodotDocumentationSnapshot().documents)) {
		if (record.health.status !== "ready") continue;
		const health = await checkDocumentationRecordFast(record);
		if (health.status === "ready") continue;
		await setDocumentHealth(record.id, health, await resolveRepairAvailability(record));
		logger.warn("godot_documentation", "query_health_failure", {
			documentId: record.id,
			branch: record.branch,
			generation: record.activeGenerationId,
			code
		});
	}
}

export function getGodotDocumentationJob(jobId: string): GodotDocumentationJob | null {
	if (activeJob?.snapshot.jobId === jobId) {
		return cloneJob(activeJob.snapshot);
	}
	const completed: GodotDocumentationJob | undefined = completedJobs.get(jobId);
	return completed === undefined ? null : cloneJob(completed);
}

export function cancelGodotDocumentationJob(jobId: string): GodotDocumentationJob | null {
	if (activeJob?.snapshot.jobId !== jobId) {
		return getGodotDocumentationJob(jobId);
	}
	activeJob.controller.abort();
	return cloneJob(activeJob.snapshot);
}

export async function setGodotDocumentationEnabled(enabled: boolean): Promise<GodotDocumentationState> {
	const current = getGodotDocumentationSnapshot();
	if (enabled && Object.keys(current.documents).length === 0) {
		throw new Error("Import Godot documentation before enabling local documentation search.");
	}
	await updateGodotDocumentationSettings((draft): void => {
		draft.enabled = enabled;
	});
	return getGodotDocumentationState();
}

export async function removeGodotDocumentation(documentId: string): Promise<GodotDocumentationState> {
	const current: GodotDocumentationRecord | undefined = getGodotDocumentationSnapshot().documents[documentId];
	if (current === undefined) {
		throw new Error(`Unknown Godot documentation item: ${documentId}`);
	}
	if (activeJob !== null) {
		throw new Error("Wait for the active documentation operation to finish before deleting documentation.");
	}
	await updateGodotDocumentationSettings((draft): void => {
		delete draft.documents[documentId];
	});
	const packageDir: string = getGodotDocumentationPackageDir(documentId);
	const trashDir: string = join(getGodotDocumentationTrashRoot(), `${documentId}-${Date.now().toString(36)}`);
	try {
		await mkdir(dirname(trashDir), { recursive: true });
		await rename(packageDir, trashDir);
		await rm(trashDir, { recursive: true, force: true });
	} catch {
		// The immutable SQLite generation may still be open in a Godot MCP process.
		// It is no longer referenced and will be removed during the next cleanup pass.
	}
	await pruneGodotDocumentationSourceCache().catch((): void => undefined);
	return getGodotDocumentationState();
}

async function cleanupOrphanedGenerations(): Promise<void> {
	const packagesRoot: string = join(getGodotDocumentationRoot(), "packages");
	const records = Object.values(getGodotDocumentationSnapshot().documents);
	const referenced: Set<string> = new Set();
	for (const record of records) {
		if (record.activeGenerationId !== null) {
			referenced.add(normalize(join(record.id, record.activeGenerationId)));
		}
		const rollbackId: string | undefined = (await listRollbackGenerationIds(record))[0];
		if (rollbackId !== undefined) referenced.add(normalize(join(record.id, rollbackId)));
	}
	let packageEntries: Dirent[];
	try {
		packageEntries = await readdir(packagesRoot, { withFileTypes: true });
	} catch {
		return;
	}
	for (const packageEntry of packageEntries) {
		if (!packageEntry.isDirectory()) {
			continue;
		}
		const packageDir: string = join(packagesRoot, packageEntry.name);
		let generationEntries: Dirent[];
		try {
			generationEntries = await readdir(packageDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const generationEntry of generationEntries) {
			if (!generationEntry.isDirectory()) {
				continue;
			}
			const key: string = normalize(join(packageEntry.name, generationEntry.name));
			if (!referenced.has(key)) {
				await rm(join(packageDir, generationEntry.name), { recursive: true, force: true }).catch((): void => undefined);
			}
		}
		const remaining: string[] = await readdir(packageDir).catch((): string[] => []);
		if (remaining.length === 0) {
			await rm(packageDir, { recursive: true, force: true }).catch((): void => undefined);
		}
	}
}
