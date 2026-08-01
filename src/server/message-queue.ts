import type WebSocket from "ws";
import type { AdditionalContextItem, AiChatParams, ClientRequest } from "../protocol/types.js";
import { appendSessionEvent, type StoredSessionEvent } from "../session/session-store.js";
import type { ClientSession, QueuedMessage, QueuedMessageStatus } from "./client-session.js";
import { cloneAdditionalContextItems } from "./additional-context.js";
import { sendSessionEvent, waitForSessionEventPersistence } from "./session-events.js";

const MAX_QUEUE_TEXT_CHARS: number = 20000;

type MessageQueuePersistEventName =
	| "message.queue.added"
	| "message.queue.updated"
	| "message.queue.removed"
	| "message.queue.status"
	| "message.queue.reordered";

export type QueueMessageInput = {
	text: string;
	additionalContext?: AdditionalContextItem[] | undefined;
	mode?: "agent" | "ask" | "plan" | undefined;
	provider?: string | undefined;
	model?: string | undefined;
	reasoningEffort?: string | undefined;
	skillRefs?: AiChatParams["skillRefs"];
};

export type QueueMutationResult = {
	item?: QueuedMessage | undefined;
	changed: boolean;
	errorCode?: string | undefined;
	errorMessage?: string | undefined;
};

function cloneSkillRefs(skillRefs: AiChatParams["skillRefs"]): AiChatParams["skillRefs"] {
	return skillRefs === undefined ? undefined : [...skillRefs];
}

function cloneQueuedMessage(message: QueuedMessage): QueuedMessage {
	return {
		...message,
		additionalContext: cloneAdditionalContextItems(message.additionalContext) ?? [],
		skillRefs: cloneSkillRefs(message.skillRefs)
	};
}

function normalizeQueueInput(input: QueueMessageInput, existing?: QueuedMessage | undefined): QueueMessageInput {
	return {
		text: input.text.trim().slice(0, MAX_QUEUE_TEXT_CHARS),
		additionalContext: cloneAdditionalContextItems(input.additionalContext ?? existing?.additionalContext) ?? [],
		mode: input.mode ?? existing?.mode,
		provider: input.provider ?? existing?.provider,
		model: input.model ?? existing?.model,
		reasoningEffort: input.reasoningEffort ?? existing?.reasoningEffort,
		skillRefs: cloneSkillRefs(input.skillRefs ?? existing?.skillRefs)
	};
}

function readRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function readNumber(value: unknown): number {
	const parsed: number = typeof value === "number" ? value : Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function readStatus(value: unknown): QueuedMessageStatus {
	if (
		value === "pending"
		|| value === "sending"
		|| value === "approval"
		|| value === "failed"
		|| value === "cancelled"
		|| value === "rejected"
	) {
		return value;
	}
	return "pending";
}

function readMode(value: unknown): "agent" | "ask" | "plan" | undefined {
	return value === "agent" || value === "ask" || value === "plan" ? value : undefined;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readAdditionalContext(value: unknown): AdditionalContextItem[] {
	return Array.isArray(value) ? value as AdditionalContextItem[] : [];
}

function readSkillRefs(value: unknown): AiChatParams["skillRefs"] {
	return Array.isArray(value) ? value.filter((item: unknown): item is string => typeof item === "string" && item.length > 0).slice(0, 4) : undefined;
}

function normalizeHydratedStatus(status: QueuedMessageStatus): QueuedMessageStatus {
	return status === "sending" || status === "approval" ? "failed" : status;
}

function readQueuedMessage(value: unknown): QueuedMessage | null {
	const record: Record<string, unknown> | null = readRecord(value);
	if (record === null) {
		return null;
	}
	const id: number = readNumber(record.id ?? record.queueId);
	const text: string = typeof record.text === "string" ? record.text.trim().slice(0, MAX_QUEUE_TEXT_CHARS) : "";
	const additionalContext: AdditionalContextItem[] = cloneAdditionalContextItems(readAdditionalContext(record.additionalContext)) ?? [];
	if (id <= 0 || (text.length === 0 && additionalContext.length === 0)) {
		return null;
	}
	const createdAt: string = readString(record.createdAt) ?? new Date().toISOString();
	const updatedAt: string = readString(record.updatedAt) ?? createdAt;
	return {
		id,
		text,
		additionalContext,
		mode: readMode(record.mode),
		provider: readString(record.provider),
		model: readString(record.model),
		reasoningEffort: readString(record.reasoningEffort),
		skillRefs: readSkillRefs(record.skillRefs),
		status: normalizeHydratedStatus(readStatus(record.status)),
		createdAt,
		updatedAt
	};
}

function sortMessagesByIds(messages: QueuedMessage[], queueIds: number[]): QueuedMessage[] {
	const messagesById: Map<number, QueuedMessage> = new Map(messages.map((message: QueuedMessage): [number, QueuedMessage] => [message.id, message]));
	const sorted: QueuedMessage[] = [];
	const usedIds: Set<number> = new Set();
	for (const queueId of queueIds) {
		const message: QueuedMessage | undefined = messagesById.get(queueId);
		if (message !== undefined && !usedIds.has(queueId)) {
			sorted.push(message);
			usedIds.add(queueId);
		}
	}
	for (const message of messages) {
		if (!usedIds.has(message.id)) {
			sorted.push(message);
		}
	}
	return sorted;
}

export function serializeQueuedMessage(message: QueuedMessage): Record<string, unknown> {
	return {
		id: message.id,
		text: message.text,
		additionalContext: cloneAdditionalContextItems(message.additionalContext) ?? [],
		mode: message.mode ?? null,
		provider: message.provider ?? null,
		model: message.model ?? null,
		reasoningEffort: message.reasoningEffort ?? null,
		skillRefs: message.skillRefs ?? [],
		status: message.status,
		createdAt: message.createdAt,
		updatedAt: message.updatedAt
	};
}

export function serializeMessageQueue(session: ClientSession): Record<string, unknown>[] {
	return session.queuedMessages.map(serializeQueuedMessage);
}

export function emitMessageQueueUpdated(socket: WebSocket, requestId: string, session: ClientSession): void {
	sendSessionEvent(socket, requestId, session, "message.queue.updated", {
		type: "message.queue.updated",
		messageQueue: serializeMessageQueue(session),
		updatedAt: new Date().toISOString()
	});
}

export async function persistMessageQueueEvent(
	session: ClientSession,
	requestId: string,
	eventName: MessageQueuePersistEventName,
	data: Record<string, unknown>
): Promise<void> {
	if (session.sessionId === undefined) {
		return;
	}
	await waitForSessionEventPersistence(session);
	await appendSessionEvent(session.sessionId, requestId, eventName, data);
}

export function hydrateMessageQueue(events: StoredSessionEvent[]): { messages: QueuedMessage[]; nextId: number } {
	let messages: QueuedMessage[] = [];
	let nextId: number = 0;

	for (const event of events) {
		const data: Record<string, unknown> | null = readRecord(event.data);
		if (data === null) {
			continue;
		}
		if (event.event === "message.queue.added") {
			const message: QueuedMessage | null = readQueuedMessage(data.item ?? data);
			if (message === null) {
				continue;
			}
			const existingIndex: number = messages.findIndex((item: QueuedMessage): boolean => item.id === message.id);
			if (existingIndex >= 0) {
				messages[existingIndex] = message;
			} else {
				messages.push(message);
			}
			nextId = Math.max(nextId, message.id);
		} else if (event.event === "message.queue.updated") {
			const message: QueuedMessage | null = readQueuedMessage(data.item ?? data);
			if (message === null) {
				continue;
			}
			const existingIndex: number = messages.findIndex((item: QueuedMessage): boolean => item.id === message.id);
			if (existingIndex >= 0) {
				messages[existingIndex] = message;
				nextId = Math.max(nextId, message.id);
			}
		} else if (event.event === "message.queue.status") {
			const queueId: number = readNumber(data.queueId);
			const status: QueuedMessageStatus = normalizeHydratedStatus(readStatus(data.status));
			const existingIndex: number = messages.findIndex((item: QueuedMessage): boolean => item.id === queueId);
			if (existingIndex >= 0) {
				const existing: QueuedMessage = messages[existingIndex] as QueuedMessage;
				messages[existingIndex] = {
					...existing,
					status,
					updatedAt: readString(data.updatedAt) ?? event.createdAt
				};
			}
		} else if (event.event === "message.queue.removed") {
			const queueId: number = readNumber(data.queueId);
			messages = messages.filter((item: QueuedMessage): boolean => item.id !== queueId);
		} else if (event.event === "message.queue.reordered") {
			const queueIds: number[] = Array.isArray(data.queueIds)
				? data.queueIds.map(readNumber).filter((queueId: number): boolean => queueId > 0)
				: [];
			if (queueIds.length > 0) {
				messages = sortMessagesByIds(messages, queueIds);
			}
		}
	}

	nextId = Math.max(nextId, ...messages.map((message: QueuedMessage): number => message.id), 0);
	return { messages, nextId };
}

export function enqueueMessage(session: ClientSession, input: QueueMessageInput): QueuedMessage {
	const now: string = new Date().toISOString();
	const normalized: QueueMessageInput = normalizeQueueInput(input);
	session.messageQueueNextId += 1;
	const message: QueuedMessage = {
		id: session.messageQueueNextId,
		text: normalized.text,
		additionalContext: normalized.additionalContext ?? [],
		mode: normalized.mode,
		provider: normalized.provider,
		model: normalized.model,
		reasoningEffort: normalized.reasoningEffort,
		skillRefs: normalized.skillRefs,
		status: "pending",
		createdAt: now,
		updatedAt: now
	};
	session.queuedMessages.push(message);
	return message;
}

export function findQueuedMessageIndex(session: ClientSession, queueId: number): number {
	return session.queuedMessages.findIndex((message: QueuedMessage): boolean => message.id === queueId);
}

export function findQueuedMessage(session: ClientSession, queueId: number): QueuedMessage | undefined {
	const index: number = findQueuedMessageIndex(session, queueId);
	return index < 0 ? undefined : session.queuedMessages[index];
}

export function getNextRunnableQueuedMessage(session: ClientSession): QueuedMessage | undefined {
	const first: QueuedMessage | undefined = session.queuedMessages[0];
	return first?.status === "pending" ? first : undefined;
}

export function updateQueuedMessage(
	session: ClientSession,
	queueId: number,
	input: QueueMessageInput
): QueueMutationResult {
	const index: number = findQueuedMessageIndex(session, queueId);
	if (index < 0) {
		return { changed: false };
	}

	const existing: QueuedMessage = session.queuedMessages[index] as QueuedMessage;
	if (existing.status !== "pending") {
		return {
			item: existing,
			changed: false,
			errorCode: "queue_item_not_pending",
			errorMessage: "Only pending queued messages can be edited."
		};
	}

	const normalized: QueueMessageInput = normalizeQueueInput(input, existing);
	if (
		existing.text === normalized.text
		&& JSON.stringify(existing.additionalContext ?? []) === JSON.stringify(normalized.additionalContext ?? [])
		&& existing.mode === normalized.mode
		&& existing.provider === normalized.provider
		&& existing.model === normalized.model
		&& existing.reasoningEffort === normalized.reasoningEffort
		&& JSON.stringify(existing.skillRefs ?? []) === JSON.stringify(normalized.skillRefs ?? [])
	) {
		return { item: existing, changed: false };
	}

	const next: QueuedMessage = {
		...existing,
		text: normalized.text,
		additionalContext: normalized.additionalContext ?? [],
		mode: normalized.mode,
		provider: normalized.provider,
		model: normalized.model,
		reasoningEffort: normalized.reasoningEffort,
		skillRefs: normalized.skillRefs,
		status: "pending",
		updatedAt: new Date().toISOString()
	};
	session.queuedMessages[index] = next;
	return { item: next, changed: true };
}

export function setQueuedMessageStatus(
	session: ClientSession,
	queueId: number,
	status: QueuedMessageStatus
): QueueMutationResult {
	const index: number = findQueuedMessageIndex(session, queueId);
	if (index < 0) {
		return { changed: false };
	}

	const existing: QueuedMessage = session.queuedMessages[index] as QueuedMessage;
	if (existing.status === status) {
		return { item: existing, changed: false };
	}

	const next: QueuedMessage = {
		...existing,
		status,
		updatedAt: new Date().toISOString()
	};
	session.queuedMessages[index] = next;
	return { item: next, changed: true };
}

export function reorderQueuedMessages(session: ClientSession, queueIds: number[]): QueueMutationResult {
	const pendingIds: number[] = session.queuedMessages
		.filter((message: QueuedMessage): boolean => message.status === "pending")
		.map((message: QueuedMessage): number => message.id);
	const uniqueIds: number[] = [...new Set(queueIds)];
	const pendingIdSet: Set<number> = new Set(pendingIds);
	const hasSameIds: boolean = uniqueIds.length === pendingIds.length
		&& uniqueIds.every((queueId: number): boolean => pendingIdSet.has(queueId));
	if (!hasSameIds) {
		return {
			changed: false,
			errorCode: "invalid_queue_order",
			errorMessage: "Queue reorder must include every pending queue item exactly once."
		};
	}

	if (pendingIds.join(",") === uniqueIds.join(",")) {
		return { changed: false };
	}

	const pendingMessagesById: Map<number, QueuedMessage> = new Map(
		session.queuedMessages
			.filter((message: QueuedMessage): boolean => message.status === "pending")
			.map((message: QueuedMessage): [number, QueuedMessage] => [message.id, message])
	);
	const orderedPendingMessages: QueuedMessage[] = uniqueIds.map((queueId: number): QueuedMessage => pendingMessagesById.get(queueId) as QueuedMessage);
	let pendingIndex: number = 0;
	session.queuedMessages = session.queuedMessages.map((message: QueuedMessage): QueuedMessage => {
		if (message.status !== "pending") {
			return message;
		}
		const nextMessage: QueuedMessage = orderedPendingMessages[pendingIndex] as QueuedMessage;
		pendingIndex += 1;
		return {
			...nextMessage,
			updatedAt: new Date().toISOString()
		};
	});
	return { changed: true };
}

export function removeQueuedMessage(session: ClientSession, queueId: number): boolean {
	const index: number = findQueuedMessageIndex(session, queueId);
	if (index < 0) {
		return false;
	}
	session.queuedMessages.splice(index, 1);
	return true;
}

export function createQueuedChatRequest(queueItem: QueuedMessage, requestId: string): ClientRequest {
	const options: NonNullable<AiChatParams["options"]> = {
		stream: true,
		queueItemId: queueItem.id
	};
	if (queueItem.reasoningEffort !== undefined) {
		options.reasoningEffort = queueItem.reasoningEffort;
	}
	return {
		type: "request",
		id: requestId,
		method: "ai.chat",
		params: {
			message: queueItem.text,
			skillRefs: queueItem.skillRefs,
			additionalContext: cloneAdditionalContextItems(queueItem.additionalContext),
			options
		}
	} as ClientRequest;
}
