import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { getSessionsDatabasePath } from "../app-paths.js";
import { logger } from "../logger.js";

const DB_SCHEMA_VERSION: number = 20;

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
		CREATE TABLE IF NOT EXISTS browser_activity (
			id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
			request_id TEXT NOT NULL, run_id TEXT NOT NULL, kind TEXT NOT NULL, proposal_id TEXT, step_id TEXT,
			summary_json TEXT NOT NULL, detail_json TEXT, png BLOB, detail_level TEXT NOT NULL DEFAULT 'full', created_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_browser_activity_turn ON browser_activity(session_id, request_id);
		CREATE TRIGGER IF NOT EXISTS trg_search_browser_activity_insert AFTER INSERT ON browser_activity BEGIN
			UPDATE session_search_source_state SET revision=revision+1,updated_at=datetime('now') WHERE session_id=NEW.session_id;
		END;
		CREATE TRIGGER IF NOT EXISTS trg_search_browser_activity_delete AFTER DELETE ON browser_activity BEGIN
			UPDATE session_search_source_state SET revision=revision+1,rebuild_epoch=rebuild_epoch+1,updated_at=datetime('now') WHERE session_id=OLD.session_id;
		END;
		CREATE TRIGGER IF NOT EXISTS trg_search_browser_activity_update AFTER UPDATE ON browser_activity BEGIN
			UPDATE session_search_source_state SET revision=revision+1, rebuild_epoch=rebuild_epoch+1, updated_at=datetime('now') WHERE session_id=NEW.session_id;
		END;
		CREATE TABLE IF NOT EXISTS computer_observations (
			session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
			observation_id TEXT NOT NULL,
			request_id TEXT NOT NULL,
			tool_call_id TEXT NOT NULL,
			detail_json TEXT,
			groundings_json TEXT,
			png BLOB,
			summary_json TEXT NOT NULL,
			detail_level TEXT NOT NULL DEFAULT 'full',
			revision INTEGER NOT NULL DEFAULT 1,
			PRIMARY KEY(session_id, observation_id)
		);
		CREATE INDEX IF NOT EXISTS idx_computer_observations_turn ON computer_observations(session_id, request_id);
		CREATE TRIGGER IF NOT EXISTS trg_search_computer_insert AFTER INSERT ON computer_observations BEGIN
			UPDATE session_search_source_state SET revision=revision+1, updated_at=datetime('now') WHERE session_id=NEW.session_id;
		END;
		CREATE TRIGGER IF NOT EXISTS trg_search_computer_update AFTER UPDATE ON computer_observations BEGIN
			UPDATE session_search_source_state SET revision=revision+1, rebuild_epoch=rebuild_epoch+1, updated_at=datetime('now') WHERE session_id=NEW.session_id;
		END;
		CREATE TRIGGER IF NOT EXISTS trg_search_computer_delete AFTER DELETE ON computer_observations BEGIN
			UPDATE session_search_source_state SET revision=revision+1, rebuild_epoch=rebuild_epoch+1, updated_at=datetime('now') WHERE session_id=OLD.session_id;
		END;
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
		CREATE TABLE IF NOT EXISTS subagent_graphs (
			graph_id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
			root_run_id TEXT NOT NULL,
			revision INTEGER NOT NULL,
			status TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_subagent_graphs_session_updated
			ON subagent_graphs (session_id, updated_at DESC);
		CREATE INDEX IF NOT EXISTS idx_subagent_graphs_root_run
			ON subagent_graphs (root_run_id, updated_at DESC);
		CREATE INDEX IF NOT EXISTS idx_subagent_graphs_recovery
			ON subagent_graphs (status, updated_at);
		CREATE TABLE IF NOT EXISTS subagent_nodes (
			graph_id TEXT NOT NULL REFERENCES subagent_graphs(graph_id) ON DELETE CASCADE,
			node_id TEXT NOT NULL,
			run_id TEXT NOT NULL UNIQUE,
			retry_of_run_id TEXT,
			name TEXT NOT NULL,
			role TEXT NOT NULL,
			objective TEXT NOT NULL,
			status TEXT NOT NULL,
			attempt INTEGER NOT NULL DEFAULT 1,
			retry_policy_json TEXT NOT NULL DEFAULT '{"mode":"transient_only","maxRetries":1}',
			queue_reason TEXT,
			queued_at TEXT,
			next_retry_at TEXT,
			context_refs_json TEXT NOT NULL,
			tool_scope_json TEXT NOT NULL,
			workspace_mode TEXT NOT NULL,
			worktree_metadata_json TEXT,
			result_json TEXT,
			failure_json TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY(graph_id, node_id)
		);
		CREATE INDEX IF NOT EXISTS idx_subagent_nodes_graph_status
			ON subagent_nodes (graph_id, status, updated_at);
		CREATE INDEX IF NOT EXISTS idx_subagent_nodes_run
			ON subagent_nodes (run_id);
		CREATE TABLE IF NOT EXISTS subagent_edges (
			graph_id TEXT NOT NULL REFERENCES subagent_graphs(graph_id) ON DELETE CASCADE,
			dependency_node_id TEXT NOT NULL,
			dependent_node_id TEXT NOT NULL,
			created_at TEXT NOT NULL,
			PRIMARY KEY(graph_id, dependency_node_id, dependent_node_id),
			FOREIGN KEY(graph_id, dependency_node_id)
				REFERENCES subagent_nodes(graph_id, node_id) ON DELETE CASCADE,
			FOREIGN KEY(graph_id, dependent_node_id)
				REFERENCES subagent_nodes(graph_id, node_id) ON DELETE CASCADE
		);
		CREATE INDEX IF NOT EXISTS idx_subagent_edges_dependent
			ON subagent_edges (graph_id, dependent_node_id);
		CREATE TABLE IF NOT EXISTS conversation_flows (
			flow_id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			workspace_id TEXT,
			pinned INTEGER NOT NULL DEFAULT 0,
			root_branch_id TEXT NOT NULL,
			revision INTEGER NOT NULL DEFAULT 1,
			active_branch_id TEXT,
			active_request_id TEXT,
			archived_at TEXT,
			created_from_session_id TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_conversation_flows_workspace
			ON conversation_flows (workspace_id, archived_at, updated_at DESC);
		CREATE TABLE IF NOT EXISTS conversation_flow_branches (
			branch_id TEXT PRIMARY KEY,
			flow_id TEXT NOT NULL REFERENCES conversation_flows(flow_id) ON DELETE CASCADE,
			session_id TEXT NOT NULL UNIQUE REFERENCES sessions(session_id) ON DELETE RESTRICT,
			parent_branch_id TEXT REFERENCES conversation_flow_branches(branch_id) ON DELETE RESTRICT,
			fork_request_id TEXT,
			fork_role TEXT CHECK(fork_role IS NULL OR fork_role IN ('user', 'assistant')),
			seed_request_id TEXT,
			head_node_id TEXT,
			pending_regenerate INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_conversation_flow_branches_flow
			ON conversation_flow_branches (flow_id, created_at, branch_id);
		CREATE TABLE IF NOT EXISTS conversation_flow_nodes (
			flow_id TEXT NOT NULL REFERENCES conversation_flows(flow_id) ON DELETE CASCADE,
			node_id TEXT NOT NULL,
			branch_id TEXT NOT NULL REFERENCES conversation_flow_branches(branch_id) ON DELETE CASCADE,
			session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE RESTRICT,
			request_id TEXT NOT NULL,
			role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
			parent_node_id TEXT,
			status TEXT NOT NULL,
			content_preview TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY(flow_id, node_id)
		);
		CREATE INDEX IF NOT EXISTS idx_conversation_flow_nodes_branch
			ON conversation_flow_nodes (branch_id, created_at, node_id);
		CREATE TABLE IF NOT EXISTS conversation_flow_layout (
			flow_id TEXT NOT NULL REFERENCES conversation_flows(flow_id) ON DELETE CASCADE,
			node_id TEXT NOT NULL,
			x REAL NOT NULL,
			y REAL NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY(flow_id, node_id)
		);
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
	`);
	const selectionAskMessageColumns = db.prepare("PRAGMA table_info(selection_ask_messages)").all() as Record<string, unknown>[];
	if (!selectionAskMessageColumns.some((column: Record<string, unknown>): boolean => String(column.name) === "error_message")) {
		db.exec("ALTER TABLE selection_ask_messages ADD COLUMN error_message TEXT");
	}
	const agentGoalColumns = db.prepare("PRAGMA table_info(agent_goals)").all() as Record<string, unknown>[];
	if (!agentGoalColumns.some((column: Record<string, unknown>): boolean => String(column.name) === "dismissed_at")) {
		db.exec("ALTER TABLE agent_goals ADD COLUMN dismissed_at TEXT");
	}
	const subagentNodeColumns = db.prepare("PRAGMA table_info(subagent_nodes)").all() as Record<string, unknown>[];
	const subagentColumnNames = new Set(subagentNodeColumns.map((column): string => String(column.name)));
	if (!subagentColumnNames.has("name")) db.exec("ALTER TABLE subagent_nodes ADD COLUMN name TEXT NOT NULL DEFAULT 'Subagent'");
	if (!subagentColumnNames.has("retry_of_run_id")) db.exec("ALTER TABLE subagent_nodes ADD COLUMN retry_of_run_id TEXT");
	if (!subagentColumnNames.has("attempt")) db.exec("ALTER TABLE subagent_nodes ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1");
	if (!subagentColumnNames.has("retry_policy_json")) db.exec("ALTER TABLE subagent_nodes ADD COLUMN retry_policy_json TEXT NOT NULL DEFAULT '{\"mode\":\"transient_only\",\"maxRetries\":1}'");
	if (!subagentColumnNames.has("queue_reason")) db.exec("ALTER TABLE subagent_nodes ADD COLUMN queue_reason TEXT");
	if (!subagentColumnNames.has("queued_at")) db.exec("ALTER TABLE subagent_nodes ADD COLUMN queued_at TEXT");
	if (!subagentColumnNames.has("next_retry_at")) db.exec("ALTER TABLE subagent_nodes ADD COLUMN next_retry_at TEXT");
	const flowBranchColumnNames: Set<string> = new Set(
		(db.prepare("PRAGMA table_info(conversation_flow_branches)").all() as Array<{ name: string }>).map(
			(column): string => column.name,
		),
	);
	const flowColumnNames: Set<string> = new Set(
		(db.prepare("PRAGMA table_info(conversation_flows)").all() as Array<{ name: string }>).map(
			(column): string => column.name,
		),
	);
	if (!flowColumnNames.has("pinned")) db.exec("ALTER TABLE conversation_flows ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
	if (!flowBranchColumnNames.has("head_node_id")) db.exec("ALTER TABLE conversation_flow_branches ADD COLUMN head_node_id TEXT");
	if (!flowBranchColumnNames.has("pending_regenerate")) db.exec("ALTER TABLE conversation_flow_branches ADD COLUMN pending_regenerate INTEGER NOT NULL DEFAULT 0");
	const flowNodeColumnNames: Set<string> = new Set(
		(db.prepare("PRAGMA table_info(conversation_flow_nodes)").all() as Array<{ name: string }>).map(
			(column): string => column.name,
		),
	);
	if (!flowNodeColumnNames.has("content_preview")) db.exec("ALTER TABLE conversation_flow_nodes ADD COLUMN content_preview TEXT NOT NULL DEFAULT ''");
	runSessionTransaction(db, (): void => {
		const observationColumns = db.prepare("PRAGMA table_info(computer_observations)").all();
		if (!observationColumns.some((column): boolean => column.name === "groundings_json")) {
			db.exec("ALTER TABLE computer_observations ADD COLUMN groundings_json TEXT");
		}
		db.exec(`
			INSERT OR IGNORE INTO schema_migrations(version, applied_at)
			VALUES (${DB_SCHEMA_VERSION}, datetime('now'));
			PRAGMA user_version = ${DB_SCHEMA_VERSION};
		`);
	});
	// 运行锁只描述当前后端进程中的真实执行，进程重启后不能继续占用 Flow
	db.exec(`
		UPDATE conversation_flows
		SET active_branch_id = NULL, active_request_id = NULL
		WHERE active_request_id IS NOT NULL;
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
	// Session tests use the same temporary profile for the search cache. Close
	// that independent SQLite handle before the fixture directory is removed.
	const { closeSearchCacheDatabase } = await import("../session-search/search-cache.js");
	await closeSearchCacheDatabase();
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
