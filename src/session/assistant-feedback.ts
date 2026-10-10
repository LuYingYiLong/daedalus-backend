import type { DatabaseSync } from "node:sqlite";
import { getSessionDatabase } from "./session-database.js";

export type AssistantFeedbackRating = "good" | "bad";

export async function readAssistantFeedback(
	sessionId: string,
	requestIds: readonly string[],
): Promise<Map<string, AssistantFeedbackRating>> {
	const uniqueRequestIds: string[] = [...new Set(requestIds)].filter((requestId): boolean => requestId.length > 0);
	if (uniqueRequestIds.length === 0) return new Map();
	const db: DatabaseSync = await getSessionDatabase();
	const rows = db.prepare(`
		SELECT request_id, rating FROM assistant_feedback
		WHERE session_id = ? AND request_id IN (${uniqueRequestIds.map((): string => "?").join(",")})
	`).all(sessionId, ...uniqueRequestIds) as Array<{ request_id: string; rating: AssistantFeedbackRating }>;
	return new Map(rows.map((row): [string, AssistantFeedbackRating] => [row.request_id, row.rating]));
}

export async function setAssistantFeedback(
	sessionId: string,
	requestId: string,
	rating: AssistantFeedbackRating | null,
): Promise<{ requestId: string; rating: AssistantFeedbackRating | null; updatedAt: string | null }> {
	const db: DatabaseSync = await getSessionDatabase();
	const response = db.prepare(`
		SELECT 1 FROM messages
		WHERE session_id = ? AND request_id = ? AND role = 'assistant'
		LIMIT 1
	`).get(sessionId, requestId);
	if (response === undefined) {
		throw Object.assign(new Error("Assistant response not found in this session."), {
			code: "assistant_feedback_response_not_found",
		});
	}
	if (rating === null) {
		db.prepare("DELETE FROM assistant_feedback WHERE session_id = ? AND request_id = ?").run(sessionId, requestId);
		return { requestId, rating: null, updatedAt: null };
	}
	const updatedAt: string = new Date().toISOString();
	db.prepare(`
		INSERT INTO assistant_feedback (session_id, request_id, rating, updated_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(session_id, request_id) DO UPDATE SET
			rating = excluded.rating,
			updated_at = excluded.updated_at
	`).run(sessionId, requestId, rating, updatedAt);
	return { requestId, rating, updatedAt };
}
