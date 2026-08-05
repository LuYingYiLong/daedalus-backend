import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const DEFAULT_WORKSPACE_TEXT_FILE_BYTES: number = 512 * 1024;
export const DEFAULT_WORKSPACE_NEW_FILE_BYTES: number = 64 * 1024;

const DEFAULT_IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
	".git",
	".daedalus",
	".godot",
	"node_modules"
]);

const PROTECTED_WRITE_DIRECTORIES: ReadonlySet<string> = new Set([
	".git",
	".daedalus"
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

function assertNoProtectedSegment(relativePath: string, protectedDirectories: ReadonlySet<string>): void {
	const segments: string[] = relativePath.split("/").filter((segment: string): boolean => segment.length > 0);
	for (const segment of segments) {
		if (segment === ".." || segment === ".") {
			throw new Error(`Path traversal denied: ${relativePath}`);
		}
		if (protectedDirectories.has(segment)) {
			throw new Error(`Writing to ${segment}/ is not allowed`);
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
	const protectedWriteDirectories: ReadonlySet<string> = options.protectedWriteDirectories ?? PROTECTED_WRITE_DIRECTORIES;
	const readMaxBytes: number = options.readMaxBytes ?? DEFAULT_WORKSPACE_TEXT_FILE_BYTES;
	const newFileMaxBytes: number = options.newFileMaxBytes ?? DEFAULT_WORKSPACE_NEW_FILE_BYTES;
	const writeMaxBytes: number = options.writeMaxBytes ?? readMaxBytes;

	async function resolveReadPath(relativePath: string): Promise<ResolvedWorkspacePath> {
		const normalizedPath: string = normalizeRelativePath(relativePath);
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
		const limit: number = input?.limit ?? 2000;
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
			throw new Error("oldText was not found in file");
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
			throw new Error("expectedText does not match the current line");
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
		resolveReadPath,
		resolveWritePath
	};
}
