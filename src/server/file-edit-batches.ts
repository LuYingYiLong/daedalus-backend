import type { FileEditBatchDraft, FileEditSnapshot } from "../tools/file-edit-snapshots.js";
import { logger } from "../logger.js";
import { getSessionDatabase, parseSqlJson, sqlJson } from "../session/session-database.js";
import { enqueueGoalFileEditDraft } from "./goal-checkpoints.js";

export type FileEditSummaryItem = {
	path: string;
	absolutePath: string;
	workspaceRoot: string;
	additions: number;
	deletions: number;
	existedBefore: boolean;
	existsAfter: boolean;
	beforeSha256?: string | undefined;
	afterSha256?: string | undefined;
	undoable: boolean;
	unavailableReason?: string | undefined;
};

export type FileEditBatchSummary = {
	batchId: string;
	workspaceId: string;
	workspaceRoot: string;
	editedFileCount: number;
	additions: number;
	deletions: number;
	undoable: boolean;
	editedFiles: FileEditSummaryItem[];
};

export type PersistedFileEditBatch = {
	schemaVersion: 1;
	batchId: string;
	requestId: string;
	toolCallId: string;
	toolName: string;
	workspaceId: string;
	workspaceRoot: string;
	createdAt: string;
	edits: FileEditSnapshot[];
};

const BATCH_ID_PATTERN: RegExp = /^edit-[a-z0-9-]+$/;
const inMemoryBatches: Map<string, PersistedFileEditBatch> = new Map();
let batchWriteQueue: Promise<void> = Promise.resolve();

function createBatchId(): string {
	return `edit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function getBatchCacheKey(sessionId: string, batchId: string): string {
	return `${sessionId}\n${batchId}`;
}

function summarizeBatch(batch: PersistedFileEditBatch): FileEditBatchSummary {
	const editedFiles: FileEditSummaryItem[] = batch.edits.map((edit: FileEditSnapshot): FileEditSummaryItem => ({
		path: edit.path,
		absolutePath: edit.absolutePath,
		workspaceRoot: edit.workspaceRoot,
		additions: edit.additions,
		deletions: edit.deletions,
		existedBefore: edit.existedBefore,
		existsAfter: edit.existsAfter,
		beforeSha256: edit.beforeSha256,
		afterSha256: edit.afterSha256,
		undoable: edit.undoable,
		unavailableReason: edit.unavailableReason
	}));

	return {
		batchId: batch.batchId,
		workspaceId: batch.workspaceId,
		workspaceRoot: batch.workspaceRoot,
		editedFileCount: editedFiles.length,
		additions: editedFiles.reduce((sum: number, edit: FileEditSummaryItem): number => sum + edit.additions, 0),
		deletions: editedFiles.reduce((sum: number, edit: FileEditSummaryItem): number => sum + edit.deletions, 0),
		undoable: editedFiles.length > 0 && editedFiles.every((edit: FileEditSummaryItem): boolean => edit.undoable),
		editedFiles
	};
}

function enqueueBatchWrite(sessionId: string, batch: PersistedFileEditBatch): void {
	const persistedBatch: PersistedFileEditBatch = {
		...batch,
		edits: batch.edits.map((edit: FileEditSnapshot): FileEditSnapshot => {
			const { beforeBase64: _beforeBase64, afterBase64: _afterBase64, ...persistedEdit } = edit;
			return persistedEdit;
		})
	};
	batchWriteQueue = batchWriteQueue.then(async (): Promise<void> => {
		const db = await getSessionDatabase();
		db.prepare(`
			INSERT OR REPLACE INTO file_edit_batches(
				batch_id, session_id, request_id, tool_call_id, tool_name, payload_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)
		`).run(
			batch.batchId,
			sessionId,
			batch.requestId,
			batch.toolCallId,
			batch.toolName,
			sqlJson(persistedBatch),
			batch.createdAt
		);
	}, async (): Promise<void> => {
		const db = await getSessionDatabase();
		db.prepare(`
			INSERT OR REPLACE INTO file_edit_batches(
				batch_id, session_id, request_id, tool_call_id, tool_name, payload_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)
		`).run(
			batch.batchId,
			sessionId,
			batch.requestId,
			batch.toolCallId,
			batch.toolName,
			sqlJson(persistedBatch),
			batch.createdAt
		);
	});

	batchWriteQueue.catch((error: unknown): void => {
		logger.error("file_edit", "batch_persist_failed", error, {
			sessionId,
			batchId: batch.batchId,
			workspaceId: batch.workspaceId,
			editedFileCount: batch.edits.length
		});
	});
}

export function persistFileEditBatch(
	sessionId: string | undefined,
	requestId: string,
	toolCallId: string,
	toolName: string,
	draft: FileEditBatchDraft | undefined
): FileEditBatchSummary | undefined {
	if (sessionId === undefined || draft === undefined || draft.edits.length === 0) {
		return undefined;
	}

	const batch: PersistedFileEditBatch = {
		schemaVersion: 1,
		batchId: createBatchId(),
		requestId,
		toolCallId,
		toolName,
		workspaceId: draft.workspaceId,
		workspaceRoot: draft.workspaceRoot,
		createdAt: new Date().toISOString(),
		edits: draft.edits
	};
	const publicBatch: PersistedFileEditBatch = {
		...batch,
		edits: batch.edits.map((edit: FileEditSnapshot): FileEditSnapshot => {
			const { beforeBase64: _beforeBase64, afterBase64: _afterBase64, ...publicEdit } = edit;
			return publicEdit;
		})
	};
	inMemoryBatches.set(getBatchCacheKey(sessionId, batch.batchId), publicBatch);
	enqueueGoalFileEditDraft(requestId, draft);
	enqueueBatchWrite(sessionId, batch);
	return summarizeBatch(batch);
}

function isPersistedFileEditBatch(value: unknown): value is PersistedFileEditBatch {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}

	const record: Partial<PersistedFileEditBatch> = value as Partial<PersistedFileEditBatch>;
	return record.schemaVersion === 1
		&& typeof record.batchId === "string"
		&& typeof record.requestId === "string"
		&& typeof record.toolCallId === "string"
		&& typeof record.toolName === "string"
		&& typeof record.workspaceId === "string"
		&& typeof record.workspaceRoot === "string"
		&& typeof record.createdAt === "string"
		&& Array.isArray(record.edits);
}

export async function readFileEditBatch(sessionId: string, batchId: string): Promise<PersistedFileEditBatch> {
	if (!BATCH_ID_PATTERN.test(batchId)) {
		throw new Error(`Invalid file edit batch id: ${batchId}`);
	}

	const cacheKey: string = getBatchCacheKey(sessionId, batchId);
	const cached: PersistedFileEditBatch | undefined = inMemoryBatches.get(cacheKey);
	if (cached !== undefined) {
		return cached;
	}

	const row = (await getSessionDatabase()).prepare(`
		SELECT payload_json FROM file_edit_batches WHERE session_id = ? AND batch_id = ?
	`).get(sessionId, batchId) as Record<string, unknown> | undefined;
	if (row === undefined) {
		throw new Error(`File edit batch not found: ${batchId}`);
	}
	const parsed: unknown = parseSqlJson<unknown>(row.payload_json);
	if (!isPersistedFileEditBatch(parsed) || parsed.batchId !== batchId) {
		throw new Error(`Invalid file edit batch: ${batchId}`);
	}

	inMemoryBatches.set(cacheKey, parsed);
	return parsed;
}

export function createFileEditBatchResponse(batch: PersistedFileEditBatch): Record<string, unknown> {
	return {
		fileEditBatch: {
			...summarizeBatch(batch),
			edits: batch.edits
		}
	};
}
