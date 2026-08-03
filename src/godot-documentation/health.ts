import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type {
	GodotDocumentationGenerationManifest,
	GodotDocumentationHealth,
	GodotDocumentationRecord
} from "./types.js";
import { getGodotDocumentationGenerationDir, getGodotDocumentationPackageDir } from "./store.js";

export const DOCUMENTATION_INDEX_FORMAT_VERSION: 1 = 1;

export class DocumentationIndexError extends Error {
	readonly code: string;

	constructor(code: string, message: string, options?: ErrorOptions) {
		super(message, options);
		this.code = code;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readManifest(value: unknown): GodotDocumentationGenerationManifest {
	if (!isRecord(value)
		|| value.schemaVersion !== 1
		|| value.indexFormatVersion !== DOCUMENTATION_INDEX_FORMAT_VERSION
		|| typeof value.generationId !== "string"
		|| typeof value.branch !== "string"
		|| typeof value.commitSha !== "string"
		|| !/^[0-9a-f]{40}$/u.test(value.commitSha)
		|| (value.sourceSha256 !== null && (typeof value.sourceSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.sourceSha256)))
		|| typeof value.sqliteSha256 !== "string"
		|| !/^[0-9a-f]{64}$/u.test(value.sqliteSha256)
		|| typeof value.documentCount !== "number"
		|| typeof value.chunkCount !== "number"
		|| typeof value.classCount !== "number"
		|| typeof value.sizeBytes !== "number"
		|| typeof value.builtAt !== "string"
		|| typeof value.verifiedAt !== "string") {
		throw new DocumentationIndexError("documentation_index_incompatible", "Documentation generation manifest is invalid or incompatible.");
	}
	return value as GodotDocumentationGenerationManifest;
}

export async function readDocumentationGenerationManifest(generationDir: string): Promise<GodotDocumentationGenerationManifest> {
	try {
		return readManifest(JSON.parse(await readFile(join(generationDir, "manifest.json"), "utf8")) as unknown);
	} catch (error: unknown) {
		if (error instanceof DocumentationIndexError) throw error;
		const code: string = (error as NodeJS.ErrnoException).code === "ENOENT"
			? "documentation_index_missing"
			: "documentation_index_incompatible";
		throw new DocumentationIndexError(code, code === "documentation_index_missing"
			? "Documentation generation manifest is missing."
			: "Documentation generation manifest cannot be read.", { cause: error });
	}
}

export async function sha256File(path: string): Promise<string> {
	return new Promise<string>((resolvePromise, rejectPromise): void => {
		const hash = createHash("sha256");
		const stream = createReadStream(path);
		stream.on("data", (chunk: Buffer): void => { hash.update(chunk); });
		stream.once("error", rejectPromise);
		stream.once("end", (): void => resolvePromise(hash.digest("hex")));
	});
}

function mapSqliteError(error: unknown): DocumentationIndexError {
	const message: string = error instanceof Error ? error.message : String(error);
	if (/SQLITE_(?:BUSY|LOCKED)|database is locked/iu.test(message)) {
		return new DocumentationIndexError("documentation_index_busy", "Documentation index is busy. Try again shortly.", { cause: error });
	}
	if (/no such table|malformed|not a database|database disk image is malformed/iu.test(message)) {
		return new DocumentationIndexError("documentation_index_corrupt", "Documentation index is corrupt.", { cause: error });
	}
	return new DocumentationIndexError("documentation_index_corrupt", "Documentation index could not be opened.", { cause: error });
}

async function inspectSqlite(indexPath: string, deep: boolean): Promise<{
	documentCount: number;
	chunkCount: number;
	classCount: number;
	branch: string | null;
	commitSha: string | null;
}> {
	let db: DatabaseSync | null = null;
	try {
		await access(indexPath);
		const sqlite = await import("node:sqlite");
		db = new sqlite.DatabaseSync(indexPath, { readOnly: true, timeout: 1_000 });
		const tables = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all() as Array<{ name: string }>;
		const tableNames: Set<string> = new Set(tables.map((row): string => row.name));
		for (const required of ["metadata", "chunks", "chunks_fts"]) {
			if (!tableNames.has(required)) {
				throw new DocumentationIndexError("documentation_index_incompatible", `Documentation index is missing required table ${required}.`);
			}
		}
		const metadata = new Map((db.prepare("SELECT key, value FROM metadata").all() as Array<{ key: string; value: string }>)
			.map((row): [string, string] => [row.key, row.value]));
		if (metadata.get("schemaVersion") !== String(DOCUMENTATION_INDEX_FORMAT_VERSION)) {
			throw new DocumentationIndexError("documentation_index_incompatible", "Documentation index format is incompatible.");
		}
		if (deep) {
			const quick = db.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
			const values: string[] = quick.flatMap((row): string[] => Object.values(row).map(String));
			if (values.length !== 1 || values[0] !== "ok") {
				throw new DocumentationIndexError("documentation_index_corrupt", `Documentation index integrity check failed: ${values.join(", ")}`);
			}
		}
		const chunkCount = Number((db.prepare("SELECT count(*) AS count FROM chunks").get() as { count: number }).count);
		const ftsCount = Number((db.prepare("SELECT count(*) AS count FROM chunks_fts").get() as { count: number }).count);
		const documentCount = Number((db.prepare("SELECT count(DISTINCT path) AS count FROM chunks").get() as { count: number }).count);
		const classCount = Number((db.prepare("SELECT count(DISTINCT path) AS count FROM chunks WHERE category = 'class_reference'").get() as { count: number }).count);
		if (chunkCount !== ftsCount) {
			throw new DocumentationIndexError("documentation_index_corrupt", "Documentation full-text index row count does not match its source table.");
		}
		if (deep && chunkCount > 0) {
			const smoke = db.prepare("SELECT rowid FROM chunks_fts LIMIT 1").get();
			if (smoke === undefined) {
				throw new DocumentationIndexError("documentation_index_corrupt", "Documentation full-text smoke query failed.");
			}
		}
		return {
			documentCount,
			chunkCount,
			classCount,
			branch: metadata.get("branch") ?? null,
			commitSha: metadata.get("commitSha") ?? null
		};
	} catch (error: unknown) {
		if (error instanceof DocumentationIndexError) throw error;
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new DocumentationIndexError("documentation_index_missing", "Documentation index file is missing.", { cause: error });
		}
		throw mapSqliteError(error);
	} finally {
		db?.close();
	}
}

export async function checkDocumentationGeneration(params: {
	generationDir: string;
	record?: Pick<GodotDocumentationRecord, "branch" | "commitSha"> | undefined;
	deep: boolean;
}): Promise<GodotDocumentationGenerationManifest> {
	const manifest = await readDocumentationGenerationManifest(params.generationDir);
	if (params.record !== undefined && (manifest.branch !== params.record.branch || manifest.commitSha !== params.record.commitSha)) {
		throw new DocumentationIndexError("documentation_index_incompatible", "Documentation generation does not match its configured branch or commit.");
	}
	const indexPath: string = join(params.generationDir, "index.sqlite");
	const counts = await inspectSqlite(indexPath, params.deep);
	const indexStats = await stat(indexPath).catch((error: unknown): never => {
		throw new DocumentationIndexError("documentation_index_missing", "Documentation index file is missing.", { cause: error });
	});
	if (counts.documentCount !== manifest.documentCount
		|| counts.chunkCount !== manifest.chunkCount
		|| counts.classCount !== manifest.classCount
		|| indexStats.size !== manifest.sizeBytes) {
		throw new DocumentationIndexError("documentation_index_corrupt", "Documentation index statistics do not match its manifest.");
	}
	if (counts.branch !== manifest.branch || counts.commitSha !== manifest.commitSha) {
		throw new DocumentationIndexError("documentation_index_incompatible", "Documentation index metadata does not match its manifest.");
	}
	if (params.deep && await sha256File(indexPath) !== manifest.sqliteSha256) {
		throw new DocumentationIndexError("documentation_index_corrupt", "Documentation index hash does not match its manifest.");
	}
	return manifest;
}

export async function checkDocumentationRecordFast(record: GodotDocumentationRecord): Promise<GodotDocumentationHealth> {
	const checkedAt: string = new Date().toISOString();
	if (record.activeGenerationId === null) {
		return { status: "unavailable", code: "documentation_index_missing", message: "Documentation has no active generation.", checkedAt };
	}
	try {
		await checkDocumentationGeneration({
			generationDir: getGodotDocumentationGenerationDir(record),
			record,
			deep: false
		});
		return { status: "ready", code: null, message: null, checkedAt };
	} catch (error: unknown) {
		const indexError = error instanceof DocumentationIndexError
			? error
			: new DocumentationIndexError("documentation_index_corrupt", error instanceof Error ? error.message : String(error));
		return { status: "degraded", code: indexError.code, message: indexError.message, checkedAt };
	}
}

export async function listRollbackGenerationIds(record: GodotDocumentationRecord): Promise<string[]> {
	const entries = await readdir(getGodotDocumentationPackageDir(record.id), { withFileTypes: true }).catch(() => []);
	const candidates: Array<{ id: string; verifiedAt: string }> = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name === record.activeGenerationId) continue;
		try {
			const manifest = await checkDocumentationGeneration({
				generationDir: join(getGodotDocumentationPackageDir(record.id), entry.name),
				deep: false
			});
			candidates.push({ id: entry.name, verifiedAt: manifest.verifiedAt });
		} catch {
			// Invalid generations are cleaned by the manager after active handles close.
		}
	}
	return candidates.sort((left, right): number => right.verifiedAt.localeCompare(left.verifiedAt)).map((candidate): string => candidate.id);
}
