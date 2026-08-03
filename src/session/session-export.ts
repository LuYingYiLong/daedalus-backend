import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
	getDefaultArchivedSessionsDir,
	getDefaultSessionsDir,
	getGoalCheckpointsRoot,
	getSessionsDatabasePath
} from "../app-paths.js";
import { getSessionDatabase } from "./session-database.js";

const SESSION_ID_PATTERN: RegExp = /^session-[A-Za-z0-9_-]+$/u;
const EXPORT_FORMAT: string = "daedalus-session-sqlite";
const EXPORT_FORMAT_VERSION: number = 1;

type SessionTableCopySpec = {
	name: string;
	where?: string;
	params?: (sessionId: string) => SQLInputValue[];
};

const SESSION_TABLES: readonly SessionTableCopySpec[] = [
	{ name: "schema_migrations" },
	{ name: "sessions", where: "session_id = ?", params: (sessionId): SQLInputValue[] => [sessionId] },
	{ name: "session_search_source_state", where: "session_id = ?", params: (sessionId): SQLInputValue[] => [sessionId] },
	{ name: "messages", where: "session_id = ?", params: (sessionId): SQLInputValue[] => [sessionId] },
	{ name: "session_events", where: "session_id = ?", params: (sessionId): SQLInputValue[] => [sessionId] },
	{ name: "summaries", where: "session_id = ?", params: (sessionId): SQLInputValue[] => [sessionId] },
	{ name: "plans", where: "session_id = ?", params: (sessionId): SQLInputValue[] => [sessionId] },
	{ name: "attachments", where: "session_id = ?", params: (sessionId): SQLInputValue[] => [sessionId] },
	{ name: "file_edit_batches", where: "session_id = ?", params: (sessionId): SQLInputValue[] => [sessionId] },
	{ name: "agent_runs", where: "session_id = ?", params: (sessionId): SQLInputValue[] => [sessionId] },
	{ name: "agent_run_continuations", where: "session_id = ?", params: (sessionId): SQLInputValue[] => [sessionId] },
	{ name: "agent_goals", where: "session_id = ?", params: (sessionId): SQLInputValue[] => [sessionId] },
	{
		name: "agent_goal_runs",
		where: "goal_id IN (SELECT goal_id FROM agent_goals WHERE session_id = ?)",
		params: (sessionId): SQLInputValue[] => [sessionId]
	},
	{
		name: "agent_goal_file_checkpoints",
		where: "goal_id IN (SELECT goal_id FROM agent_goals WHERE session_id = ?)",
		params: (sessionId): SQLInputValue[] => [sessionId]
	},
	{ name: "selection_ask_threads", where: "session_id = ?", params: (sessionId): SQLInputValue[] => [sessionId] },
	{
		name: "selection_ask_messages",
		where: "thread_id IN (SELECT thread_id FROM selection_ask_threads WHERE session_id = ?)",
		params: (sessionId): SQLInputValue[] => [sessionId]
	}
] as const;

export type SessionExportResult = {
	exported: true;
	sessionId: string;
	destinationPath: string;
	byteSize: number;
	tableCounts: Record<string, number>;
	embeddedFileCount: number;
	missingFileCount: number;
};

type SessionExportFile = {
	category: "attachment" | "goal_checkpoint";
	ownerId: string;
	relativePath: string;
	rootPath: string;
	absolutePath: string;
};

function assertSafeSessionId(sessionId: string): string {
	if (!SESSION_ID_PATTERN.test(sessionId)) {
		throw Object.assign(new Error("Invalid session id."), { code: "invalid_session_id" });
	}
	return sessionId;
}

function assertDestinationPath(destinationPath: string): string {
	if (!isAbsolute(destinationPath)) {
		throw Object.assign(new Error("Session export destination must be an absolute path."), {
			code: "session_export_destination_invalid"
		});
	}
	const destination: string = resolve(destinationPath);
	if (destination.toLocaleLowerCase() === resolve(getSessionsDatabasePath()).toLocaleLowerCase()) {
		throw Object.assign(new Error("Cannot overwrite the active session database."), {
			code: "session_export_destination_invalid"
		});
	}
	return destination;
}

function quoteIdentifier(identifier: string): string {
	return `"${identifier.replaceAll("\"", "\"\"")}"`;
}

function isInside(root: string, target: string): boolean {
	const relativePath: string = relative(root, target);
	return relativePath.length === 0 || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function readSchemaSql(source: DatabaseSync, type: "table" | "index" | "trigger", name: string): string {
	const row = source.prepare(`
		SELECT sql FROM sqlite_master WHERE type = ? AND name = ? AND sql IS NOT NULL
	`).get(type, name) as { sql?: unknown } | undefined;
	if (typeof row?.sql !== "string" || row.sql.trim().length === 0) {
		throw new Error(`Session database is missing ${type} schema for ${name}.`);
	}
	return row.sql;
}

function createCanonicalTables(source: DatabaseSync, target: DatabaseSync): void {
	for (const table of SESSION_TABLES) {
		target.exec(readSchemaSql(source, "table", table.name));
	}
}

function createCanonicalIndexesAndTriggers(source: DatabaseSync, target: DatabaseSync): void {
	const tableNames: ReadonlySet<string> = new Set(SESSION_TABLES.map((table): string => table.name));
	const schemaRows = source.prepare(`
		SELECT type, name, tbl_name, sql
		FROM sqlite_master
		WHERE type IN ('index', 'trigger') AND sql IS NOT NULL
		ORDER BY CASE type WHEN 'index' THEN 0 ELSE 1 END, name
	`).all() as Array<{ type: "index" | "trigger"; name: string; tbl_name: string; sql: string }>;
	for (const row of schemaRows) {
		if (tableNames.has(String(row.tbl_name))) {
			target.exec(String(row.sql));
		}
	}
}

function copyTableRows(
	source: DatabaseSync,
	target: DatabaseSync,
	table: SessionTableCopySpec,
	sessionId: string
): number {
	const columns = source.prepare(`PRAGMA table_info(${quoteIdentifier(table.name)})`).all()
		.map((row): string => String((row as Record<string, unknown>).name));
	if (columns.length === 0) {
		throw new Error(`Session database table has no columns: ${table.name}.`);
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

function createExportMetadataTables(target: DatabaseSync): void {
	target.exec(`
		CREATE TABLE daedalus_export_metadata (
			format TEXT NOT NULL,
			format_version INTEGER NOT NULL,
			session_id TEXT NOT NULL,
			exported_at TEXT NOT NULL,
			source_database_schema_version INTEGER NOT NULL,
			embedded_file_count INTEGER NOT NULL DEFAULT 0,
			missing_file_count INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE daedalus_export_files (
			category TEXT NOT NULL,
			owner_id TEXT NOT NULL,
			relative_path TEXT NOT NULL,
			sha256 TEXT NOT NULL,
			size_bytes INTEGER NOT NULL,
			content BLOB NOT NULL,
			PRIMARY KEY(category, owner_id, relative_path)
		);
	`);
}

function collectExportFiles(target: DatabaseSync, sessionId: string, archived: boolean): SessionExportFile[] {
	const files: SessionExportFile[] = [];
	const fileKeys: Set<string> = new Set();
	const sessionRoot: string = resolve(join(
		archived ? getDefaultArchivedSessionsDir() : getDefaultSessionsDir(),
		sessionId
	));
	const attachments = target.prepare(`
		SELECT attachment_id, storage_path FROM attachments WHERE session_id = ? ORDER BY attachment_id
	`).all(sessionId) as Array<{ attachment_id: string; storage_path: string }>;
	for (const attachment of attachments) {
		const storagePath: string = String(attachment.storage_path).replaceAll("\\", "/");
		const absolutePath: string = resolve(sessionRoot, storagePath);
		if (isAbsolute(storagePath) || !isInside(sessionRoot, absolutePath)) {
			throw Object.assign(new Error(`Attachment path is outside the session directory: ${storagePath}.`), {
				code: "session_export_attachment_path_invalid"
			});
		}
		const file: SessionExportFile = {
			category: "attachment",
			ownerId: String(attachment.attachment_id),
			relativePath: storagePath,
			rootPath: sessionRoot,
			absolutePath
		};
		const fileKey: string = `${file.category}\u0000${file.ownerId}\u0000${file.relativePath}`;
		if (!fileKeys.has(fileKey)) {
			fileKeys.add(fileKey);
			files.push(file);
		}
	}

	const checkpoints = target.prepare(`
		SELECT goal_id, content_sha256
		FROM agent_goal_file_checkpoints
		WHERE content_sha256 IS NOT NULL
		ORDER BY goal_id, relative_path
	`).all() as Array<{ goal_id: string; content_sha256: string }>;
	for (const checkpoint of checkpoints) {
		const hash: string = String(checkpoint.content_sha256);
		if (!/^[a-f0-9]{64}$/u.test(hash)) {
			continue;
		}
		const goalId: string = String(checkpoint.goal_id);
		const goalRoot: string = resolve(join(getGoalCheckpointsRoot(), goalId));
		const absolutePath: string = resolve(join(goalRoot, "objects", hash));
		if (!isInside(goalRoot, absolutePath)) {
			continue;
		}
		const file: SessionExportFile = {
			category: "goal_checkpoint",
			ownerId: goalId,
			relativePath: `objects/${hash}`,
			rootPath: goalRoot,
			absolutePath
		};
		const fileKey: string = `${file.category}\u0000${file.ownerId}\u0000${file.relativePath}`;
		if (!fileKeys.has(fileKey)) {
			fileKeys.add(fileKey);
			files.push(file);
		}
	}
	return files;
}

async function embedExportFiles(
	target: DatabaseSync,
	files: readonly SessionExportFile[]
): Promise<{ embeddedFileCount: number; missingFileCount: number }> {
	const insert = target.prepare(`
		INSERT OR IGNORE INTO daedalus_export_files(
			category, owner_id, relative_path, sha256, size_bytes, content
		) VALUES (?, ?, ?, ?, ?, ?)
	`);
	let embeddedFileCount: number = 0;
	let missingFileCount: number = 0;
	target.exec("BEGIN IMMEDIATE");
	try {
		for (const file of files) {
			try {
				const canonicalRoot: string = await realpath(file.rootPath);
				const canonicalPath: string = await realpath(file.absolutePath);
				if (!isInside(canonicalRoot, canonicalPath)) {
					throw new Error("Export file resolves outside its storage root.");
				}
				const bytes: Buffer = await readFile(canonicalPath);
				insert.run(
					file.category,
					file.ownerId,
					file.relativePath,
					createHash("sha256").update(bytes).digest("hex"),
					bytes.byteLength,
					bytes
				);
				embeddedFileCount += 1;
			} catch {
				missingFileCount += 1;
			}
		}
		target.prepare(`
			UPDATE daedalus_export_metadata
			SET embedded_file_count = ?, missing_file_count = ?
		`).run(embeddedFileCount, missingFileCount);
		target.exec("COMMIT");
	} catch (error: unknown) {
		target.exec("ROLLBACK");
		throw error;
	}
	return { embeddedFileCount, missingFileCount };
}

async function replaceDestination(stagingPath: string, destinationPath: string): Promise<void> {
	const backupPath: string = `${destinationPath}.${randomUUID()}.backup`;
	let hasBackup: boolean = false;
	try {
		const destinationStats = await stat(destinationPath);
		if (!destinationStats.isFile()) {
			throw new Error("Session export destination is not a file.");
		}
		await rename(destinationPath, backupPath);
		hasBackup = true;
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
	}
	try {
		await rename(stagingPath, destinationPath);
	} catch (error: unknown) {
		if (hasBackup) {
			await rename(backupPath, destinationPath).catch((): void => {});
		}
		throw error;
	}
	if (hasBackup) {
		await rm(backupPath, { force: true }).catch((): void => {});
	}
}

export async function exportSessionToSqlite(
	sessionId: string,
	destinationPath: string
): Promise<SessionExportResult> {
	const safeSessionId: string = assertSafeSessionId(sessionId);
	const destination: string = assertDestinationPath(destinationPath);
	await mkdir(dirname(destination), { recursive: true });
	const stagingPath: string = `${destination}.${randomUUID()}.staging`;
	await rm(stagingPath, { force: true });

	const source: DatabaseSync = await getSessionDatabase();
	const sessionRow = source.prepare(`
		SELECT archived_at FROM sessions WHERE session_id = ?
	`).get(safeSessionId) as { archived_at?: string | null } | undefined;
	if (sessionRow === undefined) {
		throw Object.assign(new Error(`Session not found: ${safeSessionId}.`), { code: "session_not_found" });
	}

	const sqlite = await import("node:sqlite");
	let target: DatabaseSync | null = null;
	let sourceTransactionOpen: boolean = false;
	try {
		target = new sqlite.DatabaseSync(stagingPath, { timeout: 5000 });
		target.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA foreign_keys = OFF;");
		source.exec("BEGIN");
		sourceTransactionOpen = true;
		target.exec("BEGIN IMMEDIATE");
		const tableCounts: Record<string, number> = {};
		try {
			createCanonicalTables(source, target);
			for (const table of SESSION_TABLES) {
				tableCounts[table.name] = copyTableRows(source, target, table, safeSessionId);
			}
			createCanonicalIndexesAndTriggers(source, target);
			createExportMetadataTables(target);
			const sourceSchemaVersion: number = Number(
				(source.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined)?.user_version ?? 0
			);
			target.prepare(`
				INSERT INTO daedalus_export_metadata(
					format, format_version, session_id, exported_at, source_database_schema_version
				) VALUES (?, ?, ?, ?, ?)
			`).run(EXPORT_FORMAT, EXPORT_FORMAT_VERSION, safeSessionId, new Date().toISOString(), sourceSchemaVersion);
			target.exec(`PRAGMA user_version = ${sourceSchemaVersion};`);
			target.exec("COMMIT");
			source.exec("COMMIT");
			sourceTransactionOpen = false;
		} catch (error: unknown) {
			target.exec("ROLLBACK");
			throw error;
		}

		const exportedSessionRow = target.prepare(`
			SELECT archived_at FROM sessions WHERE session_id = ?
		`).get(safeSessionId) as { archived_at?: string | null } | undefined;
		if (exportedSessionRow === undefined) {
			throw new Error("Session export did not contain its root session row.");
		}
		const files: SessionExportFile[] = collectExportFiles(
			target,
			safeSessionId,
			exportedSessionRow.archived_at != null
		);
		const fileResult = await embedExportFiles(target, files);
		target.exec("PRAGMA foreign_keys = ON;");
		const foreignKeyIssues = target.prepare("PRAGMA foreign_key_check").all();
		if (foreignKeyIssues.length > 0) {
			throw new Error("Session export foreign key validation failed.");
		}
		const integrity = target.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown } | undefined;
		if (String(integrity?.integrity_check ?? "") !== "ok") {
			throw new Error("Session export SQLite integrity validation failed.");
		}
		target.close();
		target = null;
		await replaceDestination(stagingPath, destination);
		const outputStats = await stat(destination);
		return {
			exported: true,
			sessionId: safeSessionId,
			destinationPath: destination,
			byteSize: outputStats.size,
			tableCounts,
			embeddedFileCount: fileResult.embeddedFileCount,
			missingFileCount: fileResult.missingFileCount
		};
	} finally {
		if (sourceTransactionOpen) {
			source.exec("ROLLBACK");
		}
		target?.close();
		await rm(stagingPath, { force: true }).catch((): void => {});
	}
}
