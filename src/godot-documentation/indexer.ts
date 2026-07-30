import { lstat, mkdir, readdir, readFile, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { GodotDocumentationScope } from "./types.js";

const MAX_SOURCE_FILES: number = 20_000;
const MAX_SOURCE_BYTES: number = 512 * 1024 * 1024;
const TARGET_CHUNK_CHARS: number = 4_000;
const MAX_CHUNK_CHARS: number = 6_000;
const HEADING_UNDERLINE_PATTERN: RegExp = /^[=\-~^"`:+*#<>]{3,}\s*$/u;
const CLASS_ANCHOR_PATTERN: RegExp = /^class_([^_]+)_(method|property|signal|enum|constant|theme_property|constructor|operator)_(.+)$/u;

export type DocumentationChunk = {
	category: Exclude<GodotDocumentationScope, "all">;
	path: string;
	anchor: string | null;
	title: string;
	symbol: string | null;
	body: string;
};

export type DocumentationIndexSummary = {
	documentCount: number;
	chunkCount: number;
	classCount: number;
	sizeBytes: number;
};

function normalizeRstInline(text: string): string {
	return text
		.replace(/:(?:ref|doc|class|method|attr|signal|enum|const):`([^`<]+)(?:\s*<[^`>]+>)?`/gu, "$1")
		.replace(/``([^`]+)``/gu, "$1")
		.replace(/\*\*([^*]+)\*\*/gu, "$1")
		.replace(/\*([^*]+)\*/gu, "$1")
		.replace(/\\([ *|])/gu, "$1")
		.trimEnd();
}

function cleanRstLines(lines: string[]): string {
	const output: string[] = [];
	let previousBlank: boolean = true;
	for (const rawLine of lines) {
		const trimmed: string = rawLine.trim();
		if (
			trimmed.startsWith(".. _")
			|| trimmed.startsWith(":github_url:")
			|| trimmed.startsWith(".. rst-class::")
			|| trimmed.startsWith(".. toctree::")
			|| trimmed.startsWith(":maxdepth:")
			|| trimmed.startsWith(":hidden:")
			|| /^\s*\+[-+]+\+\s*$/u.test(rawLine)
			|| /^\s*\|[ =|+-]+\|\s*$/u.test(rawLine)
		) {
			continue;
		}
		const line: string = normalizeRstInline(rawLine);
		const blank: boolean = line.trim().length === 0;
		if (blank && previousBlank) {
			continue;
		}
		output.push(line);
		previousBlank = blank;
	}
	return output.join("\n").trim();
}

function splitLargeBody(body: string): string[] {
	if (body.length <= MAX_CHUNK_CHARS) {
		return [body];
	}
	const paragraphs: string[] = body.split(/\n{2,}/u);
	const chunks: string[] = [];
	let current: string = "";
	for (const paragraph of paragraphs) {
		const candidate: string = current.length === 0 ? paragraph : `${current}\n\n${paragraph}`;
		if (candidate.length <= TARGET_CHUNK_CHARS || current.length === 0) {
			current = candidate;
			continue;
		}
		chunks.push(current.slice(0, MAX_CHUNK_CHARS));
		current = paragraph;
	}
	if (current.length > 0) {
		for (let offset: number = 0; offset < current.length; offset += MAX_CHUNK_CHARS) {
			chunks.push(current.slice(offset, offset + MAX_CHUNK_CHARS));
		}
	}
	return chunks.filter((chunk: string): boolean => chunk.trim().length > 0);
}

function classTitleFromPath(filePath: string): string {
	const fileName: string = filePath.replaceAll("\\", "/").split("/").pop() ?? "Godot";
	const match: RegExpMatchArray | null = fileName.match(/^class_(.+)\.rst$/u);
	if (match === null) {
		return fileName.replace(/\.rst$/u, "");
	}
	return match[1]!
		.split("_")
		.map((part: string): string => part.length === 0 ? part : `${part[0]!.toUpperCase()}${part.slice(1)}`)
		.join("");
}

function symbolFromAnchor(anchor: string | null, classTitle: string): string | null {
	if (anchor === null) {
		return null;
	}
	const match: RegExpMatchArray | null = anchor.match(CLASS_ANCHOR_PATTERN);
	if (match === null) {
		return anchor === `class_${classTitle}` ? classTitle : null;
	}
	const member: string = match[3]!;
	return `${match[1]}.${member}`;
}

function findHeading(lines: string[], index: number): string | null {
	if (index + 1 >= lines.length || lines[index]!.trim().length === 0) {
		return null;
	}
	return HEADING_UNDERLINE_PATTERN.test(lines[index + 1]!) ? normalizeRstInline(lines[index]!.trim()) : null;
}

export function parseRstDocument(filePath: string, source: string): DocumentationChunk[] {
	const normalizedPath: string = filePath.replaceAll("\\", "/");
	const category: DocumentationChunk["category"] = normalizedPath.startsWith("classes/class_")
		? "class_reference"
		: "manual";
	const declaredClassTitle: string | undefined = source
		.match(/^\.\. _class_([^:\r\n]+):\s*$/mu)?.[1];
	const classTitle: string = declaredClassTitle?.trim() || classTitleFromPath(normalizedPath);
	const lines: string[] = source.replaceAll("\r\n", "\n").split("\n");
	const sections: Array<{ anchor: string | null; title: string; lines: string[] }> = [];
	let anchor: string | null = null;
	let pendingManualAnchor: string | null = null;
	let title: string = category === "class_reference" ? classTitle : normalizedPath.replace(/\.rst$/u, "");
	let bodyLines: string[] = [];

	const flush = (): void => {
		const body: string = cleanRstLines(bodyLines);
		if (body.length > 0) {
			sections.push({ anchor, title, lines: bodyLines });
		}
		bodyLines = [];
	};

	for (let index: number = 0; index < lines.length; index += 1) {
		const line: string = lines[index]!;
		const anchorMatch: RegExpMatchArray | null = line.trim().match(/^\.\. _([^:]+):$/u);
		const heading: string | null = findHeading(lines, index);
		const classMemberAnchor: boolean = category === "class_reference"
			&& anchorMatch !== null
			&& (anchorMatch[1]!.startsWith(`class_${classTitle}_`) || anchorMatch[1] === `class_${classTitle}`);
		if (classMemberAnchor) {
			flush();
			anchor = anchorMatch![1]!;
			title = symbolFromAnchor(anchor, classTitle) ?? classTitle;
			continue;
		}
		if (category === "manual" && heading !== null) {
			flush();
			title = heading;
			anchor = pendingManualAnchor;
			pendingManualAnchor = null;
			bodyLines.push(line);
			index += 1;
			continue;
		}
		if (anchorMatch !== null) {
			if (category === "manual") {
				pendingManualAnchor = anchorMatch[1]!;
			} else {
				anchor = anchorMatch[1]!;
			}
			continue;
		}
		bodyLines.push(line);
	}
	flush();

	const chunks: DocumentationChunk[] = [];
	for (const section of sections) {
		const cleaned: string = cleanRstLines(section.lines);
		const bodies: string[] = splitLargeBody(cleaned);
		for (const [index, body] of bodies.entries()) {
			chunks.push({
				category,
				path: normalizedPath,
				anchor: section.anchor,
				title: bodies.length === 1 ? section.title : `${section.title} (${index + 1})`,
				symbol: category === "class_reference" ? symbolFromAnchor(section.anchor, classTitle) ?? classTitle : null,
				body
			});
		}
	}
	return chunks;
}

async function findDocumentationRoot(extractedRoot: string): Promise<string> {
	const queue: Array<{ path: string; depth: number }> = [{ path: extractedRoot, depth: 0 }];
	let inspectedDirectories: number = 0;
	while (queue.length > 0 && inspectedDirectories < 64) {
		const candidate = queue.shift()!;
		inspectedDirectories += 1;
		try {
			const [confStats, classesStats] = await Promise.all([
				lstat(join(candidate.path, "conf.py")),
				lstat(join(candidate.path, "classes"))
			]);
			if (confStats.isFile() && classesStats.isDirectory()) {
				return candidate.path;
			}
		} catch {
			// 继续搜索受限深度内的 GitHub archive 根目录。
		}
		if (candidate.depth >= 3) {
			continue;
		}
		const entries: Dirent[] = await readdir(candidate.path, { withFileTypes: true });
		for (const entry of entries.sort((left, right): number => left.name.localeCompare(right.name))) {
			if (entry.isDirectory()) {
				queue.push({
					path: join(candidate.path, entry.name),
					depth: candidate.depth + 1
				});
			}
		}
	}
	const topLevelEntries: string[] = (await readdir(extractedRoot, { withFileTypes: true }))
		.slice(0, 12)
		.map((entry: Dirent): string => `${entry.name}${entry.isDirectory() ? "/" : ""}`);
	throw new Error(
		"The downloaded archive does not contain a recognizable godot-docs source tree "
		+ `(expected conf.py and classes/; top-level entries: ${topLevelEntries.join(", ") || "none"}).`
	);
}

async function collectRstFiles(root: string): Promise<Array<{ absolutePath: string; relativePath: string; size: number }>> {
	const queue: string[] = [root];
	const files: Array<{ absolutePath: string; relativePath: string; size: number }> = [];
	let totalBytes: number = 0;
	while (queue.length > 0) {
		const current: string = queue.shift()!;
		const entries: Dirent[] = await readdir(current, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name === ".git" || entry.name === ".github" || entry.name === "_build" || entry.name === "__pycache__") {
				continue;
			}
			const absolutePath: string = join(current, entry.name);
			const stats = await lstat(absolutePath);
			if (stats.isSymbolicLink()) {
				throw new Error(`Symbolic links are not allowed in documentation archives: ${relative(root, absolutePath)}`);
			}
			if (stats.isDirectory()) {
				queue.push(absolutePath);
				continue;
			}
			if (!stats.isFile() || !entry.name.endsWith(".rst")) {
				continue;
			}
			totalBytes += stats.size;
			if (totalBytes > MAX_SOURCE_BYTES) {
				throw new Error("Godot documentation source exceeds the allowed uncompressed size.");
			}
			files.push({
				absolutePath,
				relativePath: relative(root, absolutePath).split(sep).join("/"),
				size: stats.size
			});
			if (files.length > MAX_SOURCE_FILES) {
				throw new Error("Godot documentation source contains too many files.");
			}
		}
	}
	return files.sort((left, right): number => left.relativePath.localeCompare(right.relativePath));
}

function createIndexSchema(db: DatabaseSync): void {
	db.exec(`
		PRAGMA journal_mode = OFF;
		PRAGMA synchronous = OFF;
		CREATE TABLE metadata (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
		CREATE TABLE chunks (
			id INTEGER PRIMARY KEY,
			category TEXT NOT NULL,
			path TEXT NOT NULL,
			anchor TEXT,
			title TEXT NOT NULL,
			symbol TEXT,
			body TEXT NOT NULL
		);
		CREATE INDEX chunks_symbol_idx ON chunks(symbol COLLATE NOCASE);
		CREATE VIRTUAL TABLE chunks_fts USING fts5(
			title,
			symbol,
			body,
			content = 'chunks',
			content_rowid = 'id',
			tokenize = 'unicode61'
		);
	`);
}

export async function buildGodotDocumentationIndex(params: {
	extractedRoot: string;
	indexPath: string;
	branch: string;
	commitSha: string;
	onProgress?: ((progress: number) => void) | undefined;
	signal?: AbortSignal | undefined;
}): Promise<DocumentationIndexSummary> {
	const documentationRoot: string = await findDocumentationRoot(params.extractedRoot);
	const files = await collectRstFiles(documentationRoot);
	await mkdir(dirname(params.indexPath), { recursive: true });
	const sqlite = await import("node:sqlite");
	const db: DatabaseSync = new sqlite.DatabaseSync(params.indexPath);
	let chunkCount: number = 0;
	let classCount: number = 0;
	try {
		createIndexSchema(db);
		const insertChunk: StatementSync = db.prepare(`
			INSERT INTO chunks(category, path, anchor, title, symbol, body)
			VALUES (?, ?, ?, ?, ?, ?)
		`);
		const insertFts: StatementSync = db.prepare(`
			INSERT INTO chunks_fts(rowid, title, symbol, body)
			VALUES (?, ?, ?, ?)
		`);
		const insertMetadata: StatementSync = db.prepare("INSERT INTO metadata(key, value) VALUES (?, ?)");
		insertMetadata.run("schemaVersion", "1");
		insertMetadata.run("branch", params.branch);
		insertMetadata.run("commitSha", params.commitSha);
		insertMetadata.run("sourceRepository", "https://github.com/godotengine/godot-docs");
		insertMetadata.run("manualLicense", "CC BY 3.0");
		insertMetadata.run("classReferenceLicense", "MIT");
		insertMetadata.run(
			"licenseUrl",
			`https://github.com/godotengine/godot-docs/blob/${params.commitSha}/LICENSE.txt`
		);

		db.exec("BEGIN");
		try {
			for (const [fileIndex, file] of files.entries()) {
				if (params.signal?.aborted === true) {
					throw new Error("Documentation import cancelled.");
				}
				const source: string = await readFile(file.absolutePath, "utf8");
				const chunks: DocumentationChunk[] = parseRstDocument(file.relativePath, source);
				if (file.relativePath.startsWith("classes/class_")) {
					classCount += 1;
				}
				for (const chunk of chunks) {
					const result = insertChunk.run(
						chunk.category,
						chunk.path,
						chunk.anchor,
						chunk.title,
						chunk.symbol,
						chunk.body
					);
					insertFts.run(result.lastInsertRowid, chunk.title, chunk.symbol ?? "", chunk.body);
					chunkCount += 1;
				}
				params.onProgress?.(files.length === 0 ? 1 : (fileIndex + 1) / files.length);
			}
			db.exec("COMMIT");
		} catch (error: unknown) {
			db.exec("ROLLBACK");
			throw error;
		}
		db.exec("PRAGMA optimize");
	} finally {
		db.close();
	}
	const indexStats = await stat(params.indexPath);
	return {
		documentCount: files.length,
		chunkCount,
		classCount,
		sizeBytes: indexStats.size
	};
}
