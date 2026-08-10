import { createHash, randomUUID } from "node:crypto";
import type { ChatMessage } from "../protocol/types.js";
import { getSessionDatabase } from "../session/session-database.js";
import type { WorkspaceFileRef } from "../workspace/source-context.js";
import {
	CONTEXT_LEDGER_SCHEMA_VERSION,
	type ActiveContextLedger,
	type ContextBlock,
	type ContextBlockKind,
	type ContextBlockStatus,
	type ContextCompressionLevel,
	type ContextCompressionRecord,
	type ContextCompressionSource,
	type ContextCompressionStatus,
	type StructuredContextSummary
} from "./context-types.js";

type ContextBlockRow = Record<string, unknown>;

function parseJsonArray<T>(value: unknown): T[] {
	if (typeof value !== "string") return [];
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) ? parsed as T[] : [];
	} catch {
		return [];
	}
}

function parseSummary(value: unknown): StructuredContextSummary | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed as StructuredContextSummary
			: undefined;
	} catch {
		return undefined;
	}
}

function rowToBlock(row: ContextBlockRow): ContextBlock {
	return {
		schemaVersion: CONTEXT_LEDGER_SCHEMA_VERSION,
		blockId: String(row.block_id),
		sessionId: String(row.session_id),
		requestId: row.request_id === null || row.request_id === undefined ? undefined : String(row.request_id),
		kind: String(row.kind) as ContextBlockKind,
		level: String(row.level) as ContextCompressionLevel,
		status: String(row.status) as ContextBlockStatus,
		tokenEstimate: Number(row.token_estimate),
		sourceFolderId: row.source_folder_id === null || row.source_folder_id === undefined ? undefined : String(row.source_folder_id),
		fileRefs: parseJsonArray<WorkspaceFileRef>(row.file_refs_json),
		protectedReason: row.protected_reason === null || row.protected_reason === undefined ? undefined : String(row.protected_reason),
		coveredBlockIds: parseJsonArray<string>(row.covered_block_ids_json),
		coveredMessageKeys: parseJsonArray<string>(row.covered_message_keys_json),
		content: String(row.content),
		summary: parseSummary(row.summary_json),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at)
	};
}

export function createContextMessageKey(message: ChatMessage, occurrence: number = 0): string {
	const identity: string = JSON.stringify({
		requestId: message.requestId ?? null,
		role: message.role,
		createdAt: message.createdAt ?? null,
		occurrence,
		content: message.requestId === undefined ? message.content : undefined
	});
	return createHash("sha256").update(identity).digest("hex");
}

export function createContextMessageKeys(messages: readonly ChatMessage[]): string[] {
	const occurrences: Map<string, number> = new Map();
	return messages.map((message: ChatMessage): string => {
		const identity: string = JSON.stringify({
			requestId: message.requestId ?? null,
			role: message.role,
			createdAt: message.createdAt ?? null,
			content: message.requestId === undefined ? message.content : undefined
		});
		const occurrence: number = occurrences.get(identity) ?? 0;
		occurrences.set(identity, occurrence + 1);
		return createContextMessageKey(message, occurrence);
	});
}

export function filterMessagesOutsideContextLedger(
	messages: readonly ChatMessage[],
	coveredMessageKeys: ReadonlySet<string>
): ChatMessage[] {
	const keys: string[] = createContextMessageKeys(messages);
	return messages.filter((_message: ChatMessage, index: number): boolean => !coveredMessageKeys.has(keys[index] ?? ""));
}

export function createContextMessageBlock(params: {
	sessionId: string;
	message: ChatMessage;
	occurrence: number;
	tokenEstimate: number;
	fileRefs?: WorkspaceFileRef[] | undefined;
	protectedReason?: string | undefined;
}): ContextBlock {
	const now: string = new Date().toISOString();
	const messageKey: string = createContextMessageKey(params.message, params.occurrence);
	return {
		schemaVersion: CONTEXT_LEDGER_SCHEMA_VERSION,
		blockId: `message:${messageKey}`,
		sessionId: params.sessionId,
		requestId: params.message.requestId,
		kind: params.message.role === "user" ? "user" : params.message.role === "assistant" ? "assistant" : "summary",
		level: "raw",
		status: "active",
		tokenEstimate: Math.max(0, params.tokenEstimate),
		fileRefs: params.fileRefs ?? [],
		protectedReason: params.protectedReason,
		coveredBlockIds: [],
		coveredMessageKeys: [messageKey],
		content: params.message.content,
		createdAt: now,
		updatedAt: now
	};
}

export function createToolContextBlock(params: {
	sessionId: string;
	requestId?: string | undefined;
	toolCallId: string;
	kind?: "tool" | "terminal" | undefined;
	content: string;
	tokenEstimate: number;
	sourceFolderId?: string | undefined;
	fileRefs?: WorkspaceFileRef[] | undefined;
	protectedReason?: string | undefined;
}): ContextBlock {
	const now: string = new Date().toISOString();
	return {
		schemaVersion: CONTEXT_LEDGER_SCHEMA_VERSION,
		blockId: `tool:${params.requestId ?? "session"}:${params.toolCallId}`,
		sessionId: params.sessionId,
		requestId: params.requestId,
		kind: params.kind ?? "tool",
		level: "raw",
		status: "active",
		tokenEstimate: Math.max(0, params.tokenEstimate),
		sourceFolderId: params.sourceFolderId,
		fileRefs: params.fileRefs ?? [],
		protectedReason: params.protectedReason,
		coveredBlockIds: [],
		coveredMessageKeys: [],
		content: params.content,
		createdAt: now,
		updatedAt: now
	};
}

export async function upsertContextBlock(block: ContextBlock): Promise<void> {
	const db = await getSessionDatabase();
	db.prepare(`
		INSERT INTO context_blocks(
			block_id, session_id, request_id, kind, level, status, token_estimate,
			source_folder_id, file_refs_json, protected_reason, covered_block_ids_json,
			covered_message_keys_json, content, summary_json, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(block_id) DO UPDATE SET
			status = excluded.status,
			token_estimate = excluded.token_estimate,
			source_folder_id = excluded.source_folder_id,
			file_refs_json = excluded.file_refs_json,
			protected_reason = excluded.protected_reason,
			covered_block_ids_json = excluded.covered_block_ids_json,
			covered_message_keys_json = excluded.covered_message_keys_json,
			content = excluded.content,
			summary_json = excluded.summary_json,
			updated_at = excluded.updated_at
	`).run(
		block.blockId,
		block.sessionId,
		block.requestId ?? null,
		block.kind,
		block.level,
		block.status,
		block.tokenEstimate,
		block.sourceFolderId ?? null,
		JSON.stringify(block.fileRefs),
		block.protectedReason ?? null,
		JSON.stringify(block.coveredBlockIds),
		JSON.stringify(block.coveredMessageKeys),
		block.content,
		block.summary === undefined ? null : JSON.stringify(block.summary),
		block.createdAt,
		block.updatedAt
	);
}

export async function loadActiveContextLedger(sessionId: string): Promise<ActiveContextLedger> {
	const db = await getSessionDatabase();
	const rows = db.prepare(`
		SELECT * FROM context_blocks
		WHERE session_id = ? AND status = 'active' AND level <> 'raw'
		ORDER BY created_at ASC, block_id ASC
	`).all(sessionId) as ContextBlockRow[];
	const activeSummaries: ContextBlock[] = rows.map(rowToBlock);
	const generationRow = db.prepare(`
		SELECT MAX(generation) AS generation FROM context_compactions WHERE session_id = ? AND status = 'completed'
	`).get(sessionId) as Record<string, unknown> | undefined;
	return {
		generation: Math.max(0, Number(generationRow?.generation ?? 0)),
		activeSummaries,
		coveredMessageKeys: new Set(activeSummaries.flatMap((block: ContextBlock): string[] => block.coveredMessageKeys))
	};
}

export async function listContextBlocks(sessionId: string, includeCompressed: boolean = true): Promise<ContextBlock[]> {
	const db = await getSessionDatabase();
	const rows = db.prepare(`
		SELECT * FROM context_blocks
		WHERE session_id = ? ${includeCompressed ? "" : "AND status = 'active'"}
		ORDER BY created_at ASC, block_id ASC
	`).all(sessionId) as ContextBlockRow[];
	return rows.map(rowToBlock);
}

export async function getContextBlocksByIds(sessionId: string, blockIds: readonly string[]): Promise<ContextBlock[]> {
	if (blockIds.length === 0) return [];
	const db = await getSessionDatabase();
	const placeholders: string = blockIds.map((): string => "?").join(", ");
	const rows = db.prepare(`
		SELECT * FROM context_blocks WHERE session_id = ? AND block_id IN (${placeholders})
	`).all(sessionId, ...blockIds) as ContextBlockRow[];
	const byId: Map<string, ContextBlock> = new Map(rows.map((row: ContextBlockRow): [string, ContextBlock] => {
		const block: ContextBlock = rowToBlock(row);
		return [block.blockId, block];
	}));
	return blockIds.flatMap((blockId: string): ContextBlock[] => {
		const block: ContextBlock | undefined = byId.get(blockId);
		return block === undefined ? [] : [block];
	});
}

export async function searchContextBlocks(sessionId: string, query: string, limit: number = 20): Promise<ContextBlock[]> {
	const normalized: string = query.trim().toLocaleLowerCase();
	if (normalized.length === 0) return [];
	const blocks: ContextBlock[] = await listContextBlocks(sessionId, true);
	return blocks
		.filter((block: ContextBlock): boolean => (
			block.blockId.toLocaleLowerCase().includes(normalized)
			|| block.content.toLocaleLowerCase().includes(normalized)
			|| block.fileRefs.some((ref: WorkspaceFileRef): boolean => `${ref.sourceFolderId}:${ref.relativePath}`.toLocaleLowerCase().includes(normalized))
			|| block.summary?.unresolvedFailures.some((failure): boolean => `${failure.code} ${failure.message}`.toLocaleLowerCase().includes(normalized)) === true
		))
		.slice(0, Math.max(1, Math.min(50, limit)));
}

export async function commitContextCompression(params: {
	sessionId: string;
	requestId?: string | undefined;
	generation: number;
	level: Exclude<ContextCompressionLevel, "raw">;
	source: ContextCompressionSource;
	beforeTokens: number;
	afterTokens: number;
	summary: StructuredContextSummary;
	content: string;
	coveredBlocks: readonly ContextBlock[];
	warning?: string | undefined;
}): Promise<{ record: ContextCompressionRecord; summaryBlock: ContextBlock }> {
	const now: string = new Date().toISOString();
	const compressionId: string = `context-compression:${params.requestId ?? randomUUID()}:${params.generation}`;
	const coveredBlockIds: string[] = [...new Set(params.coveredBlocks.flatMap((block: ContextBlock): string[] => (
		block.level === "raw" ? [block.blockId] : block.coveredBlockIds
	)))];
	const coveredMessageKeys: string[] = [...new Set(params.coveredBlocks.flatMap((block: ContextBlock): string[] => block.coveredMessageKeys))];
	const summaryBlock: ContextBlock = {
		schemaVersion: CONTEXT_LEDGER_SCHEMA_VERSION,
		blockId: `summary:${compressionId}`,
		sessionId: params.sessionId,
		requestId: params.requestId,
		kind: "summary",
		level: params.level,
		status: "active",
		tokenEstimate: Math.max(1, params.afterTokens),
		fileRefs: params.summary.changedFiles,
		coveredBlockIds,
		coveredMessageKeys,
		content: params.content,
		summary: params.summary,
		createdAt: now,
		updatedAt: now
	};
	const record: ContextCompressionRecord = {
		compressionId,
		sessionId: params.sessionId,
		requestId: params.requestId,
		generation: params.generation,
		level: params.level,
		source: params.source,
		status: "completed",
		beforeTokens: Math.max(0, params.beforeTokens),
		afterTokens: Math.max(0, params.afterTokens),
		savedTokens: Math.max(0, params.beforeTokens - params.afterTokens),
		coveredBlockIds,
		summaryBlockId: summaryBlock.blockId,
		warning: params.warning,
		createdAt: now,
		updatedAt: now
	};
	const db = await getSessionDatabase();
	db.exec("BEGIN IMMEDIATE");
	try {
		for (const block of params.coveredBlocks) {
			db.prepare("UPDATE context_blocks SET status = 'compressed', updated_at = ? WHERE session_id = ? AND block_id = ?")
				.run(now, params.sessionId, block.blockId);
		}
		db.prepare(`
			INSERT INTO context_blocks(
				block_id, session_id, request_id, kind, level, status, token_estimate,
				source_folder_id, file_refs_json, protected_reason, covered_block_ids_json,
				covered_message_keys_json, content, summary_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			summaryBlock.blockId, summaryBlock.sessionId, summaryBlock.requestId ?? null,
			summaryBlock.kind, summaryBlock.level, summaryBlock.status, summaryBlock.tokenEstimate,
			null, JSON.stringify(summaryBlock.fileRefs), null, JSON.stringify(summaryBlock.coveredBlockIds),
			JSON.stringify(summaryBlock.coveredMessageKeys), summaryBlock.content, JSON.stringify(summaryBlock.summary), now, now
		);
		db.prepare(`
			INSERT INTO context_compactions(
				compression_id, session_id, request_id, generation, level, source, status,
				before_tokens, after_tokens, saved_tokens, covered_block_ids_json,
				summary_block_id, warning, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			record.compressionId, record.sessionId, record.requestId ?? null, record.generation,
			record.level, record.source, record.status, record.beforeTokens, record.afterTokens,
			record.savedTokens, JSON.stringify(record.coveredBlockIds), record.summaryBlockId ?? null,
			record.warning ?? null, record.createdAt, record.updatedAt
		);
		db.exec("COMMIT");
	} catch (error: unknown) {
		db.exec("ROLLBACK");
		throw error;
	}
	return { record, summaryBlock };
}

export async function countRestorableContextBlocks(sessionId: string): Promise<number> {
	const row = (await getSessionDatabase()).prepare(`
		SELECT COUNT(*) AS count FROM context_blocks WHERE session_id = ? AND level = 'raw' AND status = 'compressed'
	`).get(sessionId) as Record<string, unknown> | undefined;
	return Math.max(0, Number(row?.count ?? 0));
}

export async function clearContextLedger(sessionId: string): Promise<void> {
	const db = await getSessionDatabase();
	db.exec("BEGIN IMMEDIATE");
	try {
		db.prepare("DELETE FROM context_compactions WHERE session_id = ?").run(sessionId);
		db.prepare("DELETE FROM context_blocks WHERE session_id = ?").run(sessionId);
		db.exec("COMMIT");
	} catch (error: unknown) {
		db.exec("ROLLBACK");
		throw error;
	}
}
