import { randomUUID } from "node:crypto";
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AdditionalContextItem } from "../protocol/types.js";
import {
	createSession,
	deleteSession,
	getSessionDir,
	openSession,
	type SessionForkOrigin,
	type SessionMetadata,
	type StoredMessage,
} from "./session-store.js";
import {
	getSessionDatabase,
	parseSqlJson,
	runSessionTransaction,
	sqlJson,
	toSqlValue,
} from "./session-database.js";

const FORK_DRAFT_CHANNEL: string = "workbench";
const FORK_DRAFT_EVENT: string = "session.fork.draft";
const MAX_FORK_TITLE_CHARS: number = 200;
const MAX_MESSAGE_PREVIEW_CHARS: number = 120;

type MessageRow = {
	sequence: number;
	request_id: string | null;
	role: string;
	payload_json: string;
	created_at: string;
};

type EventRow = {
	sequence: number;
	request_id: string;
	event_name: string;
	data_json: string;
	approval_id: string | null;
	workflow_id: string | null;
	run_id: string | null;
	created_at: string;
};

type AttachmentRow = {
	attachment_id: string;
	kind: string;
	metadata_json: string;
	storage_path: string;
	created_at: string;
};

type PlanRow = {
	plan_id: string;
	request_id: string;
	status: string;
	metadata_json: string;
	markdown: string;
	created_at: string;
	updated_at: string;
};

type FileEditBatchRow = {
	batch_id: string;
	request_id: string;
	tool_call_id: string;
	tool_name: string;
	payload_json: string;
	created_at: string;
};

export type SessionForkDraft = {
	text: string;
	additionalContext: AdditionalContextItem[];
};

export type CreateSessionForkParams = {
	sourceSessionId: string;
	sourceRequestId?: string | undefined;
	title: string;
};

export type CreateSessionForkResult = {
	metadata: SessionMetadata;
	draft: SessionForkDraft;
};

function forkError(code: string, message: string): Error & { code: string } {
	return Object.assign(new Error(message), { code });
}

function normalizeForkTitle(title: string): string {
	const normalized: string = title.trim();
	if (normalized.length === 0 || normalized.length > MAX_FORK_TITLE_CHARS) {
		throw forkError("session_fork_invalid_title", `Fork title must be between 1 and ${MAX_FORK_TITLE_CHARS} characters.`);
	}
	return normalized;
}

function createMessagePreview(content: string): string {
	const normalized: string = content.replace(/\s+/gu, " ").trim();
	return normalized.length <= MAX_MESSAGE_PREVIEW_CHARS
		? normalized
		: `${normalized.slice(0, MAX_MESSAGE_PREVIEW_CHARS - 1)}…`;
}

function isInside(root: string, target: string): boolean {
	const child: string = relative(root, target);
	return child.length === 0 || (!child.startsWith("..") && !isAbsolute(child));
}

function resolveSessionAssetPath(sessionId: string, storagePath: string): string {
	const root: string = resolve(getSessionDir(sessionId));
	const target: string = resolve(join(root, storagePath.replaceAll("\\", "/")));
	if (!isInside(root, target)) {
		throw forkError("session_fork_invalid_attachment", `Attachment path escapes its session: ${storagePath}`);
	}
	return target;
}

function collectStringReferences(value: unknown, references: Set<string>): void {
	if (typeof value === "string") {
		references.add(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			collectStringReferences(item, references);
		}
		return;
	}
	if (typeof value !== "object" || value === null) {
		return;
	}
	for (const child of Object.values(value as Record<string, unknown>)) {
		collectStringReferences(child, references);
	}
}

function rewriteSnapshotValue(
	value: unknown,
	idMap: ReadonlyMap<string, string>,
	sourceSessionId: string,
	targetSessionId: string,
): unknown {
	if (typeof value === "string") {
		return idMap.get(value) ?? value;
	}
	if (Array.isArray(value)) {
		return value.map((item: unknown): unknown => rewriteSnapshotValue(item, idMap, sourceSessionId, targetSessionId));
	}
	if (typeof value !== "object" || value === null) {
		return value;
	}
	const rewritten: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		if (key === "sessionId" && child === sourceSessionId) {
			rewritten[key] = targetSessionId;
		} else if (key === "undoable") {
			rewritten[key] = false;
		} else {
			rewritten[key] = rewriteSnapshotValue(child, idMap, sourceSessionId, targetSessionId);
		}
	}
	return rewritten;
}

function createAttachmentId(kind: string): string {
	if (kind === "image") {
		return `image-${randomUUID()}`;
	}
	if (kind === "text") {
		return `text-${randomUUID()}`;
	}
	if (kind === "generated_image") {
		return `generated-image-${randomUUID()}`;
	}
	throw forkError("session_fork_invalid_attachment", `Unsupported attachment kind: ${kind}`);
}

function requireMappedId(idMap: ReadonlyMap<string, string>, sourceId: string): string {
	const mappedId: string | undefined = idMap.get(sourceId);
	if (mappedId === undefined) {
		throw forkError("session_fork_snapshot_invalid", `Missing fork id mapping: ${sourceId}`);
	}
	return mappedId;
}

function createAttachmentStoragePath(kind: string, attachmentId: string, sourceStoragePath: string): string {
	const extensionMatch: RegExpMatchArray | null = sourceStoragePath.match(/(\.[a-zA-Z0-9]+)$/u);
	const extension: string = extensionMatch?.[1] ?? (kind === "text" ? ".txt" : ".png");
	if (kind === "generated_image") {
		return `attachments/images/${attachmentId}${extension}`;
	}
	if (kind === "text") {
		return `attachments/text/${attachmentId}.txt`;
	}
	return `attachments/${attachmentId}.png`;
}

function rewriteAttachmentMetadata(
	row: AttachmentRow,
	newId: string,
	newStoragePath: string,
	targetSessionId: string,
): unknown {
	const metadata: Record<string, unknown> = parseSqlJson<Record<string, unknown>>(row.metadata_json);
	if (row.kind === "generated_image") {
		metadata.imageId = newId;
		metadata.sessionId = targetSessionId;
	} else {
		metadata.id = newId;
	}
	metadata.fileName = newStoragePath.split("/").at(-1) ?? metadata.fileName;
	if ("storagePath" in metadata) {
		metadata.storagePath = newStoragePath;
	}
	return metadata;
}

function findAnchorMessage(rows: readonly MessageRow[], requestId: string | undefined): MessageRow {
	const userRows: MessageRow[] = rows.filter((row: MessageRow): boolean => row.role === "user");
	const anchor: MessageRow | undefined = requestId === undefined
		? userRows.at(-1)
		: userRows.find((row: MessageRow): boolean => row.request_id === requestId);
	if (anchor === undefined) {
		throw forkError(
			"session_fork_anchor_not_found",
			requestId === undefined ? "The source session has no user message to fork." : "The selected user message no longer exists.",
		);
	}
	return anchor;
}

function readTimelinePrefix(db: DatabaseSync, sourceSessionId: string, anchor: MessageRow): EventRow[] {
	const rows = db.prepare(`
		SELECT sequence, request_id, event_name, data_json, approval_id, workflow_id, run_id, created_at
		FROM session_events
		WHERE session_id = ? AND channel = 'timeline'
		ORDER BY sequence
	`).all(sourceSessionId) as EventRow[];
	const boundary: EventRow | undefined = rows.find((row: EventRow): boolean => row.request_id === anchor.request_id);
	return boundary === undefined
		? rows.filter((row: EventRow): boolean => row.created_at < anchor.created_at)
		: rows.filter((row: EventRow): boolean => row.sequence < boundary.sequence);
}

async function stageAttachments(
	sourceSessionId: string,
	targetSessionId: string,
	rows: readonly AttachmentRow[],
	stagingDir: string,
): Promise<Array<AttachmentRow & { newId: string; newStoragePath: string; metadata: unknown }>> {
	const staged: Array<AttachmentRow & { newId: string; newStoragePath: string; metadata: unknown }> = [];
	for (const row of rows) {
		const newId: string = createAttachmentId(row.kind);
		const newStoragePath: string = createAttachmentStoragePath(row.kind, newId, row.storage_path);
		const sourcePath: string = resolveSessionAssetPath(sourceSessionId, row.storage_path);
		const targetPath: string = resolve(join(stagingDir, newStoragePath));
		if (!isInside(resolve(stagingDir), targetPath)) {
			throw forkError("session_fork_invalid_attachment", `Attachment path escapes fork staging: ${newStoragePath}`);
		}
		await mkdir(dirname(targetPath), { recursive: true });
		await copyFile(sourcePath, targetPath);
		staged.push({
			...row,
			newId,
			newStoragePath,
			metadata: rewriteAttachmentMetadata(row, newId, newStoragePath, targetSessionId),
		});
	}
	return staged;
}

export async function readSessionForkDraft(sessionId: string): Promise<SessionForkDraft | null> {
	const db: DatabaseSync = await getSessionDatabase();
	const row = db.prepare(`
		SELECT data_json FROM session_events
		WHERE session_id = ? AND channel = ? AND event_name = ?
		ORDER BY sequence DESC LIMIT 1
	`).get(sessionId, FORK_DRAFT_CHANNEL, FORK_DRAFT_EVENT) as Record<string, unknown> | undefined;
	if (row === undefined) {
		return null;
	}
	const data: Record<string, unknown> = parseSqlJson<Record<string, unknown>>(row.data_json);
	return {
		text: typeof data.text === "string" ? data.text : "",
		additionalContext: Array.isArray(data.additionalContext) ? data.additionalContext as AdditionalContextItem[] : [],
	};
}

export async function clearSessionForkDraft(sessionId: string): Promise<void> {
	const db: DatabaseSync = await getSessionDatabase();
	db.prepare(`
		DELETE FROM session_events
		WHERE session_id = ? AND channel = ? AND event_name = ?
	`).run(sessionId, FORK_DRAFT_CHANNEL, FORK_DRAFT_EVENT);
}

export async function updateSessionForkDraft(sessionId: string, draft: SessionForkDraft): Promise<void> {
	const db: DatabaseSync = await getSessionDatabase();
	db.prepare(`
		UPDATE session_events SET data_json = ?, created_at = ?
		WHERE session_id = ? AND channel = ? AND event_name = ?
	`).run(
		sqlJson(draft),
		new Date().toISOString(),
		sessionId,
		FORK_DRAFT_CHANNEL,
		FORK_DRAFT_EVENT,
	);
}

export async function createSessionFork(params: CreateSessionForkParams): Promise<CreateSessionForkResult> {
	const source = await openSession(params.sourceSessionId);
	const title: string = normalizeForkTitle(params.title);
	const db: DatabaseSync = await getSessionDatabase();
	const messageRows = db.prepare(`
		SELECT sequence, request_id, role, payload_json, created_at
		FROM messages WHERE session_id = ? ORDER BY sequence
	`).all(params.sourceSessionId) as MessageRow[];
	const anchorRow: MessageRow = findAnchorMessage(messageRows, params.sourceRequestId);
	const anchorMessage: StoredMessage = parseSqlJson<StoredMessage>(anchorRow.payload_json);
	const sourceRequestId: string = anchorMessage.requestId ?? anchorRow.request_id ?? "";
	if (sourceRequestId.length === 0) {
		throw forkError("session_fork_anchor_not_found", "The selected user message has no request id.");
	}
	const origin: SessionForkOrigin = {
		sessionId: source.metadata.id,
		requestId: sourceRequestId,
		sessionTitle: source.metadata.title,
		messagePreview: createMessagePreview(anchorMessage.content),
	};
	const metadata: SessionMetadata = await createSession(
		title,
		source.metadata.workspaceId,
		source.metadata.activeSkillId,
		undefined,
		{
			workspaceName: source.metadata.workspaceName,
			workspaceKind: source.metadata.workspaceKind,
			workspaceRoot: source.metadata.workspaceRoot,
			godotExecutablePath: source.metadata.godotExecutablePath,
			provider: source.metadata.provider,
			model: source.metadata.model,
			reasoningEffort: source.metadata.reasoningEffort,
			chatMode: source.metadata.chatMode,
			approvalMode: source.metadata.approvalMode,
			workspaceLaunch: source.metadata.workspaceLaunch,
			forkedFrom: origin,
		},
	);
	const targetSessionId: string = metadata.id;
	const targetDir: string = getSessionDir(targetSessionId);
	const stagingDir: string = `${targetDir}.fork-staging-${randomUUID()}`;
	try {
		const prefixMessageRows: MessageRow[] = messageRows.filter((row: MessageRow): boolean => row.sequence < anchorRow.sequence);
		const eventRows: EventRow[] = readTimelinePrefix(db, params.sourceSessionId, anchorRow);
		const requestIds: Set<string> = new Set([
			...prefixMessageRows.map((row: MessageRow): string => row.request_id ?? ""),
			...eventRows.map((row: EventRow): string => row.request_id),
		].filter((requestId: string): boolean => requestId.length > 0));
		const plans = db.prepare(`
			SELECT plan_id, request_id, status, metadata_json, markdown, created_at, updated_at
			FROM plans WHERE session_id = ? ORDER BY created_at
		`).all(params.sourceSessionId) as PlanRow[];
		const copiedPlans: PlanRow[] = plans.filter((row: PlanRow): boolean => requestIds.has(row.request_id));
		const batches = db.prepare(`
			SELECT batch_id, request_id, tool_call_id, tool_name, payload_json, created_at
			FROM file_edit_batches WHERE session_id = ? ORDER BY created_at
		`).all(params.sourceSessionId) as FileEditBatchRow[];
		const copiedBatches: FileEditBatchRow[] = batches.filter((row: FileEditBatchRow): boolean => requestIds.has(row.request_id));

		const attachmentRows = db.prepare(`
			SELECT attachment_id, kind, metadata_json, storage_path, created_at
			FROM attachments WHERE session_id = ? ORDER BY created_at
		`).all(params.sourceSessionId) as AttachmentRow[];
		const references: Set<string> = new Set();
		for (const row of [...prefixMessageRows, anchorRow]) {
			collectStringReferences(parseSqlJson<unknown>(row.payload_json), references);
		}
		for (const row of eventRows) {
			collectStringReferences(parseSqlJson<unknown>(row.data_json), references);
		}
		const referencedAttachments: AttachmentRow[] = attachmentRows.filter(
			(row: AttachmentRow): boolean => references.has(row.attachment_id),
		);
		const stagedAttachments = await stageAttachments(
			params.sourceSessionId,
			targetSessionId,
			referencedAttachments,
			stagingDir,
		);
		const idMap: Map<string, string> = new Map();
		for (const row of stagedAttachments) {
			idMap.set(row.attachment_id, row.newId);
		}
		for (const row of copiedPlans) {
			idMap.set(row.plan_id, `plan-${randomUUID()}`);
		}
		for (const row of copiedBatches) {
			idMap.set(row.batch_id, `edit-${randomUUID()}`);
			if (!idMap.has(row.tool_call_id)) {
				idMap.set(row.tool_call_id, `tool-call-${randomUUID()}`);
			}
		}
		for (const row of eventRows) {
			if (row.approval_id !== null && !idMap.has(row.approval_id)) {
				idMap.set(row.approval_id, `approval-${randomUUID()}`);
			}
			if (row.workflow_id !== null && !idMap.has(row.workflow_id)) {
				idMap.set(row.workflow_id, `workflow-${randomUUID()}`);
			}
			if (row.run_id !== null && !idMap.has(row.run_id)) {
				idMap.set(row.run_id, `run-${randomUUID()}`);
			}
		}
		const rewrite = (value: unknown): unknown => rewriteSnapshotValue(
			value,
			idMap,
			params.sourceSessionId,
			targetSessionId,
		);
		const draft: SessionForkDraft = {
			text: anchorMessage.content,
			additionalContext: (rewrite(anchorMessage.additionalContext ?? []) as AdditionalContextItem[]),
		};

		runSessionTransaction(db, (): void => {
			const insertMessage = db.prepare(`
				INSERT INTO messages(session_id, sequence, request_id, role, payload_json, created_at)
				VALUES (?, ?, ?, ?, ?, ?)
			`);
			for (const row of prefixMessageRows) {
				insertMessage.run(
					targetSessionId,
					row.sequence,
					toSqlValue(row.request_id ?? undefined),
					row.role,
					sqlJson(rewrite(parseSqlJson<unknown>(row.payload_json))),
					row.created_at,
				);
			}

			const insertEvent = db.prepare(`
				INSERT INTO session_events(
					event_id, session_id, sequence, channel, request_id, event_name, data_json,
					approval_id, workflow_id, run_id, created_at
				) VALUES (?, ?, ?, 'timeline', ?, ?, ?, ?, ?, ?, ?)
			`);
			for (const row of eventRows) {
				insertEvent.run(
					`event-${randomUUID()}`,
					targetSessionId,
					row.sequence,
					row.request_id,
					row.event_name,
					sqlJson(rewrite(parseSqlJson<unknown>(row.data_json))),
					toSqlValue(row.approval_id === null ? undefined : requireMappedId(idMap, row.approval_id)),
					toSqlValue(row.workflow_id === null ? undefined : requireMappedId(idMap, row.workflow_id)),
					toSqlValue(row.run_id === null ? undefined : requireMappedId(idMap, row.run_id)),
					row.created_at,
				);
			}

			const insertPlan = db.prepare(`
				INSERT INTO plans(plan_id, session_id, request_id, status, metadata_json, markdown, created_at, updated_at)
				VALUES (?, ?, ?, 'forked_snapshot', ?, ?, ?, ?)
			`);
			for (const row of copiedPlans) {
				const planMetadata = rewrite(parseSqlJson<Record<string, unknown>>(row.metadata_json)) as Record<string, unknown>;
				planMetadata.status = "forked_snapshot";
				insertPlan.run(
					requireMappedId(idMap, row.plan_id),
					targetSessionId,
					row.request_id,
					sqlJson(planMetadata),
					row.markdown,
					row.created_at,
					row.updated_at,
				);
			}

			const insertBatch = db.prepare(`
				INSERT INTO file_edit_batches(batch_id, session_id, request_id, tool_call_id, tool_name, payload_json, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)
			`);
			for (const row of copiedBatches) {
				insertBatch.run(
					requireMappedId(idMap, row.batch_id),
					targetSessionId,
					row.request_id,
					requireMappedId(idMap, row.tool_call_id),
					row.tool_name,
					sqlJson(rewrite(parseSqlJson<unknown>(row.payload_json))),
					row.created_at,
				);
			}

			const insertAttachment = db.prepare(`
				INSERT INTO attachments(attachment_id, session_id, kind, metadata_json, storage_path, created_at)
				VALUES (?, ?, ?, ?, ?, ?)
			`);
			for (const row of stagedAttachments) {
				insertAttachment.run(
					row.newId,
					targetSessionId,
					row.kind,
					sqlJson(row.metadata),
					row.newStoragePath,
					row.created_at,
				);
			}

			db.prepare(`
				INSERT INTO session_events(
					event_id, session_id, sequence, channel, request_id, event_name, data_json, created_at
				) VALUES (?, ?, 1, ?, ?, ?, ?, ?)
			`).run(
				`fork-draft-${randomUUID()}`,
				targetSessionId,
				FORK_DRAFT_CHANNEL,
				sourceRequestId,
				FORK_DRAFT_EVENT,
				sqlJson(draft),
				new Date().toISOString(),
			);
		});

		if (stagedAttachments.length > 0) {
			await mkdir(dirname(targetDir), { recursive: true });
			await rename(stagingDir, targetDir);
		} else {
			await rm(stagingDir, { recursive: true, force: true });
		}
		return { metadata, draft };
	} catch (error: unknown) {
		await rm(stagingDir, { recursive: true, force: true }).catch((): void => {});
		await rm(targetDir, { recursive: true, force: true }).catch((): void => {});
		await deleteSession(targetSessionId).catch((): void => {});
		throw error;
	}
}
