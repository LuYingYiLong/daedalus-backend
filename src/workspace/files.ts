import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { StructuredToolError } from "../tools/tool-failure.js";

export const DEFAULT_WORKSPACE_TEXT_FILE_BYTES: number = 512 * 1024;
export const DEFAULT_WORKSPACE_NEW_FILE_BYTES: number = 64 * 1024;
export const DEFAULT_WORKSPACE_DOWNLOAD_BYTES: number = 100 * 1024 * 1024;
const DEFAULT_WORKSPACE_DOWNLOAD_TIMEOUT_MS: number = 60_000;
const MAX_WORKSPACE_DOWNLOAD_REDIRECTS: number = 5;

const DEFAULT_IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
	".git",
".daedalus",
".godot",
	"node_modules",
	".cache",
	".next",
	".nuxt",
	".turbo",
	"coverage",
	"dist",
	"out"
]);

const PROTECTED_WRITE_DIRECTORIES: ReadonlySet<string> = new Set([
	".git",
	".daedalus"
]);

// These are repository metadata, generated artifacts, or local caches. General
// workspace reads use dedicated structured tools instead of raw internal files.
const PROTECTED_READ_DIRECTORIES: ReadonlySet<string> = new Set([
	".git",
	".daedalus",
	".cache",
	"node_modules"
]);

export type WorkspaceFileValidation = {
	valid: boolean;
	path: string;
	resolvedPath?: string | undefined;
	errors: string[];
};

export type WorkspaceFileServiceOptions = {
	rootPath: string;
	readMaxBytes?: number | undefined;
	newFileMaxBytes?: number | undefined;
	writeMaxBytes?: number | undefined;
	ignoredDirectories?: ReadonlySet<string> | undefined;
	protectedReadDirectories?: ReadonlySet<string> | undefined;
	protectedWriteDirectories?: ReadonlySet<string> | undefined;
	validateContent?: ((input: { relativePath: string; content: string; operation: "create" | "overwrite" | "replace" | "replace-line" }) => string[]) | undefined;
	validateWritablePath?: ((relativePath: string) => Promise<string> | string) | undefined;
};

export type WorkspaceFileService = ReturnType<typeof createWorkspaceFileService>;

export type WorkspaceListFilesInput = {
	subdir?: string | undefined;
	extensions?: string[] | undefined;
	includeIgnored?: boolean | undefined;
	limit?: number | undefined;
};

export type WorkspaceDownloadInput = {
	url: string;
	relativePath: string;
	expectedSha256?: string | undefined;
	overwrite?: boolean | undefined;
};

export type WorkspaceListFilesResult = {
	files: string[];
	directoryExists: boolean;
};

export type WorkspaceTextFileReadOptions = {
	/** 1-based inclusive line number. */
	startLine?: number | undefined;
	/** 1-based inclusive line number. */
	endLine?: number | undefined;
};

type ResolvedWorkspacePath = {
	relativePath: string;
	absolutePath: string;
};

function isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
	const relativePath: string = path.relative(rootPath, candidatePath);
	return relativePath.length === 0 || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function toPortableRelativePath(rootPath: string, absolutePath: string): string {
	return path.relative(rootPath, absolutePath).replaceAll(path.sep, "/");
}

function normalizeRelativePath(inputPath: string): string {
	const trimmedPath: string = inputPath.trim().replaceAll("\\", "/");
	if (trimmedPath.length === 0) {
		throw new Error("Path cannot be empty");
	}
	if (trimmedPath.startsWith("res://")) {
		throw new Error("Workspace file paths must be relative paths, not res:// paths");
	}
	if (path.isAbsolute(trimmedPath) || /^[A-Za-z]:\//u.test(trimmedPath)) {
		throw new Error("Workspace file paths must be relative paths");
	}

	return trimmedPath;
}

function assertNoProtectedSegment(
	relativePath: string,
	protectedDirectories: ReadonlySet<string>,
	operation: "Reading" | "Writing" = "Writing"
): void {
	const segments: string[] = relativePath.split("/").filter((segment: string): boolean => segment.length > 0);
	for (const segment of segments) {
		if (segment === ".." || segment === ".") {
			throw new Error(`Path traversal denied: ${relativePath}`);
		}
		if (protectedDirectories.has(segment)) {
			throw new Error(operation === "Reading"
				? `Reading from ${segment}/ is not allowed`
				: `Writing to ${segment}/ is not allowed`);
		}
	}
}

async function resolveRealRoot(rootPath: string): Promise<string> {
	const realRoot: string = await fs.realpath(path.resolve(rootPath));
	const stat = await fs.stat(realRoot);
	if (!stat.isDirectory()) {
		throw new Error(`Workspace root is not a directory: ${rootPath}`);
	}
	return realRoot;
}

async function assertNoSymlinkEscape(rootPath: string, absolutePath: string): Promise<void> {
	let existingPath: string = absolutePath;
	let targetExists: boolean = true;
	while (true) {
		try {
			await fs.lstat(existingPath);
			break;
		} catch {
			const parentPath: string = path.dirname(existingPath);
			if (parentPath === existingPath) {
				throw new Error(`Cannot resolve workspace path: ${absolutePath}`);
			}
			existingPath = parentPath;
			targetExists = false;
		}
	}

	const realRoot: string = await resolveRealRoot(rootPath);
	const realExistingPath: string = await fs.realpath(existingPath);
	if (!isPathInsideRoot(realExistingPath, realRoot)) {
		throw new Error(`Path symlink escape denied: ${absolutePath}`);
	}

	if (targetExists) {
		const realTargetPath: string = await fs.realpath(absolutePath);
		if (!isPathInsideRoot(realTargetPath, realRoot)) {
			throw new Error(`Path symlink escape denied: ${absolutePath}`);
		}
	}
}

export function createWorkspaceFileService(options: WorkspaceFileServiceOptions) {
	const rootPath: string = path.resolve(options.rootPath);
	const ignoredDirectories: ReadonlySet<string> = options.ignoredDirectories ?? DEFAULT_IGNORED_DIRECTORIES;
	const protectedReadDirectories: ReadonlySet<string> = options.protectedReadDirectories ?? PROTECTED_READ_DIRECTORIES;
	const protectedWriteDirectories: ReadonlySet<string> = options.protectedWriteDirectories ?? PROTECTED_WRITE_DIRECTORIES;
	const readMaxBytes: number = options.readMaxBytes ?? DEFAULT_WORKSPACE_TEXT_FILE_BYTES;
	const newFileMaxBytes: number = options.newFileMaxBytes ?? DEFAULT_WORKSPACE_NEW_FILE_BYTES;
	const writeMaxBytes: number = options.writeMaxBytes ?? readMaxBytes;
	const downloadMaxBytes: number = Math.max(writeMaxBytes, DEFAULT_WORKSPACE_DOWNLOAD_BYTES);

	function createDownloadFailure(
		code: string,
		category: "business" | "environment" | "policy" | "protocol",
		message: string,
		retryable: boolean,
		relativePath: string
	): StructuredToolError {
		return new StructuredToolError({
			code,
			category,
			message,
			retryable,
			artifactRefs: [relativePath]
		});
	}

	function normalizeDownloadUrl(value: string): URL {
		let url: URL;
		try {
			url = new URL(value);
		} catch {
			throw createDownloadFailure("download_url_invalid", "protocol", "Download URL must be an absolute HTTPS URL.", false, value);
		}
		if (url.protocol !== "https:") {
			throw createDownloadFailure("download_url_unsupported", "policy", "Only HTTPS workspace downloads are allowed.", false, value);
		}
		if (url.username.length > 0 || url.password.length > 0) {
			throw createDownloadFailure("download_url_credentials_denied", "policy", "Download URLs must not include credentials.", false, value);
		}
		return url;
	}

	async function fetchWorkspaceDownload(inputUrl: URL, signal: AbortSignal, relativePath: string): Promise<{ response: Response; finalUrl: URL }> {
		let currentUrl: URL = inputUrl;
		for (let redirectCount: number = 0; redirectCount <= MAX_WORKSPACE_DOWNLOAD_REDIRECTS; redirectCount += 1) {
			let response: Response;
			try {
				response = await fetch(currentUrl, {
					credentials: "omit",
					redirect: "manual",
					signal
				});
			} catch (error: unknown) {
				if (signal.aborted) {
					throw createDownloadFailure("download_timeout", "environment", "The workspace download timed out.", true, relativePath);
				}
				throw createDownloadFailure(
					"download_network_unavailable",
					"environment",
					`The workspace download could not reach ${currentUrl.origin}: ${error instanceof Error ? error.message : "network error"}`,
					true,
					relativePath
				);
			}
			if (response.status < 300 || response.status >= 400) {
				return { response, finalUrl: currentUrl };
			}
			if (redirectCount === MAX_WORKSPACE_DOWNLOAD_REDIRECTS) {
				throw createDownloadFailure("download_redirect_limit", "environment", "The workspace download exceeded the redirect limit.", true, relativePath);
			}
			const location: string | null = response.headers.get("location");
			if (location === null) {
				throw createDownloadFailure("download_redirect_invalid", "environment", "The workspace download returned a redirect without a destination.", true, relativePath);
			}
			currentUrl = normalizeDownloadUrl(new URL(location, currentUrl).toString());
		}
		throw createDownloadFailure("download_redirect_limit", "environment", "The workspace download exceeded the redirect limit.", true, relativePath);
	}

	async function resolveReadPath(relativePath: string): Promise<ResolvedWorkspacePath> {
		const normalizedPath: string = normalizeRelativePath(relativePath);
		assertNoProtectedSegment(normalizedPath, protectedReadDirectories, "Reading");
		const absolutePath: string = path.resolve(rootPath, normalizedPath);
		if (!isPathInsideRoot(absolutePath, rootPath)) {
			throw new Error(`Path traversal denied: ${relativePath}`);
		}
		await assertNoSymlinkEscape(rootPath, absolutePath);
		return {
			relativePath: toPortableRelativePath(rootPath, absolutePath),
			absolutePath
		};
	}

	async function resolveWritePath(relativePath: string): Promise<ResolvedWorkspacePath> {
		const normalizedPath: string = normalizeRelativePath(relativePath);
		assertNoProtectedSegment(normalizedPath, protectedWriteDirectories);

		let absolutePath: string;
		if (options.validateWritablePath !== undefined) {
			absolutePath = path.resolve(await options.validateWritablePath(normalizedPath));
		} else {
			absolutePath = path.resolve(rootPath, normalizedPath);
		}
		if (!isPathInsideRoot(absolutePath, rootPath)) {
			throw new Error(`Path traversal denied: ${relativePath}`);
		}
		await assertNoSymlinkEscape(rootPath, absolutePath);
		return {
			relativePath: toPortableRelativePath(rootPath, absolutePath),
			absolutePath
		};
	}

	async function readTextFile(relativePath: string, options: WorkspaceTextFileReadOptions = {}): Promise<string> {
		const resolved = await resolveReadPath(relativePath);
		const stat = await fs.stat(resolved.absolutePath);
		if (!stat.isFile()) {
			throw new Error(`Not a file: ${resolved.relativePath}`);
		}
		if (stat.size > readMaxBytes) {
			throw new Error(`File too large: ${resolved.relativePath} (${stat.size} bytes)`);
		}

		const content: string = await fs.readFile(resolved.absolutePath, "utf8");
		const { startLine, endLine } = options;
		if (startLine === undefined && endLine === undefined) {
			return content;
		}
		if (startLine !== undefined && (!Number.isInteger(startLine) || startLine < 1)) {
			throw new Error("startLine must be a 1-based positive integer");
		}
		if (endLine !== undefined && (!Number.isInteger(endLine) || endLine < 1)) {
			throw new Error("endLine must be a 1-based positive integer");
		}
		if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
			throw new Error("endLine must be greater than or equal to startLine");
		}

		const lineStarts: number[] = [0];
		for (let index: number = 0; index < content.length; index += 1) {
			if (content[index] === "\n") {
				lineStarts.push(index + 1);
			}
		}
		const firstLine: number = startLine ?? 1;
		if (firstLine > lineStarts.length) {
			return "";
		}
		const lastLine: number = Math.min(endLine ?? lineStarts.length, lineStarts.length);
		const startOffset: number = lineStarts[firstLine - 1] ?? content.length;
		const endOffset: number = lastLine < lineStarts.length
			? lineStarts[lastLine] ?? content.length
			: content.length;
		return content.slice(startOffset, endOffset);
	}

	async function listFilesDetailed(input?: WorkspaceListFilesInput): Promise<WorkspaceListFilesResult> {
		const start = input?.subdir === undefined
			? { absolutePath: rootPath, relativePath: "" }
			: await resolveReadPath(input.subdir);
		try {
			const startStat = await fs.stat(start.absolutePath);
			if (!startStat.isDirectory()) {
				throw new Error(`Not a directory: ${start.relativePath}`);
			}
		} catch (error: unknown) {
			const code: string | undefined = error instanceof Error && "code" in error
				? String((error as NodeJS.ErrnoException).code)
				: undefined;
			if (input?.subdir !== undefined && code === "ENOENT") {
				return { files: [], directoryExists: false };
			}
			throw error;
		}
		const extensions: Set<string> | undefined = input?.extensions !== undefined && input.extensions.length > 0
			? new Set(input.extensions.map((extension: string): string => extension.startsWith(".") ? extension : `.${extension}`))
			: undefined;
		const limit: number = input?.limit ?? 200;
		const results: string[] = [];

		async function walk(directoryPath: string): Promise<void> {
			if (results.length >= limit) {
				return;
			}

			const entries: Dirent[] = await fs.readdir(directoryPath, { withFileTypes: true });
			for (const entry of entries) {
				if (results.length >= limit) {
					return;
				}
				if (entry.isDirectory() && input?.includeIgnored !== true && ignoredDirectories.has(entry.name)) {
					continue;
				}

				const fullPath: string = path.join(directoryPath, entry.name);
				if (entry.isDirectory()) {
					await walk(fullPath);
					continue;
				}
				if (!entry.isFile()) {
					continue;
				}
				if (extensions !== undefined && !extensions.has(path.extname(entry.name))) {
					continue;
				}
				results.push(toPortableRelativePath(rootPath, fullPath));
			}
		}

		await walk(start.absolutePath);
		results.sort();
		return { files: results, directoryExists: true };
	}

	async function listFiles(input?: WorkspaceListFilesInput): Promise<string[]> {
		return (await listFilesDetailed(input)).files;
	}

	async function searchText(input: {
		query: string;
		extensions?: string[] | undefined;
		limit?: number | undefined;
	}): Promise<Array<{ file: string; line: number; text: string }>> {
		const maxMatches: number = input.limit ?? 50;
		const files: string[] = await listFiles({ extensions: input.extensions, limit: 4000 });
		const matches: Array<{ file: string; line: number; text: string }> = [];

		for (const file of files) {
			if (matches.length >= maxMatches) {
				break;
			}
			let content: string;
			try {
				content = await readTextFile(file);
			} catch {
				continue;
			}
			const lines: string[] = content.split(/\r?\n/u);
			for (let index: number = 0; index < lines.length; index += 1) {
				const lineText: string | undefined = lines[index];
				if (lineText === undefined || !lineText.includes(input.query)) {
					continue;
				}
				matches.push({
					file,
					line: index + 1,
					text: lineText.trim()
				});
				if (matches.length >= maxMatches) {
					break;
				}
			}
		}

		return matches;
	}

	async function validateNewTextFile(relativePath: string, content: string): Promise<WorkspaceFileValidation> {
		const errors: string[] = [];
		if (content.length === 0) {
			errors.push("File content is empty");
		}
		if (content.length > newFileMaxBytes) {
			errors.push(`Content too large: ${content.length} bytes (max ${newFileMaxBytes})`);
		}

		let resolved: ResolvedWorkspacePath;
		try {
			resolved = await resolveWritePath(relativePath);
		} catch (error: unknown) {
			return {
				valid: false,
				path: relativePath,
				errors: [error instanceof Error ? error.message : "Path validation failed"]
			};
		}

		errors.push(...(options.validateContent?.({ relativePath: resolved.relativePath, content, operation: "create" }) ?? []));

		try {
			await fs.access(resolved.absolutePath);
			errors.push(`File already exists: ${resolved.relativePath}`);
		} catch {
			// File must not exist for create.
		}

		return {
			valid: errors.length === 0,
			path: resolved.relativePath,
			resolvedPath: resolved.absolutePath,
			errors
		};
	}

	async function createTextFile(relativePath: string, content: string): Promise<{ created: true; path: string; size: number }> {
		const validation = await validateNewTextFile(relativePath, content);
		if (!validation.valid || validation.resolvedPath === undefined) {
			throw new Error(validation.errors.join("; "));
		}
		await fs.mkdir(path.dirname(validation.resolvedPath), { recursive: true });
		await fs.writeFile(validation.resolvedPath, content, "utf8");
		return {
			created: true,
			path: validation.path,
			size: content.length
		};
	}

	async function validateOverwriteTextFile(relativePath: string, content: string): Promise<WorkspaceFileValidation & { oldSize?: number | undefined }> {
		const errors: string[] = [];
		if (content.length === 0) {
			errors.push("File content is empty");
		}
		if (content.length > writeMaxBytes) {
			errors.push(`Content too large: ${content.length} bytes (max ${writeMaxBytes})`);
		}

		let resolved: ResolvedWorkspacePath;
		try {
			resolved = await resolveWritePath(relativePath);
		} catch (error: unknown) {
			return {
				valid: false,
				path: relativePath,
				errors: [error instanceof Error ? error.message : "Path validation failed"]
			};
		}

		errors.push(...(options.validateContent?.({ relativePath: resolved.relativePath, content, operation: "overwrite" }) ?? []));
		let oldContent: string | undefined;
		try {
			oldContent = await fs.readFile(resolved.absolutePath, "utf8");
		} catch {
			errors.push(`File does not exist: ${resolved.relativePath}`);
		}

		return {
			valid: errors.length === 0,
			path: resolved.relativePath,
			resolvedPath: resolved.absolutePath,
			errors,
			oldSize: oldContent?.length
		};
	}

	async function overwriteTextFile(relativePath: string, content: string): Promise<{ overwritten: true; path: string; size: number; oldSize: number }> {
		const validation = await validateOverwriteTextFile(relativePath, content);
		if (!validation.valid || validation.resolvedPath === undefined) {
			throw new Error(validation.errors.join("; "));
		}
		const oldContent: string = await fs.readFile(validation.resolvedPath, "utf8");
		await fs.writeFile(validation.resolvedPath, content, "utf8");
		return {
			overwritten: true,
			path: validation.path,
			size: content.length,
			oldSize: oldContent.length
		};
	}

	async function replaceTextInFile(relativePath: string, oldText: string, newText: string): Promise<{ replaced: true; path: string; occurrences: number; size: number; oldSize: number }> {
		if (oldText.length === 0) {
			throw new Error("oldText must not be empty");
		}
		const resolved = await resolveWritePath(relativePath);
		const oldContent: string = await fs.readFile(resolved.absolutePath, "utf8");
		if (!oldContent.includes(oldText)) {
			throw new StructuredToolError({
				code: "old_text_not_found",
				category: "business",
				message: "The requested text was not found in the current file content.",
				retryable: true,
				artifactRefs: [resolved.relativePath]
			});
		}
		const occurrenceCount: number = oldContent.split(oldText).length - 1;
		const newContent: string = oldContent.replace(oldText, newText);
		if (newContent.length > writeMaxBytes) {
			throw new Error(`Content too large after replacement: ${newContent.length} bytes (max ${writeMaxBytes})`);
		}
		const contentErrors: string[] = options.validateContent?.({ relativePath: resolved.relativePath, content: newContent, operation: "replace" }) ?? [];
		if (contentErrors.length > 0) {
			throw new Error(`Content validation failed: ${contentErrors.join("; ")}`);
		}
		await fs.writeFile(resolved.absolutePath, newContent, "utf8");
		return {
			replaced: true,
			path: resolved.relativePath,
			occurrences: occurrenceCount,
			size: newContent.length,
			oldSize: oldContent.length
		};
	}

	async function replaceLineInFile(relativePath: string, lineNumber: number, expectedText: string, newText: string): Promise<{ replaced: true; path: string; lineNumber: number; size: number; oldSize: number }> {
		if (!Number.isInteger(lineNumber) || lineNumber < 1) {
			throw new Error("lineNumber must be a 1-based positive integer");
		}
		const resolved = await resolveWritePath(relativePath);
		const oldContent: string = await fs.readFile(resolved.absolutePath, "utf8");
		const newline: string = oldContent.includes("\r\n") ? "\r\n" : "\n";
		const lines: string[] = oldContent.split(/\r?\n/u);
		const index: number = lineNumber - 1;
		const currentLine: string | undefined = lines[index];
		if (currentLine === undefined) {
			throw new Error(`lineNumber is outside file: ${lineNumber}`);
		}
		if (currentLine !== expectedText) {
			throw new StructuredToolError({
				code: "expected_text_mismatch",
				category: "business",
				message: "expectedText does not match the current line content.",
				retryable: true,
				artifactRefs: [resolved.relativePath],
				details: { lineNumber }
			});
		}
		lines[index] = newText;
		const newContent: string = lines.join(newline);
		if (newContent.length > writeMaxBytes) {
			throw new Error(`Content too large after replacement: ${newContent.length} bytes (max ${writeMaxBytes})`);
		}
		const contentErrors: string[] = options.validateContent?.({ relativePath: resolved.relativePath, content: newContent, operation: "replace-line" }) ?? [];
		if (contentErrors.length > 0) {
			throw new Error(`Content validation failed: ${contentErrors.join("; ")}`);
		}
		await fs.writeFile(resolved.absolutePath, newContent, "utf8");
		return {
			replaced: true,
			path: resolved.relativePath,
			lineNumber,
			size: newContent.length,
			oldSize: oldContent.length
		};
	}

	async function deleteFile(relativePath: string): Promise<{ deleted: true; path: string }> {
		const resolved = await resolveWritePath(relativePath);
		const stat = await fs.stat(resolved.absolutePath);
		if (!stat.isFile()) {
			throw new Error(`Not a file: ${resolved.relativePath}`);
		}
		await fs.unlink(resolved.absolutePath);
		return {
			deleted: true,
			path: resolved.relativePath
		};
	}

	async function downloadFile(input: WorkspaceDownloadInput): Promise<{
		ok: true;
		downloaded: true;
		path: string;
		size: number;
		sha256: string;
		sourceUrl: string;
		finalUrl: string;
		overwritten: boolean;
	}> {
		const resolved = await resolveWritePath(input.relativePath);
		const sourceUrl: URL = normalizeDownloadUrl(input.url);
		const expectedSha256: string | undefined = input.expectedSha256?.trim().toLowerCase();
		if (expectedSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(expectedSha256)) {
			throw createDownloadFailure("download_checksum_invalid", "protocol", "expectedSha256 must be a 64-character SHA-256 hex digest.", false, resolved.relativePath);
		}

		let overwritten: boolean = false;
		try {
			const existing = await fs.stat(resolved.absolutePath);
			if (!existing.isFile()) {
				throw createDownloadFailure("download_target_not_file", "business", `Download target is not a file: ${resolved.relativePath}`, false, resolved.relativePath);
			}
			overwritten = true;
			if (input.overwrite !== true) {
				throw createDownloadFailure("download_target_exists", "business", `Download target already exists: ${resolved.relativePath}`, false, resolved.relativePath);
			}
		} catch (error: unknown) {
			if (error instanceof StructuredToolError) throw error;
			const code: string | undefined = error instanceof Error && "code" in error
				? String((error as NodeJS.ErrnoException).code)
				: undefined;
			if (code !== "ENOENT") throw error;
		}

		await fs.mkdir(path.dirname(resolved.absolutePath), { recursive: true });
		const controller = new AbortController();
		const timeout = setTimeout((): void => controller.abort(), DEFAULT_WORKSPACE_DOWNLOAD_TIMEOUT_MS);
		const temporaryPath: string = `${resolved.absolutePath}.daedalus-download-${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
		let handle: fs.FileHandle | undefined;
		try {
			const { response, finalUrl } = await fetchWorkspaceDownload(sourceUrl, controller.signal, resolved.relativePath);
			if (!response.ok) {
				throw createDownloadFailure(
					"download_http_error",
					"environment",
					`The workspace download failed with HTTP ${response.status}.`,
					response.status >= 500 || response.status === 429,
					resolved.relativePath
				);
			}
			if (response.body === null) {
				throw createDownloadFailure("download_empty_response", "environment", "The workspace download returned no response body.", true, resolved.relativePath);
			}
			const declaredSizeText: string | null = response.headers.get("content-length");
			const declaredSize: number | undefined = declaredSizeText === null ? undefined : Number(declaredSizeText);
			if (declaredSize !== undefined && (!Number.isFinite(declaredSize) || declaredSize < 0 || declaredSize > downloadMaxBytes)) {
				throw createDownloadFailure("download_too_large", "policy", `The workspace download exceeds the ${downloadMaxBytes} byte limit.`, false, resolved.relativePath);
			}

			handle = await fs.open(temporaryPath, "wx");
			const hash = createHash("sha256");
			let size: number = 0;
			for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
				const bytes: Uint8Array = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
				size += bytes.byteLength;
				if (size > downloadMaxBytes) {
					throw createDownloadFailure("download_too_large", "policy", `The workspace download exceeds the ${downloadMaxBytes} byte limit.`, false, resolved.relativePath);
				}
				hash.update(bytes);
				await handle.write(bytes);
			}
			await handle.close();
			handle = undefined;
			const sha256: string = hash.digest("hex");
			if (expectedSha256 !== undefined && sha256 !== expectedSha256) {
				throw createDownloadFailure("download_checksum_mismatch", "business", "The downloaded file did not match expectedSha256.", false, resolved.relativePath);
			}
			await fs.rename(temporaryPath, resolved.absolutePath);
			return {
				ok: true,
				downloaded: true,
				path: resolved.relativePath,
				size,
				sha256,
				sourceUrl: sourceUrl.toString(),
				finalUrl: finalUrl.toString(),
				overwritten
			};
		} finally {
			clearTimeout(timeout);
			await handle?.close().catch((): void => undefined);
			await fs.rm(temporaryPath, { force: true }).catch((): void => undefined);
		}
	}

	return {
		rootPath,
		listFiles,
		listFilesDetailed,
		searchText,
		readTextFile,
		validateNewTextFile,
		createTextFile,
		validateOverwriteTextFile,
		overwriteTextFile,
		replaceTextInFile,
		replaceLineInFile,
		deleteFile,
		downloadFile,
		resolveReadPath,
		resolveWritePath
	};
}
