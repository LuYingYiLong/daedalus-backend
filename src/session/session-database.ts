import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { getSessionsDatabasePath } from "../app-paths.js";
import { logger } from "../logger.js";

const DB_SCHEMA_VERSION: number = 3;

export type SessionDatabaseState =
	| { available: true; db: DatabaseSync }
	| { available: false; errorMessage: string };

const statePromisesByPath: Map<string, Promise<SessionDatabaseState>> = new Map();
let testDatabasePath: string | null = null;

function resolveDatabasePath(): string {
	return testDatabasePath ?? getSessionsDatabasePath();
}

function migrateSchema(db: DatabaseSync): void {
	db.exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA foreign_keys = ON;
		PRAGMA busy_timeout = 5000;
		PRAGMA synchronous = NORMAL;
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			applied_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS sessions (
			session_id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			workspace_id TEXT,
			metadata_json TEXT NOT NULL,
			archived_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_sessions_archive_updated ON sessions (archived_at, updated_at DESC);
		CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions (workspace_id, archived_at);
		CREATE TABLE IF NOT EXISTS messages (
			row_id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
			sequence INTEGER NOT NULL,
			request_id TEXT,
			role TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			created_at TEXT NOT NULL,
			UNIQUE(session_id, sequence)
		);
		CREATE INDEX IF NOT EXISTS idx_messages_session_request ON messages (session_id, request_id, sequence);
		CREATE TABLE IF NOT EXISTS session_events (
			row_id INTEGER PRIMARY KEY AUTOINCREMENT,
			event_id TEXT NOT NULL UNIQUE,
			session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
			sequence INTEGER NOT NULL,
			channel TEXT NOT NULL DEFAULT 'timeline',
			request_id TEXT NOT NULL,
			event_name TEXT NOT NULL,
			data_json TEXT NOT NULL,
			approval_id TEXT,
			workflow_id TEXT,
			run_id TEXT,
			created_at TEXT NOT NULL,
			UNIQUE(session_id, channel, sequence)
		);
		CREATE INDEX IF NOT EXISTS idx_events_session_sequence ON session_events (session_id, channel, sequence);
		CREATE INDEX IF NOT EXISTS idx_events_session_request ON session_events (session_id, request_id, channel, sequence);
		CREATE INDEX IF NOT EXISTS idx_events_workflow ON session_events (session_id, workflow_id);
		CREATE INDEX IF NOT EXISTS idx_events_run ON session_events (session_id, run_id);
		CREATE INDEX IF NOT EXISTS idx_events_name ON session_events (session_id, event_name, sequence DESC);
		CREATE TABLE IF NOT EXISTS summaries (
			session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
			content TEXT NOT NULL,
			message_count INTEGER NOT NULL,
			token_estimate INTEGER NOT NULL,
			generated_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS plans (
			plan_id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
			request_id TEXT NOT NULL,
			status TEXT NOT NULL,
			metadata_json TEXT NOT NULL,
			markdown TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_plans_session ON plans (session_id, updated_at DESC);
		CREATE TABLE IF NOT EXISTS attachments (
			attachment_id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
			kind TEXT NOT NULL,
			metadata_json TEXT NOT NULL,
			storage_path TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_attachments_session ON attachments (session_id, created_at);
		CREATE TABLE IF NOT EXISTS file_edit_batches (
			batch_id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
			request_id TEXT NOT NULL,
			tool_call_id TEXT NOT NULL,
			tool_name TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_file_edits_session ON file_edit_batches (session_id, created_at);
		CREATE TABLE IF NOT EXISTS agent_runs (
			run_id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
			request_id TEXT NOT NULL,
			root_request_id TEXT NOT NULL,
			retry_of_run_id TEXT,
			revision INTEGER NOT NULL,
			stage TEXT NOT NULL,
			state_json TEXT NOT NULL,
			checkpoint_json TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_agent_runs_session_updated
			ON agent_runs (session_id, updated_at DESC);
		CREATE INDEX IF NOT EXISTS idx_agent_runs_request
			ON agent_runs (session_id, request_id);
		CREATE INDEX IF NOT EXISTS idx_agent_runs_stage
			ON agent_runs (stage, updated_at);
		CREATE TABLE IF NOT EXISTS agent_run_continuations (
			run_id TEXT PRIMARY KEY REFERENCES agent_runs(run_id) ON DELETE CASCADE,
			session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
			revision INTEGER NOT NULL,
			kind TEXT NOT NULL,
			pause_id TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_agent_run_continuations_session
			ON agent_run_continuations (session_id, updated_at DESC);
		DROP TABLE IF EXISTS event_aliases;
		DROP TABLE IF EXISTS legacy_imports;
		DROP TABLE IF EXISTS migration_issues;
		INSERT OR IGNORE INTO schema_migrations(version, applied_at)
		VALUES (${DB_SCHEMA_VERSION}, datetime('now'));
		PRAGMA user_version = ${DB_SCHEMA_VERSION};
	`);
}

async function openDatabase(): Promise<SessionDatabaseState> {
	let db: DatabaseSync | undefined;
	const databasePath: string = resolveDatabasePath();
	try {
		const sqlite = await import("node:sqlite");
		await mkdir(dirname(databasePath), { recursive: true });
		db = new sqlite.DatabaseSync(databasePath, { timeout: 5000 });
		migrateSchema(db);
		const integrity = db.prepare("PRAGMA integrity_check").get() as Record<string, unknown> | undefined;
		if (String(integrity?.integrity_check ?? "") !== "ok") {
			throw new Error(`SQLite integrity_check failed: ${String(integrity?.integrity_check ?? "unknown")}`);
		}
		return { available: true, db };
	} catch (error: unknown) {
		db?.close();
		const errorMessage: string = error instanceof Error ? error.message : String(error);
		logger.error("session", "sqlite_unavailable", error, { message: errorMessage });
		return { available: false, errorMessage };
	}
}

export async function getSessionDatabase(): Promise<DatabaseSync> {
	const databasePath: string = resolveDatabasePath();
	let statePromise: Promise<SessionDatabaseState> | undefined = statePromisesByPath.get(databasePath);
	if (statePromise === undefined) {
		statePromise = openDatabase();
		statePromisesByPath.set(databasePath, statePromise);
	}
	const state: SessionDatabaseState = await statePromise;
	if (!state.available) {
		const error = new Error(state.errorMessage) as Error & { code?: string };
		error.code = "session_storage_unavailable";
		throw error;
	}
	return state.db;
}

export function runSessionTransaction<T>(db: DatabaseSync, operation: () => T): T {
	db.exec("BEGIN IMMEDIATE");
	try {
		const result: T = operation();
		db.exec("COMMIT");
		return result;
	} catch (error: unknown) {
		db.exec("ROLLBACK");
		throw error;
	}
}

export function sqlJson(value: unknown): string {
	return JSON.stringify(value);
}

export function parseSqlJson<T>(value: unknown): T {
	return JSON.parse(String(value)) as T;
}

export function toSqlValue(value: string | undefined): SQLInputValue {
	return value ?? null;
}

export async function resetSessionDatabaseForTests(databasePath?: string): Promise<void> {
	const closeOperations: Array<Promise<void>> = [];
	for (const [path, promise] of statePromisesByPath) {
		if (databasePath !== undefined && path !== databasePath) {
			continue;
		}
		closeOperations.push(promise.then((state: SessionDatabaseState): void => {
			if (state.available) {
				state.db.close();
			}
		}));
		statePromisesByPath.delete(path);
	}
	await Promise.all(closeOperations);
	testDatabasePath = databasePath ?? null;
}

export async function closeSessionDatabases(): Promise<void> {
	const closeOperations: Array<Promise<void>> = [];
	for (const promise of statePromisesByPath.values()) {
		closeOperations.push(promise.then((state: SessionDatabaseState): void => {
			if (state.available) {
				state.db.close();
			}
		}));
	}
	statePromisesByPath.clear();
	await Promise.all(closeOperations);
}
