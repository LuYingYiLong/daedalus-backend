import { createWorkspaceFileService, type WorkspaceListFilesInput } from "./files.js";
import type { WorkspaceFileRef } from "./source-context.js";
import { createWorkspaceFileRef } from "./source-context.js";
import type { WorkspaceConfig, WorkspaceSourceFolder } from "./types.js";

const SOURCE_INDEX_TTL_MS: number = 5_000;
const SEARCH_FILE_LIMIT: number = 4_000;
const SEARCH_CONCURRENCY: number = 4;

export type IndexedFile = {
	file: string;
	fileRef: WorkspaceFileRef;
	sourceFolderId: string;
	sourceName: string;
};

export type IndexedSearchMatch = IndexedFile & {
	line: number;
	text: string;
};

type FileCacheEntry = {
	expiresAt: number;
	files: string[];
	directoryExists: boolean;
};

function sourceName(source: WorkspaceSourceFolder): string {
	const normalized: string = source.path.replaceAll("\\", "/").replace(/\/+$/u, "");
	return normalized.slice(normalized.lastIndexOf("/") + 1) || source.id;
}

function normalizeExtensions(extensions: string[] | undefined): string {
	return (extensions ?? [])
		.map((extension: string): string => extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`)
		.sort()
		.join(",");
}

function fileCacheKey(source: WorkspaceSourceFolder, input: WorkspaceListFilesInput): string {
	return [
		source.id,
		input.subdir ?? "",
		normalizeExtensions(input.extensions),
		input.includeIgnored === true ? "1" : "0",
		String(input.limit ?? 2_000)
	].join("\u0000");
}

export class WorkspaceSourceIndex {
	private readonly fileCache: Map<string, FileCacheEntry> = new Map();

	async listSourceFiles(
		workspace: WorkspaceConfig,
		source: WorkspaceSourceFolder,
		input: WorkspaceListFilesInput = {}
	): Promise<{ files: IndexedFile[]; directoryExists: boolean }> {
		const key: string = `${workspace.id}\u0000${fileCacheKey(source, input)}`;
		const cached: FileCacheEntry | undefined = this.fileCache.get(key);
		const now: number = Date.now();
		let result: FileCacheEntry;
		if (cached !== undefined && cached.expiresAt > now) {
			result = cached;
		} else {
			const service = createWorkspaceFileService({ rootPath: source.path });
			const listed = await service.listFilesDetailed(input);
			result = { expiresAt: now + SOURCE_INDEX_TTL_MS, files: listed.files, directoryExists: listed.directoryExists };
			this.fileCache.set(key, result);
			return {
				files: this.toIndexedFiles(workspace, source, result.files),
				directoryExists: result.directoryExists
			};
		}
		return {
			files: this.toIndexedFiles(workspace, source, result.files),
			directoryExists: result.directoryExists
		};
	}

	async searchSource(
		workspace: WorkspaceConfig,
		source: WorkspaceSourceFolder,
		input: { query: string; extensions?: string[] | undefined; limit?: number | undefined; subdir?: string | undefined }
	): Promise<IndexedSearchMatch[]> {
		const service = createWorkspaceFileService({ rootPath: source.path });
		const maxMatches: number = Math.max(1, Math.min(input.limit ?? 50, 500));
		const listed = await this.listSourceFiles(workspace, source, {
			subdir: input.subdir,
			extensions: input.extensions,
			limit: SEARCH_FILE_LIMIT
		});
		if (!listed.directoryExists) return [];
		const matches: IndexedSearchMatch[] = [];
		let nextIndex: number = 0;
		const worker = async (): Promise<void> => {
			while (true) {
				if (matches.length >= maxMatches) return;
				const index: number = nextIndex;
				nextIndex += 1;
				const file: IndexedFile | undefined = listed.files[index];
				if (file === undefined) return;
				let content: string;
				try {
					content = await service.readTextFile(file.file);
				} catch {
					continue;
				}
				const lines: string[] = content.split(/\r?\n/u);
				for (let lineIndex: number = 0; lineIndex < lines.length && matches.length < maxMatches; lineIndex += 1) {
					const text: string | undefined = lines[lineIndex];
					if (text === undefined || !text.includes(input.query)) continue;
					matches.push({ ...file, line: lineIndex + 1, text: text.trim() });
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(SEARCH_CONCURRENCY, listed.files.length) }, worker));
		return matches
			.sort((left: IndexedSearchMatch, right: IndexedSearchMatch): number =>
				left.file.localeCompare(right.file) || left.line - right.line)
			.slice(0, maxMatches);
	}

	invalidateSource(workspaceId: string, sourceFolderId?: string | undefined): void {
		const prefix: string = `${workspaceId}\u0000`;
		for (const key of this.fileCache.keys()) {
			if (!key.startsWith(prefix)) continue;
			if (sourceFolderId === undefined || key.includes(`\u0000${sourceFolderId}\u0000`)) {
				this.fileCache.delete(key);
			}
		}
	}

	clear(): void {
		this.fileCache.clear();
	}

	private toIndexedFiles(workspace: WorkspaceConfig, source: WorkspaceSourceFolder, files: string[]): IndexedFile[] {
		return files.map((file: string): IndexedFile => {
			const fileRef: WorkspaceFileRef = createWorkspaceFileRef(workspace, source.id, file);
			return {
				file,
				fileRef,
				sourceFolderId: source.id,
				sourceName: sourceName(source)
			};
		});
	}
}
