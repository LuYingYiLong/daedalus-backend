import { statfs } from "node:fs/promises";
import { getSessionsDatabasePath } from "../app-paths.js";
import { getGeneralSettings } from "../general-settings-store.js";
import { logger } from "../logger.js";
import { getSessionDatabase, parseSqlJson, runSessionTransaction, sqlJson } from "./session-database.js";
import {
	invalidateSessionTimelineCache,
	listArchivedSessions,
	listSessions,
	type SessionMetadata,
} from "./session-store.js";
import type { StoredMessage, StoredSessionEvent } from "./session-store.js";
import type { DatabaseSync } from "node:sqlite";
import { publishTraceRecordUpdate } from "../trace/trace-recorder.js";
import { compactTracePayloadsInTransaction, getTraceRecordsByIds } from "../trace/trace-store.js";
import { compactComputerObservations } from "./computer-observation-store.js";
import { compactBrowserActivity } from "./browser-activity-store.js";

export const ACTIVITY_DETAIL_RETENTION_TURNS: number = 10;
export const ACTIVITY_COMPACTION_SCHEMA_VERSION: number = 1;
const VACUUM_RECLAIM_THRESHOLD_BYTES: number = 64 * 1024 * 1024;
const ACTIVE_RUN_RETRY_DELAY_MS: number = 30_000;

const THINKING_EVENT_NAMES: ReadonlySet<string> = new Set([
	"ai.thinking.delta",
	"ai.thinking.done",
	"agent.thinking.delta",
	"agent.thinking.done",
]);

const TOOL_EVENT_PREFIXES: readonly string[] = ["agent.tool.", "tool."];
const MESSAGE_DELTA_EVENT_NAMES: ReadonlySet<string> = new Set([
	"ai.delta",
	"agent.message.delta",
]);

const TERMINAL_EVENT_NAMES: ReadonlySet<string> = new Set([
	"agent.message.done",
	"agent.run.done",
	"agent.run.error",
	"agent.run.cancelled",
	"workflow.error",
	"workflow.done",
]);

const TERMINAL_RUN_STAGES: ReadonlySet<string> = new Set([
	"completed",
	"failed",
	"cancelled",
	"interrupted",
]);

const ACTIVE_RUN_STAGES: ReadonlySet<string> = new Set([
	"routing",
	"probing",
	"executing",
	"verifying",
	"awaiting_approval",
	"awaiting_tool_budget",
	"interrupted",
	"finalizing",
]);

type ActivityCompactionMessage = Pick<StoredMessage, "role" | "requestId" | "createdAt">;

export type ActivityCompactionResult = {
	sessionId: string;
	completedTurns: number;
	retainedTurns: number;
	compactedRequestIds: string[];
	compactedEvents: number;
	compactedTraceRecords?: number | undefined;
	removedBytes: number;
	skipped: "disabled" | "active_run" | "nothing_to_compact" | null;
};

type EventRow = {
	rowId: number;
	requestId: string;
	event: string;
	data: unknown;
};

type ActivityCompactionRowsResult = Omit<ActivityCompactionResult, "sessionId" | "skipped"> & {
	compactedTraceRecordIds: string[];
};

export type CompactedEvent = {
	data: Record<string, unknown>;
	removedBytes: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(record: Record<string, unknown>, key: string): string {
	const value: unknown = record[key];
	return typeof value === "string" ? value.trim() : "";
}

function getNumber(record: Record<string, unknown>, key: string): number | undefined {
	const value: unknown = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getRecord(data: unknown): Record<string, unknown> {
	return isRecord(data) ? data : {};
}

function isToolEvent(eventName: string): boolean {
	return TOOL_EVENT_PREFIXES.some((prefix: string): boolean => eventName.startsWith(prefix));
}

function isThinkingEvent(eventName: string): boolean {
	return THINKING_EVENT_NAMES.has(eventName);
}

function isMessageDeltaEvent(eventName: string): boolean {
	return MESSAGE_DELTA_EVENT_NAMES.has(eventName);
}

function hasTerminalEvent(events: readonly StoredSessionEvent[], requestId: string): boolean {
	return events.some((event: StoredSessionEvent): boolean => {
		if (event.requestId !== requestId) {
			return false;
		}
		if (TERMINAL_EVENT_NAMES.has(event.event)) {
			return true;
		}
		if (event.event !== "agent.run.state") {
			return false;
		}
		const data: Record<string, unknown> = getRecord(event.data);
		return TERMINAL_RUN_STAGES.has(getString(data, "stage"));
	});
}

function collectTurnRequestIds(
	messages: readonly ActivityCompactionMessage[],
	events: readonly StoredSessionEvent[],
): { completedRequestIds: string[]; assistantRequestIds: ReadonlySet<string> } {
	const assistantRequestIds: Set<string> = new Set(
		messages
			.filter((message: ActivityCompactionMessage): boolean => message.role === "assistant")
			.map((message: ActivityCompactionMessage): string => message.requestId?.trim() ?? "")
			.filter((requestId: string): boolean => requestId.length > 0),
	);
	const seenRequestIds: Set<string> = new Set();
	const completedRequestIds: string[] = [];
	for (const message of messages) {
		if (message.role !== "user") {
			continue;
		}
		const requestId: string = message.requestId?.trim() ?? "";
		if (requestId.length === 0 || seenRequestIds.has(requestId)) {
			continue;
		}
		seenRequestIds.add(requestId);
		if (assistantRequestIds.has(requestId) || hasTerminalEvent(events, requestId)) {
			completedRequestIds.push(requestId);
		}
	}
	return { completedRequestIds, assistantRequestIds };
}

function keepString(
	target: Record<string, unknown>,
	source: Record<string, unknown>,
	key: string,
	maxLength: number = 240,
): void {
	const value: string = getString(source, key);
	if (value.length > 0) {
		target[key] = value.slice(0, maxLength);
	}
}

function keepNumber(target: Record<string, unknown>, source: Record<string, unknown>, key: string): void {
	const value: number | undefined = getNumber(source, key);
	if (value !== undefined) {
		target[key] = value;
	}
}

function compactFileEditBatch(source: Record<string, unknown>): Record<string, unknown> | undefined {
	const value: unknown = source.fileEditBatch;
	if (!isRecord(value)) {
		return undefined;
	}
	const summary: Record<string, unknown> = {};
	for (const key of ["batchId", "sessionId", "sourceFolderId"]) {
		keepString(summary, value, key, 240);
	}
	for (const key of ["editedFileCount", "additions", "deletions"]) {
		keepNumber(summary, value, key);
	}
	if (Array.isArray(value.editedFiles)) {
		const editedFiles: Record<string, unknown>[] = value.editedFiles.flatMap((item: unknown): Record<string, unknown>[] => {
			if (!isRecord(item)) {
				return [];
			}
			const file: Record<string, unknown> = {};
			keepString(file, item, "path", 1000);
			keepString(file, item, "sourceFolderId", 240);
			keepNumber(file, item, "additions");
			keepNumber(file, item, "deletions");
			return Object.keys(file).length === 0 ? [] : [file];
		});
		if (editedFiles.length > 0) {
			summary.editedFiles = editedFiles.slice(0, 200);
		}
	}
	return Object.keys(summary).length === 0 ? undefined : summary;
}

function compactStructuredPaths(source: Record<string, unknown>): string[] {
	const paths: string[] = [];
	const addPath = (value: unknown): void => {
		if (typeof value !== "string") {
			return;
		}
		const pathValue: string = value.trim();
		if (pathValue.length > 0 && !paths.includes(pathValue)) {
			paths.push(pathValue.slice(0, 1000));
		}
	};
	for (const key of ["path", "filePath", "relativePath", "targetPath", "sourcePath", "destinationPath"]) {
		addPath(source[key]);
	}
	const args: Record<string, unknown> = isRecord(source.args) ? source.args : {};
	for (const key of ["path", "filePath", "relativePath", "targetPath", "sourcePath", "destinationPath"]) {
		addPath(args[key]);
	}
	const files: unknown = source.files;
	if (Array.isArray(files)) {
		for (const file of files) {
			if (isRecord(file)) {
				addPath(file.path);
				addPath(file.filePath);
			}
		}
	}
	return paths.slice(0, 32);
}

function compactEventData(eventName: string, data: unknown): CompactedEvent {
	const source: Record<string, unknown> = getRecord(data);
	const compacted: Record<string, unknown> = {
		compacted: true,
		detailLevel: "compacted",
		compactionSchemaVersion: ACTIVITY_COMPACTION_SCHEMA_VERSION,
	};

	for (const key of [
		"type",
		"sessionId",
		"requestId",
		"rootRequestId",
		"runId",
		"step",
		"stepId",
		"stepRunId",
		"activityGroupId",
		"activityPartId",
		"activityPartKind",
		"toolCallId",
		"toolName",
		"approvalId",
		"workflowId",
		"sourceFolderId",
	]) {
		keepString(compacted, source, key);
	}
	for (const key of ["ok", "success", "exitCode", "durationMs", "editedFileCount", "additions", "deletions"]) {
		const value: unknown = source[key];
		if (typeof value === "boolean") {
			compacted[key] = value;
		} else {
			keepNumber(compacted, source, key);
		}
	}

	if (isThinkingEvent(eventName)) {
		const text: string = getString(source, "text");
		compacted.done = eventName.endsWith(".done") || source.done === true;
		compacted.removedThinkingChars = text.length;
		compacted.compactedSummary = "思考详情已精简";
	} else if (isToolEvent(eventName)) {
		const errorEvent: boolean = eventName.endsWith(".error") || eventName.endsWith(".rejected");
		const status: string = getString(source, "status");
		if (status.length > 0) {
			compacted.status = status;
		} else if (source.ok === false || errorEvent) {
			compacted.status = "failed";
		} else if (eventName.endsWith(".result") || source.success === true) {
			compacted.status = "success";
		}
		if (errorEvent) {
			keepString(compacted, source, "code", 160);
			keepString(compacted, source, "errorCode", 160);
			keepString(compacted, source, "message", 500);
			keepString(compacted, source, "reason", 500);
		}
		keepString(compacted, source, "summary", 1200);
		if (Array.isArray(source.failedChecks)) {
			const failedChecks: string[] = source.failedChecks
				.filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0)
				.map((value: string): string => value.trim().slice(0, 400))
				.slice(0, 24);
			if (failedChecks.length > 0) {
				compacted.failedChecks = failedChecks;
			}
		}
		const fileEditBatch: Record<string, unknown> | undefined = compactFileEditBatch(source);
		if (fileEditBatch !== undefined) {
			compacted.fileEditBatch = fileEditBatch;
		}
		const filePaths: string[] = compactStructuredPaths(source);
		if (filePaths.length > 0) {
			compacted.filePaths = filePaths;
		}
		compacted.compactedSummary = "工具详情已精简";
	} else {
		compacted.compactedSummary = "活动详情已精简";
	}

	const removedBytes: number = Math.max(0, JSON.stringify(source).length - JSON.stringify(compacted).length);
	compacted.removedBytes = removedBytes;
	compacted.removedChars = isThinkingEvent(eventName)
		? typeof source.text === "string" ? source.text.length : 0
		: removedBytes;
	return { data: compacted, removedBytes };
}

export function getCompactionRequestIds(
	messages: readonly ActivityCompactionMessage[],
	events: readonly StoredSessionEvent[],
	retentionTurns: number = ACTIVITY_DETAIL_RETENTION_TURNS,
): { completedRequestIds: string[]; retainedRequestIds: string[]; compactedRequestIds: string[]; assistantRequestIds: ReadonlySet<string> } {
	const { completedRequestIds, assistantRequestIds } = collectTurnRequestIds(messages, events);
	const retainedRequestIds: string[] = completedRequestIds.slice(-Math.max(0, retentionTurns));
	const retainedSet: ReadonlySet<string> = new Set(retainedRequestIds);
	return {
		completedRequestIds,
		retainedRequestIds,
		compactedRequestIds: completedRequestIds.filter((requestId: string): boolean => !retainedSet.has(requestId)),
		assistantRequestIds,
	};
}

export function compactTimelineEvent(event: Pick<StoredSessionEvent, "event" | "data">): CompactedEvent | null {
	if (!isThinkingEvent(event.event) && !isToolEvent(event.event) && !isMessageDeltaEvent(event.event)) {
		return null;
	}
	const source: Record<string, unknown> = getRecord(event.data);
	if (source.compacted === true) {
		return null;
	}
	return compactEventData(event.event, event.data);
}

function readMessagesForCompaction(db: DatabaseSync, sessionId: string): StoredMessage[] {
	const rows = db.prepare("SELECT payload_json FROM messages WHERE session_id = ? ORDER BY sequence").all(sessionId) as Record<string, unknown>[];
	return rows.map((row: Record<string, unknown>): StoredMessage => parseSqlJson<StoredMessage>(row.payload_json));
}

function readTimelineEventsForCompaction(db: DatabaseSync, sessionId: string): StoredSessionEvent[] {
	const rows = db.prepare(`
		SELECT event_id, request_id, event_name, data_json, created_at, sequence
		FROM session_events
		WHERE session_id = ? AND channel = 'timeline'
		ORDER BY sequence
	`).all(sessionId) as Record<string, unknown>[];
	return rows.map((row: Record<string, unknown>): StoredSessionEvent => ({
		id: String(row.event_id),
		requestId: String(row.request_id),
		event: String(row.event_name),
		data: parseSqlJson<unknown>(row.data_json),
		createdAt: String(row.created_at),
		sequence: typeof row.sequence === "number" ? row.sequence : undefined,
	}));
}

function hasActiveRun(db: DatabaseSync, sessionId: string): boolean {
	const rows = db.prepare("SELECT stage FROM agent_runs WHERE session_id = ?").all(sessionId) as Record<string, unknown>[];
	return rows.some((row: Record<string, unknown>): boolean => ACTIVE_RUN_STAGES.has(String(row.stage)));
}

function compactSessionRows(db: DatabaseSync, sessionId: string): ActivityCompactionRowsResult {
	const messages: StoredMessage[] = readMessagesForCompaction(db, sessionId);
	const events: StoredSessionEvent[] = readTimelineEventsForCompaction(db, sessionId);
	const requestSelection = getCompactionRequestIds(messages, events);
	if (requestSelection.compactedRequestIds.length === 0) {
		return {
			completedTurns: requestSelection.completedRequestIds.length,
			retainedTurns: requestSelection.retainedRequestIds.length,
			compactedRequestIds: [],
			compactedEvents: 0,
			compactedTraceRecordIds: [],
			removedBytes: 0,
		};
	}

	const compactedRequestIdSet: ReadonlySet<string> = new Set(requestSelection.compactedRequestIds);
	const assistantRequestIdSet: ReadonlySet<string> = requestSelection.assistantRequestIds;
	let compactedEvents: number = 0;
	let removedBytes: number = 0;
	const update = db.prepare("UPDATE session_events SET data_json = ? WHERE row_id = ?");
	const rows = db.prepare(`
		SELECT row_id, request_id, event_name, data_json
		FROM session_events
		WHERE session_id = ? AND channel = 'timeline'
			AND request_id IN (${requestSelection.compactedRequestIds.map((): string => "?").join(",")})
	`).all(sessionId, ...requestSelection.compactedRequestIds) as Record<string, unknown>[];
	for (const row of rows) {
		const event: EventRow = {
			rowId: Number(row.row_id),
			requestId: String(row.request_id),
			event: String(row.event_name),
			data: parseSqlJson<unknown>(row.data_json),
		};
		if (!compactedRequestIdSet.has(event.requestId)) {
			continue;
		}
		if (isMessageDeltaEvent(event.event) && !assistantRequestIdSet.has(event.requestId)) {
			continue;
		}
		const compacted: CompactedEvent | null = compactTimelineEvent(event);
		if (compacted === null) {
			continue;
		}
		update.run(sqlJson(compacted.data), event.rowId);
		compactedEvents += 1;
		removedBytes += compacted.removedBytes;
	}
	const compactedTrace = compactTracePayloadsInTransaction(db, sessionId, requestSelection.compactedRequestIds);
	removedBytes += compactedTrace.removedChars;
	removedBytes += compactComputerObservations(db, sessionId, requestSelection.compactedRequestIds);
	removedBytes += compactBrowserActivity(db, sessionId, requestSelection.compactedRequestIds);
	return {
		completedTurns: requestSelection.completedRequestIds.length,
		retainedTurns: requestSelection.retainedRequestIds.length,
		compactedRequestIds: requestSelection.compactedRequestIds,
		compactedEvents,
		compactedTraceRecords: compactedTrace.records,
		compactedTraceRecordIds: compactedTrace.recordIds,
		removedBytes,
	};
}

export async function compactSessionActivity(sessionId: string, enabled: boolean = true): Promise<ActivityCompactionResult> {
	if (!enabled) {
		return {
			sessionId,
			completedTurns: 0,
			retainedTurns: 0,
			compactedRequestIds: [],
			compactedEvents: 0,
			removedBytes: 0,
			skipped: "disabled",
		};
	}
	const db: DatabaseSync = await getSessionDatabase();
	if (hasActiveRun(db, sessionId)) {
		return {
			sessionId,
			completedTurns: 0,
			retainedTurns: 0,
			compactedRequestIds: [],
			compactedEvents: 0,
			removedBytes: 0,
			skipped: "active_run",
		};
	}
	const result: ActivityCompactionRowsResult = runSessionTransaction(db, (): ActivityCompactionRowsResult => compactSessionRows(db, sessionId));
	if (result.compactedEvents > 0 || result.removedBytes > 0) {
		invalidateSessionTimelineCache(sessionId);
	}
	if (result.compactedTraceRecordIds.length > 0) {
		for (const record of await getTraceRecordsByIds(sessionId, result.compactedTraceRecordIds)) {
			publishTraceRecordUpdate(record, "updated");
		}
	}
	const { compactedTraceRecordIds: _compactedTraceRecordIds, ...publicResult } = result;
	return {
		sessionId,
		...publicResult,
		skipped: result.compactedEvents === 0 && (result.compactedTraceRecords ?? 0) === 0 && result.removedBytes === 0 ? "nothing_to_compact" : null,
	};
}

function readDatabaseBytes(db: DatabaseSync): number {
	const pageCountRow = db.prepare("PRAGMA page_count").get() as Record<string, unknown> | undefined;
	const pageSizeRow = db.prepare("PRAGMA page_size").get() as Record<string, unknown> | undefined;
	return Number(pageCountRow?.page_count ?? 0) * Number(pageSizeRow?.page_size ?? 0);
}

async function vacuumIfSafe(db: DatabaseSync, reclaimableBytes: number): Promise<boolean> {
	if (reclaimableBytes < VACUUM_RECLAIM_THRESHOLD_BYTES) {
		return false;
	}
	const databaseBytes: number = readDatabaseBytes(db);
	const fileSystem = await statfs(getSessionsDatabasePath());
	const availableBytes: number = Number(fileSystem.bavail) * Number(fileSystem.bsize);
	if (!Number.isFinite(availableBytes) || availableBytes < databaseBytes * 2) {
		logger.info("session", "activity_compaction_vacuum_skipped", {
			databaseBytes,
			availableBytes,
			reclaimableBytes,
			reason: "insufficient_free_space",
		});
		return false;
	}
	db.exec("VACUUM");
	logger.info("session", "activity_compaction_vacuum_completed", {
		databaseBytes,
		reclaimableBytes,
	});
	return true;
}

function checkpointWal(db: DatabaseSync): void {
	db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}

function hasAnyActiveRun(db: DatabaseSync): boolean {
	const rows = db.prepare("SELECT stage FROM agent_runs").all() as Record<string, unknown>[];
	return rows.some((row: Record<string, unknown>): boolean => ACTIVE_RUN_STAGES.has(String(row.stage)));
}

type SchedulerState = {
	enabled: boolean;
	started: boolean;
	processing: boolean;
	queuedSessionIds: Set<string>;
	retryTimers: Map<string, ReturnType<typeof setTimeout>>;
	timer: ReturnType<typeof setTimeout> | null;
	reclaimableBytes: number;
};

const scheduler: SchedulerState = {
	enabled: true,
	started: false,
	processing: false,
	queuedSessionIds: new Set(),
	retryTimers: new Map(),
	timer: null,
	reclaimableBytes: 0,
};

function scheduleNextCompaction(): void {
	if (!scheduler.started || scheduler.processing || scheduler.timer !== null || scheduler.queuedSessionIds.size === 0) {
		return;
	}
	scheduler.timer = setTimeout((): void => {
		scheduler.timer = null;
		void processNextCompaction();
	}, 0);
	scheduler.timer.unref();
}

async function processNextCompaction(): Promise<void> {
	if (scheduler.processing || !scheduler.started || !scheduler.enabled) {
		return;
	}
	const sessionId: string | undefined = scheduler.queuedSessionIds.values().next().value as string | undefined;
	if (sessionId === undefined) {
		return;
	}
	scheduler.queuedSessionIds.delete(sessionId);
	scheduler.processing = true;
	try {
		const result: ActivityCompactionResult = await compactSessionActivity(sessionId, scheduler.enabled);
		if (result.skipped === "active_run") {
			const retryTimer = setTimeout((): void => {
				scheduler.retryTimers.delete(sessionId);
				scheduleSessionActivityCompaction(sessionId);
			}, ACTIVE_RUN_RETRY_DELAY_MS);
			retryTimer.unref();
			scheduler.retryTimers.set(sessionId, retryTimer);
		}
		if (result.compactedEvents > 0 || (result.compactedTraceRecords ?? 0) > 0) {
			scheduler.reclaimableBytes += result.removedBytes;
			logger.info("session", "activity_compaction_completed", result);
		}
		if (result.compactedEvents > 0 || (result.compactedTraceRecords ?? 0) > 0) {
			const db: DatabaseSync = await getSessionDatabase();
			checkpointWal(db);
			if (scheduler.reclaimableBytes >= VACUUM_RECLAIM_THRESHOLD_BYTES && !hasAnyActiveRun(db)) {
				if (await vacuumIfSafe(db, scheduler.reclaimableBytes)) {
					scheduler.reclaimableBytes = 0;
				}
			}
		}
	} catch (error: unknown) {
		logger.warn("session", "activity_compaction_failed", {
			sessionId,
			error: error instanceof Error ? error.message : String(error),
		});
	} finally {
		scheduler.processing = false;
		scheduleNextCompaction();
	}
}

export function scheduleSessionActivityCompaction(sessionId: string): void {
	if (!scheduler.enabled || sessionId.trim().length === 0) {
		return;
	}
	scheduler.queuedSessionIds.add(sessionId);
	scheduleNextCompaction();
}

export async function scheduleAllSessionActivityCompaction(): Promise<void> {
	if (!scheduler.enabled) {
		return;
	}
	const [sessions, archivedSessions]: [SessionMetadata[], SessionMetadata[]] = await Promise.all([
		listSessions(),
		listArchivedSessions(),
	]);
	for (const session of [...sessions, ...archivedSessions]) {
		scheduleSessionActivityCompaction(session.id);
	}
}

export function setSessionActivityCompactionEnabled(enabled: boolean): void {
	scheduler.enabled = enabled;
	if (!enabled) {
		scheduler.queuedSessionIds.clear();
		for (const timer of scheduler.retryTimers.values()) {
			clearTimeout(timer);
		}
		scheduler.retryTimers.clear();
		return;
	}
	if (scheduler.started) {
		void scheduleAllSessionActivityCompaction().catch((error: unknown): void => {
			logger.warn("session", "activity_compaction_scan_failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}
}

export async function startSessionActivityCompactionScheduler(): Promise<void> {
	scheduler.started = true;
	const settings = await getGeneralSettings();
	scheduler.enabled = settings.autoCompactActivityDetails;
	if (scheduler.enabled) {
		await scheduleAllSessionActivityCompaction();
	}
}

export function stopSessionActivityCompactionScheduler(): void {
	scheduler.started = false;
	scheduler.processing = false;
	scheduler.queuedSessionIds.clear();
	if (scheduler.timer !== null) {
		clearTimeout(scheduler.timer);
		scheduler.timer = null;
	}
	for (const timer of scheduler.retryTimers.values()) {
		clearTimeout(timer);
	}
	scheduler.retryTimers.clear();
}
