import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { MessageTextAnchor, ProviderId } from "../protocol/types.js";
import { getSessionDatabase, parseSqlJson, runSessionTransaction, sqlJson, toSqlValue } from "./session-database.js";

export type SelectionAskThreadStatus = "idle" | "running" | "failed" | "interrupted";
export type SelectionAskMessageStatus = "completed" | "running" | "failed" | "interrupted";

export type SelectionAskThread = {
	threadId: string;
	sessionId: string;
	anchor: MessageTextAnchor;
	provider: ProviderId;
	model: string;
	reasoningEffort?: string | undefined;
	baseUrl?: string | undefined;
	status: SelectionAskThreadStatus;
	createdAt: string;
	updatedAt: string;
};

export type SelectionAskMessage = {
	messageId: string;
	threadId: string;
	sequence: number;
	requestId: string;
	role: "user" | "assistant";
	content: string;
	status: SelectionAskMessageStatus;
	errorMessage?: string | undefined;
	createdAt: string;
	updatedAt: string;
};

export type SelectionAskThreadPage = {
	thread: SelectionAskThread;
	messages: SelectionAskMessage[];
	hasMoreBefore: boolean;
};

const PROCESS_STARTED_AT: string = new Date().toISOString();

function createAnchorKey(anchor: MessageTextAnchor): string {
	return createHash("sha256")
		.update([
			anchor.entryId,
			anchor.requestId,
			anchor.role,
			anchor.segmentKey,
			String(anchor.startOffset),
			String(anchor.endOffset),
			anchor.quote
		].join("\n"))
		.digest("hex");
}

function parseThreadRow(row: Record<string, unknown>): SelectionAskThread {
	return {
		threadId: String(row.thread_id),
		sessionId: String(row.session_id),
		anchor: parseSqlJson<MessageTextAnchor>(row.anchor_json),
		provider: String(row.provider),
		model: String(row.model),
		reasoningEffort: row.reasoning_effort === null ? undefined : String(row.reasoning_effort),
		baseUrl: row.base_url === null ? undefined : String(row.base_url),
		status: String(row.status) as SelectionAskThreadStatus,
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at)
	};
}

function parseMessageRow(row: Record<string, unknown>): SelectionAskMessage {
	return {
		messageId: String(row.message_id),
		threadId: String(row.thread_id),
		sequence: Number(row.sequence),
		requestId: String(row.request_id),
		role: String(row.role) as SelectionAskMessage["role"],
		content: String(row.content),
		status: String(row.status) as SelectionAskMessageStatus,
		errorMessage: row.error_message === null || row.error_message === undefined ? undefined : String(row.error_message),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at)
	};
}

function normalizeInterruptedRows(db: DatabaseSync): void {
	db.prepare(`
		UPDATE selection_ask_messages
		SET status = 'interrupted', updated_at = ?
		WHERE status = 'running' AND updated_at < ?
	`).run(PROCESS_STARTED_AT, PROCESS_STARTED_AT);
	db.prepare(`
		UPDATE selection_ask_threads
		SET status = 'interrupted', updated_at = ?
		WHERE status = 'running' AND updated_at < ?
	`).run(PROCESS_STARTED_AT, PROCESS_STARTED_AT);
}

export async function listSelectionAskThreads(sessionId: string): Promise<SelectionAskThread[]> {
	const db: DatabaseSync = await getSessionDatabase();
	normalizeInterruptedRows(db);
	const rows = db.prepare(`
		SELECT * FROM selection_ask_threads
		WHERE session_id = ?
		ORDER BY created_at ASC
	`).all(sessionId) as Record<string, unknown>[];
	return rows.map(parseThreadRow);
}

export async function readSelectionAskThread(sessionId: string, threadId: string): Promise<SelectionAskThread | null> {
	const db: DatabaseSync = await getSessionDatabase();
	normalizeInterruptedRows(db);
	const row = db.prepare(`
		SELECT * FROM selection_ask_threads
		WHERE session_id = ? AND thread_id = ?
	`).get(sessionId, threadId) as Record<string, unknown> | undefined;
	return row === undefined ? null : parseThreadRow(row);
}

export async function createOrReadSelectionAskThread(input: {
	sessionId: string;
	anchor: MessageTextAnchor;
	provider: ProviderId;
	model: string;
	reasoningEffort?: string | undefined;
	baseUrl?: string | undefined;
}): Promise<{ thread: SelectionAskThread; created: boolean }> {
	const db: DatabaseSync = await getSessionDatabase();
	const anchorKey: string = createAnchorKey(input.anchor);
	const now: string = new Date().toISOString();
	const threadId: string = `selection-ask-${randomUUID()}`;
	const inserted = db.prepare(`
		INSERT OR IGNORE INTO selection_ask_threads(
			thread_id, session_id, anchor_key, source_entry_id, source_request_id,
			anchor_json, provider, model, reasoning_effort, base_url, status, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)
	`).run(
		threadId,
		input.sessionId,
		anchorKey,
		input.anchor.entryId,
		input.anchor.requestId,
		sqlJson(input.anchor),
		input.provider,
		input.model,
		toSqlValue(input.reasoningEffort),
		toSqlValue(input.baseUrl),
		now,
		now
	);
	const row = db.prepare(`
		SELECT * FROM selection_ask_threads
		WHERE session_id = ? AND anchor_key = ?
	`).get(input.sessionId, anchorKey) as Record<string, unknown> | undefined;
	if (row === undefined) {
		throw new Error("selection_ask_create_failed: Failed to create selection Ask thread.");
	}
	return { thread: parseThreadRow(row), created: Number(inserted.changes) > 0 };
}

export async function readSelectionAskThreadPage(
	sessionId: string,
	threadId: string,
	beforeSequence: number | undefined,
	limit: number = 100
): Promise<SelectionAskThreadPage | null> {
	const thread: SelectionAskThread | null = await readSelectionAskThread(sessionId, threadId);
	if (thread === null) {
		return null;
	}
	const db: DatabaseSync = await getSessionDatabase();
	const boundedLimit: number = Math.max(1, Math.min(200, Math.floor(limit)));
	const rows = beforeSequence === undefined
		? db.prepare(`
			SELECT * FROM selection_ask_messages
			WHERE thread_id = ?
			ORDER BY sequence DESC LIMIT ?
		`).all(threadId, boundedLimit + 1) as Record<string, unknown>[]
		: db.prepare(`
			SELECT * FROM selection_ask_messages
			WHERE thread_id = ? AND sequence < ?
			ORDER BY sequence DESC LIMIT ?
		`).all(threadId, beforeSequence, boundedLimit + 1) as Record<string, unknown>[];
	const hasMoreBefore: boolean = rows.length > boundedLimit;
	const messages: SelectionAskMessage[] = rows.slice(0, boundedLimit).map(parseMessageRow).reverse();
	return { thread, messages, hasMoreBefore };
}

export async function appendSelectionAskTurn(
	thread: SelectionAskThread,
	requestId: string,
	userContent: string
): Promise<{ userMessage: SelectionAskMessage; assistantMessage: SelectionAskMessage }> {
	const db: DatabaseSync = await getSessionDatabase();
	const now: string = new Date().toISOString();
	const userMessageId: string = `selection-ask-message-${randomUUID()}`;
	const assistantMessageId: string = `selection-ask-message-${randomUUID()}`;
	return runSessionTransaction(db, (): { userMessage: SelectionAskMessage; assistantMessage: SelectionAskMessage } => {
		const running = db.prepare(`
			SELECT 1 AS value FROM selection_ask_messages
			WHERE thread_id = ? AND status = 'running' LIMIT 1
		`).get(thread.threadId) as Record<string, unknown> | undefined;
		if (running !== undefined) {
			throw new Error("selection_ask_busy: This selection Ask thread is already responding.");
		}
		const sequenceRow = db.prepare(`
			SELECT COALESCE(MAX(sequence), 0) + 1 AS value
			FROM selection_ask_messages WHERE thread_id = ?
		`).get(thread.threadId) as Record<string, unknown>;
		const userSequence: number = Number(sequenceRow.value);
		const assistantSequence: number = userSequence + 1;
		db.prepare(`
			INSERT INTO selection_ask_messages(
				message_id, thread_id, sequence, request_id, role, content, status, created_at, updated_at
			) VALUES (?, ?, ?, ?, 'user', ?, 'completed', ?, ?)
		`).run(userMessageId, thread.threadId, userSequence, requestId, userContent, now, now);
		db.prepare(`
			INSERT INTO selection_ask_messages(
				message_id, thread_id, sequence, request_id, role, content, status, created_at, updated_at
			) VALUES (?, ?, ?, ?, 'assistant', '', 'running', ?, ?)
		`).run(assistantMessageId, thread.threadId, assistantSequence, requestId, now, now);
		db.prepare(`
			UPDATE selection_ask_threads SET status = 'running', updated_at = ? WHERE thread_id = ?
		`).run(now, thread.threadId);
		return {
			userMessage: {
				messageId: userMessageId,
				threadId: thread.threadId,
				sequence: userSequence,
				requestId,
				role: "user",
				content: userContent,
				status: "completed",
				createdAt: now,
				updatedAt: now
			},
			assistantMessage: {
				messageId: assistantMessageId,
				threadId: thread.threadId,
				sequence: assistantSequence,
				requestId,
				role: "assistant",
				content: "",
				status: "running",
				createdAt: now,
				updatedAt: now
			}
		};
	});
}

export async function updateSelectionAskAssistantMessage(
	threadId: string,
	messageId: string,
	content: string,
	status: SelectionAskMessageStatus,
	errorMessage?: string | undefined
): Promise<void> {
	const db: DatabaseSync = await getSessionDatabase();
	const now: string = new Date().toISOString();
	const threadStatus: SelectionAskThreadStatus = status === "completed"
		? "idle"
		: status === "interrupted" ? "interrupted" : status === "failed" ? "failed" : "running";
	runSessionTransaction(db, (): void => {
		db.prepare(`
			UPDATE selection_ask_messages
			SET content = ?, status = ?, error_message = ?, updated_at = ?
			WHERE thread_id = ? AND message_id = ? AND role = 'assistant'
		`).run(content, status, toSqlValue(errorMessage), now, threadId, messageId);
		db.prepare(`
			UPDATE selection_ask_threads SET status = ?, updated_at = ? WHERE thread_id = ?
		`).run(threadStatus, now, threadId);
	});
}

export async function readSelectionAskMessagesForProvider(threadId: string): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
	const db: DatabaseSync = await getSessionDatabase();
	const rows = db.prepare(`
		SELECT role, content FROM selection_ask_messages
		WHERE thread_id = ? AND status = 'completed' AND content <> ''
		ORDER BY sequence ASC
	`).all(threadId) as Record<string, unknown>[];
	return rows.map((row: Record<string, unknown>): { role: "user" | "assistant"; content: string } => ({
		role: String(row.role) as "user" | "assistant",
		content: String(row.content)
	}));
}

export async function deleteSelectionAskThread(sessionId: string, threadId: string): Promise<boolean> {
	const db: DatabaseSync = await getSessionDatabase();
	const result = db.prepare(`
		DELETE FROM selection_ask_threads
		WHERE session_id = ? AND thread_id = ?
	`).run(sessionId, threadId);
	return Number(result.changes) > 0;
}

export async function deleteAllSelectionAskThreads(sessionId: string): Promise<number> {
	const db: DatabaseSync = await getSessionDatabase();
	const result = db.prepare(`
		DELETE FROM selection_ask_threads
		WHERE session_id = ?
	`).run(sessionId);
	return Number(result.changes);
}

export async function deleteSelectionAskThreadsBySourceRequestIds(sessionId: string, requestIds: readonly string[]): Promise<void> {
	if (requestIds.length === 0) {
		return;
	}
	const db: DatabaseSync = await getSessionDatabase();
	const placeholders: string = requestIds.map((): string => "?").join(",");
	db.prepare(`
		DELETE FROM selection_ask_threads
		WHERE session_id = ? AND source_request_id IN (${placeholders})
	`).run(sessionId, ...requestIds);
}
