import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getSessionDatabase, parseSqlJson, runSessionTransaction, sqlJson } from "./session-database.js";

const MODEL_TRANSITION_CHANNEL: string = "workbench";
const MODEL_TRANSITION_EVENT: string = "session.model.transition.pending";

export type SessionModelRef = {
	provider: string;
	model: string;
};

export type PendingSessionModelTransition = {
	eventId: string;
	from: SessionModelRef;
	to: SessionModelRef;
};

export function hasSessionUserTurn(messages: readonly { role: string }[]): boolean {
	return messages.some((message: { role: string }): boolean => message.role === "user");
}

function isModelRef(value: unknown): value is SessionModelRef {
	return typeof value === "object"
		&& value !== null
		&& !Array.isArray(value)
		&& typeof (value as Record<string, unknown>).provider === "string"
		&& typeof (value as Record<string, unknown>).model === "string";
}

function isSameModel(left: SessionModelRef, right: SessionModelRef): boolean {
	return left.provider === right.provider && left.model === right.model;
}

function readPendingTransitionRow(db: DatabaseSync, sessionId: string): PendingSessionModelTransition | null {
	const row = db.prepare(`
		SELECT event_id, data_json FROM session_events
		WHERE session_id = ? AND channel = ? AND event_name = ?
		ORDER BY sequence DESC LIMIT 1
	`).get(sessionId, MODEL_TRANSITION_CHANNEL, MODEL_TRANSITION_EVENT) as Record<string, unknown> | undefined;
	if (row === undefined) {
		return null;
	}
	const data: Record<string, unknown> = parseSqlJson<Record<string, unknown>>(row.data_json);
	if (!isModelRef(data.from) || !isModelRef(data.to)) {
		return null;
	}
	return {
		eventId: String(row.event_id),
		from: data.from,
		to: data.to,
	};
}

export async function readPendingSessionModelTransition(sessionId: string): Promise<PendingSessionModelTransition | null> {
	return readPendingTransitionRow(await getSessionDatabase(), sessionId);
}

export async function recordPendingSessionModelTransition(
	sessionId: string,
	from: SessionModelRef,
	to: SessionModelRef,
): Promise<void> {
	const db: DatabaseSync = await getSessionDatabase();
	runSessionTransaction(db, (): void => {
		const existing: PendingSessionModelTransition | null = readPendingTransitionRow(db, sessionId);
		const origin: SessionModelRef = existing?.from ?? from;
		db.prepare(`
			DELETE FROM session_events
			WHERE session_id = ? AND channel = ? AND event_name = ?
		`).run(sessionId, MODEL_TRANSITION_CHANNEL, MODEL_TRANSITION_EVENT);
		if (isSameModel(origin, to)) {
			return;
		}
		const sequenceRow = db.prepare(`
			SELECT COALESCE(MAX(sequence), 0) AS sequence
			FROM session_events WHERE session_id = ? AND channel = ?
		`).get(sessionId, MODEL_TRANSITION_CHANNEL) as Record<string, unknown>;
		db.prepare(`
			INSERT INTO session_events(
				event_id, session_id, sequence, channel, request_id, event_name, data_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			`model-transition-${randomUUID()}`,
			sessionId,
			Number(sequenceRow.sequence) + 1,
			MODEL_TRANSITION_CHANNEL,
			"",
			MODEL_TRANSITION_EVENT,
			sqlJson({ from: origin, to }),
			new Date().toISOString(),
		);
	});
}

export async function clearPendingSessionModelTransition(sessionId: string, eventId: string): Promise<void> {
	const db: DatabaseSync = await getSessionDatabase();
	db.prepare(`
		DELETE FROM session_events
		WHERE session_id = ? AND event_id = ? AND channel = ? AND event_name = ?
	`).run(sessionId, eventId, MODEL_TRANSITION_CHANNEL, MODEL_TRANSITION_EVENT);
}
