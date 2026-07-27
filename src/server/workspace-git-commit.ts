import { z } from "zod";
import type { AiChatParams, ChatMessage, ProviderId } from "../protocol/types.js";
import { chatWithDeepSeek, type ProviderChatOptions } from "../providers/deepseek-client.js";
import { parseJsonObjectFromLlm } from "../providers/llm-json.js";
import { loadProviderConfigWithSecret, type ProviderConfigWithSecret } from "../providers/provider-config-store.js";
import {
	ProviderTaskModelError,
	resolveConfiguredProviderTaskModelOptions
} from "../providers/task-model-routing.js";
import { normalizeConfiguredProviderBaseUrl } from "../providers/provider-base-url.js";
import { getProviderAdapterFamily, getProviderDefaultModel, getProviderEndpointTypeForModel, isProviderId } from "../providers/provider-registry.js";
import { resolveModelProfile } from "../tokens/model-profiles.js";
import { withProviderUsageContext } from "../usage/provider-recorder.js";
import { composeSystemPrompt } from "../prompts/registry.js";
import { getGitCommitPrompt } from "../user-prompt-store.js";
import type { ClientSession } from "./client-session.js";
import { clipTextByChars } from "./additional-context.js";
import { isInsideGitWorkTree, readGitBranch, runGit, type GitResult } from "./git-utils.js";
import { readWorkspaceGitDiff, type WorkspaceGitDiffResult } from "./workspace-git-diff.js";

export type WorkspaceGitCommitMessageGenerateParams = {
	workspaceId: string;
	workspaceRoot: string;
	includeUnstagedChanges: boolean;
	provider?: string | undefined;
	model?: string | undefined;
	session: ClientSession;
	requestId: string;
};

export type WorkspaceGitCommitMessageResult = {
	message: string;
	subject: string;
	body: string;
	additions: number;
	deletions: number;
	changedFiles: number;
	truncated: boolean;
};

export type WorkspaceGitCommitOrPushAction = "commit" | "push" | "commit_and_push";

export type WorkspaceGitCommitOrPushParams = {
	workspaceId: string;
	workspaceRoot: string;
	action: WorkspaceGitCommitOrPushAction;
	message?: string | undefined;
	includeUnstagedChanges: boolean;
};

export type WorkspaceGitCommitOrPushResult = {
	workspaceId: string;
	action: WorkspaceGitCommitOrPushAction;
	branch: string | null;
	commitHash: string | null;
	committed: boolean;
	pushed: boolean;
	stdout: string;
	stderr: string;
};

export type CandidateDiff = {
	patch: string;
	additions: number;
	deletions: number;
	changedFiles: number;
	truncated: boolean;
	branch: string | null;
};

export type CommitMessageDiffContext = {
	text: string;
	truncated: boolean;
	omittedFiles: number;
	omittedHunks: number;
	omittedChangedLines: number;
	omittedWhitespaceLines: number;
	suppressedLargeFiles: number;
};

const COMMIT_MESSAGE_SCHEMA = z.object({
	subject: z.string().min(1).max(120),
	body: z.string().max(4000).optional()
}).strict();

const DEFAULT_STAGED_PATCH_LIMIT_CHARS: number = 1024 * 1024;
const COMMIT_MESSAGE_CONTEXT_LIMIT_CHARS: number = 48 * 1024;
const COMMIT_MESSAGE_MAX_FILES: number = 80;
const COMMIT_MESSAGE_MAX_HUNKS_PER_FILE: number = 8;
const COMMIT_MESSAGE_MAX_CHANGED_LINES_PER_HUNK: number = 24;
const COMMIT_MESSAGE_MAX_LINE_CHARS: number = 220;
const GIT_COMMIT_TIMEOUT_MS: number = 20_000;
const GIT_PUSH_TIMEOUT_MS: number = 120_000;
const MAX_PUBLIC_GIT_OUTPUT_CHARS: number = 4000;
const COMMIT_SUBJECT_MAX_CHARS: number = 100;
const COMMIT_BODY_MAX_LINE_CHARS: number = 100;

function splitNullTerminated(text: string): string[] {
	return text.split("\0").filter((item: string): boolean => item.length > 0);
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

function extractDiffPath(line: string): string | null {
	const value: string = line.replace(/^(?:---|\+\+\+)\s+/u, "").trim();
	if (value === "/dev/null") {
		return null;
	}
	return value.replace(/^[ab]\//u, "");
}

function isLargeGeneratedOrLockPath(filePath: string): boolean {
	const normalized: string = filePath.replaceAll("\\", "/").toLowerCase();
	return normalized.endsWith("package-lock.json")
		|| normalized.endsWith("pnpm-lock.yaml")
		|| normalized.endsWith("yarn.lock")
		|| normalized.endsWith("bun.lockb")
		|| normalized.endsWith(".min.js")
		|| normalized.endsWith(".map")
		|| normalized.includes("/dist/")
		|| normalized.includes("/build/")
		|| normalized.includes("/release/");
}

function clipDiffLine(line: string): string {
	const chars: string[] = Array.from(line);
	if (chars.length <= COMMIT_MESSAGE_MAX_LINE_CHARS) {
		return line;
	}
	return `${chars.slice(0, COMMIT_MESSAGE_MAX_LINE_CHARS).join("")} ...`;
}

function createContextAppender(limitChars: number): {
	append: (line?: string | undefined) => boolean;
	lines: string[];
	truncated: () => boolean;
} {
	const lines: string[] = [];
	let usedChars: number = 0;
	let truncated: boolean = false;
	return {
		append(line: string = ""): boolean {
			if (truncated) {
				return false;
			}
			const nextChars: number = usedChars + line.length + 1;
			if (nextChars > limitChars) {
				lines.push("[context truncated: commit message input budget reached]");
				truncated = true;
				return false;
			}
			lines.push(line);
			usedChars = nextChars;
			return true;
		},
		lines,
		truncated: (): boolean => truncated
	};
}

export function createCommitMessageDiffContext(diff: CandidateDiff): CommitMessageDiffContext {
	const appender = createContextAppender(COMMIT_MESSAGE_CONTEXT_LIMIT_CHARS);
	let currentDiffHeader: string | null = null;
	let currentOldPath: string | null = null;
	let currentNewPath: string | null = null;
	let fileCount: number = 0;
	let hunksInCurrentFile: number = 0;
	let changedLinesInCurrentHunk: number = 0;
	let currentFileSuppressed: boolean = false;
	let currentHunkIncluded: boolean = false;
	let omittedFiles: number = 0;
	let omittedHunks: number = 0;
	let omittedChangedLines: number = 0;
	let omittedWhitespaceLines: number = 0;
	let suppressedLargeFiles: number = 0;

	function displayPath(): string {
		return currentNewPath ?? currentOldPath ?? currentDiffHeader ?? "unknown";
	}

	function beginFile(header: string): void {
		currentDiffHeader = header;
		currentOldPath = null;
		currentNewPath = null;
		hunksInCurrentFile = 0;
		changedLinesInCurrentHunk = 0;
		currentFileSuppressed = false;
		currentHunkIncluded = false;
		fileCount += 1;
		if (fileCount > COMMIT_MESSAGE_MAX_FILES) {
			omittedFiles += 1;
			return;
		}
		appender.append();
		appender.append(header);
	}

	function appendFilePathLine(line: string): void {
		if (line.startsWith("--- ")) {
			currentOldPath = extractDiffPath(line);
		} else {
			currentNewPath = extractDiffPath(line);
		}
		if (fileCount <= COMMIT_MESSAGE_MAX_FILES) {
			appender.append(line);
		}
		if (!currentFileSuppressed && isLargeGeneratedOrLockPath(displayPath())) {
			currentFileSuppressed = true;
			suppressedLargeFiles += 1;
			if (fileCount <= COMMIT_MESSAGE_MAX_FILES) {
				appender.append("[changed lines omitted: generated, build output, or lockfile]");
			}
		}
	}

	for (const rawLine of diff.patch.replace(/\r\n?/gu, "\n").split("\n")) {
		if (rawLine.startsWith("diff --git ")) {
			beginFile(rawLine);
			continue;
		}
		if (currentDiffHeader === null) {
			beginFile("diff --git <unknown>");
		}
		if (fileCount > COMMIT_MESSAGE_MAX_FILES) {
			continue;
		}
		if (rawLine.startsWith("Binary files ") || rawLine.startsWith("GIT binary patch")) {
			appender.append(rawLine);
			currentFileSuppressed = true;
			continue;
		}
		if (rawLine.startsWith("--- ") || rawLine.startsWith("+++ ")) {
			appendFilePathLine(rawLine);
			continue;
		}
		if (rawLine.startsWith("@@")) {
			hunksInCurrentFile += 1;
			changedLinesInCurrentHunk = 0;
			currentHunkIncluded = false;
			if (currentFileSuppressed) {
				continue;
			}
			if (hunksInCurrentFile > COMMIT_MESSAGE_MAX_HUNKS_PER_FILE) {
				omittedHunks += 1;
				continue;
			}
			currentHunkIncluded = appender.append(clipDiffLine(rawLine));
			continue;
		}
		if (currentFileSuppressed || !currentHunkIncluded) {
			continue;
		}
		if ((rawLine.startsWith("+") && !rawLine.startsWith("+++")) || (rawLine.startsWith("-") && !rawLine.startsWith("---"))) {
			if (rawLine.slice(1).trim().length === 0) {
				omittedWhitespaceLines += 1;
				continue;
			}
			if (changedLinesInCurrentHunk >= COMMIT_MESSAGE_MAX_CHANGED_LINES_PER_HUNK) {
				omittedChangedLines += 1;
				continue;
			}
			if (appender.append(clipDiffLine(rawLine))) {
				changedLinesInCurrentHunk += 1;
			} else {
				omittedChangedLines += 1;
			}
		}
	}

	const text: string = appender.lines.join("\n").trim();
	const hasSemanticLines: boolean = text.split(/\r?\n/u).some((line: string): boolean => /^[+-].*\S/u.test(line.trim()));
	const fallbackText: string = hasSemanticLines
		? text
		: [
			text,
			"",
			"[diff note: no non-empty changed lines remained after blank-line suppression; this may be whitespace-only, binary-only, or metadata-only]"
		].join("\n").trim();

	return {
		text: fallbackText,
		truncated: diff.truncated || appender.truncated() || omittedFiles > 0 || omittedHunks > 0 || omittedChangedLines > 0,
		omittedFiles,
		omittedHunks,
		omittedChangedLines,
		omittedWhitespaceLines,
		suppressedLargeFiles
	};
}

function sanitizeGitOutput(workspaceRoot: string, text: string): string {
	return clipTextByChars(
		text.replaceAll(workspaceRoot, "<workspace>").replaceAll(workspaceRoot.replaceAll("\\", "/"), "<workspace>"),
		MAX_PUBLIC_GIT_OUTPUT_CHARS
	);
}

function getCharLength(value: string): number {
	return Array.from(value).length;
}

function sliceChars(value: string, start: number, end?: number | undefined): string {
	return Array.from(value).slice(start, end).join("");
}

function clipCommitSubject(subject: string): string {
	const chars: string[] = Array.from(subject);
	if (chars.length <= COMMIT_SUBJECT_MAX_CHARS) {
		return subject;
	}

	const clipped: string = chars.slice(0, COMMIT_SUBJECT_MAX_CHARS).join("");
	const wordBoundaryIndex: number = Math.max(clipped.lastIndexOf(" "), clipped.lastIndexOf("\t"));
	if (wordBoundaryIndex >= Math.floor(COMMIT_SUBJECT_MAX_CHARS * 0.75)) {
		return clipped.slice(0, wordBoundaryIndex).trim();
	}
	return clipped.trim();
}

function normalizeCommitSubject(subject: string): string {
	return clipCommitSubject(subject
		.trim()
		.replace(/^\s*([a-z]+(?:\([^)]+\))?)\s+:\s*/u, "$1: ")
		.replace(/^([a-z]+(?:\([^)]+\))?):\s*/u, "$1: ")
		.trim());
}

function appendWrappedToken(lines: string[], prefix: string, token: string): string {
	const availableChars: number = Math.max(1, COMMIT_BODY_MAX_LINE_CHARS - getCharLength(prefix));
	let remaining: string = token;
	while (getCharLength(`${prefix}${remaining}`) > COMMIT_BODY_MAX_LINE_CHARS) {
		lines.push(`${prefix}${sliceChars(remaining, 0, availableChars)}`);
		remaining = sliceChars(remaining, availableChars);
	}
	return `${prefix}${remaining}`;
}

function wrapCommitBodyLine(line: string): string[] {
	const lineWithoutTrailingSpace: string = line.trimEnd();
	if (getCharLength(lineWithoutTrailingSpace) <= COMMIT_BODY_MAX_LINE_CHARS) {
		return [lineWithoutTrailingSpace];
	}

	const bulletMatch: RegExpMatchArray | null = lineWithoutTrailingSpace.match(/^(\s*(?:[-*+]|\d+[.)])\s+)(.*)$/u);
	const leadingWhitespace: string = lineWithoutTrailingSpace.match(/^\s*/u)?.[0] ?? "";
	const firstPrefix: string = bulletMatch?.[1] ?? leadingWhitespace;
	const continuationPrefix: string = bulletMatch === null ? leadingWhitespace : " ".repeat(getCharLength(firstPrefix));
	const text: string = (bulletMatch?.[2] ?? lineWithoutTrailingSpace.trim()).trim();
	if (text.length === 0) {
		return [lineWithoutTrailingSpace];
	}

	const lines: string[] = [];
	let currentLine: string = firstPrefix;
	for (const token of text.split(/\s+/u)) {
		const isPrefixOnly: boolean = currentLine === firstPrefix || currentLine === continuationPrefix;
		const candidate: string = isPrefixOnly ? `${currentLine}${token}` : `${currentLine} ${token}`;
		if (getCharLength(candidate) <= COMMIT_BODY_MAX_LINE_CHARS) {
			currentLine = candidate;
			continue;
		}

		if (!isPrefixOnly) {
			lines.push(currentLine.trimEnd());
			currentLine = continuationPrefix;
		}
		currentLine = appendWrappedToken(lines, currentLine, token);
	}
	if (currentLine.trim().length > 0) {
		lines.push(currentLine.trimEnd());
	}
	return lines.length > 0 ? lines : [lineWithoutTrailingSpace];
}

function normalizeCommitBody(body: string): string {
	return body
		.replace(/\r\n?/gu, "\n")
		.split("\n")
		.flatMap((line: string): string[] => wrapCommitBodyLine(line))
		.join("\n")
		.trim();
}

function normalizeCommitMessage(message: string): { subject: string; body: string; message: string } {
	const normalizedLines: string[] = message.replace(/\r\n?/gu, "\n").split("\n");
	const firstNonEmptyIndex: number = normalizedLines.findIndex((line: string): boolean => line.trim().length > 0);
	if (firstNonEmptyIndex < 0) {
		throw new Error("Commit message is required.");
	}

	const subject: string = normalizeCommitSubject(normalizedLines[firstNonEmptyIndex]!);
	const body: string = normalizeCommitBody(normalizedLines.slice(firstNonEmptyIndex + 1).join("\n"));
	return {
		subject,
		body,
		message: body.length > 0 ? `${subject}\n\n${body}` : subject
	};
}

async function assertGitRepository(workspaceRoot: string): Promise<void> {
	if (!await isInsideGitWorkTree(workspaceRoot)) {
		throw new Error("Workspace is not a Git repository.");
	}
}

async function readStagedCandidateDiff(workspaceRoot: string): Promise<CandidateDiff> {
	await assertGitRepository(workspaceRoot);
	const branch: string | null = await readGitBranch(workspaceRoot);
	const patch: string = (await runGit(workspaceRoot, ["diff", "--cached", "--no-color", "--no-ext-diff", "--unified=3", "--"])).stdout;
	const changedFiles: number = splitNullTerminated((await runGit(workspaceRoot, ["diff", "--cached", "--name-only", "-z", "--"])).stdout).length;
	const counts = countChangedLines(patch);
	const truncated: boolean = patch.length > DEFAULT_STAGED_PATCH_LIMIT_CHARS;

	return {
		patch: truncated ? patch.slice(0, DEFAULT_STAGED_PATCH_LIMIT_CHARS) : patch,
		additions: counts.additions,
		deletions: counts.deletions,
		changedFiles,
		truncated,
		branch
	};
}

async function readCandidateDiff(workspaceId: string, workspaceRoot: string, includeUnstagedChanges: boolean): Promise<CandidateDiff> {
	if (!includeUnstagedChanges) {
		return readStagedCandidateDiff(workspaceRoot);
	}

	const diff: WorkspaceGitDiffResult = await readWorkspaceGitDiff(workspaceId, workspaceRoot);
	if (!diff.hasGitRepository) {
		throw new Error("Workspace is not a Git repository.");
	}

	return {
		patch: diff.patch,
		additions: diff.additions,
		deletions: diff.deletions,
		changedFiles: diff.changedFiles,
		truncated: diff.truncated,
		branch: diff.branch
	};
}

function resolveRequestedProvider(session: ClientSession, providerInput: string | undefined): ProviderId {
	if (providerInput === undefined) {
		return session.activeProvider;
	}
	if (!isProviderId(providerInput)) {
		throw new Error(`Unknown provider: ${providerInput}`);
	}
	return providerInput;
}

function createProviderOptions(session: ClientSession, provider: ProviderId, modelInput: string | undefined, apiKey: string): ProviderChatOptions {
	const model: string = modelInput?.trim() || (provider === session.activeProvider
		? session.providerModel ?? getProviderDefaultModel(provider)
		: getProviderDefaultModel(provider));
	const endpointType = getProviderEndpointTypeForModel(provider, model);
	const options: ProviderChatOptions = {
		provider,
		apiKey,
		model,
		endpointType,
		adapterFamily: getProviderAdapterFamily(provider, endpointType),
		modelProfile: resolveModelProfile(provider, model)
	};
	const configuredBaseUrl: string | undefined = provider === session.activeProvider
		? session.providerBaseUrl
		: undefined;
	const normalizedBaseUrl: string | undefined = normalizeConfiguredProviderBaseUrl(configuredBaseUrl);
	if (normalizedBaseUrl !== undefined) {
		options.baseUrl = normalizedBaseUrl;
	}
	return options;
}

export type GitCommitProviderOptionsDependencies = {
	resolveConfiguredTaskModel?: typeof resolveConfiguredProviderTaskModelOptions;
	loadProviderConfig?: typeof loadProviderConfigWithSecret;
};

export async function resolveGitCommitProviderOptions(
	session: ClientSession,
	providerInput: string | undefined,
	modelInput: string | undefined,
	dependencies: GitCommitProviderOptionsDependencies = {}
): Promise<ProviderChatOptions> {
	if (providerInput === undefined && modelInput === undefined) {
		const resolveConfiguredTaskModel = dependencies.resolveConfiguredTaskModel
			?? resolveConfiguredProviderTaskModelOptions;
		try {
			return (await resolveConfiguredTaskModel("gitCommit")).options;
		} catch (error: unknown) {
			if (!(error instanceof ProviderTaskModelError) || error.code !== "task_model_not_configured") {
				throw error;
			}
		}
	}

	const provider: ProviderId = resolveRequestedProvider(session, providerInput);
	const loadProviderConfig = dependencies.loadProviderConfig ?? loadProviderConfigWithSecret;
	const config: ProviderConfigWithSecret | null = await loadProviderConfig(provider);
	if (config === null || config.apiKey === undefined) {
		throw new Error(`Provider is not configured: ${provider}`);
	}

	const options: ProviderChatOptions = createProviderOptions(session, provider, modelInput ?? config.model, config.apiKey);
	const normalizedBaseUrl: string | undefined = normalizeConfiguredProviderBaseUrl(config.baseUrl);
	if (normalizedBaseUrl !== undefined) {
		options.baseUrl = normalizedBaseUrl;
	}
	return options;
}

function createCommitMessageUserPrompt(diff: CandidateDiff): string {
	const context: CommitMessageDiffContext = createCommitMessageDiffContext(diff);
	return [
		"Generate a concise Git commit message for the following workspace changes.",
		"Focus on intent and user-visible behavior. Do not mention every file unless it matters.",
		"The diff context below is compressed: blank-line-only changes, generated files, lockfiles, and oversized hunks may be summarized.",
		"",
		"## Git state",
		`- branch: ${diff.branch ?? "detached"}`,
		`- changedFiles: ${diff.changedFiles}`,
		`- additions: ${diff.additions}`,
		`- deletions: ${diff.deletions}`,
		`- originalDiffTruncated: ${diff.truncated ? "true" : "false"}`,
		`- contextTruncated: ${context.truncated ? "true" : "false"}`,
		`- omittedFiles: ${context.omittedFiles}`,
		`- omittedHunks: ${context.omittedHunks}`,
		`- omittedChangedLines: ${context.omittedChangedLines}`,
		`- omittedWhitespaceLines: ${context.omittedWhitespaceLines}`,
		`- suppressedGeneratedOrLockFiles: ${context.suppressedLargeFiles}`,
		"",
		"## Compact diff context",
		"```diff",
		context.text,
		"```"
	].join("\n");
}

function normalizeGeneratedCommitMessage(text: string): { subject: string; body: string; message: string } {
	const parsed: unknown = parseJsonObjectFromLlm(text, "Failed to parse generated commit message.");
	const result = COMMIT_MESSAGE_SCHEMA.parse(parsed);
	return normalizeCommitMessage([
		result.subject,
		result.body?.trim() ?? ""
	].filter((part: string): boolean => part.length > 0).join("\n\n"));
}

async function hasStagedChanges(workspaceRoot: string): Promise<boolean> {
	const result: GitResult = await runGit(workspaceRoot, ["diff", "--cached", "--quiet", "--"], {
		allowedExitCodes: [0, 1]
	});
	return result.exitCode === 1;
}

async function readCurrentBranch(workspaceRoot: string): Promise<string> {
	const branch: string = (await runGit(workspaceRoot, ["branch", "--show-current"])).stdout.trim();
	if (branch.length === 0) {
		throw new Error("Cannot push from detached HEAD.");
	}
	return branch;
}

async function hasUpstream(workspaceRoot: string): Promise<boolean> {
	try {
		await runGit(workspaceRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
		return true;
	} catch {
		return false;
	}
}

async function hasOriginRemote(workspaceRoot: string): Promise<boolean> {
	const remotes: string[] = (await runGit(workspaceRoot, ["remote"])).stdout.split(/\r?\n/u).map((line: string): string => line.trim());
	return remotes.includes("origin");
}

async function commitChanges(workspaceRoot: string, message: string, includeUnstagedChanges: boolean): Promise<{ commitHash: string; stdout: string; stderr: string }> {
	const normalized = normalizeCommitMessage(message);
	if (includeUnstagedChanges) {
		await runGit(workspaceRoot, ["add", "-A", "--"], { timeoutMs: GIT_COMMIT_TIMEOUT_MS });
	}
	if (!await hasStagedChanges(workspaceRoot)) {
		throw new Error(includeUnstagedChanges ? "No changes to commit." : "No staged changes to commit.");
	}

	const args: string[] = ["commit", "-m", normalized.subject];
	if (normalized.body.length > 0) {
		args.push("-m", normalized.body);
	}
	const result: GitResult = await runGit(workspaceRoot, args, { timeoutMs: GIT_COMMIT_TIMEOUT_MS });
	const commitHash: string = (await runGit(workspaceRoot, ["rev-parse", "--short", "HEAD"])).stdout.trim();
	return { commitHash, stdout: result.stdout, stderr: result.stderr };
}

async function pushChanges(workspaceRoot: string): Promise<{ stdout: string; stderr: string }> {
	const branch: string = await readCurrentBranch(workspaceRoot);
	const args: string[] = await hasUpstream(workspaceRoot)
		? ["push"]
		: await hasOriginRemote(workspaceRoot)
			? ["push", "-u", "origin", branch]
			: (() => {
				throw new Error("No upstream branch or origin remote is configured.");
			})();
	const result: GitResult = await runGit(workspaceRoot, args, { timeoutMs: GIT_PUSH_TIMEOUT_MS });
	return { stdout: result.stdout, stderr: result.stderr };
}

export async function generateWorkspaceGitCommitMessage(params: WorkspaceGitCommitMessageGenerateParams): Promise<WorkspaceGitCommitMessageResult> {
	const diff: CandidateDiff = await readCandidateDiff(params.workspaceId, params.workspaceRoot, params.includeUnstagedChanges);
	if (diff.patch.trim().length === 0 || diff.changedFiles === 0) {
		throw new Error(params.includeUnstagedChanges ? "No changes found for commit message generation." : "No staged changes found for commit message generation.");
	}

	const options: ProviderChatOptions = withProviderUsageContext(
		await resolveGitCommitProviderOptions(params.session, params.provider, params.model),
		{
			requestId: params.requestId,
			runId: params.requestId,
			sessionId: params.session.sessionId,
			workspaceId: params.workspaceId,
			operation: "git_commit_message"
		}
	);
	const customPrompt: string = await getGitCommitPrompt();
	const systemPrompt: string = await composeSystemPrompt(
		"git.committer",
		customPrompt.length > 0 ? customPrompt : undefined,
		"",
		"ask"
	);
	const aiParams: AiChatParams = {
		message: createCommitMessageUserPrompt(diff),
		mode: "ask",
		options: {
			temperature: 0,
			responseFormat: "json",
			maxTokens: 800
		}
	};
	const text: string = await chatWithDeepSeek(aiParams, options, [] satisfies ChatMessage[], systemPrompt);
	const generated = normalizeGeneratedCommitMessage(text);

	return {
		message: generated.message,
		subject: generated.subject,
		body: generated.body,
		additions: diff.additions,
		deletions: diff.deletions,
		changedFiles: diff.changedFiles,
		truncated: createCommitMessageDiffContext(diff).truncated
	};
}

export async function commitOrPushWorkspaceGit(params: WorkspaceGitCommitOrPushParams): Promise<WorkspaceGitCommitOrPushResult> {
	await assertGitRepository(params.workspaceRoot);
	const outputs: string[] = [];
	const errors: string[] = [];
	const branch: string | null = await readGitBranch(params.workspaceRoot);
	let commitHash: string | null = null;
	let committed: boolean = false;
	let pushed: boolean = false;

	if (params.action === "commit" || params.action === "commit_and_push") {
		const commitResult = await commitChanges(params.workspaceRoot, params.message ?? "", params.includeUnstagedChanges);
		commitHash = commitResult.commitHash;
		committed = true;
		outputs.push(commitResult.stdout);
		errors.push(commitResult.stderr);
	}

	if (params.action === "push" || params.action === "commit_and_push") {
		const pushResult = await pushChanges(params.workspaceRoot);
		pushed = true;
		outputs.push(pushResult.stdout);
		errors.push(pushResult.stderr);
	}

	return {
		workspaceId: params.workspaceId,
		action: params.action,
		branch,
		commitHash,
		committed,
		pushed,
		stdout: sanitizeGitOutput(params.workspaceRoot, outputs.join("\n")),
		stderr: sanitizeGitOutput(params.workspaceRoot, errors.join("\n"))
	};
}
