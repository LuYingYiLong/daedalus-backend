import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getSessionSearchDatabasePath } from "../app-paths.js";
import type {
	SessionSearchProjectionBlock,
	SessionTimelineSearchDocument
} from "../session/session-store.js";

// Bump whenever projection semantics change so stale generations cannot keep
// returning matches for content that is no longer searchable.
const SEARCH_CACHE_SCHEMA_VERSION: number = 3;
const SEARCH_CACHE_LIMIT_BYTES: number = 1024 * 1024 * 1024;

export type SearchGenerationRecord = {
	generationId: string;
	sessionId: string;
	sourceRevision: number;
	rebuildEpoch: number;
	status: "building" | "ready";
	blockCount: number;
	indexedThroughOffset: number;
	lastAccessedAt: string;
};

let databasePromise: Promise<DatabaseSync> | null = null;
let testDatabasePath: string | null = null;

function resolveDatabasePath(): string {
	return testDatabasePath ?? getSessionSearchDatabasePath();
}

function createSchema(db: DatabaseSync): void {
	db.exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA foreign_keys = ON;
		PRAGMA busy_timeout = 5000;
		PRAGMA synchronous = NORMAL;
		CREATE TABLE IF NOT EXISTS search_generations (
			generation_id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			source_revision INTEGER NOT NULL,
			rebuild_epoch INTEGER NOT NULL,
			status TEXT NOT NULL,
			block_count INTEGER NOT NULL DEFAULT 0,
			indexed_through_offset INTEGER NOT NULL DEFAULT 0,
			active INTEGER NOT NULL DEFAULT 1,
			archived INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			last_accessed_at TEXT NOT NULL
		);
		CREATE UNIQUE INDEX IF NOT EXISTS idx_search_generations_active_session
			ON search_generations(session_id) WHERE active = 1;
		CREATE INDEX IF NOT EXISTS idx_search_generations_lru
			ON search_generations(active, last_accessed_at);
		CREATE TABLE IF NOT EXISTS search_blocks (
			generation_id TEXT NOT NULL REFERENCES search_generations(generation_id) ON DELETE CASCADE,
			block_offset INTEGER NOT NULL,
			block_key TEXT NOT NULL,
			request_id TEXT NOT NULL,
			role TEXT NOT NULL,
			PRIMARY KEY(generation_id, block_offset)
		);
		CREATE TABLE IF NOT EXISTS search_documents (
			generation_id TEXT NOT NULL REFERENCES search_generations(generation_id) ON DELETE CASCADE,
			block_offset INTEGER NOT NULL,
			request_id TEXT NOT NULL,
			role TEXT NOT NULL,
			segments_json TEXT NOT NULL,
			PRIMARY KEY(generation_id, block_offset)
		);
		CREATE INDEX IF NOT EXISTS idx_search_documents_page
			ON search_documents(generation_id, block_offset);
		PRAGMA user_version = ${SEARCH_CACHE_SCHEMA_VERSION};
	`);
}

async function removeCacheFiles(path: string): Promise<void> {
	await Promise.all([
		rm(path, { force: true }),
		rm(`${path}-wal`, { force: true }),
		rm(`${path}-shm`, { force: true })
	]);
}

async function openDatabase(): Promise<DatabaseSync> {
	const sqlite = await import("node:sqlite");
	const path: string = resolveDatabasePath();
	await mkdir(dirname(path), { recursive: true });
	let db = new sqlite.DatabaseSync(path, { timeout: 5000 });
	const version = Number((db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined)?.user_version ?? 0);
	if (version !== 0 && version !== SEARCH_CACHE_SCHEMA_VERSION) {
		db.close();
		await removeCacheFiles(path);
		db = new sqlite.DatabaseSync(path, { timeout: 5000 });
	}
	try {
		createSchema(db);
		const integrity = db.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
		if (String(integrity?.quick_check ?? "") !== "ok") {
			throw new Error("Session search cache integrity check failed.");
		}
		return db;
	} catch (error: unknown) {
		db.close();
		await removeCacheFiles(path);
		const rebuilt = new sqlite.DatabaseSync(path, { timeout: 5000 });
		createSchema(rebuilt);
		return rebuilt;
	}
}

export async function getSearchCacheDatabase(): Promise<DatabaseSync> {
	databasePromise ??= openDatabase();
	return databasePromise;
}

function rowToGeneration(row: Record<string, unknown>): SearchGenerationRecord {
	return {
		generationId: String(row.generation_id),
		sessionId: String(row.session_id),
		sourceRevision: Number(row.source_revision),
		rebuildEpoch: Number(row.rebuild_epoch),
		status: row.status === "ready" ? "ready" : "building",
		blockCount: Number(row.block_count),
		indexedThroughOffset: Number(row.indexed_through_offset),
		lastAccessedAt: String(row.last_accessed_at)
	};
}

export async function readActiveGeneration(sessionId: string): Promise<SearchGenerationRecord | null> {
	const db: DatabaseSync = await getSearchCacheDatabase();
	const row = db.prepare(`
		SELECT * FROM search_generations WHERE session_id = ? AND active = 1
	`).get(sessionId) as Record<string, unknown> | undefined;
	return row === undefined ? null : rowToGeneration(row);
}

export async function beginSearchGeneration(params: {
	sessionId: string;
	sourceRevision: number;
	rebuildEpoch: number;
	forceNew?: boolean | undefined;
}): Promise<SearchGenerationRecord> {
	const db: DatabaseSync = await getSearchCacheDatabase();
	const existing: SearchGenerationRecord | null = await readActiveGeneration(params.sessionId);
	if (existing !== null && existing.rebuildEpoch === params.rebuildEpoch && params.forceNew !== true) {
		return existing;
	}
	const now: string = new Date().toISOString();
	const generationId: string = `search-gen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	db.exec("BEGIN IMMEDIATE");
	try {
		db.prepare("UPDATE search_generations SET active = 0 WHERE session_id = ? AND active = 1").run(params.sessionId);
		db.prepare(`
			INSERT INTO search_generations(
				generation_id, session_id, source_revision, rebuild_epoch, status,
				block_count, indexed_through_offset, active, created_at, updated_at, last_accessed_at
			) VALUES (?, ?, ?, ?, 'building', 0, 0, 1, ?, ?, ?)
		`).run(generationId, params.sessionId, params.sourceRevision, params.rebuildEpoch, now, now, now);
		db.exec("COMMIT");
	} catch (error: unknown) {
		db.exec("ROLLBACK");
		throw error;
	}
	return (await readActiveGeneration(params.sessionId))!;
}

export async function markGenerationBuilding(generationId: string, sourceRevision: number, blockCount: number): Promise<void> {
	const db: DatabaseSync = await getSearchCacheDatabase();
	db.prepare(`
		UPDATE search_generations
		SET source_revision = ?, status = 'building', block_count = ?, updated_at = ?
		WHERE generation_id = ?
	`).run(sourceRevision, blockCount, new Date().toISOString(), generationId);
}

export async function readGenerationBlockKeys(generationId: string): Promise<string[]> {
	const db: DatabaseSync = await getSearchCacheDatabase();
	return (db.prepare(`
		SELECT block_key FROM search_blocks WHERE generation_id = ? ORDER BY block_offset
	`).all(generationId) as Record<string, unknown>[]).map((row): string => String(row.block_key));
}

export async function truncateGenerationFrom(generationId: string, blockOffset: number): Promise<void> {
	const db: DatabaseSync = await getSearchCacheDatabase();
	db.exec("BEGIN IMMEDIATE");
	try {
		db.prepare("DELETE FROM search_documents WHERE generation_id = ? AND block_offset >= ?").run(generationId, blockOffset);
		db.prepare("DELETE FROM search_blocks WHERE generation_id = ? AND block_offset >= ?").run(generationId, blockOffset);
		db.prepare(`
			UPDATE search_generations SET indexed_through_offset = ?, updated_at = ? WHERE generation_id = ?
		`).run(blockOffset, new Date().toISOString(), generationId);
		db.exec("COMMIT");
	} catch (error: unknown) {
		db.exec("ROLLBACK");
		throw error;
	}
}

export async function appendProjectionBatch(generationId: string, blocks: readonly SessionSearchProjectionBlock[]): Promise<void> {
	if (blocks.length === 0) return;
	const db: DatabaseSync = await getSearchCacheDatabase();
	const insertBlock = db.prepare(`
		INSERT OR REPLACE INTO search_blocks(generation_id, block_offset, block_key, request_id, role)
		VALUES (?, ?, ?, ?, ?)
	`);
	const insertDocument = db.prepare(`
		INSERT OR REPLACE INTO search_documents(generation_id, block_offset, request_id, role, segments_json)
		VALUES (?, ?, ?, ?, ?)
	`);
	db.exec("BEGIN IMMEDIATE");
	try {
		for (const block of blocks) {
			insertBlock.run(generationId, block.blockOffset, block.blockKey, block.requestId, block.role);
			if (block.document !== null) {
				insertDocument.run(
					generationId,
					block.blockOffset,
					block.requestId,
					block.role,
					JSON.stringify(block.document.markdownSegments)
				);
			}
		}
		const indexedThroughOffset: number = blocks[blocks.length - 1]!.blockOffset + 1;
		db.prepare(`
			UPDATE search_generations SET indexed_through_offset = ?, updated_at = ? WHERE generation_id = ?
		`).run(indexedThroughOffset, new Date().toISOString(), generationId);
		db.exec("COMMIT");
	} catch (error: unknown) {
		db.exec("ROLLBACK");
		throw error;
	}
}

export async function completeGeneration(generationId: string, sourceRevision: number, blockCount: number): Promise<void> {
	const db: DatabaseSync = await getSearchCacheDatabase();
	const now: string = new Date().toISOString();
	db.prepare(`
		UPDATE search_generations
		SET source_revision = ?, status = 'ready', block_count = ?, indexed_through_offset = ?, updated_at = ?
		WHERE generation_id = ?
	`).run(sourceRevision, blockCount, blockCount, now, generationId);
}

export async function readSearchDocumentsPage(
	generationId: string,
	afterOffset: number,
	limit: number
): Promise<SessionTimelineSearchDocument[]> {
	const db: DatabaseSync = await getSearchCacheDatabase();
	const endOffset: number = afterOffset + limit;
	const rows = db.prepare(`
		SELECT block_offset, request_id, role, segments_json
		FROM search_documents
		WHERE generation_id = ? AND block_offset >= ? AND block_offset < ?
		ORDER BY block_offset
	`).all(generationId, afterOffset, endOffset) as Record<string, unknown>[];
	db.prepare("UPDATE search_generations SET last_accessed_at = ? WHERE generation_id = ?")
		.run(new Date().toISOString(), generationId);
	return rows.map((row): SessionTimelineSearchDocument => ({
		blockOffset: Number(row.block_offset),
		requestId: String(row.request_id),
		role: row.role === "user" ? "user" : "assistant",
		markdownSegments: JSON.parse(String(row.segments_json)) as string[]
	}));
}

export async function deleteSessionSearchCache(sessionId: string): Promise<void> {
	(await getSearchCacheDatabase()).prepare("DELETE FROM search_generations WHERE session_id = ?").run(sessionId);
}

export async function deleteOrphanedSessionSearchCaches(validSessionIds: ReadonlySet<string>): Promise<void> {
	const db: DatabaseSync = await getSearchCacheDatabase();
	const rows = db.prepare("SELECT DISTINCT session_id FROM search_generations").all() as Record<string, unknown>[];
	for (const row of rows) {
		const sessionId: string = String(row.session_id);
		if (!validSessionIds.has(sessionId)) {
			db.prepare("DELETE FROM search_generations WHERE session_id = ?").run(sessionId);
		}
	}
}

export async function setArchivedSessionSearchCaches(archivedSessionIds: ReadonlySet<string>): Promise<void> {
	const db: DatabaseSync = await getSearchCacheDatabase();
	db.prepare("UPDATE search_generations SET archived = 0 WHERE archived <> 0").run();
	const ids: string[] = [...archivedSessionIds];
	if (ids.length === 0) return;
	const placeholders: string = ids.map((): string => "?").join(",");
	db.prepare(`UPDATE search_generations SET archived = 1 WHERE session_id IN (${placeholders})`).run(...ids);
}

export async function pruneSearchCache(protectedGenerationIds: ReadonlySet<string>): Promise<void> {
	const db: DatabaseSync = await getSearchCacheDatabase();
	const pageCount = Number((db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count);
	const freePages = Number((db.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count);
	const pageSize = Number((db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size);
	if ((pageCount - freePages) * pageSize <= SEARCH_CACHE_LIMIT_BYTES) return;
	const rows = db.prepare(`
		SELECT generation_id FROM search_generations ORDER BY active ASC, archived DESC, last_accessed_at ASC
	`).all() as Record<string, unknown>[];
	for (const row of rows) {
		const generationId: string = String(row.generation_id);
		if (protectedGenerationIds.has(generationId)) continue;
		db.prepare("DELETE FROM search_generations WHERE generation_id = ?").run(generationId);
		const nextPageCount = Number((db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count);
		const nextFreePages = Number((db.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count);
		if ((nextPageCount - nextFreePages) * pageSize <= SEARCH_CACHE_LIMIT_BYTES) break;
	}
}

export async function isSearchCacheAtCapacity(): Promise<boolean> {
	const db: DatabaseSync = await getSearchCacheDatabase();
	const pageCount = Number((db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count);
	const freePages = Number((db.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count);
	const pageSize = Number((db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size);
	return (pageCount - freePages) * pageSize >= SEARCH_CACHE_LIMIT_BYTES;
}

export async function closeSearchCacheDatabase(): Promise<void> {
	if (databasePromise !== null) {
		const db: DatabaseSync = await databasePromise;
		db.close();
		databasePromise = null;
	}
}

export async function resetSearchCacheDatabaseForTests(databasePath?: string): Promise<void> {
	await closeSearchCacheDatabase();
	testDatabasePath = databasePath ?? null;
}
