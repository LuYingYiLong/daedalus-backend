import { logger } from "../logger.js";
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { listArchivedSessions, listSessions, type SessionMetadata } from "../session/session-store.js";
import { hasActiveSessionRuns } from "../server/client-connections.js";
import { sessionSearchService } from "./service.js";
import { deleteOrphanedSessionSearchCaches, isSearchCacheAtCapacity, setArchivedSessionSearchCaches } from "./search-cache.js";

const START_DELAY_MS: number = 10_000;
const IDLE_REQUIRED_MS: number = 5_000;

let stopped: boolean = true;
let startupTimer: NodeJS.Timeout | null = null;
let eventLoopHistogram: IntervalHistogram | null = null;
let eventLoopTimer: NodeJS.Timeout | null = null;

async function waitForIdle(): Promise<boolean> {
	let idleSince: number | null = null;
	while (!stopped) {
		if (hasActiveSessionRuns()) {
			idleSince = null;
		} else {
			idleSince ??= Date.now();
			if (Date.now() - idleSince >= IDLE_REQUIRED_MS) return true;
		}
		await new Promise<void>((resolve): void => {
			const timer = setTimeout(resolve, 500);
			timer.unref();
		});
	}
	return false;
}

async function runPrebuild(): Promise<void> {
	try {
		const activeSessions: SessionMetadata[] = await listSessions();
		const archivedSessions: SessionMetadata[] = await listArchivedSessions();
		const sessions: SessionMetadata[] = [
			...activeSessions,
			...archivedSessions
		].sort((left, right): number => right.updatedAt.localeCompare(left.updatedAt));
		await deleteOrphanedSessionSearchCaches(new Set(sessions.map((session): string => session.id)));
		await setArchivedSessionSearchCaches(new Set(archivedSessions.map((session): string => session.id)));
		for (const session of sessions) {
			if (stopped || !await waitForIdle()) return;
			if (await isSearchCacheAtCapacity()) {
				logger.info("session_search", "prebuild_capacity_reached", { remainingSessions: sessions.length });
				return;
			}
			await sessionSearchService.scheduleBuild(session.id, "idle_prebuild");
		}
	} catch (error: unknown) {
		logger.warn("session_search", "prebuild_failed", {
			error: error instanceof Error ? error.message : String(error)
		});
	}
}

export function startSessionSearchPrebuildScheduler(): void {
	if (!stopped) return;
	stopped = false;
	startupTimer = setTimeout((): void => { void runPrebuild(); }, START_DELAY_MS);
	startupTimer.unref();
	eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
	eventLoopHistogram.enable();
	eventLoopTimer = setInterval((): void => {
		if (eventLoopHistogram === null) return;
		const maxDelayMs: number = eventLoopHistogram.max / 1_000_000;
		if (maxDelayMs > 50) {
			logger.warn("session_search", "main_event_loop_delay", { maxDelayMs: Math.round(maxDelayMs) });
		}
		eventLoopHistogram.reset();
	}, 5_000);
	eventLoopTimer.unref();
}

export function stopSessionSearchPrebuildScheduler(): void {
	stopped = true;
	if (startupTimer !== null) clearTimeout(startupTimer);
	if (eventLoopTimer !== null) clearInterval(eventLoopTimer);
	eventLoopHistogram?.disable();
	startupTimer = null;
	eventLoopTimer = null;
	eventLoopHistogram = null;
}
