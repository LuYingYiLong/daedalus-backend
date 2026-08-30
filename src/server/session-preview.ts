import type { AdditionalContextItem, ChatMessage } from "../protocol/types.js";
import {
	openSession,
	type StoredMessage,
	type StoredSessionTimelinePage
} from "../session/session-store.js";
import { readImageAttachmentDataUrl } from "../session/session-attachments.js";
import type { TimelineBlock } from "../session/timeline-blocks.js";
import type { ClientSession } from "./client-session.js";
import { hydratePendingGuides } from "./pending-guides.js";
import { logger } from "../logger.js";

const DEFAULT_SESSION_OPEN_MESSAGE_LIMIT: number = 80;
const MAX_SESSION_OPEN_MESSAGE_LIMIT: number = 500;
const SESSION_OPEN_PREVIEW_STRING_LIMIT: number = 1200;
const SESSION_OPEN_PREVIEW_ARRAY_LIMIT: number = 80;

function cloneStoredAdditionalContextItems(items: readonly AdditionalContextItem[] | undefined): AdditionalContextItem[] | undefined {
	if (items === undefined || items.length === 0) {
		return undefined;
	}

	return items.map((item: AdditionalContextItem): AdditionalContextItem => ({ ...item }));
}

export function getSessionWorkspaceRoot(session: ClientSession): string {
	return session.activeWorkspace?.rootPath
		?? session.workspaceRoot
		?? process.env.GODOT_PROJECT_PATH
		?? "";
}

export function toChatMessage(message: StoredMessage): ChatMessage {
	const chatMessage: ChatMessage = {
		role: message.role,
		content: message.content
	};

	if (message.requestId !== undefined) {
		chatMessage.requestId = message.requestId;
	}

	if (message.createdAt !== undefined) {
		chatMessage.createdAt = message.createdAt;
	}

	if (message.additionalContext !== undefined && message.additionalContext.length > 0) {
		chatMessage.additionalContext = cloneStoredAdditionalContextItems(message.additionalContext);
	}

	if (message.excludeFromLlmContext === true) {
		chatMessage.excludeFromLlmContext = true;
	}

	if (message.status === "failed") {
		chatMessage.status = "failed";
	}

	if (message.error !== undefined) {
		chatMessage.error = {
			code: message.error.code,
			message: message.error.message
		};
	}

	return chatMessage;
}

export function clampSessionOpenMessageLimit(limit: number | undefined): number {
	if (limit === undefined) {
		return DEFAULT_SESSION_OPEN_MESSAGE_LIMIT;
	}

	return Math.min(MAX_SESSION_OPEN_MESSAGE_LIMIT, Math.max(1, Math.floor(limit)));
}

export function createPreviewValue(value: unknown, depth: number = 0): unknown {
	if (typeof value === "string") {
		if (value.length <= SESSION_OPEN_PREVIEW_STRING_LIMIT) {
			return value;
		}

		return [
			value.slice(0, SESSION_OPEN_PREVIEW_STRING_LIMIT),
			`\n\n[Historical event content truncated; original length: ${value.length} characters]`
		].join("");
	}

	if (value === null || typeof value !== "object") {
		return value;
	}

	if (depth >= 6) {
		return "[Nested historical event content truncated]";
	}

	if (Array.isArray(value)) {
		const previewItems: unknown[] = value
			.slice(0, SESSION_OPEN_PREVIEW_ARRAY_LIMIT)
			.map((item: unknown): unknown => createPreviewValue(item, depth + 1));

		if (value.length > SESSION_OPEN_PREVIEW_ARRAY_LIMIT) {
			previewItems.push(`[Historical event array truncated; original length: ${value.length}]`);
		}

		return previewItems;
	}

	const source: Record<string, unknown> = value as Record<string, unknown>;
	const preview: Record<string, unknown> = {};

	for (const [key, item] of Object.entries(source)) {
		preview[key] = createPreviewValue(item, depth + 1);
	}

	return preview;
}

async function hydrateTimelineImageThumbnails(sessionId: string, blocks: TimelineBlock[]): Promise<TimelineBlock[]> {
	const hydratedBlocks: TimelineBlock[] = [];
	for (const block of blocks) {
		if (block.type !== "user" || block.additionalContext === undefined || block.additionalContext.length === 0) {
			hydratedBlocks.push(block);
			continue;
		}

		let changed: boolean = false;
		const additionalContext: AdditionalContextItem[] = [];
		for (const item of block.additionalContext) {
			if (item.kind !== "image" || item.data === undefined || typeof item.data !== "object" || item.data === null || Array.isArray(item.data)) {
				additionalContext.push(item);
				continue;
			}

			const data: Record<string, unknown> = item.data as Record<string, unknown>;
			if (typeof data.thumbnailDataUrl === "string" || typeof data.dataUrl === "string" || typeof data.attachmentId !== "string") {
				additionalContext.push(item);
				continue;
			}

			try {
				additionalContext.push({
					...item,
					data: {
						...data,
						thumbnailDataUrl: await readImageAttachmentDataUrl(sessionId, data.attachmentId)
					}
				});
				changed = true;
			} catch {
				additionalContext.push(item);
			}
		}

		hydratedBlocks.push(changed ? { ...block, additionalContext } : block);
	}

	return hydratedBlocks;
}

export async function createTimelinePageResult(page: StoredSessionTimelinePage, limit: number): Promise<Record<string, unknown>> {
	return {
		blockCount: page.blockCount,
		blockOffset: page.blockOffset,
		eventCount: page.eventCount,
		limit,
		hasMoreBefore: page.hasMoreBefore,
		hasMoreAfter: page.hasMoreAfter,
		timelineBlocks: await hydrateTimelineImageThumbnails(page.metadata.id, page.timelineBlocks),
		latestWorkflowSnapshot: page.latestWorkflowSnapshot === null ? null : createPreviewValue(page.latestWorkflowSnapshot),
		latestAgentSnapshot: page.latestAgentSnapshot === null ? null : createPreviewValue(page.latestAgentSnapshot),
		latestPlanClarification: page.latestPlanClarification,
		latestPlanApproval: page.latestPlanApproval
	};
}

export function startFullSessionLoad(session: ClientSession, sessionId: string): void {
	const loadPromise: Promise<void> = (async (): Promise<void> => {
		try {
			const stored = await openSession(sessionId);
			if (session.sessionId !== sessionId) {
				return;
			}

			session.messages = stored.messages.map(toChatMessage);
			session.pendingGuides = hydratePendingGuides(stored.events);
		} catch (error: unknown) {
			logger.error("session", "full_history_load_failed", error, {
				sessionId
			});
		}
	})();

	const trackedPromise: Promise<void> = loadPromise.finally((): void => {
		if (session.fullSessionLoadPromise === trackedPromise) {
			session.fullSessionLoadPromise = undefined;
		}
	});
	session.fullSessionLoadPromise = trackedPromise;
}

export async function waitForFullSessionLoad(session: ClientSession): Promise<void> {
	if (session.fullSessionLoadPromise !== undefined) {
		await session.fullSessionLoadPromise;
	}
}
