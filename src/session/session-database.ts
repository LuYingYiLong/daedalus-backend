import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { getSessionsDatabasePath, getDaedalusPath } from "../app-paths.js";
import { logger } from "../logger.js";

const DB_SCHEMA_VERSION: number = 27;
const FLOW_PARAMETER_SCHEMA_VERSION: number = 27;

export type SessionDatabaseState =
	| { available: true; db: DatabaseSync }
	| { available: false; errorMessage: string };

const statePromisesByPath: Map<string, Promise<SessionDatabaseState>> = new Map();
let testDatabasePath: string | null = null;

function resolveDatabasePath(): string {
	return testDatabasePath ?? getSessionsDatabasePath();
}

function migrateSchema(db: DatabaseSync): void {
	const previousSchemaVersion: number = Number(
		(db.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined)?.user_version ?? 0,
	);
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
		CREATE TABLE IF NOT EXISTS flow_documents (
			flow_id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			workspace_id TEXT,
			pinned INTEGER NOT NULL DEFAULT 0,
			revision INTEGER NOT NULL DEFAULT 1,
			graph_revision INTEGER NOT NULL DEFAULT 1,
			layout_revision INTEGER NOT NULL DEFAULT 1,
			approval_mode TEXT NOT NULL DEFAULT 'manual',
			viewport_json TEXT NOT NULL,
			archived_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_flow_documents_workspace
			ON flow_documents (workspace_id, archived_at, updated_at DESC);
		CREATE TABLE IF NOT EXISTS flow_nodes (
			node_id TEXT PRIMARY KEY,
			flow_id TEXT NOT NULL REFERENCES flow_documents(flow_id) ON DELETE CASCADE,
			type_id TEXT NOT NULL,
			plugin_id TEXT NOT NULL,
			plugin_version TEXT NOT NULL,
			plugin_fingerprint TEXT NOT NULL,
			config_version INTEGER NOT NULL,
			title TEXT NOT NULL,
			x REAL NOT NULL,
			y REAL NOT NULL,
			width REAL NOT NULL,
			height REAL NOT NULL,
			config_json TEXT NOT NULL,
			ports_json TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'idle',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_flow_nodes_flow ON flow_nodes (flow_id, created_at, node_id);
		CREATE TABLE IF NOT EXISTS flow_artifacts (
			artifact_id TEXT PRIMARY KEY,
			flow_id TEXT NOT NULL REFERENCES flow_documents(flow_id) ON DELETE CASCADE,
			run_id TEXT NOT NULL REFERENCES flow_runs(run_id) ON DELETE CASCADE,
			node_id TEXT NOT NULL REFERENCES flow_nodes(node_id) ON DELETE CASCADE,
			mime_type TEXT NOT NULL,
			byte_size INTEGER NOT NULL,
			sha256 TEXT NOT NULL,
			width INTEGER,
			height INTEGER,
			duration_ms INTEGER,
			fps REAL,
			preview_artifact_id TEXT,
			storage_path TEXT NOT NULL,
			metadata_json TEXT NOT NULL DEFAULT '{}',
			created_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_flow_artifacts_flow_run ON flow_artifacts (flow_id, run_id, node_id, created_at DESC);
		CREATE TABLE IF NOT EXISTS flow_edges (
			edge_id TEXT PRIMARY KEY,
			flow_id TEXT NOT NULL REFERENCES flow_documents(flow_id) ON DELETE CASCADE,
			source_node_id TEXT NOT NULL REFERENCES flow_nodes(node_id) ON DELETE CASCADE,
			source_port TEXT NOT NULL,
			target_node_id TEXT NOT NULL REFERENCES flow_nodes(node_id) ON DELETE CASCADE,
			target_port TEXT NOT NULL,
			data_type TEXT NOT NULL CHECK(data_type IN ('text', 'json', 'image', 'video', 'audio', 'frames', 'artifact', 'number', 'boolean', 'color', 'size', 'mask')),
			UNIQUE(flow_id, target_node_id, target_port)
		);
		CREATE INDEX IF NOT EXISTS idx_flow_edges_flow ON flow_edges (flow_id, edge_id);
		CREATE TABLE IF NOT EXISTS flow_runs (
			run_id TEXT PRIMARY KEY,
			flow_id TEXT NOT NULL REFERENCES flow_documents(flow_id) ON DELETE CASCADE,
			revision INTEGER NOT NULL,
			entry_node_ids_json TEXT NOT NULL DEFAULT '[]',
			target_node_ids_json TEXT NOT NULL DEFAULT '[]',
			input_values_json TEXT NOT NULL DEFAULT '{}',
			status TEXT NOT NULL,
			started_at TEXT,
			finished_at TEXT,
			error TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_flow_runs_flow ON flow_runs (flow_id, started_at DESC);
		CREATE TABLE IF NOT EXISTS flow_node_runs (
			run_id TEXT NOT NULL REFERENCES flow_runs(run_id) ON DELETE CASCADE,
			node_id TEXT NOT NULL REFERENCES flow_nodes(node_id) ON DELETE CASCADE,
			type_id TEXT NOT NULL,
			plugin_version TEXT NOT NULL,
			plugin_fingerprint TEXT NOT NULL,
			config_version INTEGER NOT NULL,
			status TEXT NOT NULL,
			provider_job_id TEXT,
			input_fingerprint TEXT,
			output_json TEXT,
			error TEXT,
			started_at TEXT,
			finished_at TEXT,
			PRIMARY KEY(run_id, node_id)
		);
		CREATE INDEX IF NOT EXISTS idx_flow_node_runs_cache ON flow_node_runs (node_id, input_fingerprint, status);
		CREATE TABLE IF NOT EXISTS flow_operations (
			mutation_id TEXT PRIMARY KEY,
			flow_id TEXT NOT NULL REFERENCES flow_documents(flow_id) ON DELETE CASCADE,
			client_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			graph_revision INTEGER NOT NULL,
			layout_revision INTEGER NOT NULL,
			created_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_flow_operations_flow ON flow_operations(flow_id, created_at, mutation_id);
		CREATE TABLE IF NOT EXISTS flow_approvals (
			approval_id TEXT PRIMARY KEY,
			flow_id TEXT NOT NULL REFERENCES flow_documents(flow_id) ON DELETE CASCADE,
			run_id TEXT NOT NULL REFERENCES flow_runs(run_id) ON DELETE CASCADE,
			node_id TEXT NOT NULL REFERENCES flow_nodes(node_id) ON DELETE CASCADE,
			tool_name TEXT NOT NULL,
			reason TEXT NOT NULL,
			pending_json TEXT NOT NULL,
			status TEXT NOT NULL,
			required_consent_json TEXT,
			created_at TEXT NOT NULL,
			resolved_at TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_flow_approvals_run ON flow_approvals(flow_id, run_id, status, created_at);
		CREATE TABLE IF NOT EXISTS flow_node_run_events (
			run_id TEXT NOT NULL REFERENCES flow_runs(run_id) ON DELETE CASCADE,
			node_id TEXT NOT NULL REFERENCES flow_nodes(node_id) ON DELETE CASCADE,
			sequence INTEGER NOT NULL,
			event_type TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			created_at TEXT NOT NULL,
			PRIMARY KEY(run_id, node_id, sequence)
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
	const flowDocumentColumns = new Set(
		(db.prepare("PRAGMA table_info(flow_documents)").all() as Array<{ name: string }>).map((column): string => column.name),
	);
	if (!flowDocumentColumns.has("graph_revision")) db.exec("ALTER TABLE flow_documents ADD COLUMN graph_revision INTEGER NOT NULL DEFAULT 1");
	if (!flowDocumentColumns.has("layout_revision")) db.exec("ALTER TABLE flow_documents ADD COLUMN layout_revision INTEGER NOT NULL DEFAULT 1");
	if (!flowDocumentColumns.has("approval_mode")) db.exec("ALTER TABLE flow_documents ADD COLUMN approval_mode TEXT NOT NULL DEFAULT 'manual'");
	db.exec("UPDATE flow_documents SET graph_revision = revision WHERE graph_revision = 1 AND revision <> 1");
	db.exec("UPDATE flow_documents SET layout_revision = revision WHERE layout_revision = 1 AND revision <> 1");
	const flowNodeColumns = new Set((db.prepare("PRAGMA table_info(flow_nodes)").all() as Array<{ name: string }>).map((column): string => column.name));
	if (previousSchemaVersion < FLOW_PARAMETER_SCHEMA_VERSION || !flowNodeColumns.has("type_id") || !flowNodeColumns.has("plugin_fingerprint")) {
		// Flow is still pre-release. Parameter definitions replace the old port
		// contract, so reset its snapshots instead of carrying a compatibility layer.
		const legacyFlowBranchSessionIds: string[] = db.prepare(
			"SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'conversation_flow_branches'",
		).get() === undefined
			? []
			: (db.prepare("SELECT session_id FROM conversation_flow_branches").all() as Array<{ session_id: string }>).map(
				(row): string => row.session_id,
			);
		db.exec("PRAGMA foreign_keys = OFF");
		db.exec(`
			DROP TABLE IF EXISTS flow_video_saves;
			DROP TABLE IF EXISTS flow_image_saves;
			DROP TABLE IF EXISTS flow_batch_items;
			DROP TABLE IF EXISTS flow_node_run_events;
			DROP TABLE IF EXISTS flow_artifacts;
			DROP TABLE IF EXISTS flow_approvals;
			DROP TABLE IF EXISTS flow_node_runs;
			DROP TABLE IF EXISTS flow_runs;
			DROP TABLE IF EXISTS flow_operations;
			DROP TABLE IF EXISTS flow_edges;
			DROP TABLE IF EXISTS flow_nodes;
			DROP TABLE IF EXISTS flow_documents;
			DROP TABLE IF EXISTS conversation_flow_layout;
			DROP TABLE IF EXISTS conversation_flow_nodes;
			DROP TABLE IF EXISTS conversation_flow_branches;
			DROP TABLE IF EXISTS conversation_flows;
			CREATE TABLE flow_documents (flow_id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_id TEXT, pinned INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1, graph_revision INTEGER NOT NULL DEFAULT 1, layout_revision INTEGER NOT NULL DEFAULT 1, approval_mode TEXT NOT NULL DEFAULT 'manual', viewport_json TEXT NOT NULL, archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
			CREATE INDEX idx_flow_documents_workspace ON flow_documents (workspace_id, archived_at, updated_at DESC);
			CREATE TABLE flow_nodes (node_id TEXT PRIMARY KEY, flow_id TEXT NOT NULL REFERENCES flow_documents(flow_id) ON DELETE CASCADE, type_id TEXT NOT NULL, plugin_id TEXT NOT NULL, plugin_version TEXT NOT NULL, plugin_fingerprint TEXT NOT NULL, config_version INTEGER NOT NULL, title TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL, width REAL NOT NULL, height REAL NOT NULL, config_json TEXT NOT NULL, ports_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'idle', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
			CREATE INDEX idx_flow_nodes_flow ON flow_nodes (flow_id, created_at, node_id);
			CREATE TABLE flow_artifacts (artifact_id TEXT PRIMARY KEY, flow_id TEXT NOT NULL REFERENCES flow_documents(flow_id) ON DELETE CASCADE, run_id TEXT NOT NULL REFERENCES flow_runs(run_id) ON DELETE CASCADE, node_id TEXT NOT NULL REFERENCES flow_nodes(node_id) ON DELETE CASCADE, mime_type TEXT NOT NULL, byte_size INTEGER NOT NULL, sha256 TEXT NOT NULL, width INTEGER, height INTEGER, duration_ms INTEGER, fps REAL, preview_artifact_id TEXT, storage_path TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
			CREATE INDEX idx_flow_artifacts_flow_run ON flow_artifacts (flow_id, run_id, node_id, created_at DESC);
			CREATE TABLE flow_edges (edge_id TEXT PRIMARY KEY, flow_id TEXT NOT NULL REFERENCES flow_documents(flow_id) ON DELETE CASCADE, source_node_id TEXT NOT NULL REFERENCES flow_nodes(node_id) ON DELETE CASCADE, source_port TEXT NOT NULL, target_node_id TEXT NOT NULL REFERENCES flow_nodes(node_id) ON DELETE CASCADE, target_port TEXT NOT NULL, data_type TEXT NOT NULL CHECK(data_type IN ('text', 'json', 'image', 'video', 'audio', 'frames', 'artifact', 'number', 'boolean', 'color', 'size', 'mask')), UNIQUE(flow_id, target_node_id, target_port));
			CREATE INDEX idx_flow_edges_flow ON flow_edges (flow_id, edge_id);
			CREATE TABLE flow_runs (run_id TEXT PRIMARY KEY, flow_id TEXT NOT NULL REFERENCES flow_documents(flow_id) ON DELETE CASCADE, revision INTEGER NOT NULL, entry_node_ids_json TEXT NOT NULL DEFAULT '[]', target_node_ids_json TEXT NOT NULL DEFAULT '[]', input_values_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL, started_at TEXT, finished_at TEXT, error TEXT);
			CREATE INDEX idx_flow_runs_flow ON flow_runs (flow_id, started_at DESC);
			CREATE TABLE flow_node_runs (run_id TEXT NOT NULL REFERENCES flow_runs(run_id) ON DELETE CASCADE, node_id TEXT NOT NULL REFERENCES flow_nodes(node_id) ON DELETE CASCADE, type_id TEXT NOT NULL, plugin_version TEXT NOT NULL, plugin_fingerprint TEXT NOT NULL, config_version INTEGER NOT NULL, status TEXT NOT NULL, provider_job_id TEXT, input_fingerprint TEXT, output_json TEXT, error TEXT, started_at TEXT, finished_at TEXT, PRIMARY KEY(run_id, node_id));
			CREATE INDEX idx_flow_node_runs_cache ON flow_node_runs (node_id, input_fingerprint, status);
			CREATE TABLE flow_approvals (approval_id TEXT PRIMARY KEY, flow_id TEXT NOT NULL REFERENCES flow_documents(flow_id) ON DELETE CASCADE, run_id TEXT NOT NULL REFERENCES flow_runs(run_id) ON DELETE CASCADE, node_id TEXT NOT NULL REFERENCES flow_nodes(node_id) ON DELETE CASCADE, tool_name TEXT NOT NULL, reason TEXT NOT NULL, pending_json TEXT NOT NULL, status TEXT NOT NULL, required_consent_json TEXT, created_at TEXT NOT NULL, resolved_at TEXT);
			CREATE INDEX idx_flow_approvals_run ON flow_approvals(flow_id, run_id, status, created_at);
			CREATE TABLE flow_node_run_events (run_id TEXT NOT NULL REFERENCES flow_runs(run_id) ON DELETE CASCADE, node_id TEXT NOT NULL REFERENCES flow_nodes(node_id) ON DELETE CASCADE, sequence INTEGER NOT NULL, event_type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(run_id, node_id, sequence));
			CREATE TABLE flow_operations (mutation_id TEXT PRIMARY KEY, flow_id TEXT NOT NULL REFERENCES flow_documents(flow_id) ON DELETE CASCADE, client_id TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, graph_revision INTEGER NOT NULL, layout_revision INTEGER NOT NULL, created_at TEXT NOT NULL);
			CREATE INDEX idx_flow_operations_flow ON flow_operations(flow_id, created_at, mutation_id);
		`);
		db.exec("PRAGMA foreign_keys = ON");
		const deleteLegacySession = db.prepare("DELETE FROM sessions WHERE session_id = ?");
		for (const sessionId of legacyFlowBranchSessionIds) deleteLegacySession.run(sessionId);
	}
	db.exec(`CREATE TABLE IF NOT EXISTS flow_batch_items(run_id TEXT NOT NULL REFERENCES flow_runs(run_id) ON DELETE CASCADE, node_id TEXT NOT NULL REFERENCES flow_nodes(node_id) ON DELETE CASCADE, item_id TEXT NOT NULL, flow_id TEXT NOT NULL REFERENCES flow_documents(flow_id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, request_fingerprint TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(run_id,node_id,item_id)); CREATE INDEX IF NOT EXISTS idx_flow_batch_cache ON flow_batch_items(flow_id,node_id,item_id,request_fingerprint,updated_at);`);
	db.exec("CREATE TABLE IF NOT EXISTS flow_image_saves(save_id TEXT NOT NULL,item_index INTEGER NOT NULL,flow_id TEXT NOT NULL REFERENCES flow_documents(flow_id) ON DELETE CASCADE,relative_path TEXT NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(save_id,item_index))");
	db.exec("CREATE TABLE IF NOT EXISTS flow_video_saves(save_id TEXT NOT NULL,item_index INTEGER NOT NULL,flow_id TEXT NOT NULL REFERENCES flow_documents(flow_id) ON DELETE CASCADE,relative_path TEXT NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(save_id,item_index))");
	const currentFlowNodeColumns = db.prepare("PRAGMA table_info(flow_nodes)").all() as Array<{ name: string }>;
	if (!currentFlowNodeColumns.some(column => column.name === "collapsed"))
		db.exec("ALTER TABLE flow_nodes ADD COLUMN collapsed INTEGER NOT NULL DEFAULT 0 CHECK (collapsed IN (0, 1))");
	const flowRunColumns = new Set((db.prepare("PRAGMA table_info(flow_runs)").all() as Array<{ name: string }>).map((column): string => column.name));
	if (!flowRunColumns.has("entry_node_ids_json")) db.exec("ALTER TABLE flow_runs ADD COLUMN entry_node_ids_json TEXT NOT NULL DEFAULT '[]'");
	if (!flowRunColumns.has("target_node_ids_json")) db.exec("ALTER TABLE flow_runs ADD COLUMN target_node_ids_json TEXT NOT NULL DEFAULT '[]'");
	if (!flowRunColumns.has("input_values_json")) db.exec("ALTER TABLE flow_runs ADD COLUMN input_values_json TEXT NOT NULL DEFAULT '{}'");
	db.exec("UPDATE flow_nodes SET config_json = json_remove(config_json, '$.required') WHERE type_id = 'builtin/flow-input' AND json_type(config_json, '$.required') IS NOT NULL");
	db.exec(`
		CREATE TEMP TABLE recoverable_flow_runs AS SELECT DISTINCT r.run_id FROM flow_runs r JOIN flow_batch_items b ON b.run_id=r.run_id WHERE r.status IN ('queued','running') AND b.status IN ('running','submitting') AND json_extract(b.payload_json,'$.providerJobId') IS NOT NULL;
		UPDATE flow_node_runs
		SET status = 'failed', error = COALESCE(error, 'Flow run was interrupted before the backend restarted.'), finished_at = COALESCE(finished_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		WHERE status IN ('queued', 'running', 'waiting')
			AND NOT (run_id IN (SELECT run_id FROM recoverable_flow_runs) AND (status='queued' OR node_id IN (SELECT node_id FROM flow_batch_items WHERE flow_batch_items.run_id=flow_node_runs.run_id)))
			AND run_id IN (SELECT run_id FROM flow_runs WHERE status IN ('queued', 'running', 'waiting'));
		UPDATE flow_runs
		SET status = 'failed', error = COALESCE(error, 'Flow run was interrupted before the backend restarted.'), finished_at = COALESCE(finished_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		WHERE status IN ('queued', 'running', 'waiting') AND run_id NOT IN (SELECT run_id FROM recoverable_flow_runs);
		UPDATE flow_node_runs SET status='queued' WHERE run_id IN (SELECT run_id FROM recoverable_flow_runs) AND status IN ('running','waiting');
		UPDATE flow_runs SET status='queued' WHERE run_id IN (SELECT run_id FROM recoverable_flow_runs);
		DROP TABLE recoverable_flow_runs;
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
}

async function openDatabase(): Promise<SessionDatabaseState> {
	let db: DatabaseSync | undefined;
	const databasePath: string = resolveDatabasePath();
	try {
		const sqlite = await import("node:sqlite");
		await mkdir(dirname(databasePath), { recursive: true });
		db = new sqlite.DatabaseSync(databasePath, { timeout: 5000 });
		const previousVersion = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
		db.exec("CREATE TABLE IF NOT EXISTS flow_storage_maintenance(key TEXT PRIMARY KEY, pending INTEGER NOT NULL)");
		if (previousVersion > 0 && previousVersion < 27) db.exec("INSERT OR REPLACE INTO flow_storage_maintenance VALUES('composable-reset',1)");
		migrateSchema(db);
		if (db.prepare("SELECT key FROM flow_storage_maintenance WHERE key='composable-reset' AND pending=1").get() && testDatabasePath === null) {
			await rm(getDaedalusPath("flow.artifacts.root"), { recursive: true, force: true });
			await rm(getDaedalusPath("config.flowTreeOrder"), { force: true });
			db.exec("UPDATE flow_storage_maintenance SET pending=0 WHERE key='composable-reset'");
		}
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
