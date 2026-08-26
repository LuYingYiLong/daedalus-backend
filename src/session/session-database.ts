import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { getSessionsDatabasePath } from "../app-paths.js";
import { logger } from "../logger.js";

const DB_SCHEMA_VERSION: number = 9;

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
		CREATE TABLE IF NOT EXISTS session_search_source_state (
			session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
			revision INTEGER NOT NULL DEFAULT 0,
			rebuild_epoch INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL
		);
		INSERT OR IGNORE INTO session_search_source_state(session_id, revision, rebuild_epoch, updated_at)
		SELECT session_id, 0, 0, updated_at FROM sessions;
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
		CREATE TABLE IF NOT EXISTS trace_records (
			record_id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
			parent_id TEXT REFERENCES trace_records(record_id) ON DELETE CASCADE,
			sequence INTEGER NOT NULL,
			turn_index INTEGER NOT NULL,
			kind TEXT NOT NULL,
			status TEXT NOT NULL,
			request_id TEXT NOT NULL,
			run_id TEXT,
			step_id TEXT,
			tool_call_id TEXT,
			provider TEXT,
			model TEXT,
			started_at TEXT NOT NULL,
			finished_at TEXT,
			duration_ms INTEGER,
			input_tokens INTEGER,
			output_tokens INTEGER,
			detail_level TEXT NOT NULL DEFAULT 'full',
			summary_json TEXT NOT NULL,
			content_hash TEXT,
			truncated INTEGER NOT NULL DEFAULT 0,
			revision INTEGER NOT NULL,
			updated_at TEXT NOT NULL,
			UNIQUE(session_id, sequence)
		);
		CREATE INDEX IF NOT EXISTS idx_trace_session_sequence ON trace_records (session_id, sequence DESC);
		CREATE INDEX IF NOT EXISTS idx_trace_session_turn ON trace_records (session_id, turn_index, sequence);
		CREATE INDEX IF NOT EXISTS idx_trace_request ON trace_records (session_id, request_id, sequence);
		CREATE INDEX IF NOT EXISTS idx_trace_run ON trace_records (session_id, run_id, sequence);
		CREATE INDEX IF NOT EXISTS idx_trace_tool_call ON trace_records (session_id, tool_call_id);
		CREATE TABLE IF NOT EXISTS trace_payloads (
			record_id TEXT PRIMARY KEY REFERENCES trace_records(record_id) ON DELETE CASCADE,
			payload_json TEXT NOT NULL,
			redacted_fields_json TEXT NOT NULL,
			char_count INTEGER NOT NULL,
			content_hash TEXT,
			truncated INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS summaries (
			session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
			content TEXT NOT NULL,
			message_count INTEGER NOT NULL,
			token_estimate INTEGER NOT NULL,
			generated_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS context_blocks (
			block_id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
			request_id TEXT,
			kind TEXT NOT NULL,
			level TEXT NOT NULL,
			status TEXT NOT NULL,
			token_estimate INTEGER NOT NULL,
			source_folder_id TEXT,
			file_refs_json TEXT NOT NULL,
			protected_reason TEXT,
			covered_block_ids_json TEXT NOT NULL,
			covered_message_keys_json TEXT NOT NULL,
			content TEXT NOT NULL,
			summary_json TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_context_blocks_session_status
			ON context_blocks (session_id, status, level, created_at);
		CREATE INDEX IF NOT EXISTS idx_context_blocks_request
			ON context_blocks (session_id, request_id, created_at);
		CREATE TABLE IF NOT EXISTS context_compactions (
			compression_id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
			request_id TEXT,
			generation INTEGER NOT NULL,
			level TEXT NOT NULL,
			source TEXT NOT NULL,
			status TEXT NOT NULL,
			before_tokens INTEGER NOT NULL,
			after_tokens INTEGER NOT NULL,
			saved_tokens INTEGER NOT NULL,
			covered_block_ids_json TEXT NOT NULL,
			summary_block_id TEXT REFERENCES context_blocks(block_id) ON DELETE SET NULL,
			warning TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			UNIQUE(session_id, generation)
		);
		CREATE INDEX IF NOT EXISTS idx_context_compactions_session_generation
			ON context_compactions (session_id, generation DESC);
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
		CREATE TABLE IF NOT EXISTS agent_goals (
			goal_id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
			root_request_id TEXT NOT NULL,
			revision INTEGER NOT NULL,
			stage TEXT NOT NULL,
			state_json TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			completed_at TEXT,
			dismissed_at TEXT
		);
		CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_goals_active_session
			ON agent_goals (session_id) WHERE completed_at IS NULL;
		CREATE INDEX IF NOT EXISTS idx_agent_goals_session_updated
			ON agent_goals (session_id, updated_at DESC);
		CREATE TABLE IF NOT EXISTS agent_goal_runs (
			goal_id TEXT NOT NULL REFERENCES agent_goals(goal_id) ON DELETE CASCADE,
			run_id TEXT NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
			cycle INTEGER NOT NULL,
			created_at TEXT NOT NULL,
			PRIMARY KEY(goal_id, run_id)
		);
		CREATE INDEX IF NOT EXISTS idx_agent_goal_runs_goal_cycle
			ON agent_goal_runs (goal_id, cycle);
		CREATE TABLE IF NOT EXISTS agent_goal_file_checkpoints (
			goal_id TEXT NOT NULL REFERENCES agent_goals(goal_id) ON DELETE CASCADE,
			workspace_id TEXT,
			relative_path TEXT NOT NULL,
			before_sha256 TEXT,
			after_sha256 TEXT,
			content_sha256 TEXT,
			size_bytes INTEGER NOT NULL,
			metadata_json TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY(goal_id, relative_path)
		);
		CREATE TABLE IF NOT EXISTS selection_ask_threads (
			thread_id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
			anchor_key TEXT NOT NULL,
			source_entry_id TEXT NOT NULL,
			source_request_id TEXT NOT NULL,
			anchor_json TEXT NOT NULL,
			provider TEXT NOT NULL,
			model TEXT NOT NULL,
			reasoning_effort TEXT,
			base_url TEXT,
			status TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			UNIQUE(session_id, anchor_key)
		);
		CREATE INDEX IF NOT EXISTS idx_selection_ask_threads_session
			ON selection_ask_threads (session_id, updated_at DESC);
		CREATE INDEX IF NOT EXISTS idx_selection_ask_threads_source_request
			ON selection_ask_threads (session_id, source_request_id);
		CREATE TABLE IF NOT EXISTS selection_ask_messages (
			message_id TEXT PRIMARY KEY,
			thread_id TEXT NOT NULL REFERENCES selection_ask_threads(thread_id) ON DELETE CASCADE,
			sequence INTEGER NOT NULL,
			request_id TEXT NOT NULL,
			role TEXT NOT NULL,
			content TEXT NOT NULL,
			status TEXT NOT NULL,
			error_message TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			UNIQUE(thread_id, sequence)
		);
		CREATE INDEX IF NOT EXISTS idx_selection_ask_messages_thread
			ON selection_ask_messages (thread_id, sequence);
		CREATE TRIGGER IF NOT EXISTS trg_search_session_insert
		AFTER INSERT ON sessions BEGIN
			INSERT OR IGNORE INTO session_search_source_state(session_id, revision, rebuild_epoch, updated_at)
			VALUES (NEW.session_id, 0, 0, NEW.updated_at);
		END;
		CREATE TRIGGER IF NOT EXISTS trg_search_message_insert
		AFTER INSERT ON messages BEGIN
			UPDATE session_search_source_state
			SET revision = revision + 1, updated_at = NEW.created_at
			WHERE session_id = NEW.session_id;
		END;
		CREATE TRIGGER IF NOT EXISTS trg_search_message_update
		AFTER UPDATE ON messages BEGIN
			UPDATE session_search_source_state
			SET revision = revision + 1, rebuild_epoch = rebuild_epoch + 1, updated_at = NEW.created_at
			WHERE session_id = NEW.session_id;
		END;
		CREATE TRIGGER IF NOT EXISTS trg_search_message_delete
		AFTER DELETE ON messages BEGIN
			UPDATE session_search_source_state
			SET revision = revision + 1, rebuild_epoch = rebuild_epoch + 1, updated_at = datetime('now')
			WHERE session_id = OLD.session_id;
		END;
		CREATE TRIGGER IF NOT EXISTS trg_search_timeline_event_insert
		AFTER INSERT ON session_events WHEN NEW.channel = 'timeline' BEGIN
			UPDATE session_search_source_state
			SET revision = revision + 1,
				rebuild_epoch = rebuild_epoch + CASE WHEN NEW.event_name LIKE 'plan.%' THEN 1 ELSE 0 END,
				updated_at = NEW.created_at
			WHERE session_id = NEW.session_id;
		END;
		CREATE TRIGGER IF NOT EXISTS trg_search_timeline_event_update
		AFTER UPDATE ON session_events WHEN OLD.channel = 'timeline' OR NEW.channel = 'timeline' BEGIN
			UPDATE session_search_source_state
			SET revision = revision + 1, rebuild_epoch = rebuild_epoch + 1, updated_at = NEW.created_at
			WHERE session_id = NEW.session_id;
		END;
		CREATE TRIGGER IF NOT EXISTS trg_search_timeline_event_delete
		AFTER DELETE ON session_events WHEN OLD.channel = 'timeline' BEGIN
			UPDATE session_search_source_state
			SET revision = revision + 1, rebuild_epoch = rebuild_epoch + 1, updated_at = datetime('now')
			WHERE session_id = OLD.session_id;
		END;
		DROP TABLE IF EXISTS event_aliases;
		DROP TABLE IF EXISTS legacy_imports;
		DROP TABLE IF EXISTS migration_issues;
		INSERT OR IGNORE INTO schema_migrations(version, applied_at)
		VALUES (${DB_SCHEMA_VERSION}, datetime('now'));
		PRAGMA user_version = ${DB_SCHEMA_VERSION};
	`);
	const selectionAskMessageColumns = db.prepare("PRAGMA table_info(selection_ask_messages)").all() as Record<string, unknown>[];
	if (!selectionAskMessageColumns.some((column: Record<string, unknown>): boolean => String(column.name) === "error_message")) {
		db.exec("ALTER TABLE selection_ask_messages ADD COLUMN error_message TEXT");
	}
	const agentGoalColumns = db.prepare("PRAGMA table_info(agent_goals)").all() as Record<string, unknown>[];
	if (!agentGoalColumns.some((column: Record<string, unknown>): boolean => String(column.name) === "dismissed_at")) {
		db.exec("ALTER TABLE agent_goals ADD COLUMN dismissed_at TEXT");
	}
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
