import type { DatabaseSync } from "node:sqlite";
import { getGeneralSettings } from "../general-settings-store.js";
import { getSessionDatabase, parseSqlJson, runSessionTransaction, sqlJson, toSqlValue } from "../session/session-database.js";
import { hashTraceContent, redactTraceValue } from "./trace-redactor.js";
import type { TraceDetail, TracePage, TracePayload, TraceRecord, TraceRecordKind, TraceRecordWrite, TraceSummary } from "./trace-types.js";

type TraceRow = Record<string, unknown>;

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function rowToRecord(row: TraceRow, hasDetails?: boolean): TraceRecord {
	return {
		recordId: String(row.record_id),
		parentId: optionalString(row.parent_id),
		sessionId: String(row.session_id),
		sequence: Number(row.sequence),
		turn: Number(row.turn_index),
		kind: String(row.kind) as TraceRecord["kind"],
		status: String(row.status) as TraceRecord["status"],
		requestId: String(row.request_id),
		runId: optionalString(row.run_id),
		stepId: optionalString(row.step_id),
		toolCallId: optionalString(row.tool_call_id),
		provider: optionalString(row.provider),
		model: optionalString(row.model),
		startedAt: String(row.started_at),
		finishedAt: optionalString(row.finished_at),
		durationMs: optionalNumber(row.duration_ms),
		inputTokens: optionalNumber(row.input_tokens),
		outputTokens: optionalNumber(row.output_tokens),
		detailLevel: String(row.detail_level) as TraceRecord["detailLevel"],
		summary: parseSqlJson<Record<string, unknown>>(row.summary_json),
		contentHash: optionalString(row.content_hash),
		truncated: Number(row.truncated) === 1,
		hasDetails: hasDetails ?? Number(row.has_details ?? 0) === 1,
		revision: Number(row.revision)
	};
}

function getTurnIndex(db: DatabaseSync, sessionId: string, requestId: string): number {
	const row = db.prepare(`
		SELECT COUNT(DISTINCT request_id) AS value
		FROM messages
		WHERE session_id = ? AND role = 'user' AND request_id IS NOT NULL
			AND sequence <= COALESCE((
				SELECT MAX(sequence) FROM messages
				WHERE session_id = ? AND role = 'user' AND request_id = ?
			), 9223372036854775807)
	`).get(sessionId, sessionId, requestId) as TraceRow;
	return Math.max(1, Number(row.value ?? 1));
}

export async function upsertTraceRecord(write: TraceRecordWrite): Promise<TraceRecord> {
	const db: DatabaseSync = await getSessionDatabase();
	return runSessionTransaction(db, (): TraceRecord => {
		const existing = db.prepare(`
			SELECT sequence, turn_index, detail_level, started_at, summary_json,
				p.payload_json, p.redacted_fields_json, p.truncated AS payload_truncated,
				EXISTS(SELECT 1 FROM trace_payloads p WHERE p.record_id = trace_records.record_id) AS has_details
			FROM trace_records LEFT JOIN trace_payloads p ON p.record_id = trace_records.record_id
			WHERE trace_records.record_id = ?
		`).get(write.recordId) as TraceRow | undefined;
		const sequence: number = existing === undefined
			? Number((db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM trace_records WHERE session_id = ?").get(write.sessionId) as TraceRow).value)
			: Number(existing.sequence);
		const turn: number = write.turn ?? (existing === undefined ? getTurnIndex(db, write.sessionId, write.requestId) : Number(existing.turn_index));
		const revision: number = Number((db.prepare("SELECT COALESCE(MAX(revision), 0) + 1 AS value FROM trace_records WHERE session_id = ?").get(write.sessionId) as TraceRow).value);
		const parentId: string | undefined = write.parentId !== undefined
			&& db.prepare("SELECT 1 AS value FROM trace_records WHERE record_id = ? AND session_id = ?").get(write.parentId, write.sessionId) !== undefined
				? write.parentId
				: undefined;
		const existingPayload: TracePayload = existing?.payload_json === null || existing?.payload_json === undefined
			? {}
			: parseSqlJson<TracePayload>(existing.payload_json);
		const existingSummary: Record<string, unknown> = existing?.summary_json === undefined
			? {}
			: parseSqlJson<Record<string, unknown>>(existing.summary_json);
		let payload: TracePayload | undefined;
		let redactedFields: string[] = existing?.redacted_fields_json === null || existing?.redacted_fields_json === undefined
			? write.redactedFields ?? []
			: [...parseSqlJson<string[]>(existing.redacted_fields_json), ...(write.redactedFields ?? [])];
		let truncated: boolean = write.truncated || Number(existing?.payload_truncated ?? 0) === 1;
		let contentHash: string | undefined = write.contentHash;
		const detailLevel: TraceRecord["detailLevel"] = String(existing?.detail_level) === "compacted"
			? "compacted"
			: existing !== undefined
				&& String(existing.detail_level) === "full"
				&& Number(existing.has_details) === 1
				&& write.detailLevel === "summary"
					? "full"
					: write.detailLevel;
		const effectiveStartedAt: string = optionalString(existing?.started_at) ?? write.startedAt;
		const durationMs: number | undefined = write.durationMs ?? (write.finishedAt === undefined
			? undefined
			: Math.max(0, Date.parse(write.finishedAt) - Date.parse(effectiveStartedAt)));
		if (write.payload !== undefined && detailLevel === "full") {
			const redacted = redactTraceValue(write.payload);
			payload = { ...existingPayload, ...redacted.value as TracePayload };
			redactedFields = [...new Set([...redactedFields, ...redacted.redactedFields])];
			truncated ||= redacted.truncated;
			contentHash = hashTraceContent(payload);
		}
		const now: string = new Date().toISOString();
		db.prepare(`
			INSERT INTO trace_records(
				record_id, session_id, parent_id, sequence, turn_index, kind, status, request_id,
				run_id, step_id, tool_call_id, provider, model, started_at, finished_at, duration_ms,
				input_tokens, output_tokens, detail_level, summary_json, content_hash, truncated, revision, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(record_id) DO UPDATE SET
				parent_id = excluded.parent_id, kind = excluded.kind, status = excluded.status,
				run_id = excluded.run_id, step_id = excluded.step_id, tool_call_id = excluded.tool_call_id,
				provider = excluded.provider, model = excluded.model, finished_at = excluded.finished_at,
				duration_ms = excluded.duration_ms,
				input_tokens = COALESCE(excluded.input_tokens, trace_records.input_tokens),
				output_tokens = COALESCE(excluded.output_tokens, trace_records.output_tokens),
				detail_level = excluded.detail_level,
				summary_json = excluded.summary_json, content_hash = COALESCE(excluded.content_hash, trace_records.content_hash),
				truncated = excluded.truncated, revision = excluded.revision, updated_at = excluded.updated_at
		`).run(
			write.recordId, write.sessionId, toSqlValue(parentId), sequence, turn, write.kind, write.status,
			write.requestId, toSqlValue(write.runId), toSqlValue(write.stepId), toSqlValue(write.toolCallId),
			toSqlValue(write.provider), toSqlValue(write.model), write.startedAt, toSqlValue(write.finishedAt),
			durationMs ?? null, write.inputTokens ?? null, write.outputTokens ?? null, detailLevel,
			sqlJson({ ...existingSummary, ...write.summary }), toSqlValue(contentHash), truncated ? 1 : 0, revision, now
		);
		if (payload !== undefined) {
			const serialized: string = sqlJson(payload);
			db.prepare(`
				INSERT INTO trace_payloads(record_id, payload_json, redacted_fields_json, char_count, content_hash, truncated, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(record_id) DO UPDATE SET payload_json = excluded.payload_json,
					redacted_fields_json = excluded.redacted_fields_json, char_count = excluded.char_count,
					content_hash = excluded.content_hash, truncated = excluded.truncated, updated_at = excluded.updated_at
			`).run(write.recordId, serialized, sqlJson(redactedFields), serialized.length, contentHash ?? null, truncated ? 1 : 0, now);
		}
		if (write.kind === "turn") {
			db.prepare(`
				UPDATE trace_records SET parent_id = ?
				WHERE session_id = ? AND request_id = ? AND parent_id IS NULL AND record_id <> ?
			`).run(write.recordId, write.sessionId, write.requestId, write.recordId);
		}
		const row = db.prepare(`
			SELECT r.*, EXISTS(SELECT 1 FROM trace_payloads p WHERE p.record_id = r.record_id) AS has_details
			FROM trace_records r WHERE r.record_id = ?
		`).get(write.recordId) as TraceRow;
		return rowToRecord(row);
	});
}

export async function getTraceSummary(sessionId: string): Promise<TraceSummary> {
	const db: DatabaseSync = await getSessionDatabase();
	const row = db.prepare(`
		SELECT COALESCE(MAX(revision), 0) AS revision,
			COUNT(DISTINCT CASE WHEN kind = 'turn' THEN request_id END) AS turn_count,
			SUM(CASE WHEN kind = 'model_call' THEN 1 ELSE 0 END) AS model_call_count,
			SUM(CASE WHEN kind = 'tool_call' THEN 1 ELSE 0 END) AS tool_call_count,
			SUM(CASE WHEN status = 'error' OR kind = 'error' THEN 1 ELSE 0 END) AS error_count,
			COALESCE(SUM(CASE WHEN kind = 'turn' THEN duration_ms ELSE 0 END), 0) AS duration_ms,
			COALESCE(SUM(input_tokens), 0) AS input_tokens,
			COALESCE(SUM(output_tokens), 0) AS output_tokens,
			EXISTS(SELECT 1 FROM trace_payloads p JOIN trace_records p_r ON p_r.record_id = p.record_id WHERE p_r.session_id = ?) AS has_details
		FROM trace_records WHERE session_id = ?
	`).get(sessionId, sessionId) as TraceRow;
	return {
		revision: Number(row.revision),
		turnCount: Number(row.turn_count),
		modelCallCount: Number(row.model_call_count),
		toolCallCount: Number(row.tool_call_count),
		errorCount: Number(row.error_count),
		durationMs: Number(row.duration_ms),
		inputTokens: Number(row.input_tokens),
		outputTokens: Number(row.output_tokens),
		hasDetails: Number(row.has_details) === 1
	};
}

export async function completeTraceTurn(
	sessionId: string,
	recordId: string,
	finishedAt: string,
	status: Extract<TraceRecord["status"], "success" | "error" | "cancelled"> = "success"
): Promise<TraceRecord | null> {
	const db: DatabaseSync = await getSessionDatabase();
	return runSessionTransaction(db, (): TraceRecord | null => {
		const existing = db.prepare("SELECT started_at FROM trace_records WHERE session_id = ? AND record_id = ? AND kind = 'turn'").get(sessionId, recordId) as TraceRow | undefined;
		if (existing === undefined) return null;
		const revision: number = Number((db.prepare("SELECT COALESCE(MAX(revision), 0) + 1 AS value FROM trace_records WHERE session_id = ?").get(sessionId) as TraceRow).value);
		const durationMs: number = Math.max(0, Date.parse(finishedAt) - Date.parse(String(existing.started_at)));
		db.prepare("UPDATE trace_records SET status = ?, finished_at = ?, duration_ms = ?, revision = ?, updated_at = ? WHERE record_id = ?")
			.run(status, finishedAt, durationMs, revision, finishedAt, recordId);
		const row = db.prepare(`
			SELECT r.*, EXISTS(SELECT 1 FROM trace_payloads p WHERE p.record_id = r.record_id) AS has_details
			FROM trace_records r WHERE r.record_id = ?
		`).get(recordId) as TraceRow;
		return rowToRecord(row);
	});
}

export async function getTracePage(params: {
	sessionId: string;
	cursor?: string | undefined;
	limit?: number | undefined;
	turn?: number | undefined;
	kind?: TraceRecordKind | undefined;
}): Promise<TracePage> {
	const db: DatabaseSync = await getSessionDatabase();
	const limit: number = Math.min(200, Math.max(1, params.limit ?? 100));
	const cursor: number | null = params.cursor === undefined ? null : Number.parseInt(params.cursor, 10);
	const rows = db.prepare(`
		SELECT r.*, EXISTS(SELECT 1 FROM trace_payloads p WHERE p.record_id = r.record_id) AS has_details
		FROM trace_records r WHERE r.session_id = ?
			AND (? IS NULL OR r.sequence < ?)
			AND (? IS NULL OR r.turn_index = ?)
			AND (? IS NULL OR r.kind = ?)
		ORDER BY r.sequence DESC LIMIT ?
	`).all(params.sessionId, cursor, cursor, params.turn ?? null, params.turn ?? null, params.kind ?? null, params.kind ?? null, limit + 1) as TraceRow[];
	const hasMore: boolean = rows.length > limit;
	const pageRows: TraceRow[] = hasMore ? rows.slice(0, limit) : rows;
	const summary: TraceSummary = await getTraceSummary(params.sessionId);
	return {
		revision: summary.revision,
		records: pageRows.map((row: TraceRow): TraceRecord => rowToRecord(row)).reverse(),
		nextCursor: hasMore ? String(pageRows.at(-1)?.sequence) : undefined
	};
}

export async function getTraceDetail(
	sessionId: string,
	recordId: string,
	options: { developerMode?: boolean | undefined } = {}
): Promise<TraceDetail | null> {
	const db: DatabaseSync = await getSessionDatabase();
	const row = db.prepare(`
		SELECT r.*, EXISTS(SELECT 1 FROM trace_payloads p WHERE p.record_id = r.record_id) AS has_details,
			p.payload_json, p.redacted_fields_json
		FROM trace_records r LEFT JOIN trace_payloads p ON p.record_id = r.record_id
		WHERE r.session_id = ? AND r.record_id = ?
	`).get(sessionId, recordId) as TraceRow | undefined;
	if (row === undefined) return null;
	const record: TraceRecord = rowToRecord(row);
	const developerMode: boolean = options.developerMode ?? (await getGeneralSettings()).developerMode;
	if (!developerMode || row.payload_json === null || row.payload_json === undefined || record.detailLevel !== "full") {
		return {
			record,
			promptSections: [],
			redactions: [],
			detailLevel: record.detailLevel,
			detailsHidden: !developerMode && record.hasDetails
		};
	}
	const payload = parseSqlJson<TracePayload>(row.payload_json);
	return {
		record,
		promptSections: payload.promptSections ?? [],
		request: payload.request ?? payload.toolInput,
		response: payload.response ?? payload.providerResult ?? payload.toolOutput ?? payload.thinking,
		redactions: parseSqlJson<string[]>(row.redacted_fields_json),
		detailLevel: record.detailLevel
	};
}

export async function getTraceRecordsByIds(sessionId: string, recordIds: readonly string[]): Promise<TraceRecord[]> {
	if (recordIds.length === 0) return [];
	const db: DatabaseSync = await getSessionDatabase();
	const records: TraceRecord[] = [];
	for (let start: number = 0; start < recordIds.length; start += 200) {
		const batch: readonly string[] = recordIds.slice(start, start + 200);
		const placeholders: string = batch.map((): string => "?").join(", ");
		const rows = db.prepare(`
			SELECT r.*, EXISTS(SELECT 1 FROM trace_payloads p WHERE p.record_id = r.record_id) AS has_details
			FROM trace_records r WHERE r.session_id = ? AND r.record_id IN (${placeholders})
		`).all(sessionId, ...batch) as TraceRow[];
		records.push(...rows.map((row: TraceRow): TraceRecord => rowToRecord(row)));
	}
	return records.sort((left: TraceRecord, right: TraceRecord): number => left.sequence - right.sequence);
}

export type TraceCompactionResult = { records: number; removedChars: number; recordIds: string[] };

export function compactTracePayloadsInTransaction(db: DatabaseSync, sessionId: string, requestIds: readonly string[]): TraceCompactionResult {
	if (requestIds.length === 0) return { records: 0, removedChars: 0, recordIds: [] };
	const placeholders: string = requestIds.map((): string => "?").join(", ");
	const rows = db.prepare(`
		SELECT p.record_id, p.char_count FROM trace_payloads p
		JOIN trace_records r ON r.record_id = p.record_id
		WHERE r.session_id = ? AND r.request_id IN (${placeholders})
	`).all(sessionId, ...requestIds) as TraceRow[];
	if (rows.length === 0) return { records: 0, removedChars: 0, recordIds: [] };
	const ids: string[] = rows.map((row: TraceRow): string => String(row.record_id));
	const idPlaceholders: string = ids.map((): string => "?").join(", ");
	const now: string = new Date().toISOString();
	const revision: number = Number((db.prepare("SELECT COALESCE(MAX(revision), 0) + 1 AS value FROM trace_records WHERE session_id = ?").get(sessionId) as TraceRow).value);
	db.prepare(`DELETE FROM trace_payloads WHERE record_id IN (${idPlaceholders})`).run(...ids);
	db.prepare(`
		UPDATE trace_records SET detail_level = 'compacted', content_hash = NULL,
			revision = ?, updated_at = ? WHERE record_id IN (${idPlaceholders})
	`).run(revision, now, ...ids);
	return {
		records: rows.length,
		removedChars: rows.reduce((total: number, row: TraceRow): number => total + Number(row.char_count), 0),
		recordIds: ids
	};
}
