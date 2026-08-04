import { createHash } from "node:crypto";
import { mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
	getDefaultArchivedSessionsDir,
	getDefaultSessionsDir,
	getGoalCheckpointsRoot,
	getSessionsDatabasePath
} from "../app-paths.js";
import { getSessionDatabase } from "./session-database.js";
import {
	SESSION_EXPORT_FORMAT,
	SESSION_EXPORT_FORMAT_VERSION,
	SESSION_EXPORT_TABLES,
	type SessionTableCopySpec
} from "./session-export.js";

const SESSION_ID_PATTERN: RegExp = /^session-[A-Za-z0-9_-]+$/u;
const SKIPPED_IMPORT_TABLES: ReadonlySet<string> = new Set(["schema_migrations", "session_search_source_state"]);

export type SessionImportResult = {
	imported: true;
	sessionId: string;
	title: string;
	sourcePath: string;
	archived: boolean;
	tableCounts: Record<string, number>;
	restoredFileCount: number;
};

type ExportMetadataRow = {
	format: string;
	format_version: number;
	session_id: string;
};

type ExportedFileRow = {
	category: string;
	owner_id: string;
	relative_path: string;
	sha256: string;
	size_bytes: number;
	content: Uint8Array;
};

function assertSafeSessionId(sessionId: string): string {
	if (!SESSION_ID_PATTERN.test(sessionId)) {
		throw Object.assign(new Error("Invalid exported session id."), { code: "session_import_invalid_session_id" });
	}
	return sessionId;
}

async function assertImportSourcePath(sourcePath: string): Promise<string> {
	if (!isAbsolute(sourcePath)) {
		throw Object.assign(new Error("Session import source must be an absolute path."), {
			code: "session_import_source_invalid"
		});
	}
	const source: string = resolve(sourcePath);
	if (source.toLocaleLowerCase() === resolve(getSessionsDatabasePath()).toLocaleLowerCase()) {
		throw Object.assign(new Error("Cannot import the active session database into itself."), {
			code: "session_import_source_invalid"
		});
	}
	const stats = await stat(source);
	if (!stats.isFile()) {
		throw Object.assign(new Error("Session import source is not a file."), {
			code: "session_import_source_invalid"
		});
	}
	return await realpath(source);
}

function quoteIdentifier(identifier: string): string {
	return `"${identifier.replaceAll("\"", "\"\"")}"`;
}

function isInside(root: string, target: string): boolean {
	const relativePath: string = relative(root, target);
	return relativePath.length === 0 || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
	return db.prepare(`
		SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
	`).get(tableName) !== undefined;
}

function readExportMetadata(source: DatabaseSync): ExportMetadataRow {
	if (!tableExists(source, "daedalus_export_metadata")) {
		throw Object.assign(new Error("The selected SQLite file is not a Daedalus session export."), {
			code: "session_import_invalid_format"
		});
	}
	const rows = source.prepare(`
		SELECT format, format_version, session_id FROM daedalus_export_metadata
	`).all() as ExportMetadataRow[];
	if (rows.length !== 1) {
		throw Object.assign(new Error("Daedalus session export metadata is invalid."), {
			code: "session_import_invalid_format"
		});
	}
	const metadata: ExportMetadataRow = rows[0]!;
	if (metadata.format !== SESSION_EXPORT_FORMAT || Number(metadata.format_version) !== SESSION_EXPORT_FORMAT_VERSION) {
		throw Object.assign(new Error("Unsupported Daedalus session export format."), {
			code: "session_import_unsupported_format"
		});
	}
	assertSafeSessionId(metadata.session_id);
	return metadata;
}

function readColumnNames(db: DatabaseSync, tableName: string): string[] {
	return db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all()
		.map((row): string => String((row as Record<string, unknown>).name))
		.filter((name): boolean => name.length > 0);
}

function copyTableRows(
	source: DatabaseSync,
	target: DatabaseSync,
	table: SessionTableCopySpec,
	sessionId: string
): number {
	if (SKIPPED_IMPORT_TABLES.has(table.name)) {
		return 0;
	}
	if (!tableExists(source, table.name)) {
		throw Object.assign(new Error(`Daedalus session export is missing table: ${table.name}.`), {
			code: "session_import_invalid_format"
		});
	}
	const sourceColumns: string[] = readColumnNames(source, table.name);
	const targetColumns: Set<string> = new Set(readColumnNames(target, table.name));
	const columns: string[] = sourceColumns.filter((column): boolean => targetColumns.has(column));
	if (columns.length === 0) {
		throw new Error(`Session import table has no compatible columns: ${table.name}.`);
	}
	const columnSql: string = columns.map(quoteIdentifier).join(", ");
	const selectSql: string = `SELECT ${columnSql} FROM ${quoteIdentifier(table.name)}${table.where === undefined ? "" : ` WHERE ${table.where}`}`;
	const insertSql: string = `INSERT INTO ${quoteIdentifier(table.name)} (${columnSql}) VALUES (${columns.map((): string => "?").join(", ")})`;
	const select = source.prepare(selectSql);
	const insert = target.prepare(insertSql);
	let count: number = 0;
	for (const value of select.iterate(...(table.params?.(sessionId) ?? []))) {
		const row: Record<string, unknown> = value as Record<string, unknown>;
		insert.run(...columns.map((column): SQLInputValue => row[column] as SQLInputValue));
		count += 1;
	}
	return count;
}

function getImportedSessionAssetRoot(sessionId: string, archived: boolean): string {
	return resolve(join(archived ? getDefaultArchivedSessionsDir() : getDefaultSessionsDir(), sessionId));
}

function resolveSafeRelativeFile(root: string, relativePath: string): string {
	const normalizedRelativePath: string = String(relativePath).replaceAll("\\", "/");
	if (normalizedRelativePath.length === 0 || isAbsolute(normalizedRelativePath) || normalizedRelativePath.includes("\u0000")) {
		throw Object.assign(new Error(`Invalid embedded file path: ${relativePath}.`), {
			code: "session_import_file_path_invalid"
		});
	}
	const target: string = resolve(join(root, normalizedRelativePath));
	if (!isInside(root, target)) {
		throw Object.assign(new Error(`Embedded file path escapes its target directory: ${relativePath}.`), {
			code: "session_import_file_path_invalid"
		});
	}
	return target;
}

function readExportedFiles(source: DatabaseSync): ExportedFileRow[] {
	if (!tableExists(source, "daedalus_export_files")) {
		return [];
	}
	return source.prepare(`
		SELECT category, owner_id, relative_path, sha256, size_bytes, content
		FROM daedalus_export_files
		ORDER BY category, owner_id, relative_path
	`).all() as ExportedFileRow[];
}

async function restoreEmbeddedFiles(
	source: DatabaseSync,
	sessionId: string,
	archived: boolean
): Promise<{ restoredFileCount: number; createdRoots: string[] }> {
	const files: ExportedFileRow[] = readExportedFiles(source);
	const sessionAssetRoot: string = getImportedSessionAssetRoot(sessionId, archived);
	const requiredRoots: Set<string> = new Set();
	for (const file of files) {
		if (file.category === "attachment") {
			requiredRoots.add(sessionAssetRoot);
		} else if (file.category === "goal_checkpoint") {
			requiredRoots.add(resolve(join(getGoalCheckpointsRoot(), String(file.owner_id))));
		}
	}
	for (const root of requiredRoots) {
		try {
			await stat(root);
			throw Object.assign(new Error(`Session import target already exists: ${root}.`), {
				code: "session_import_asset_conflict"
			});
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw error;
			}
		}
	}

	const createdRoots: Set<string> = new Set();
	let restoredFileCount: number = 0;
	for (const file of files) {
		const bytes: Buffer = Buffer.from(file.content);
		const expectedSize: number = Number(file.size_bytes);
		if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || bytes.byteLength !== expectedSize) {
			throw Object.assign(new Error(`Embedded file size does not match metadata: ${file.relative_path}.`), {
				code: "session_import_file_invalid"
			});
		}
		const expectedHash: string = String(file.sha256);
		if (!/^[a-f0-9]{64}$/u.test(expectedHash) || createHash("sha256").update(bytes).digest("hex") !== expectedHash) {
			throw Object.assign(new Error(`Embedded file checksum does not match metadata: ${file.relative_path}.`), {
				code: "session_import_file_invalid"
			});
		}

		let targetRoot: string;
		if (file.category === "attachment") {
			targetRoot = sessionAssetRoot;
		} else if (file.category === "goal_checkpoint") {
			targetRoot = resolve(join(getGoalCheckpointsRoot(), String(file.owner_id)));
		} else {
			throw Object.assign(new Error(`Unsupported embedded file category: ${file.category}.`), {
				code: "session_import_file_invalid"
			});
		}
		const targetPath: string = resolveSafeRelativeFile(targetRoot, String(file.relative_path));
		createdRoots.add(targetRoot);
		await mkdir(dirname(targetPath), { recursive: true });
		await writeFile(targetPath, bytes, { flag: "wx" });
		restoredFileCount += 1;
	}
	return { restoredFileCount, createdRoots: [...createdRoots] };
}

function validateSourceDatabase(source: DatabaseSync): void {
	const integrity = source.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown } | undefined;
	if (String(integrity?.integrity_check ?? "") !== "ok") {
		throw Object.assign(new Error("Session import SQLite integrity validation failed."), {
			code: "session_import_sqlite_invalid"
		});
	}
	const foreignKeyIssues = source.prepare("PRAGMA foreign_key_check").all();
	if (foreignKeyIssues.length > 0) {
		throw Object.assign(new Error("Session import foreign key validation failed."), {
			code: "session_import_sqlite_invalid"
		});
	}
}

export async function importSessionFromSqlite(sourcePath: string): Promise<SessionImportResult> {
	const sourceFilePath: string = await assertImportSourcePath(sourcePath);
	const sqlite = await import("node:sqlite");
	const source = new sqlite.DatabaseSync(sourceFilePath, { readOnly: true, timeout: 5000 });
	const target: DatabaseSync = await getSessionDatabase();
	let createdRoots: string[] = [];
	let targetForeignKeysWereDisabled: boolean = false;
	try {
		validateSourceDatabase(source);
		const metadata: ExportMetadataRow = readExportMetadata(source);
		const sessionId: string = metadata.session_id;
		const sourceSessionRow = source.prepare(`
			SELECT title, archived_at FROM sessions WHERE session_id = ?
		`).get(sessionId) as { title?: string | null; archived_at?: string | null } | undefined;
		if (sourceSessionRow === undefined) {
			throw Object.assign(new Error("Daedalus session export does not contain its root session row."), {
				code: "session_import_invalid_format"
			});
		}
		if (target.prepare("SELECT 1 FROM sessions WHERE session_id = ?").get(sessionId) !== undefined) {
			throw Object.assign(new Error(`Session already exists: ${sessionId}.`), {
				code: "session_import_conflict"
			});
		}

		const archived: boolean = sourceSessionRow.archived_at != null;
		const fileResult = await restoreEmbeddedFiles(source, sessionId, archived);
		createdRoots = fileResult.createdRoots;
		const tableCounts: Record<string, number> = {};
		target.exec("PRAGMA foreign_keys = OFF;");
		targetForeignKeysWereDisabled = true;
		target.exec("BEGIN IMMEDIATE");
		try {
			for (const table of SESSION_EXPORT_TABLES) {
				tableCounts[table.name] = copyTableRows(source, target, table, sessionId);
			}
			const targetForeignKeyIssues = target.prepare("PRAGMA foreign_key_check").all();
			if (targetForeignKeyIssues.length > 0) {
				throw Object.assign(new Error("Session import produced foreign key issues."), {
					code: "session_import_sqlite_invalid"
				});
			}
			target.exec("COMMIT");
		} catch (error: unknown) {
			target.exec("ROLLBACK");
			throw error;
		}
		target.exec("PRAGMA foreign_keys = ON;");
		targetForeignKeysWereDisabled = false;
		return {
			imported: true,
			sessionId,
			title: String(sourceSessionRow.title ?? sessionId),
			sourcePath: sourceFilePath,
			archived,
			tableCounts,
			restoredFileCount: fileResult.restoredFileCount
		};
	} catch (error: unknown) {
		for (const root of createdRoots.reverse()) {
			await rm(root, { recursive: true, force: true }).catch((): void => {});
		}
		throw error;
	} finally {
		if (targetForeignKeysWereDisabled) {
			target.exec("PRAGMA foreign_keys = ON;");
		}
		source.close();
	}
}
