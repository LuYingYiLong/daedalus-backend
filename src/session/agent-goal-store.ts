import type { DatabaseSync } from "node:sqlite";
import { cloneAgentGoalState, transitionAgentGoalState, type AgentGoalState } from "../workflow/agent-goal-state.js";
import { getSessionDatabase, parseSqlJson, runSessionTransaction, sqlJson } from "./session-database.js";

function upsert(db: DatabaseSync, state: AgentGoalState): void {
	db.prepare(`
		INSERT INTO agent_goals(
			goal_id, session_id, root_request_id, revision, stage, state_json,
			created_at, updated_at, completed_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(goal_id) DO UPDATE SET
			revision = excluded.revision,
			stage = excluded.stage,
			state_json = excluded.state_json,
			updated_at = excluded.updated_at,
			completed_at = excluded.completed_at
		WHERE excluded.revision > agent_goals.revision
	`).run(
		state.goalId,
		state.sessionId,
		state.rootRequestId,
		state.revision,
		state.stage,
		sqlJson(state),
		state.createdAt,
		state.updatedAt,
		state.completedAt
	);
}

export async function saveAgentGoalState(state: AgentGoalState): Promise<void> {
	const db: DatabaseSync = await getSessionDatabase();
	runSessionTransaction(db, (): void => upsert(db, state));
}

export async function readAgentGoalState(goalId: string): Promise<AgentGoalState | null> {
	const db: DatabaseSync = await getSessionDatabase();
	const row = db.prepare("SELECT state_json FROM agent_goals WHERE goal_id = ?").get(goalId) as Record<string, unknown> | undefined;
	return row === undefined ? null : parseSqlJson<AgentGoalState>(row.state_json);
}

export async function readCurrentAgentGoal(sessionId: string): Promise<AgentGoalState | null> {
	const db: DatabaseSync = await getSessionDatabase();
	const row = db.prepare(`
		SELECT state_json FROM agent_goals
		WHERE session_id = ? AND completed_at IS NULL
		ORDER BY updated_at DESC LIMIT 1
	`).get(sessionId) as Record<string, unknown> | undefined;
	return row === undefined ? null : parseSqlJson<AgentGoalState>(row.state_json);
}

export async function readLatestAgentGoal(sessionId: string): Promise<AgentGoalState | null> {
	const db: DatabaseSync = await getSessionDatabase();
	const row = db.prepare(`
		SELECT state_json FROM agent_goals
		WHERE session_id = ?
		ORDER BY updated_at DESC LIMIT 1
	`).get(sessionId) as Record<string, unknown> | undefined;
	return row === undefined ? null : parseSqlJson<AgentGoalState>(row.state_json);
}

export async function linkAgentGoalRun(goalId: string, runId: string, cycle: number): Promise<void> {
	const db: DatabaseSync = await getSessionDatabase();
	db.prepare(`
		INSERT OR IGNORE INTO agent_goal_runs(goal_id, run_id, cycle, created_at)
		VALUES (?, ?, ?, ?)
	`).run(goalId, runId, cycle, new Date().toISOString());
}

export async function listAgentGoalRunIds(goalId: string): Promise<string[]> {
	const db: DatabaseSync = await getSessionDatabase();
	const rows = db.prepare(`
		SELECT run_id FROM agent_goal_runs WHERE goal_id = ? ORDER BY cycle, created_at
	`).all(goalId) as { run_id: string }[];
	return rows.map((row: { run_id: string }): string => row.run_id);
}

export async function markActiveAgentGoalsPaused(reason: "backend_restart" | "client_disconnected"): Promise<AgentGoalState[]> {
	const db: DatabaseSync = await getSessionDatabase();
	const rows = db.prepare("SELECT state_json FROM agent_goals WHERE completed_at IS NULL").all() as Record<string, unknown>[];
	const paused: AgentGoalState[] = [];
	runSessionTransaction(db, (): void => {
		for (const row of rows) {
			const state = parseSqlJson<AgentGoalState>(row.state_json);
			if (state.stage === "paused") continue;
			const next = transitionAgentGoalState(state, "paused", {
				pauseReason: reason,
				activeRunId: null
			});
			upsert(db, next);
			paused.push(next);
		}
	});
	return paused;
}

export function clonePersistedAgentGoalState(state: AgentGoalState): AgentGoalState {
	return cloneAgentGoalState(state);
}
