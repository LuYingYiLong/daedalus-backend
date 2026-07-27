import { access, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getDefaultArchivedSessionsDir, getDefaultSessionsDir } from "../app-paths.js";
import type { ChatMessage } from "../protocol/types.js";
import type { WorkspaceConfig } from "../workspace/types.js";
import { findContainingWorkspaceSourceFolder } from "../workspace/registry.js";
import {
	getSessionDatabase,
	parseSqlJson,
	runSessionTransaction,
	sqlJson,
	toSqlValue
} from "./session-database.js";
import {
	buildCanonicalTimelineBlocks,
	type TimelineBlock,
	type TimelinePlanApproval,
	type TimelinePlanClarification
} from "./timeline-blocks.js";

const SESSIONS_DIR: string = getDefaultSessionsDir();
const ARCHIVED_SESSIONS_DIR: string = getDefaultArchivedSessionsDir();
const SESSION_ID_PATTERN: RegExp = /^session-[a-zA-Z0-9_-]+$/;

export type SessionChatMode = "agent" | "ask" | "plan";

export type SessionMetadata = {
	id: string;
	title: string;
	temporary?: boolean | undefined;
	pinned?: boolean | undefined;
	workspaceId?: string | undefined;
	workspaceName?: string | undefined;
	workspaceKind?: "godot" | undefined;
	workspaceRoot?: string | undefined;
	godotExecutablePath?: string | undefined;
	activeSkillId?: string | undefined;
	provider?: string | undefined;
	model?: string | undefined;
	reasoningEffort?: string | undefined;
	chatMode?: SessionChatMode | undefined;
	approvalMode?: "manual" | "auto-safe" | "full-trust" | undefined;
	workflowTodoCollapsed?: boolean | undefined;
	archivedAt?: string | undefined;
	createdAt: string;
	updatedAt: string;
};

export type StoredMessage = ChatMessage & {
	createdAt: string;
};

export type StoredSessionEvent = {
	id: string;
	requestId: string;
	event: string;
	data: unknown;
	createdAt: string;
};

export type StoredApprovalEvent = {
	id: string;
	schemaVersion: 1;
	approvalId: string;
	requestId: string;
	event: string;
	data: unknown;
	createdAt: string;
};

export type StoredWorkflowEvent = {
	id: string;
	schemaVersion: 1;
	workflowId: string;
	requestId: string;
	event: string;
	data: unknown;
	createdAt: string;
};

export type StoredAgentEvent = {
	id: string;
	schemaVersion: 1;
	runId: string;
	requestId: string;
	event: string;
	data: unknown;
	createdAt: string;
};

export type StoredSession = {
	metadata: SessionMetadata;
	messages: StoredMessage[];
	events: StoredSessionEvent[];
};

export type StoredSessionTimelinePage = {
	metadata: SessionMetadata;
	messages: StoredMessage[];
	timelineBlocks: TimelineBlock[];
	blockCount: number;
	blockOffset: number;
	eventCount: number;
	hasMoreBefore: boolean;
	hasMoreAfter: boolean;
	latestWorkflowSnapshot: unknown | null;
	latestAgentSnapshot: unknown | null;
	latestPlanClarification: TimelinePlanClarification | null;
	latestPlanApproval: TimelinePlanApproval | null;
};

export type SessionTimelineNavigationEntry = {
	entryId: string;
	requestId: string;
	blockOffset: number;
	sentAtUtc: string;
	preview: string;
};

export type SessionTimelineNavigationIndex = {
	sessionId: string;
	blockCount: number;
	entries: SessionTimelineNavigationEntry[];
};

type RewindableEvent = {
	requestId: string;
	createdAt: string;
};

type StoredEventFileKind = "messages" | "events" | "approval-events" | "workflow-events" | "agent-events";

export type SessionIntegrityIssue = {
	file: StoredEventFileKind;
	line: number;
	expectedSessionId: string;
	actualSessionId: string;
	requestId?: string | undefined;
	event?: string | undefined;
};

export type SessionIntegrityCheckResult = {
	sessionId: string;
	ok: boolean;
	issues: SessionIntegrityIssue[];
	checkedFiles: StoredEventFileKind[];
	storage?: "sqlite" | undefined;
	integrityCheck?: string | undefined;
	foreignKeyIssueCount?: number | undefined;
};

type TranscriptUpdate<T> = {
	messages: ChatMessage[];
	metadata?: Partial<SessionMetadata> | undefined;
	result: T;
};

export type SessionSummary = {
	content: string;
	messageCount: number;
	tokenEstimate: number;
	generatedAt: string;
};

const timelineCacheBySessionId: Map<string, ReturnType<typeof buildCanonicalTimelineBlocks>> = new Map();
const transcriptWriteQueuesBySessionId: Map<string, Promise<void>> = new Map();

function assertSafeSessionId(sessionId: string): string {
	if (!SESSION_ID_PATTERN.test(sessionId)) {
		throw new Error(`Invalid session id: ${sessionId}`);
	}
	return sessionId;
}

export function getSessionDir(sessionId: string): string {
	return join(SESSIONS_DIR, assertSafeSessionId(sessionId));
}

function getArchivedSessionDir(sessionId: string): string {
	return join(ARCHIVED_SESSIONS_DIR, assertSafeSessionId(sessionId));
}

function invalidateTimelineCache(sessionId: string): void {
	timelineCacheBySessionId.delete(assertSafeSessionId(sessionId));
}

async function enqueueTranscriptWrite<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
	const safeSessionId: string = assertSafeSessionId(sessionId);
	const previousWrite: Promise<void> = transcriptWriteQueuesBySessionId.get(safeSessionId) ?? Promise.resolve();
	const nextWrite: Promise<T> = previousWrite.then(operation, operation);
	const tracked: Promise<void> = nextWrite.then((): void => undefined, (): void => undefined);
	transcriptWriteQueuesBySessionId.set(safeSessionId, tracked);
	try {
		return await nextWrite;
	} finally {
		if (transcriptWriteQueuesBySessionId.get(safeSessionId) === tracked) {
			transcriptWriteQueuesBySessionId.delete(safeSessionId);
		}
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function rowMetadata(row: Record<string, unknown> | undefined, sessionId: string): SessionMetadata {
	if (row === undefined) {
		throw new Error(`Session not found: ${sessionId}`);
	}
	return parseSqlJson<SessionMetadata>(row.metadata_json);
}

async function readSessionMetadata(sessionId: string, archived?: boolean): Promise<SessionMetadata> {
	const safeSessionId: string = assertSafeSessionId(sessionId);
	const db: DatabaseSync = await getSessionDatabase();
	const archivedClause: string = archived === undefined ? "" : archived ? " AND archived_at IS NOT NULL" : " AND archived_at IS NULL";
	const row = db.prepare(`SELECT metadata_json FROM sessions WHERE session_id = ?${archivedClause}`).get(safeSessionId) as Record<string, unknown> | undefined;
	if (row === undefined) {
		throw new Error(`${archived ? "Archived session" : "Session"} not found: ${safeSessionId}`);
	}
	return rowMetadata(row, safeSessionId);
}

function mergeSessionMetadata(existing: SessionMetadata, metadata?: Partial<SessionMetadata>): SessionMetadata {
	const updated: SessionMetadata = { ...existing, updatedAt: new Date().toISOString() };
	delete (updated as SessionMetadata & { webSearchEnabled?: unknown }).webSearchEnabled;
	if (metadata !== undefined) {
		for (const [key, value] of Object.entries(metadata) as [keyof SessionMetadata, SessionMetadata[keyof SessionMetadata]][]) {
			if (value !== undefined) {
				updated[key] = value as never;
			}
		}
	}
	return updated;
}

function writeMetadataRow(db: DatabaseSync, metadata: SessionMetadata): void {
	db.prepare(`
		UPDATE sessions
		SET title = ?, workspace_id = ?, metadata_json = ?, archived_at = ?, updated_at = ?
		WHERE session_id = ?
	`).run(
		metadata.title,
		toSqlValue(metadata.workspaceId),
		sqlJson(metadata),
		toSqlValue(metadata.archivedAt),
		metadata.updatedAt,
		metadata.id
	);
}

export function createWorkspaceMetadataSnapshot(workspace: WorkspaceConfig | undefined): Partial<SessionMetadata> {
	if (workspace === undefined) {
		return {};
	}
	const metadata: Partial<SessionMetadata> = {
		workspaceId: workspace.id,
		workspaceName: workspace.name,
		workspaceKind: workspace.kind,
		workspaceRoot: workspace.rootPath
	};
	if (workspace.godotExecutablePath !== undefined) {
		metadata.godotExecutablePath = workspace.godotExecutablePath;
	}
	return metadata;
}

export function createWorkspaceMetadataBackfill(existing: SessionMetadata, workspace: WorkspaceConfig | undefined): Partial<SessionMetadata> {
	if (existing.workspaceId !== undefined || existing.workspaceRoot !== undefined) {
		return {};
	}
	return createWorkspaceMetadataSnapshot(workspace);
}

export async function createSession(
	title: string,
	workspaceId?: string,
	skillId?: string,
	workspaceSnapshot?: WorkspaceConfig | undefined,
	initialMetadata?: Partial<SessionMetadata> | undefined
): Promise<SessionMetadata> {
	const timestamp: string = new Date().toISOString();
	const dateStr: string = timestamp.slice(0, 10).replace(/-/g, "");
	const id: string = `session-${dateStr}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	const metadata: SessionMetadata = {
		...initialMetadata,
		id,
		title,
		workspaceId,
		activeSkillId: skillId,
		...createWorkspaceMetadataSnapshot(workspaceSnapshot),
		createdAt: timestamp,
		updatedAt: timestamp
	};
	const db: DatabaseSync = await getSessionDatabase();
	db.prepare(`
		INSERT INTO sessions(session_id, title, workspace_id, metadata_json, archived_at, created_at, updated_at)
		VALUES (?, ?, ?, ?, NULL, ?, ?)
	`).run(id, title, toSqlValue(metadata.workspaceId), sqlJson(metadata), timestamp, timestamp);
	return metadata;
}

function readMessages(db: DatabaseSync, sessionId: string): StoredMessage[] {
	const rows = db.prepare(`
		SELECT payload_json FROM messages WHERE session_id = ? ORDER BY sequence
	`).all(sessionId) as Record<string, unknown>[];
	return rows.map((row: Record<string, unknown>): StoredMessage => parseSqlJson<StoredMessage>(row.payload_json));
}

function readEvents(db: DatabaseSync, sessionId: string, channel: string = "timeline"): StoredSessionEvent[] {
	const rows = db.prepare(`
		SELECT event_id, request_id, event_name, data_json, created_at
		FROM session_events WHERE session_id = ? AND channel = ? ORDER BY sequence
	`).all(sessionId, channel) as Record<string, unknown>[];
	return rows.map((row: Record<string, unknown>): StoredSessionEvent => ({
		id: String(row.event_id),
		requestId: String(row.request_id),
		event: String(row.event_name),
		data: parseSqlJson<unknown>(row.data_json),
		createdAt: String(row.created_at)
	}));
}

export async function openSession(sessionId: string): Promise<StoredSession> {
	const safeSessionId: string = assertSafeSessionId(sessionId);
	const db: DatabaseSync = await getSessionDatabase();
	const metadata: SessionMetadata = rowMetadata(
		db.prepare("SELECT metadata_json FROM sessions WHERE session_id = ? AND archived_at IS NULL").get(safeSessionId) as Record<string, unknown> | undefined,
		safeSessionId
	);
	return {
		metadata,
		messages: readMessages(db, safeSessionId),
		events: readEvents(db, safeSessionId)
	};
}

function getTimelineBuildResult(stored: StoredSession): ReturnType<typeof buildCanonicalTimelineBlocks> {
	const cached = timelineCacheBySessionId.get(stored.metadata.id);
	if (cached !== undefined) {
		return cached;
	}
	const result = buildCanonicalTimelineBlocks(stored);
	timelineCacheBySessionId.set(stored.metadata.id, result);
	return result;
}

type TimelineIndexEntry = {
	requestId: string;
	sourceRequestIds: Set<string>;
	userCreatedAt?: string | undefined;
	assistantCreatedAt?: string | undefined;
	firstEventAt?: string | undefined;
	orderAt: string;
	sequence: number;
	hasEvents: boolean;
};

type TimelineBlockIndex = {
	key: string;
	requestId: string;
	type: "user" | "assistant";
	sourceRequestIds: string[];
};

function timelineBlockKey(requestId: string, type: "user" | "assistant"): string {
	return `${requestId}\n${type}`;
}

function createTimelineNavigationPreview(content: string): string {
	const normalized: string = content.replace(/\s+/gu, " ").trim();
	return normalized.length <= 120 ? normalized : `${normalized.slice(0, 117)}...`;
}

function parseAliasRequestId(value: unknown): string {
	if (typeof value !== "string") {
		return "";
	}
	try {
		const parsed: unknown = JSON.parse(value);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return "";
		}
		const requestId: unknown = (parsed as Record<string, unknown>).requestId;
		return typeof requestId === "string" ? requestId.trim() : "";
	} catch {
		return "";
	}
}

function buildTimelineBlockIndex(db: DatabaseSync, sessionId: string): TimelineBlockIndex[] | null {
	const messageRows = db.prepare(`
		SELECT request_id, role, created_at FROM messages WHERE session_id = ? ORDER BY sequence
	`).all(sessionId) as Record<string, unknown>[];
	if (messageRows.some((row: Record<string, unknown>): boolean => (
		(row.role === "user" || row.role === "assistant")
			&& (typeof row.request_id !== "string" || row.request_id.length === 0)
	))) {
		return null;
	}

	const eventRows = db.prepare(`
		SELECT event_id, request_id, event_name, created_at,
			CASE WHEN event_name LIKE 'plan.%' THEN data_json ELSE NULL END AS alias_data
		FROM session_events
		WHERE session_id = ? AND channel = 'timeline'
		ORDER BY created_at, event_id
	`).all(sessionId) as Record<string, unknown>[];
	const aliases: Map<string, string> = new Map();
	for (const row of eventRows) {
		const eventName: string = String(row.event_name);
		if (!eventName.startsWith("plan.") || eventName === "plan.execution.started") {
			continue;
		}
		const sourceRequestId: string = String(row.request_id);
		const canonicalRequestId: string = parseAliasRequestId(row.alias_data);
		if (sourceRequestId.length > 0 && canonicalRequestId.length > 0 && sourceRequestId !== canonicalRequestId) {
			aliases.set(sourceRequestId, canonicalRequestId);
		}
	}

	const entries: Map<string, TimelineIndexEntry> = new Map();
	let sequence: number = 0;
	const getOrCreate = (requestId: string, orderAt: string): TimelineIndexEntry => {
		const existing: TimelineIndexEntry | undefined = entries.get(requestId);
		if (existing !== undefined) {
			if (orderAt.length > 0 && (existing.orderAt.length === 0 || orderAt < existing.orderAt)) {
				existing.orderAt = orderAt;
			}
			existing.sequence = Math.min(existing.sequence, sequence);
			return existing;
		}
		const entry: TimelineIndexEntry = {
			requestId,
			sourceRequestIds: new Set([requestId]),
			orderAt,
			sequence,
			hasEvents: false
		};
		entries.set(requestId, entry);
		return entry;
	};

	for (const row of messageRows) {
		const role: string = String(row.role);
		if (role !== "user" && role !== "assistant") {
			sequence += 1;
			continue;
		}
		const requestId: string = String(row.request_id);
		const createdAt: string = String(row.created_at);
		const entry: TimelineIndexEntry = getOrCreate(requestId, createdAt);
		if (role === "user" && (entry.userCreatedAt === undefined || createdAt < entry.userCreatedAt)) {
			entry.userCreatedAt = createdAt;
		}
		if (role === "assistant" && (entry.assistantCreatedAt === undefined || createdAt > entry.assistantCreatedAt)) {
			entry.assistantCreatedAt = createdAt;
		}
		entry.orderAt = entry.userCreatedAt ?? entry.firstEventAt ?? entry.assistantCreatedAt ?? entry.orderAt;
		sequence += 1;
	}

	const eventGroups: Map<string, { firstAt: string; sourceRequestIds: Set<string> }> = new Map();
	for (const row of eventRows) {
		const sourceRequestId: string = String(row.request_id);
		const requestId: string = aliases.get(sourceRequestId) ?? sourceRequestId;
		if (requestId.length === 0) {
			continue;
		}
		const createdAt: string = String(row.created_at);
		const existing = eventGroups.get(requestId);
		if (existing === undefined) {
			eventGroups.set(requestId, { firstAt: createdAt, sourceRequestIds: new Set([sourceRequestId]) });
		} else {
			existing.sourceRequestIds.add(sourceRequestId);
			if (createdAt < existing.firstAt) {
				existing.firstAt = createdAt;
			}
		}
	}
	for (const [requestId, group] of eventGroups) {
		const entry: TimelineIndexEntry = getOrCreate(requestId, group.firstAt);
		entry.hasEvents = true;
		entry.firstEventAt = group.firstAt;
		entry.sourceRequestIds = group.sourceRequestIds;
		entry.orderAt = entry.userCreatedAt ?? entry.firstEventAt ?? entry.assistantCreatedAt ?? entry.orderAt;
		sequence += 1;
	}

	const hasAnyEvents: boolean = eventGroups.size > 0;
	const sortedEntries: TimelineIndexEntry[] = [...entries.values()]
		.filter((entry: TimelineIndexEntry): boolean => !(
			hasAnyEvents
				&& !entry.hasEvents
				&& entry.userCreatedAt !== undefined
				&& entry.assistantCreatedAt !== undefined
		))
		.sort((left: TimelineIndexEntry, right: TimelineIndexEntry): number => (
			left.orderAt.localeCompare(right.orderAt) || left.sequence - right.sequence
		));
	return sortedEntries.flatMap((entry: TimelineIndexEntry): TimelineBlockIndex[] => {
		const blocks: TimelineBlockIndex[] = [];
		if (entry.userCreatedAt !== undefined) {
			blocks.push({
				key: timelineBlockKey(entry.requestId, "user"),
				requestId: entry.requestId,
				type: "user",
				sourceRequestIds: [...entry.sourceRequestIds]
			});
		}
		if (entry.assistantCreatedAt !== undefined || entry.hasEvents) {
			blocks.push({
				key: timelineBlockKey(entry.requestId, "assistant"),
				requestId: entry.requestId,
				type: "assistant",
				sourceRequestIds: [...entry.sourceRequestIds]
			});
		}
		return blocks;
	});
}

function eventFromRow(row: Record<string, unknown>): StoredSessionEvent {
	return {
		id: String(row.event_id),
		requestId: String(row.request_id),
		event: String(row.event_name),
		data: parseSqlJson<unknown>(row.data_json),
		createdAt: String(row.created_at)
	};
}

function readLatestTimelineSnapshots(db: DatabaseSync, sessionId: string): ReturnType<typeof buildCanonicalTimelineBlocks> {
	const snapshotEventNames: string[] = [
		"workflow.todo.updated",
		"workflow.todo.dismissed",
		"agent.run.snapshot",
		"agent.run.error",
		"plan.clarification.required",
		"plan.generated",
		"plan.revised",
		"plan.approved",
		"plan.execution.started",
		"plan.error"
	];
	const placeholders: string = snapshotEventNames.map((): string => "?").join(",");
	const rows = db.prepare(`
		SELECT event_id, request_id, event_name, data_json, created_at
		FROM session_events
		WHERE session_id = ? AND channel = 'timeline' AND event_name IN (${placeholders})
		ORDER BY sequence
	`).all(sessionId, ...snapshotEventNames) as Record<string, unknown>[];
	return buildCanonicalTimelineBlocks({
		metadata: { id: sessionId, title: "", createdAt: "", updatedAt: "" },
		messages: [],
		events: rows.map(eventFromRow)
	});
}

async function createSqlTimelinePage(sessionId: string, offset: number | null, limit: number): Promise<StoredSessionTimelinePage | null> {
	const safeSessionId: string = assertSafeSessionId(sessionId);
	const db: DatabaseSync = await getSessionDatabase();
	const metadata: SessionMetadata = rowMetadata(
		db.prepare("SELECT metadata_json FROM sessions WHERE session_id = ? AND archived_at IS NULL").get(safeSessionId) as Record<string, unknown> | undefined,
		safeSessionId
	);
	const index: TimelineBlockIndex[] | null = buildTimelineBlockIndex(db, safeSessionId);
	if (index === null) {
		return null;
	}
	const blockCount: number = index.length;
	const blockOffset: number = offset === null
		? Math.max(0, blockCount - Math.max(0, limit))
		: Math.max(0, Math.min(offset, blockCount));
	const endOffset: number = Math.min(blockCount, blockOffset + Math.max(0, limit));
	const selectedIndex: TimelineBlockIndex[] = index.slice(blockOffset, endOffset);
	const requestIds: string[] = [...new Set(selectedIndex.map((item: TimelineBlockIndex): string => item.requestId))];
	const sourceRequestIds: string[] = [...new Set(selectedIndex.flatMap((item: TimelineBlockIndex): string[] => item.sourceRequestIds))];
	const selectedMessages = requestIds.length === 0
		? []
		: db.prepare(`SELECT payload_json FROM messages WHERE session_id = ? AND request_id IN (${requestIds.map((): string => "?").join(",")}) ORDER BY sequence`)
			.all(safeSessionId, ...requestIds) as Record<string, unknown>[];
	const selectedEvents = sourceRequestIds.length === 0
		? []
		: db.prepare(`SELECT event_id, request_id, event_name, data_json, created_at FROM session_events WHERE session_id = ? AND channel = 'timeline' AND request_id IN (${sourceRequestIds.map((): string => "?").join(",")}) ORDER BY sequence`)
			.all(safeSessionId, ...sourceRequestIds) as Record<string, unknown>[];
	const messages: StoredMessage[] = selectedMessages.map((row: Record<string, unknown>): StoredMessage => parseSqlJson<StoredMessage>(row.payload_json));
	const events: StoredSessionEvent[] = selectedEvents.map(eventFromRow);
	const timeline = buildCanonicalTimelineBlocks({ metadata, messages, events });
	const blocksByKey: Map<string, TimelineBlock> = new Map(timeline.blocks.map((block: TimelineBlock): [string, TimelineBlock] => [
		timelineBlockKey(block.requestId, block.type),
		block
	]));
	const timelineBlocks: TimelineBlock[] = selectedIndex
		.map((item: TimelineBlockIndex): TimelineBlock | undefined => blocksByKey.get(item.key))
		.filter((block: TimelineBlock | undefined): block is TimelineBlock => block !== undefined);
	if (timelineBlocks.length !== selectedIndex.length) {
		return null;
	}
	const snapshots = readLatestTimelineSnapshots(db, safeSessionId);
	const eventCountRow = db.prepare(`
		SELECT COUNT(*) AS count FROM session_events WHERE session_id = ? AND channel = 'timeline'
	`).get(safeSessionId) as Record<string, unknown>;
	return {
		metadata,
		messages,
		timelineBlocks,
		blockCount,
		blockOffset,
		eventCount: Number(eventCountRow.count),
		hasMoreBefore: blockOffset > 0,
		hasMoreAfter: endOffset < blockCount,
		latestWorkflowSnapshot: snapshots.latestWorkflowSnapshot,
		latestAgentSnapshot: snapshots.latestAgentSnapshot,
		latestPlanClarification: snapshots.latestPlanClarification,
		latestPlanApproval: snapshots.latestPlanApproval
	};
}

function createTimelinePage(stored: StoredSession, offset: number, limit: number): StoredSessionTimelinePage {
	const timeline = getTimelineBuildResult(stored);
	const blockCount: number = timeline.blocks.length;
	const blockOffset: number = Math.max(0, Math.min(offset, blockCount));
	const endOffset: number = Math.min(blockCount, blockOffset + Math.max(0, limit));
	return {
		metadata: stored.metadata,
		messages: stored.messages,
		timelineBlocks: timeline.blocks.slice(blockOffset, endOffset),
		blockCount,
		blockOffset,
		eventCount: timeline.eventCount,
		hasMoreBefore: blockOffset > 0,
		hasMoreAfter: endOffset < blockCount,
		latestWorkflowSnapshot: timeline.latestWorkflowSnapshot,
		latestAgentSnapshot: timeline.latestAgentSnapshot,
		latestPlanClarification: timeline.latestPlanClarification,
		latestPlanApproval: timeline.latestPlanApproval
	};
}

export async function openSessionRecentTimeline(sessionId: string, limit: number): Promise<StoredSessionTimelinePage> {
	const sqlPage: StoredSessionTimelinePage | null = await createSqlTimelinePage(sessionId, null, limit);
	if (sqlPage !== null) {
		return sqlPage;
	}
	const stored: StoredSession = await openSession(sessionId);
	const blockCount: number = getTimelineBuildResult(stored).blocks.length;
	return createTimelinePage(stored, Math.max(0, blockCount - limit), limit);
}

/** Returns the complete, lightweight user-turn index without hydrating assistant timeline content. */
export async function getSessionTimelineNavigationIndex(sessionId: string): Promise<SessionTimelineNavigationIndex> {
	const safeSessionId: string = assertSafeSessionId(sessionId);
	const db: DatabaseSync = await getSessionDatabase();
	rowMetadata(
		db.prepare("SELECT metadata_json FROM sessions WHERE session_id = ? AND archived_at IS NULL").get(safeSessionId) as Record<string, unknown> | undefined,
		safeSessionId
	);
	const blockIndex: TimelineBlockIndex[] | null = buildTimelineBlockIndex(db, safeSessionId);
	if (blockIndex === null) {
		throw new Error(`Timeline index is unavailable for session: ${safeSessionId}`);
	}
	const userRows = db.prepare(`
		SELECT request_id, created_at, payload_json
		FROM messages
		WHERE session_id = ? AND role = 'user'
		ORDER BY sequence
	`).all(safeSessionId) as Record<string, unknown>[];
	const userMessages = new Map<string, StoredMessage>();
	for (const row of userRows) {
		const message: StoredMessage = parseSqlJson<StoredMessage>(row.payload_json);
		userMessages.set(String(row.request_id), message);
	}

	const entries: SessionTimelineNavigationEntry[] = [];
	for (let blockOffset: number = 0; blockOffset < blockIndex.length; blockOffset += 1) {
		const block: TimelineBlockIndex = blockIndex[blockOffset]!;
		if (block.type !== "user") {
			continue;
		}
		const message: StoredMessage | undefined = userMessages.get(block.requestId);
		if (message === undefined) {
			continue;
		}
		entries.push({
			entryId: `message:${block.requestId}:user:${message.createdAt}`,
			requestId: block.requestId,
			blockOffset,
			sentAtUtc: message.createdAt,
			preview: createTimelineNavigationPreview(message.content)
		});
	}
	return { sessionId: safeSessionId, blockCount: blockIndex.length, entries };
}

export async function openSessionTimelinePage(sessionId: string, beforeOffset: number, limit: number): Promise<StoredSessionTimelinePage> {
	const endOffset: number = Math.max(0, beforeOffset);
	const blockOffset: number = Math.max(0, endOffset - limit);
	const sqlPage: StoredSessionTimelinePage | null = await createSqlTimelinePage(sessionId, blockOffset, endOffset - blockOffset);
	if (sqlPage !== null) {
		return sqlPage;
	}
	const stored: StoredSession = await openSession(sessionId);
	return createTimelinePage(stored, blockOffset, endOffset - blockOffset);
}

export async function openSessionTimelinePageAfter(sessionId: string, afterOffset: number, limit: number): Promise<StoredSessionTimelinePage> {
	const sqlPage: StoredSessionTimelinePage | null = await createSqlTimelinePage(sessionId, Math.max(0, afterOffset), limit);
	if (sqlPage !== null) {
		return sqlPage;
	}
	return createTimelinePage(await openSession(sessionId), Math.max(0, afterOffset), limit);
}

function replaceMessages(db: DatabaseSync, sessionId: string, messages: ChatMessage[]): void {
	db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
	const insert = db.prepare(`
		INSERT INTO messages(session_id, sequence, request_id, role, payload_json, created_at)
		VALUES (?, ?, ?, ?, ?, ?)
	`);
	const timestamp: string = new Date().toISOString();
	for (let index: number = 0; index < messages.length; index += 1) {
		const message: ChatMessage = messages[index]!;
		const stored: StoredMessage = { ...message, createdAt: message.createdAt ?? timestamp };
		insert.run(sessionId, index + 1, toSqlValue(message.requestId), message.role, sqlJson(stored), stored.createdAt);
	}
}

export async function updateSessionTranscript<T>(
	sessionId: string,
	updater: (stored: StoredSession) => Promise<TranscriptUpdate<T>> | TranscriptUpdate<T>
): Promise<T> {
	return enqueueTranscriptWrite(sessionId, async (): Promise<T> => {
		const stored: StoredSession = await openSession(sessionId);
		const update: TranscriptUpdate<T> = await updater(stored);
		const updatedMetadata: SessionMetadata = mergeSessionMetadata(stored.metadata, update.metadata);
		const db: DatabaseSync = await getSessionDatabase();
		runSessionTransaction(db, (): void => {
			replaceMessages(db, sessionId, update.messages);
			writeMetadataRow(db, updatedMetadata);
		});
		invalidateTimelineCache(sessionId);
		return update.result;
	});
}

export async function saveSession(sessionId: string, messages: ChatMessage[], metadata?: Partial<SessionMetadata>): Promise<void> {
	await updateSessionTranscript(sessionId, (): TranscriptUpdate<void> => ({ messages, metadata, result: undefined }));
}

export async function updateSessionMetadata(sessionId: string, metadata: Partial<SessionMetadata>): Promise<SessionMetadata> {
	const existing: SessionMetadata = await readSessionMetadata(sessionId, false);
	const updated: SessionMetadata = mergeSessionMetadata(existing, metadata);
	writeMetadataRow(await getSessionDatabase(), updated);
	invalidateTimelineCache(sessionId);
	return updated;
}

/** Promotes a Studio-only draft before its first accepted chat request. */
export async function promoteTemporarySession(sessionId: string): Promise<SessionMetadata> {
	const existing: SessionMetadata = await readSessionMetadata(sessionId, false);
	if (existing.temporary !== true) {
		return existing;
	}
	const { temporary: _temporary, ...promoted } = existing;
	const updated: SessionMetadata = {
		...promoted,
		updatedAt: new Date().toISOString()
	};
	writeMetadataRow(await getSessionDatabase(), updated);
	invalidateTimelineCache(sessionId);
	return updated;
}

function findRewindBoundaryCreatedAt(events: RewindableEvent[], removedRequestIds: Set<string>): string | null {
	let boundary: string | null = null;
	for (const event of events) {
		if (removedRequestIds.has(event.requestId) && (boundary === null || event.createdAt < boundary)) {
			boundary = event.createdAt;
		}
	}
	return boundary;
}

function findRewindTimelineSequence(
	db: DatabaseSync,
	sessionId: string,
	requestIds: string[]
): number | null {
	if (requestIds.length === 0) {
		return null;
	}
	const placeholders: string = requestIds.map((): string => "?").join(",");
	const row = db.prepare(`
		SELECT MIN(sequence) AS sequence
		FROM session_events
		WHERE session_id = ? AND channel = 'timeline' AND request_id IN (${placeholders})
	`).get(sessionId, ...requestIds) as Record<string, unknown>;
	const sequence: unknown = row.sequence;
	return typeof sequence === "number" && Number.isInteger(sequence) ? sequence : null;
}

export async function rewindSessionFromRequest(sessionId: string, requestId: string): Promise<StoredMessage[]> {
	return enqueueTranscriptWrite(sessionId, async (): Promise<StoredMessage[]> => {
		const stored: StoredSession = await openSession(sessionId);
		const startIndex: number = stored.messages.findIndex((message: StoredMessage): boolean => message.requestId === requestId);
		const eventBoundary: string | null = findRewindBoundaryCreatedAt(stored.events, new Set([requestId]));
		if (startIndex < 0 && eventBoundary === null) {
			return stored.messages;
		}
		const fallbackBoundary: string = eventBoundary ?? "";
		const keptMessages: StoredMessage[] = startIndex >= 0
			? stored.messages.slice(0, startIndex)
			: stored.messages.filter((message: StoredMessage): boolean => message.createdAt.length === 0 || message.createdAt < fallbackBoundary);
		const removedRequestIds: Set<string> = new Set([
			requestId,
			...stored.messages.slice(startIndex >= 0 ? startIndex : 0)
				.filter((message: StoredMessage): boolean => startIndex >= 0 || message.createdAt >= fallbackBoundary)
				.map((message: StoredMessage): string | undefined => message.requestId)
				.filter((value: string | undefined): value is string => value !== undefined && value.length > 0)
		]);
		const db: DatabaseSync = await getSessionDatabase();
		runSessionTransaction(db, (): void => {
			replaceMessages(db, sessionId, keptMessages);
			const ids: string[] = [...removedRequestIds];
			if (ids.length > 0) {
				const placeholders: string = ids.map((): string => "?").join(",");
				const timelineSequence: number | null = findRewindTimelineSequence(db, sessionId, ids);
				db.prepare(`
					DELETE FROM session_events
					WHERE session_id = ? AND channel = 'timeline'
						AND (request_id IN (${placeholders}) OR (? IS NOT NULL AND sequence >= ?))
				`).run(sessionId, ...ids, timelineSequence, timelineSequence);
				db.prepare(`
					DELETE FROM session_events
					WHERE session_id = ? AND channel = 'approval' AND request_id IN (${placeholders})
				`).run(sessionId, ...ids);
				db.prepare(`DELETE FROM plans WHERE session_id = ? AND request_id IN (${placeholders})`)
					.run(sessionId, ...ids);
			}
			const updated: SessionMetadata = { ...stored.metadata, updatedAt: new Date().toISOString() };
			writeMetadataRow(db, updated);
		});
		invalidateTimelineCache(sessionId);
		return keptMessages;
	});
}

export async function appendMessage(sessionId: string, message: ChatMessage): Promise<void> {
	await enqueueTranscriptWrite(sessionId, async (): Promise<void> => {
		const db: DatabaseSync = await getSessionDatabase();
		const row = db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM messages WHERE session_id = ?").get(sessionId) as Record<string, unknown>;
		const stored: StoredMessage = { ...message, createdAt: message.createdAt ?? new Date().toISOString() };
		db.prepare(`
			INSERT INTO messages(session_id, sequence, request_id, role, payload_json, created_at)
			VALUES (?, ?, ?, ?, ?, ?)
		`).run(sessionId, Number(row.value), toSqlValue(message.requestId), message.role, sqlJson(stored), stored.createdAt);
		invalidateTimelineCache(sessionId);
	});
}

function dataString(data: unknown, key: string): string | null {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return null;
	}
	const value: unknown = (data as Record<string, unknown>)[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

async function appendEventRecord(params: {
	sessionId: string;
	requestId: string;
	event: string;
	data: unknown;
	channel: "timeline" | "approval" | "audit";
	idPrefix: string;
	approvalId?: string | undefined;
	workflowId?: string | undefined;
	runId?: string | undefined;
}): Promise<void> {
	const db: DatabaseSync = await getSessionDatabase();
	const row = db.prepare(`
		SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM session_events
		WHERE session_id = ? AND channel = ?
	`).get(params.sessionId, params.channel) as Record<string, unknown>;
	const eventId: string = `${params.idPrefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	db.prepare(`
		INSERT INTO session_events(
			event_id, session_id, sequence, channel, request_id, event_name, data_json,
			approval_id, workflow_id, run_id, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		eventId,
		params.sessionId,
		Number(row.value),
		params.channel,
		params.requestId,
		params.event,
		sqlJson(params.data),
		params.approvalId ?? dataString(params.data, "approvalId"),
		params.workflowId ?? dataString(params.data, "workflowId"),
		params.runId ?? dataString(params.data, "runId"),
		new Date().toISOString()
	);
	invalidateTimelineCache(params.sessionId);
}

export async function appendSessionEvent(sessionId: string, requestId: string, event: string, data: unknown): Promise<void> {
	await appendEventRecord({ sessionId, requestId, event, data, channel: "timeline", idPrefix: "event" });
}

export async function appendApprovalEvent(sessionId: string, approvalId: string, requestId: string, event: string, data: unknown): Promise<void> {
	await appendEventRecord({ sessionId, approvalId, requestId, event, data, channel: "approval", idPrefix: "approval-event" });
}

// Compatibility wrappers no longer duplicate payloads. Canonical events already index workflowId/runId.
export async function appendWorkflowEvent(
	_sessionId: string,
	_workflowId: string,
	_requestId: string,
	_event: string,
	_data: unknown
): Promise<void> {}
export async function appendAgentEvent(
	_sessionId: string,
	_runId: string,
	_requestId: string,
	_event: string,
	_data: unknown
): Promise<void> {}

export async function readApprovalEvents(sessionId: string): Promise<StoredApprovalEvent[]> {
	const safeSessionId: string = assertSafeSessionId(sessionId);
	const db: DatabaseSync = await getSessionDatabase();
	const rows = db.prepare(`
		SELECT event_id, approval_id, request_id, event_name, data_json, created_at
		FROM session_events WHERE session_id = ? AND channel = 'approval' ORDER BY sequence
	`).all(safeSessionId) as Record<string, unknown>[];
	return rows.map((row: Record<string, unknown>): StoredApprovalEvent => ({
		id: String(row.event_id),
		schemaVersion: 1,
		approvalId: String(row.approval_id ?? ""),
		requestId: String(row.request_id),
		event: String(row.event_name),
		data: parseSqlJson<unknown>(row.data_json),
		createdAt: String(row.created_at)
	}));
}

export async function checkSessionIntegrity(sessionId: string): Promise<SessionIntegrityCheckResult> {
	const safeSessionId: string = assertSafeSessionId(sessionId);
	await readSessionMetadata(safeSessionId);
	const db: DatabaseSync = await getSessionDatabase();
	const integrity = db.prepare("PRAGMA integrity_check").get() as Record<string, unknown>;
	const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
	const issues: SessionIntegrityIssue[] = [];
	const rows = db.prepare(`
		SELECT row_id, request_id, event_name, data_json FROM session_events WHERE session_id = ?
	`).all(safeSessionId) as Record<string, unknown>[];
	for (const row of rows) {
		const data: unknown = parseSqlJson<unknown>(row.data_json);
		const actual: string | null = dataString(data, "sessionId");
		if (actual !== null && actual !== safeSessionId) {
			issues.push({
				file: "events",
				line: Number(row.row_id),
				expectedSessionId: safeSessionId,
				actualSessionId: actual,
				requestId: String(row.request_id),
				event: String(row.event_name)
			});
		}
	}
	return {
		sessionId: safeSessionId,
		ok: String(integrity.integrity_check) === "ok" && foreignKeys.length === 0 && issues.length === 0,
		issues,
		checkedFiles: ["messages", "events", "approval-events", "workflow-events", "agent-events"],
		storage: "sqlite",
		integrityCheck: String(integrity.integrity_check),
		foreignKeyIssueCount: foreignKeys.length
	};
}

export async function clearSessionEvents(sessionId: string): Promise<void> {
	const safeSessionId: string = assertSafeSessionId(sessionId);
	(await getSessionDatabase()).prepare("DELETE FROM session_events WHERE session_id = ?").run(safeSessionId);
	invalidateTimelineCache(safeSessionId);
}

function listMetadataRows(rows: Record<string, unknown>[]): SessionMetadata[] {
	return rows.map((row: Record<string, unknown>): SessionMetadata => parseSqlJson<SessionMetadata>(row.metadata_json));
}

export async function listSessions(): Promise<SessionMetadata[]> {
	const db: DatabaseSync = await getSessionDatabase();
	return listMetadataRows(db.prepare(`
		SELECT metadata_json FROM sessions WHERE archived_at IS NULL ORDER BY updated_at DESC
	`).all() as Record<string, unknown>[]).filter((metadata: SessionMetadata): boolean => metadata.temporary !== true);
}

export async function listTemporarySessions(): Promise<SessionMetadata[]> {
	const db: DatabaseSync = await getSessionDatabase();
	return listMetadataRows(db.prepare(`
		SELECT metadata_json FROM sessions WHERE archived_at IS NULL ORDER BY updated_at DESC
	`).all() as Record<string, unknown>[]).filter((metadata: SessionMetadata): boolean => metadata.temporary === true);
}

export async function listArchivedSessions(): Promise<SessionMetadata[]> {
	const db: DatabaseSync = await getSessionDatabase();
	return listMetadataRows(db.prepare(`
		SELECT metadata_json FROM sessions WHERE archived_at IS NOT NULL ORDER BY updated_at DESC
	`).all() as Record<string, unknown>[]);
}

async function moveSessionAssetDir(source: string, target: string): Promise<boolean> {
	if (!await pathExists(source)) {
		return false;
	}
	if (await pathExists(target)) {
		throw new Error(`Session asset directory already exists: ${target}`);
	}
	await mkdir(join(target, ".."), { recursive: true });
	await rename(source, target);
	return true;
}

export async function archiveSession(sessionId: string): Promise<SessionMetadata> {
	const safeSessionId: string = assertSafeSessionId(sessionId);
	const metadata: SessionMetadata = await readSessionMetadata(safeSessionId, false);
	const archivedAt: string = new Date().toISOString();
	const updated: SessionMetadata = { ...metadata, archivedAt, updatedAt: archivedAt };
	const source: string = getSessionDir(safeSessionId);
	const target: string = getArchivedSessionDir(safeSessionId);
	const movedAssets: boolean = await moveSessionAssetDir(source, target);
	try {
		writeMetadataRow(await getSessionDatabase(), updated);
	} catch (error: unknown) {
		if (movedAssets) {
			await rename(target, source).catch((): void => {});
		}
		throw error;
	}
	invalidateTimelineCache(safeSessionId);
	return updated;
}

export async function restoreArchivedSession(sessionId: string): Promise<SessionMetadata> {
	const safeSessionId: string = assertSafeSessionId(sessionId);
	const metadata: SessionMetadata = await readSessionMetadata(safeSessionId, true);
	const updated: SessionMetadata = { ...metadata, archivedAt: undefined, updatedAt: new Date().toISOString() };
	const source: string = getArchivedSessionDir(safeSessionId);
	const target: string = getSessionDir(safeSessionId);
	const movedAssets: boolean = await moveSessionAssetDir(source, target);
	try {
		writeMetadataRow(await getSessionDatabase(), updated);
	} catch (error: unknown) {
		if (movedAssets) {
			await rename(target, source).catch((): void => {});
		}
		throw error;
	}
	invalidateTimelineCache(safeSessionId);
	return updated;
}

async function deleteSessionRecord(sessionId: string, archived: boolean): Promise<void> {
	const safeSessionId: string = assertSafeSessionId(sessionId);
	await readSessionMetadata(safeSessionId, archived);
	const dir: string = archived ? getArchivedSessionDir(safeSessionId) : getSessionDir(safeSessionId);
	const staging: string = `${dir}.deleting-${Date.now().toString(36)}`;
	const hadDir: boolean = await pathExists(dir);
	if (hadDir) {
		await rename(dir, staging);
	}
	try {
		(await getSessionDatabase()).prepare("DELETE FROM sessions WHERE session_id = ?").run(safeSessionId);
	} catch (error: unknown) {
		if (hadDir) {
			await rename(staging, dir).catch((): void => {});
		}
		throw error;
	}
	if (hadDir) {
		await rm(staging, { recursive: true, force: true });
	}
	invalidateTimelineCache(safeSessionId);
}

export async function deleteSession(sessionId: string): Promise<void> {
	await deleteSessionRecord(sessionId, false);
}

export async function deleteArchivedSession(sessionId: string): Promise<void> {
	await deleteSessionRecord(sessionId, true);
}

export async function deleteSessionsByWorkspace(workspaceId: string): Promise<{ deletedSessionIds: string[]; deletedArchivedSessionIds: string[] }> {
	const sessions: SessionMetadata[] = await listSessions();
	const archived: SessionMetadata[] = await listArchivedSessions();
	const deletedSessionIds: string[] = sessions.filter((item) => item.workspaceId === workspaceId).map((item) => item.id);
	const deletedArchivedSessionIds: string[] = archived.filter((item) => item.workspaceId === workspaceId).map((item) => item.id);
	for (const id of deletedSessionIds) {
		await deleteSession(id);
	}
	for (const id of deletedArchivedSessionIds) {
		await deleteArchivedSession(id);
	}
	return { deletedSessionIds, deletedArchivedSessionIds };
}

export type WorkspaceSessionMove = {
	sessionId: string;
	archived: boolean;
	workspaceId: string;
};

export type WorkspaceSessionReassignmentResult = {
	movedSessions: WorkspaceSessionMove[];
	deletedSessionIds: string[];
	deletedArchivedSessionIds: string[];
};

function findSessionDestination(
	metadata: SessionMetadata,
	workspaces: WorkspaceConfig[]
): WorkspaceConfig | undefined {
	if (metadata.workspaceRoot === undefined) {
		return undefined;
	}

	return workspaces
		.map((workspace: WorkspaceConfig) => ({
			workspace,
			sourceFolder: findContainingWorkspaceSourceFolder(workspace, metadata.workspaceRoot!)
		}))
		.filter((candidate): candidate is {
			workspace: WorkspaceConfig;
			sourceFolder: WorkspaceConfig["sourceFolders"][number];
		} => candidate.sourceFolder !== undefined)
		.sort((left, right): number => right.sourceFolder.path.length - left.sourceFolder.path.length)[0]?.workspace;
}

export async function updateSessionsForWorkspace(workspace: WorkspaceConfig): Promise<SessionMetadata[]> {
	const db: DatabaseSync = await getSessionDatabase();
	const rows = db.prepare("SELECT metadata_json FROM sessions WHERE workspace_id = ?").all(workspace.id) as Record<string, unknown>[];
	const updatedSessions: SessionMetadata[] = rows.map((row: Record<string, unknown>): SessionMetadata => {
		const metadata: SessionMetadata = parseSqlJson<SessionMetadata>(row.metadata_json);
		return {
			...metadata,
			workspaceId: workspace.id,
			workspaceName: workspace.name,
			workspaceKind: workspace.kind,
			workspaceRoot: workspace.rootPath,
			godotExecutablePath: workspace.godotExecutablePath,
			updatedAt: new Date().toISOString()
		};
	});
	runSessionTransaction(db, (): void => {
		for (const metadata of updatedSessions) {
			writeMetadataRow(db, metadata);
		}
	});
	for (const metadata of updatedSessions) {
		invalidateTimelineCache(metadata.id);
	}
	return updatedSessions;
}

export async function reassignOrDeleteSessionsForWorkspace(
	workspaceId: string,
	remainingWorkspaces: WorkspaceConfig[]
): Promise<WorkspaceSessionReassignmentResult> {
	const db: DatabaseSync = await getSessionDatabase();
	const rows = db.prepare("SELECT metadata_json FROM sessions WHERE workspace_id = ?").all(workspaceId) as Record<string, unknown>[];
	const movedSessions: WorkspaceSessionMove[] = [];
	const deleteTargets: Array<{ id: string; archived: boolean }> = [];
	const movedMetadata: SessionMetadata[] = [];

	for (const row of rows) {
		const metadata: SessionMetadata = parseSqlJson<SessionMetadata>(row.metadata_json);
		const destination: WorkspaceConfig | undefined = findSessionDestination(metadata, remainingWorkspaces);
		if (destination === undefined) {
			deleteTargets.push({ id: metadata.id, archived: metadata.archivedAt !== undefined });
			continue;
		}
		movedMetadata.push({
			...metadata,
			workspaceId: destination.id,
			workspaceName: destination.name,
			workspaceKind: destination.kind,
			workspaceRoot: destination.rootPath,
			godotExecutablePath: destination.godotExecutablePath,
			updatedAt: new Date().toISOString()
		});
		movedSessions.push({
			sessionId: metadata.id,
			archived: metadata.archivedAt !== undefined,
			workspaceId: destination.id
		});
	}

	runSessionTransaction(db, (): void => {
		for (const metadata of movedMetadata) {
			writeMetadataRow(db, metadata);
		}
	});
	for (const metadata of movedMetadata) {
		invalidateTimelineCache(metadata.id);
	}
	for (const target of deleteTargets) {
		await deleteSessionRecord(target.id, target.archived);
	}

	return {
		movedSessions,
		deletedSessionIds: deleteTargets.filter((target): boolean => !target.archived).map((target) => target.id),
		deletedArchivedSessionIds: deleteTargets.filter((target): boolean => target.archived).map((target) => target.id)
	};
}

export async function renameSession(sessionId: string, newTitle: string): Promise<SessionMetadata> {
	return updateSessionMetadata(sessionId, { title: newTitle });
}

export async function sessionExists(sessionId: string): Promise<boolean> {
	const safeSessionId: string = assertSafeSessionId(sessionId);
	const db: DatabaseSync = await getSessionDatabase();
	return db.prepare("SELECT 1 FROM sessions WHERE session_id = ? AND archived_at IS NULL").get(safeSessionId) !== undefined;
}

export async function readSummary(sessionId: string): Promise<SessionSummary | null> {
	const safeSessionId: string = assertSafeSessionId(sessionId);
	const row = (await getSessionDatabase()).prepare(`
		SELECT content, message_count, token_estimate, generated_at FROM summaries WHERE session_id = ?
	`).get(safeSessionId) as Record<string, unknown> | undefined;
	return row === undefined ? null : {
		content: String(row.content),
		messageCount: Number(row.message_count),
		tokenEstimate: Number(row.token_estimate),
		generatedAt: String(row.generated_at)
	};
}

export async function writeSummary(sessionId: string, summary: SessionSummary): Promise<void> {
	const safeSessionId: string = assertSafeSessionId(sessionId);
	(await getSessionDatabase()).prepare(`
		INSERT INTO summaries(session_id, content, message_count, token_estimate, generated_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(session_id) DO UPDATE SET
			content = excluded.content,
			message_count = excluded.message_count,
			token_estimate = excluded.token_estimate,
			generated_at = excluded.generated_at
	`).run(safeSessionId, summary.content, summary.messageCount, summary.tokenEstimate, summary.generatedAt);
}

export async function deleteSummary(sessionId: string): Promise<void> {
	(await getSessionDatabase()).prepare("DELETE FROM summaries WHERE session_id = ?").run(assertSafeSessionId(sessionId));
}
