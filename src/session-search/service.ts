import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { createSelfInvocation } from "../runtime/self-invocation.js";
import { logger } from "../logger.js";
import {
	readSessionSearchSourceState,
	type SessionTimelineSearchDocument
} from "../session/session-store.js";
import {
	beginSearchGeneration,
	closeSearchCacheDatabase,
	deleteSessionSearchCache,
	pruneSearchCache,
	readActiveGeneration,
	readSearchDocumentsPage,
	type SearchGenerationRecord
} from "./search-cache.js";
import { registerSessionDeletedListener } from "./lifecycle.js";

const HANDLE_IDLE_MS: number = 5 * 60_000;
const INDEXER_IDLE_MS: number = 60_000;
const DEFAULT_PAGE_LIMIT: number = 400;
const MAX_PAGE_LIMIT: number = 500;

type IndexerResponse = {
	id: string;
	type: "started" | "progress" | "completed" | "cancelled" | "error";
	sessionId?: string | undefined;
	generationId?: string | undefined;
	indexedThroughOffset?: number | undefined;
	blockCount?: number | undefined;
	sourceRevision?: number | undefined;
	message?: string | undefined;
};

type PendingBuild = {
	sessionId: string;
	reason: string;
	resolve: () => void;
	reject: (error: Error) => void;
	startedAt: number;
};

type SearchHandle = {
	searchId: string;
	ownerConnectionId: string;
	sessionId: string;
	generationId: string;
	sourceRevision: number;
	lastAccessedAt: number;
};

export type SessionSearchPage = {
	searchId: string;
	sessionId: string;
	generationId: string;
	sourceRevision: number;
	status: "building" | "ready";
	blockCount: number;
	indexedThroughOffset: number;
	documents: SessionTimelineSearchDocument[];
	nextOffset: number | null;
	pending: boolean;
	retryAfterMs?: number | undefined;
};

export class SessionSearchError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

class SessionSearchService {
	private child: ChildProcessWithoutNullStreams | null = null;
	private pendingBuilds = new Map<string, PendingBuild>();
	private buildBySession = new Map<string, Promise<void>>();
	private handles = new Map<string, SearchHandle>();
	private indexerIdleTimer: NodeJS.Timeout | null = null;
	private restartFailures: number = 0;
	private expectedChildExit: boolean = false;
	private closed: boolean = false;

	constructor() {
		registerSessionDeletedListener((sessionId: string): void => {
			void this.removeSession(sessionId).catch((error: unknown): void => {
				logger.warn("session_search", "delete_cleanup_failed", {
					sessionId,
					error: error instanceof Error ? error.message : String(error)
				});
			});
		});
		const timer = setInterval((): void => this.expireHandles(), 30_000);
		timer.unref();
	}

	private ensureChild(): ChildProcessWithoutNullStreams {
		if (this.child !== null && this.child.exitCode === null) return this.child;
		if (this.closed) throw new Error("Session search service is closed.");
		const invocation = createSelfInvocation(["internal", "session-search-indexer"]);
		const child = spawn(invocation.command, invocation.args, {
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			env: {
				...process.env,
				DAEDALUS_LOG_CONSOLE: "0"
			}
		});
		this.child = child;
		this.expectedChildExit = false;
		const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
		lines.on("line", (line: string): void => this.handleIndexerLine(line));
		child.stderr.on("data", (chunk: Buffer): void => {
			const message: string = chunk.toString("utf8").trim();
			if (message.length > 0) logger.warn("session_search", "indexer_stderr", { message: message.slice(0, 2000) });
		});
		child.once("exit", (code, signal): void => {
			if (this.child === child) this.child = null;
			const expected: boolean = this.expectedChildExit;
			this.expectedChildExit = false;
			const error = new Error(`Session search indexer exited (${code ?? signal ?? "unknown"}).`);
			for (const pending of this.pendingBuilds.values()) pending.reject(error);
			this.pendingBuilds.clear();
			if (!expected) {
				this.restartFailures += 1;
				logger.warn("session_search", "indexer_exited", { code, signal, restartFailures: this.restartFailures });
			}
		});
		return child;
	}

	private handleIndexerLine(line: string): void {
		let response: IndexerResponse;
		try {
			response = JSON.parse(line) as IndexerResponse;
		} catch {
			logger.warn("session_search", "indexer_invalid_output", { line: line.slice(0, 1000) });
			return;
		}
		if (response.type === "progress") {
			if (response.message === "slow_batch") {
				logger.warn("session_search", "index_batch_slow", {
					sessionId: response.sessionId,
					generationId: response.generationId,
					indexedThroughOffset: response.indexedThroughOffset
				});
			}
			return;
		}
		if (response.type === "started") return;
		const pending: PendingBuild | undefined = this.pendingBuilds.get(response.id);
		if (pending === undefined) return;
		this.pendingBuilds.delete(response.id);
		if (response.type === "error") {
			pending.reject(new Error(response.message ?? "Session search indexing failed."));
			return;
		}
		logger.info("session_search", "index_completed", {
			sessionId: pending.sessionId,
			generationId: response.generationId,
			durationMs: Date.now() - pending.startedAt,
			blockCount: response.blockCount,
			cancelled: response.type === "cancelled",
			sourceAdvanced: response.message === "source_advanced"
		});
		pending.resolve();
		this.scheduleIndexerIdleShutdown();
		if (response.message === "source_advanced") {
			const retry = setTimeout((): void => {
				this.scheduleBuild(pending.sessionId, "source_advanced");
			}, 0);
			retry.unref();
		}
	}

	private scheduleIndexerIdleShutdown(): void {
		if (this.indexerIdleTimer !== null) clearTimeout(this.indexerIdleTimer);
		this.indexerIdleTimer = setTimeout((): void => {
			if (this.pendingBuilds.size > 0 || this.handles.size > 0) return;
			this.expectedChildExit = true;
			this.child?.stdin.write(`${JSON.stringify({ id: "shutdown", type: "shutdown" })}\n`);
		}, INDEXER_IDLE_MS);
		this.indexerIdleTimer.unref();
	}

	private expireHandles(): void {
		const threshold: number = Date.now() - HANDLE_IDLE_MS;
		let removed: boolean = false;
		for (const [searchId, handle] of this.handles) {
			if (handle.lastAccessedAt < threshold) {
				this.handles.delete(searchId);
				removed = true;
			}
		}
		if (removed && this.handles.size === 0 && this.pendingBuilds.size === 0) this.scheduleIndexerIdleShutdown();
	}

	private preemptBackgroundBuilds(): void {
		for (const pending of this.pendingBuilds.values()) {
			if (pending.reason !== "idle_prebuild") continue;
			this.child?.stdin.write(`${JSON.stringify({
				id: `cancel-${Date.now().toString(36)}`,
				type: "cancel",
				sessionId: pending.sessionId
			})}\n`);
		}
	}

	pauseBackgroundBuilds(): void {
		this.preemptBackgroundBuilds();
	}

	async ensureGeneration(sessionId: string, reason: string): Promise<SearchGenerationRecord> {
		const source = await readSessionSearchSourceState(sessionId);
		let generation = await readActiveGeneration(sessionId);
		if (generation === null || generation.rebuildEpoch !== source.rebuildEpoch) {
			generation = await beginSearchGeneration({
				sessionId,
				sourceRevision: source.revision,
				rebuildEpoch: source.rebuildEpoch,
				forceNew: true
			});
		}
		if (generation.status !== "ready" || generation.sourceRevision !== source.revision) {
			this.scheduleBuild(sessionId, reason);
		}
		return generation;
	}

	scheduleBuild(sessionId: string, reason: string): Promise<void> {
		if (this.closed) return Promise.resolve();
		const existing: Promise<void> | undefined = this.buildBySession.get(sessionId);
		if (existing !== undefined) return existing;
		const operation = (async (): Promise<void> => {
			const source = await readSessionSearchSourceState(sessionId);
			let generation = await readActiveGeneration(sessionId);
			if (generation === null || generation.rebuildEpoch !== source.rebuildEpoch) {
				generation = await beginSearchGeneration({
					sessionId,
					sourceRevision: source.revision,
					rebuildEpoch: source.rebuildEpoch,
					forceNew: true
				});
			}
			if (generation.status === "ready" && generation.sourceRevision === source.revision) return;
			const requestId: string = `search-build-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
			const child = this.ensureChild();
			await new Promise<void>((resolve, reject): void => {
				this.pendingBuilds.set(requestId, { sessionId, reason, resolve, reject, startedAt: Date.now() });
				child.stdin.write(`${JSON.stringify({
					id: requestId,
					type: "build",
					sessionId,
					generationId: generation!.generationId,
					reason
				})}\n`);
			});
			this.restartFailures = 0;
			await pruneSearchCache(this.protectedGenerationIds());
		})().catch((error: unknown): void => {
			if (this.closed) return;
			const delayMs: number = this.restartFailures <= 1 ? 5_000 : 30_000;
			logger.warn("session_search", "index_failed", {
				sessionId,
				reason,
				delayMs,
				error: error instanceof Error ? error.message : String(error)
			});
			const retry = setTimeout((): void => { this.scheduleBuild(sessionId, "retry"); }, delayMs);
			retry.unref();
		}).finally((): void => {
			if (this.buildBySession.get(sessionId) === operation) this.buildBySession.delete(sessionId);
		});
		this.buildBySession.set(sessionId, operation);
		return operation;
	}

	private protectedGenerationIds(): Set<string> {
		return new Set([...this.handles.values()].map((handle): string => handle.generationId));
	}

	async start(ownerConnectionId: string, sessionId: string): Promise<SessionSearchPage> {
		this.preemptBackgroundBuilds();
		const generation = await this.ensureGeneration(sessionId, "user_search");
		const searchId: string = `session-search-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
		this.handles.set(searchId, {
			searchId,
			ownerConnectionId,
			sessionId,
			generationId: generation.generationId,
			sourceRevision: generation.sourceRevision,
			lastAccessedAt: Date.now()
		});
		return this.page(ownerConnectionId, searchId, 0, DEFAULT_PAGE_LIMIT);
	}

	async compatibilityPage(
		ownerConnectionId: string,
		sessionId: string,
		afterOffset: number,
		limit: number
	): Promise<SessionSearchPage> {
		await this.ensureGeneration(sessionId, "compatibility_search");
		await this.scheduleBuild(sessionId, "compatibility_search");
		const started: SessionSearchPage = await this.start(ownerConnectionId, sessionId);
		try {
			return await this.page(ownerConnectionId, started.searchId, afterOffset, limit);
		} finally {
			this.cancel(ownerConnectionId, started.searchId);
		}
	}

	async page(ownerConnectionId: string, searchId: string, afterOffset: number = 0, limit: number = DEFAULT_PAGE_LIMIT): Promise<SessionSearchPage> {
		const handle: SearchHandle | undefined = this.handles.get(searchId);
		if (handle === undefined || handle.ownerConnectionId !== ownerConnectionId) {
			throw new SessionSearchError("session_search_not_found", "Session search handle was cancelled or expired.");
		}
		handle.lastAccessedAt = Date.now();
		const generation = await readActiveGeneration(handle.sessionId);
		if (generation === null || generation.generationId !== handle.generationId) {
			throw new SessionSearchError(
				"session_search_generation_changed",
				"The session timeline changed while the search index was being read. Restart historical loading."
			);
		}
		const safeOffset: number = Math.max(0, Math.floor(afterOffset));
		const safeLimit: number = Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.floor(limit)));
		const availableEnd: number = Math.min(generation.indexedThroughOffset, safeOffset + safeLimit);
		const pending: boolean = generation.status === "building" && safeOffset >= generation.indexedThroughOffset;
		const documents: SessionTimelineSearchDocument[] = availableEnd > safeOffset
			? await readSearchDocumentsPage(generation.generationId, safeOffset, availableEnd - safeOffset)
			: [];
		const nextOffset: number | null = availableEnd < generation.indexedThroughOffset
			? availableEnd
			: generation.status === "building"
				? availableEnd
				: availableEnd < generation.blockCount ? availableEnd : null;
		return {
			searchId,
			sessionId: handle.sessionId,
			generationId: generation.generationId,
			sourceRevision: generation.sourceRevision,
			status: generation.status,
			blockCount: generation.blockCount,
			indexedThroughOffset: generation.indexedThroughOffset,
			documents,
			nextOffset,
			pending,
			...(pending ? { retryAfterMs: 150 } : {})
		};
	}

	cancel(ownerConnectionId: string, searchId: string): boolean {
		const handle: SearchHandle | undefined = this.handles.get(searchId);
		if (handle === undefined || handle.ownerConnectionId !== ownerConnectionId) return false;
		this.handles.delete(searchId);
		if (this.handles.size === 0 && this.pendingBuilds.size === 0) this.scheduleIndexerIdleShutdown();
		return true;
	}

	releaseOwner(ownerConnectionId: string): void {
		for (const [searchId, handle] of this.handles) {
			if (handle.ownerConnectionId === ownerConnectionId) this.handles.delete(searchId);
		}
		if (this.handles.size === 0 && this.pendingBuilds.size === 0) this.scheduleIndexerIdleShutdown();
	}

	async removeSession(sessionId: string): Promise<void> {
		for (const [searchId, handle] of this.handles) {
			if (handle.sessionId === sessionId) this.handles.delete(searchId);
		}
		this.child?.stdin.write(`${JSON.stringify({ id: `cancel-${Date.now()}`, type: "cancel", sessionId })}\n`);
		await deleteSessionSearchCache(sessionId);
	}

	async close(): Promise<void> {
		this.closed = true;
		if (this.indexerIdleTimer !== null) clearTimeout(this.indexerIdleTimer);
		const child = this.child;
		if (child !== null && child.exitCode === null) {
			this.expectedChildExit = true;
			for (const pending of this.pendingBuilds.values()) {
				child.stdin.write(`${JSON.stringify({ id: `cancel-${Date.now()}`, type: "cancel", sessionId: pending.sessionId })}\n`);
			}
			child.stdin.write(`${JSON.stringify({ id: "shutdown", type: "shutdown" })}\n`);
			await new Promise<void>((resolve): void => {
				const timeout = setTimeout((): void => {
					if (child.exitCode === null) child.kill();
					resolve();
				}, 3_000);
				child.once("exit", (): void => {
					clearTimeout(timeout);
					resolve();
				});
			});
		}
		this.handles.clear();
		await closeSearchCacheDatabase();
	}
}

export const sessionSearchService = new SessionSearchService();
