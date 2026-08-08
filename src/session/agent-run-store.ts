import type { DatabaseSync } from "node:sqlite";
import type { PendingAiContinuation } from "./pending-continuation.js";
import type { PendingToolBudget } from "./pending-tool-budget.js";
import {
	AGENT_RUN_STATE_SCHEMA_VERSION,
	cloneAgentRunState,
	interruptRecoverableAgentRun,
	type AgentRunState
} from "../workflow/agent-run-state.js";
import {
	getSessionDatabase,
	parseSqlJson,
	runSessionTransaction,
	sqlJson
} from "./session-database.js";

export type PersistedAgentRunContinuation =
	| {
		kind: "approval";
		pauseId: string;
		revision: number;
		continuation: PendingAiContinuation;
	}
	| {
		kind: "tool_budget";
		pauseId: string;
		revision: number;
		pending: PendingToolBudget;
	};

function serializeWithoutApiKey(value: unknown): unknown {
	const cloned: unknown = structuredClone(value);
	if (typeof cloned !== "object" || cloned === null || Array.isArray(cloned)) {
		return cloned;
	}
	const record: Record<string, unknown> = cloned as Record<string, unknown>;
	const options: unknown = record.options;
	if (typeof options === "object" && options !== null && !Array.isArray(options)) {
		delete (options as Record<string, unknown>).apiKey;
	}
	const directContinuation: unknown = record.continuation;
	if (
		typeof directContinuation === "object"
		&& directContinuation !== null
		&& !Array.isArray(directContinuation)
	) {
		const nestedOptions: unknown = (directContinuation as Record<string, unknown>).options;
		if (typeof nestedOptions === "object" && nestedOptions !== null && !Array.isArray(nestedOptions)) {
			delete (nestedOptions as Record<string, unknown>).apiKey;
		}
	}
	const pending: unknown = record.pending;
	if (typeof pending === "object" && pending !== null && !Array.isArray(pending)) {
		const continuation: unknown = (pending as Record<string, unknown>).continuation;
		if (typeof continuation === "object" && continuation !== null && !Array.isArray(continuation)) {
			const nestedOptions: unknown = (continuation as Record<string, unknown>).options;
			if (typeof nestedOptions === "object" && nestedOptions !== null && !Array.isArray(nestedOptions)) {
				delete (nestedOptions as Record<string, unknown>).apiKey;
			}
		}
	}
	return cloned;
}

function parsePersistedAgentRunState(value: unknown): AgentRunState {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("agent_run_state_corrupted: persisted state is not an object");
	}
	const record: Record<string, unknown> = value as Record<string, unknown>;
	if (record.schemaVersion === AGENT_RUN_STATE_SCHEMA_VERSION) {
		return record as AgentRunState;
	}
	if (record.schemaVersion === 1 || record.schemaVersion === 2) {
		// Older runs keep their recorded lane and continuation semantics. New
		// agent-loop state is optional, so migration is structural and never
		// infers execution state from titles, prompts, or model prose.
		return { ...record, schemaVersion: AGENT_RUN_STATE_SCHEMA_VERSION } as AgentRunState;
	}
	throw new Error(`agent_run_state_corrupted: unsupported schema version ${String(record.schemaVersion)}`);
}

function upsertAgentRunState(db: DatabaseSync, state: AgentRunState): void {
	db.prepare(`
			INSERT INTO agent_runs(
				run_id, session_id, request_id, root_request_id, retry_of_run_id,
				revision, stage, state_json, checkpoint_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(run_id) DO UPDATE SET
				request_id = excluded.request_id,
				root_request_id = excluded.root_request_id,
				retry_of_run_id = excluded.retry_of_run_id,
				revision = excluded.revision,
				stage = excluded.stage,
				state_json = excluded.state_json,
				checkpoint_json = excluded.checkpoint_json,
				updated_at = excluded.updated_at
			WHERE excluded.revision > agent_runs.revision
		`).run(
			state.runId,
			state.sessionId,
			state.requestId,
			state.rootRequestId,
			state.retryOfRunId ?? null,
			state.revision,
			state.stage,
			sqlJson(state),
			sqlJson(state.checkpoint),
			state.createdAt,
			state.updatedAt
		);
}

function excludeFailedRunMessagesFromLlmContext(db: DatabaseSync, state: AgentRunState): void {
	if (state.stage !== "failed") {
		return;
	}
	const rows = db.prepare(`
		SELECT row_id, payload_json FROM messages
		WHERE session_id = ? AND request_id = ?
		ORDER BY sequence
	`).all(state.sessionId, state.requestId) as Array<{ row_id: number; payload_json: unknown }>;
	const update = db.prepare("UPDATE messages SET payload_json = ? WHERE row_id = ?");
	for (const row of rows) {
		const message = parseSqlJson<Record<string, unknown>>(row.payload_json);
		if (message.excludeFromLlmContext === true) {
			continue;
		}
		update.run(sqlJson({
			...message,
			excludeFromLlmContext: true
		}), row.row_id);
	}
}

export async function saveAgentRunState(state: AgentRunState): Promise<void> {
	const db: DatabaseSync = await getSessionDatabase();
	runSessionTransaction(db, (): void => {
		upsertAgentRunState(db, state);
		const persisted = db.prepare(`
			SELECT revision, stage FROM agent_runs WHERE run_id = ?
		`).get(state.runId) as { revision: number; stage: string } | undefined;
		if (persisted?.revision !== state.revision || persisted.stage !== state.stage) {
			return;
		}
		excludeFailedRunMessagesFromLlmContext(db, state);
		if (state.stage !== "awaiting_approval" && state.stage !== "awaiting_tool_budget") {
			db.prepare("DELETE FROM agent_run_continuations WHERE run_id = ?").run(state.runId);
		}
	});
}

export async function readAgentRunState(runId: string): Promise<AgentRunState | null> {
	const db: DatabaseSync = await getSessionDatabase();
	const row = db.prepare("SELECT state_json FROM agent_runs WHERE run_id = ?").get(runId) as Record<string, unknown> | undefined;
	return row === undefined ? null : parsePersistedAgentRunState(parseSqlJson<unknown>(row.state_json));
}

export async function listAgentRunStates(sessionId: string): Promise<AgentRunState[]> {
	const db: DatabaseSync = await getSessionDatabase();
	const rows = db.prepare(`
		SELECT state_json FROM agent_runs
		WHERE session_id = ?
		ORDER BY updated_at, run_id
	`).all(sessionId) as Record<string, unknown>[];
	return rows.map((row: Record<string, unknown>): AgentRunState => parsePersistedAgentRunState(parseSqlJson<unknown>(row.state_json)));
}

export async function markActiveAgentRunsInterrupted(
	sessionId: string,
	reason: string = "backend_restart"
): Promise<AgentRunState[]> {
	const states: AgentRunState[] = await listAgentRunStates(sessionId);
	const interrupted: AgentRunState[] = [];
	for (const state of states) {
		const next: AgentRunState = interruptRecoverableAgentRun(state, reason);
		if (next.revision === state.revision) {
			continue;
		}
		await saveAgentRunState(next);
		interrupted.push(next);
	}
	return interrupted;
}

export async function saveAgentRunContinuation(
	run: AgentRunState,
	continuation: PersistedAgentRunContinuation
): Promise<void> {
	if (continuation.revision !== run.revision) {
		throw new Error(`Continuation revision ${continuation.revision} does not match run revision ${run.revision}.`);
	}
	const expectedPauseKind: "approval" | "tool_budget" = continuation.kind;
	if (
		run.pause === null
		|| run.pause.kind !== expectedPauseKind
		|| run.pause.id !== continuation.pauseId
		|| (
			continuation.kind === "approval"
				? run.stage !== "awaiting_approval"
				: run.stage !== "awaiting_tool_budget"
		)
	) {
		throw new Error(`Continuation ${continuation.pauseId} does not match paused run ${run.runId}.`);
	}
	const now: string = new Date().toISOString();
	const db: DatabaseSync = await getSessionDatabase();
	runSessionTransaction(db, (): void => {
		upsertAgentRunState(db, run);
		const persistedRun = db.prepare(`
			SELECT revision FROM agent_runs WHERE run_id = ?
		`).get(run.runId) as { revision: number } | undefined;
		if (persistedRun?.revision !== run.revision) {
			throw new Error(`Cannot persist stale continuation for run ${run.runId}.`);
		}
		db.prepare(`
			INSERT INTO agent_run_continuations(
				run_id, session_id, revision, kind, pause_id, payload_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(run_id) DO UPDATE SET
				revision = excluded.revision,
				kind = excluded.kind,
				pause_id = excluded.pause_id,
				payload_json = excluded.payload_json,
				updated_at = excluded.updated_at
		`).run(
			run.runId,
			run.sessionId,
			continuation.revision,
			continuation.kind,
			continuation.pauseId,
			sqlJson(serializeWithoutApiKey(continuation)),
			now,
			now
		);
	});
}

export async function saveAgentRunApprovalPause(
	run: AgentRunState,
	continuation: Extract<PersistedAgentRunContinuation, { kind: "approval" }>,
	approvalEvent: {
		approvalId: string;
		requestId: string;
		data: unknown;
	}
): Promise<void> {
	if (continuation.revision !== run.revision) {
		throw new Error(`Continuation revision ${continuation.revision} does not match run revision ${run.revision}.`);
	}
	if (
		run.stage !== "awaiting_approval"
		|| run.pause?.kind !== "approval"
		|| run.pause.id !== continuation.pauseId
		|| approvalEvent.approvalId !== continuation.pauseId
	) {
		throw new Error(`Approval ${approvalEvent.approvalId} does not match paused run ${run.runId}.`);
	}
	const now: string = new Date().toISOString();
	const db: DatabaseSync = await getSessionDatabase();
	runSessionTransaction(db, (): void => {
		upsertAgentRunState(db, run);
		const persistedRun = db.prepare("SELECT revision FROM agent_runs WHERE run_id = ?")
			.get(run.runId) as { revision: number } | undefined;
		if (persistedRun?.revision !== run.revision) {
			throw new Error(`Cannot persist stale approval pause for run ${run.runId}.`);
		}
		db.prepare(`
			INSERT INTO agent_run_continuations(
				run_id, session_id, revision, kind, pause_id, payload_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(run_id) DO UPDATE SET
				revision = excluded.revision,
				kind = excluded.kind,
				pause_id = excluded.pause_id,
				payload_json = excluded.payload_json,
				updated_at = excluded.updated_at
		`).run(
			run.runId,
			run.sessionId,
			continuation.revision,
			continuation.kind,
			continuation.pauseId,
			sqlJson(serializeWithoutApiKey(continuation)),
			now,
			now
		);
		const sequenceRow = db.prepare(`
			SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM session_events
			WHERE session_id = ? AND channel = 'approval'
		`).get(run.sessionId) as Record<string, unknown>;
		db.prepare(`
			INSERT INTO session_events(
				event_id, session_id, sequence, channel, request_id, event_name, data_json,
				approval_id, workflow_id, run_id, created_at
			) VALUES (?, ?, ?, 'approval', ?, 'requested', ?, ?, NULL, ?, ?)
		`).run(
			`approval-event-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
			run.sessionId,
			Number(sequenceRow.value),
			approvalEvent.requestId,
			sqlJson(approvalEvent.data),
			approvalEvent.approvalId,
			run.runId,
			now
		);
	});
}

export async function readAgentRunContinuation(runId: string): Promise<PersistedAgentRunContinuation | null> {
	const db: DatabaseSync = await getSessionDatabase();
	const row = db.prepare(`
		SELECT continuation.payload_json
		FROM agent_run_continuations AS continuation
		INNER JOIN agent_runs AS run ON run.run_id = continuation.run_id
		WHERE continuation.run_id = ?
			AND continuation.revision = run.revision
			AND (
				(continuation.kind = 'approval' AND run.stage = 'awaiting_approval')
				OR (continuation.kind = 'tool_budget' AND run.stage = 'awaiting_tool_budget')
			)
	`).get(runId) as Record<string, unknown> | undefined;
	return row === undefined ? null : parseSqlJson<PersistedAgentRunContinuation>(row.payload_json);
}

export async function removeAgentRunContinuation(runId: string): Promise<void> {
	const db: DatabaseSync = await getSessionDatabase();
	db.prepare("DELETE FROM agent_run_continuations WHERE run_id = ?").run(runId);
}

export function clonePersistedAgentRunState(state: AgentRunState): AgentRunState {
	return cloneAgentRunState(state);
}
