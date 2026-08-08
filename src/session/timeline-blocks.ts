import type { ChatMessage } from "../protocol/types.js";
import type { StoredMessage, StoredSession, StoredSessionEvent } from "./session-store.js";
import { annotateActivityEvent, createActivityGroupAccumulator, type TimelineActivityStats } from "./activity-groups.js";

export type TimelineUserBlock = {
	id: string;
	type: "user";
	requestId: string;
	content: string;
	sentAtUtc: string;
	additionalContext?: ChatMessage["additionalContext"] | undefined;
	renderHints?: TimelineRenderHints | undefined;
};

export type TimelineAssistantBlock = {
	id: string;
	type: "assistant";
	requestId: string;
	content: string;
	startedAtUtc: string;
	completedAtUtc: string;
	status?: "failed" | "stopped" | undefined;
	completionStatus?: "responded" | "stopped" | undefined;
	bodyParts: TimelineBodyPart[];
	renderHints?: TimelineRenderHints | undefined;
};

export type TimelineBlock = TimelineUserBlock | TimelineAssistantBlock;

export type TimelineRenderHints = {
	estimatedHeight: number;
	contentChars: number;
	bodyPartCount: number;
	heavyPartCount: number;
};

export type TimelineMarkdownPart = {
	type: "markdown";
	text: string;
};

export type TimelineThinkingPart = {
	type: "thinking";
	text: string;
	done: boolean;
	activityGroupId?: string;
	activityPartId?: string;
	activityPartKind?: "thinking" | "tool";
	activityGroupStats?: TimelineActivityStats;
};

export type TimelineProviderReconnectPart = {
	type: "provider_reconnect";
	reconnectId: string;
	revision: number;
	provider: string;
	model: string;
	status: "waiting" | "reconnecting" | "recovered" | "failed";
	reason: "transport" | "idle_timeout" | "gateway" | "rate_limit" | "server";
	attempt: number;
	maxAttempts: 2 | 5 | 15;
	timeoutMs: number;
	retryAt?: string | undefined;
	autoExtended: boolean;
};

export type TimelineToolPart = {
	type: "tool";
	tool_call_id: string;
	events: Record<string, unknown>[];
	activityGroupId?: string;
	activityPartId?: string;
	activityPartKind?: "thinking" | "tool";
	activityGroupStats?: TimelineActivityStats;
};

export type TimelinePlanRecommendedReply = {
	label: string;
	text: string;
	description?: string | undefined;
};

export type TimelinePlanClarification = {
	planId: string;
	requestId: string;
	title: string;
	question: string;
	recommendedReplies: TimelinePlanRecommendedReply[];
};

export type TimelinePlanApproval = {
	planId: string;
	requestId: string;
	title: string;
	status: string;
	previewMarkdown: string;
	updatedAt: string;
};

export type TimelineSummaryStartPart = {
	type: "summary_start";
	runId: string;
	stepId: string;
	stepRunId: string;
	title: string;
	foldTitle: string;
};

export type TimelineCompressionPart = {
	type: "compression";
	compressionId: string;
	status: "running" | "completed" | "skipped" | "failed";
	summary: string;
	reason: string;
};

export type TimelineStatusPart = {
	type: "status";
	status: string;
	title: string;
	details: string;
	actionLabel: string;
	actionId: string;
	code: string;
	iconUid: string;
	planId: string;
	recommendedReplies?: TimelinePlanRecommendedReply[] | undefined;
};

export type TimelinePlanPart = {
	type: "plan";
	planId: string;
	title: string;
	status: string;
	previewMarkdown: string;
};

export type TimelineInlineDiffPart = {
	type: "inline_diff";
	sessionId: string;
	batchIds: string[];
	editedFileCount: number;
	additions: number;
	deletions: number;
	undoable: boolean;
	editedFiles: Record<string, unknown>[];
};

export type TimelineImageGenerationPart = {
	type: "image_generation";
	status: "running" | "completed" | "failed";
	prompt: string;
	toolCallId?: string | undefined;
	artifacts?: Record<string, unknown>[] | undefined;
	provider?: string | undefined;
	model?: string | undefined;
	error?: string | undefined;
};

export type TimelineBodyPart =
	| TimelineMarkdownPart
	| TimelineThinkingPart
	| TimelineProviderReconnectPart
	| TimelineToolPart
	| TimelineSummaryStartPart
	| TimelineCompressionPart
	| TimelineStatusPart
	| TimelinePlanPart
	| TimelineInlineDiffPart
	| TimelineImageGenerationPart;

/**
 * Returns the assistant Markdown visible in the normal message body. Parts
 * before a summary marker belong to the collapsed execution transcript and
 * must not create search matches that cannot be located in the default view.
 */
export function getVisibleAssistantMarkdownSegments(parts: readonly TimelineBodyPart[]): string[] {
	const summaryStartIndex: number = parts.findIndex(
		(part: TimelineBodyPart): boolean => isTimelineBodyPart(part) && part.type === "summary_start"
	);
	const visibleParts: readonly TimelineBodyPart[] = summaryStartIndex < 0
		? parts
		: parts.slice(summaryStartIndex + 1);
	return visibleParts
		.filter((part): part is TimelineMarkdownPart => isTimelineBodyPart(part) && part.type === "markdown")
		.map((part: TimelineMarkdownPart): string => part.text)
		.filter((text: string): boolean => text.length > 0);
}

export type TimelineBuildResult = {
	blocks: TimelineBlock[];
	eventCount: number;
	latestWorkflowSnapshot: unknown | null;
	latestAgentSnapshot: unknown | null;
	latestPlanClarification: TimelinePlanClarification | null;
	latestPlanApproval: TimelinePlanApproval | null;
};

type RequestEvents = {
	events: StoredSessionEvent[];
	firstEventAt: string;
	lastEventAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Timeline parts are reconstructed from append-only historical events. A
 * malformed legacy event must never make an otherwise valid session
 * impossible to open, so tolerate an invalid slot and omit it from the
 * derived UI projection. Persisted events themselves remain untouched.
 */
function isTimelineBodyPart(value: unknown): value is TimelineBodyPart {
	return isRecord(value) && typeof value.type === "string";
}

function getTimelineBodyPartAt(parts: readonly TimelineBodyPart[], index: number): TimelineBodyPart | undefined {
	const candidate: unknown = parts[index];
	return isTimelineBodyPart(candidate) ? candidate : undefined;
}

function removeInvalidTimelineBodyParts(parts: TimelineBodyPart[]): void {
	let destinationIndex: number = 0;
	for (let sourceIndex: number = 0; sourceIndex < parts.length; sourceIndex += 1) {
		const part: TimelineBodyPart | undefined = getTimelineBodyPartAt(parts, sourceIndex);
		if (part === undefined) {
			continue;
		}
		if (destinationIndex !== sourceIndex) {
			parts[destinationIndex] = part;
		}
		destinationIndex += 1;
	}
	if (destinationIndex !== parts.length) {
		parts.length = destinationIndex;
	}
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asBoolean(value: unknown, fallback: boolean = false): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
	return { ...value };
}

function getEventData(event: StoredSessionEvent): Record<string, unknown> {
	return isRecord(event.data) ? cloneRecord(event.data) : {};
}

function compareEvents(left: StoredSessionEvent, right: StoredSessionEvent): number {
	if (left.sequence !== undefined && right.sequence !== undefined && left.sequence !== right.sequence) {
		return left.sequence - right.sequence;
	}
	if (left.sequence !== undefined && right.sequence === undefined) {
		return -1;
	}
	if (left.sequence === undefined && right.sequence !== undefined) {
		return 1;
	}

	const timeCompare: number = left.createdAt.localeCompare(right.createdAt);
	if (timeCompare !== 0) {
		return timeCompare;
	}

	return left.id.localeCompare(right.id);
}

function collectRequestAliases(events: StoredSessionEvent[]): Map<string, string> {
	const aliases: Map<string, string> = new Map();
	for (const event of events) {
		const data: Record<string, unknown> = getEventData(event);
		if (event.event === "agent.run.state" && asString(data.goalId).trim().length > 0) {
			const rootRequestId: string = asString(data.rootRequestId).trim();
			if (event.requestId.length > 0 && rootRequestId.length > 0 && event.requestId !== rootRequestId) {
				aliases.set(event.requestId, rootRequestId);
			}
			continue;
		}
		if (!event.event.startsWith("plan.") || event.event === "plan.execution.started") {
			continue;
		}

		const canonicalRequestId: string = asString(data.requestId).trim();
		if (event.requestId.length > 0 && canonicalRequestId.length > 0 && event.requestId !== canonicalRequestId) {
			aliases.set(event.requestId, canonicalRequestId);
		}
	}

	return aliases;
}

function normalizeEventRequestId(event: StoredSessionEvent, aliases: Map<string, string>): StoredSessionEvent {
	const canonicalRequestId: string | undefined = aliases.get(event.requestId);
	if (canonicalRequestId === undefined) {
		return event;
	}

	return {
		...event,
		requestId: canonicalRequestId
	};
}

function collectRequestEvents(events: StoredSessionEvent[], aliases: Map<string, string>): Map<string, RequestEvents> {
	const grouped: Map<string, RequestEvents> = new Map();

	for (const sourceEvent of events) {
		const event: StoredSessionEvent = normalizeEventRequestId(sourceEvent, aliases);
		if (event.requestId.length === 0) {
			continue;
		}

		const existing: RequestEvents | undefined = grouped.get(event.requestId);
		if (existing === undefined) {
			grouped.set(event.requestId, {
				events: [event],
				firstEventAt: event.createdAt,
				lastEventAt: event.createdAt
			});
			continue;
		}

		existing.events.push(event);
		if (event.createdAt < existing.firstEventAt) {
			existing.firstEventAt = event.createdAt;
		}
		if (event.createdAt > existing.lastEventAt) {
			existing.lastEventAt = event.createdAt;
		}
	}

	for (const requestEvents of grouped.values()) {
		requestEvents.events.sort(compareEvents);
	}

	return grouped;
}

function appendMarkdownPart(parts: TimelineBodyPart[], text: string): void {
	if (text.length === 0) {
		return;
	}

	const lastPart: TimelineBodyPart | undefined = getTimelineBodyPartAt(parts, parts.length - 1);
	if (lastPart?.type === "markdown") {
		lastPart.text += text;
		return;
	}

	parts.push({ type: "markdown", text });
}

function appendFinalMarkdownPart(parts: TimelineBodyPart[], text: string): void {
	if (text.length === 0) {
		return;
	}

	let lastMarkdownIndex: number = -1;
	for (let index: number = parts.length - 1; index >= 0; index -= 1) {
		if (parts[index]?.type === "markdown") {
			lastMarkdownIndex = index;
			break;
		}
	}

	if (lastMarkdownIndex >= 0) {
		const lastMarkdownPart: TimelineBodyPart | undefined = getTimelineBodyPartAt(parts, lastMarkdownIndex);
		if (lastMarkdownPart?.type === "markdown" && shouldReplaceMarkdownWithFinalText(lastMarkdownPart.text, text)) {
			lastMarkdownPart.text = text;
			return;
		}
	}

	const existingMarkdown: string = parts
		.filter((part): part is TimelineMarkdownPart => isTimelineBodyPart(part) && part.type === "markdown")
		.map((part: TimelineMarkdownPart): string => part.text)
		.join("");
	if (existingMarkdown === text || existingMarkdown.endsWith(text)) {
		return;
	}
	if (existingMarkdown.length > 0 && text.startsWith(existingMarkdown)) {
		appendMarkdownPart(parts, text.slice(existingMarkdown.length));
		return;
	}

	appendMarkdownPart(parts, text);
}

function shouldReplaceMarkdownWithFinalText(existingText: string, finalText: string): boolean {
	if (existingText.length === 0 || finalText.length === 0) {
		return false;
	}
	if (existingText === finalText || existingText.endsWith(finalText) || existingText.startsWith(finalText) || finalText.startsWith(existingText)) {
		return true;
	}

	const compareLength: number = Math.min(existingText.length, finalText.length);
	let commonPrefixLength: number = 0;
	while (commonPrefixLength < compareLength && existingText[commonPrefixLength] === finalText[commonPrefixLength]) {
		commonPrefixLength += 1;
	}

	return commonPrefixLength >= 80 && commonPrefixLength / Math.max(1, Math.min(existingText.length, finalText.length)) >= 0.35;
}

function getActivityMetadata(data: Record<string, unknown>): {
	activityGroupId?: string;
	activityPartId?: string;
	activityPartKind?: "thinking" | "tool";
	activityGroupStats?: TimelineActivityStats;
} {
	const activityGroupId: string = asString(data.activityGroupId);
	const activityPartId: string = asString(data.activityPartId);
	const activityPartKind: string = asString(data.activityPartKind);
	const stats: Record<string, unknown> = isRecord(data.activityGroupStats) ? data.activityGroupStats : {};
	const activityGroupStats: TimelineActivityStats | undefined = activityGroupId.length === 0 || activityPartId.length === 0
		? undefined
		: {
			editedFiles: asNumber(stats.editedFiles),
			commands: asNumber(stats.commands),
			thoughts: asNumber(stats.thoughts)
		};
	return {
		...(activityGroupId.length === 0 ? {} : { activityGroupId }),
		...(activityPartId.length === 0 ? {} : { activityPartId }),
		...(activityPartKind === "thinking" || activityPartKind === "tool" ? { activityPartKind } : {}),
		...(activityGroupStats === undefined ? {} : { activityGroupStats })
	};
}

function appendThinkingPart(parts: TimelineBodyPart[], text: string, done: boolean, metadata: ReturnType<typeof getActivityMetadata> = {}): void {
	const lastPart: TimelineBodyPart | undefined = getTimelineBodyPartAt(parts, parts.length - 1);
	if (text.length > 0 && lastPart?.type === "thinking" && !lastPart.done) {
		lastPart.text += text;
		Object.assign(lastPart, metadata);
		return;
	}

	if (done) {
		for (let index: number = parts.length - 1; index >= 0; index -= 1) {
			const part: TimelineBodyPart | undefined = getTimelineBodyPartAt(parts, index);
			if (part?.type !== "thinking" || part.done) {
				continue;
			}

			part.done = true;
			if (part.activityGroupId === metadata.activityGroupId || metadata.activityGroupId === undefined) {
				Object.assign(part, metadata);
			}
			return;
		}
	}

	parts.push({ type: "thinking", text, done, ...metadata });
}

function truncateTextByCodePoints(text: string, count: number): { text: string; removed: number } {
	if (count <= 0 || text.length === 0) return { text, removed: 0 };
	const codePoints: string[] = Array.from(text);
	const removed: number = Math.min(count, codePoints.length);
	return { text: codePoints.slice(0, codePoints.length - removed).join(""), removed };
}

function discardAttemptText(parts: TimelineBodyPart[], type: "markdown" | "thinking", count: number): void {
	let remaining: number = Math.max(0, Math.trunc(count));
	for (let index: number = parts.length - 1; index >= 0 && remaining > 0; index -= 1) {
		const part: TimelineBodyPart | undefined = getTimelineBodyPartAt(parts, index);
		if (part?.type !== type) continue;
		const truncated = truncateTextByCodePoints(part.text, remaining);
		part.text = truncated.text;
		remaining -= truncated.removed;
		if (part.text.length === 0) parts.splice(index, 1);
	}
}

function appendProviderReconnectPart(parts: TimelineBodyPart[], eventData: Record<string, unknown>): void {
	const reconnectId: string = asString(eventData.reconnectId);
	const revision: number = asNumber(eventData.revision);
	if (reconnectId.length === 0 || revision <= 0) return;
	const existingIndex: number = parts.findIndex((part: TimelineBodyPart): boolean => (
		isTimelineBodyPart(part) && part.type === "provider_reconnect" && part.reconnectId === reconnectId
	));
	const existing: TimelineProviderReconnectPart | undefined = existingIndex >= 0
		? parts[existingIndex] as TimelineProviderReconnectPart
		: undefined;
	if (existing !== undefined && existing.revision >= revision) return;

	discardAttemptText(parts, "markdown", asNumber(eventData.discardedMessageCodePoints));
	discardAttemptText(parts, "thinking", asNumber(eventData.discardedThinkingCodePoints));
	const statusValue: string = asString(eventData.status);
	const reasonValue: string = asString(eventData.reason);
	const maxAttemptsValue: number = asNumber(eventData.maxAttempts);
	const part: TimelineProviderReconnectPart = {
		type: "provider_reconnect",
		reconnectId,
		revision,
		provider: asString(eventData.provider),
		model: asString(eventData.model),
		status: statusValue === "reconnecting" || statusValue === "recovered" || statusValue === "failed" ? statusValue : "waiting",
		reason: reasonValue === "idle_timeout" || reasonValue === "gateway" || reasonValue === "rate_limit" || reasonValue === "server" ? reasonValue : "transport",
		attempt: Math.min(
			maxAttemptsValue === 15 ? 15 : maxAttemptsValue === 2 ? 2 : 5,
			Math.max(0, Math.trunc(asNumber(eventData.attempt)))
		),
		maxAttempts: maxAttemptsValue === 15
			? 15
			: maxAttemptsValue === 2
				? 2
				: 5,
		timeoutMs: Math.max(0, Math.trunc(asNumber(eventData.timeoutMs))),
		autoExtended: eventData.autoExtended === true,
		...(asString(eventData.retryAt).length === 0 ? {} : { retryAt: asString(eventData.retryAt) })
	};
	if (existingIndex >= 0) {
		parts[existingIndex] = part;
	} else {
		parts.push(part);
	}
}

function normalizeToolEventData(eventName: string, eventData: Record<string, unknown>, eventRecordId: string): Record<string, unknown> {
	const normalizedData: Record<string, unknown> = cloneRecord(eventData);
	if (eventName.startsWith("agent.tool.")) {
		normalizedData.type = eventName.replace("agent.tool.", "tool.");
	} else if (eventName === "tool.call" || eventName === "tool.result" || eventName === "tool.error" || eventName === "tool.approval_required" || eventName === "tool.approved" || eventName === "tool.rejected" || eventName === "tool.progress") {
		// Legacy rows may carry an agent.* type in their payload even when the
		// event name is already canonical. Normalize the discriminator as well.
		normalizedData.type = eventName;
	} else if (normalizedData.type === undefined) {
		normalizedData.type = eventName;
	}
	normalizedData._eventRecordId = eventRecordId;
	return normalizedData;
}

function getToolCallKey(eventData: Record<string, unknown>, requestId: string): string {
	const toolCallId: string = asString(eventData.toolCallId);
	const approvalId: string = asString(eventData.approvalId);
	const baseKey: string = toolCallId.length > 0
		? toolCallId
		: approvalId.length > 0
			? approvalId
			: `${asString(eventData.toolName) || "tool"}-${asNumber(eventData.step)}`;
	return requestId.length > 0 ? `${requestId}:${baseKey}` : baseKey;
}

function toolPartMatchesEvent(part: TimelineToolPart, toolCallKey: string, eventData: Record<string, unknown>): boolean {
	if (part.tool_call_id === toolCallKey) {
		return true;
	}

	const toolCallId: string = asString(eventData.toolCallId);
	const approvalId: string = asString(eventData.approvalId);
	return part.events.some((event: Record<string, unknown>): boolean => {
		if (toolCallId.length > 0 && asString(event.toolCallId) === toolCallId) {
			return true;
		}
		if (approvalId.length > 0 && asString(event.approvalId) === approvalId) {
			return true;
		}
		return false;
	});
}

function mergeToolActivityMetadata(part: TimelineToolPart, metadata: ReturnType<typeof getActivityMetadata>): void {
	if (part.activityGroupId === undefined || part.activityPartId === undefined) {
		Object.assign(part, metadata);
		return;
	}

	if (metadata.activityGroupStats === undefined) {
		return;
	}

	const current = part.activityGroupStats;
	part.activityGroupStats = {
		editedFiles: Math.max(current?.editedFiles ?? 0, metadata.activityGroupStats.editedFiles),
		commands: Math.max(current?.commands ?? 0, metadata.activityGroupStats.commands),
		thoughts: Math.max(current?.thoughts ?? 0, metadata.activityGroupStats.thoughts)
	};
}

function appendToolPart(parts: TimelineBodyPart[], eventData: Record<string, unknown>, requestId: string): void {
	const toolCallKey: string = getToolCallKey(eventData, requestId);
	for (const candidate of parts) {
		if (!isTimelineBodyPart(candidate)) {
			continue;
		}
		const part: TimelineBodyPart = candidate;
		if (part.type === "tool" && toolPartMatchesEvent(part, toolCallKey, eventData)) {
			const eventRecordId: string = asString(eventData._eventRecordId);
			if (eventRecordId.length > 0 && part.events.some((event: Record<string, unknown>): boolean => event._eventRecordId === eventRecordId)) {
				return;
			}
			// A tool result can arrive after streamed prose. The card remains at the
			// call's original timeline position, so its activity identity must not move.
			mergeToolActivityMetadata(part, getActivityMetadata(eventData));
			part.events.push(cloneRecord(eventData));
			return;
		}
	}

	parts.push({
		type: "tool",
		tool_call_id: toolCallKey,
		...getActivityMetadata(eventData),
		events: [cloneRecord(eventData)]
	});
}

function extractImageGenerationPrompt(eventData: Record<string, unknown>): string {
	const args: unknown = eventData.args;
	if (isRecord(args)) {
		return asString(args.prompt);
	}
	const imageGeneration: unknown = eventData.imageGeneration;
	if (isRecord(imageGeneration)) {
		return asString(imageGeneration.prompt);
	}
	return "";
}

function appendImageGenerationPart(parts: TimelineBodyPart[], eventData: Record<string, unknown>, requestId: string): void {
	if (asString(eventData.toolName) !== "mcp_image_generate") {
		return;
	}

	const toolCallId: string = getToolCallKey(eventData, requestId);
	const eventType: string = asString(eventData.type);
	let nextPart: TimelineImageGenerationPart | null = null;

	if (eventType === "tool.call" || eventType === "agent.tool.call") {
		nextPart = {
			type: "image_generation",
			status: "running",
			toolCallId,
			prompt: extractImageGenerationPrompt(eventData)
		};
	} else if (eventType === "tool.result" || eventType === "agent.tool.result") {
		const imageGeneration: unknown = eventData.imageGeneration;
		if (!isRecord(imageGeneration)) {
			return;
		}
		const artifactsValue: unknown = imageGeneration.artifacts;
		nextPart = {
			type: "image_generation",
			status: "completed",
			toolCallId,
			prompt: asString(imageGeneration.prompt) || extractImageGenerationPrompt(eventData),
			provider: asString(imageGeneration.provider),
			model: asString(imageGeneration.model),
			artifacts: Array.isArray(artifactsValue)
				? artifactsValue.filter(isRecord).map(cloneRecord)
				: []
		};
	} else if (eventType === "tool.error" || eventType === "agent.tool.error") {
		nextPart = {
			type: "image_generation",
			status: "failed",
			toolCallId,
			prompt: extractImageGenerationPrompt(eventData),
			error: asString(eventData.message)
		};
	}

	if (nextPart === null) {
		return;
	}

	for (let index: number = parts.length - 1; index >= 0; index -= 1) {
		const part: TimelineBodyPart | undefined = getTimelineBodyPartAt(parts, index);
		if (part?.type === "image_generation" && part.toolCallId === toolCallId) {
			if (nextPart.prompt.length === 0) {
				nextPart.prompt = part.prompt;
			}
			parts[index] = nextPart;
			return;
		}
	}

	parts.push(nextPart);
}

function appendSummaryStartPart(parts: TimelineBodyPart[], eventData: Record<string, unknown>): void {
	const runId: string = asString(eventData.runId);
	const stepId: string = asString(eventData.stepId);
	const stepRunId: string = asString(eventData.stepRunId);
	if (runId.length === 0 || stepRunId.length === 0) {
		return;
	}
	if (parts.some((part: TimelineBodyPart): boolean => isTimelineBodyPart(part) && part.type === "summary_start" && part.stepRunId === stepRunId)) {
		return;
	}

	parts.push({
		type: "summary_start",
		runId,
		stepId,
		stepRunId,
		title: asString(eventData.title),
		foldTitle: asString(eventData.foldTitle) || "总结前的过程"
	});
}

function appendCompressionPart(parts: TimelineBodyPart[], eventData: Record<string, unknown>): void {
	const compressionId: string = asString(eventData.compressionId);
	if (compressionId.length === 0) return;
	const statusValue: string = asString(eventData.status);
	const status: TimelineCompressionPart["status"] = statusValue === "completed" || statusValue === "skipped" || statusValue === "failed"
		? statusValue
		: "running";
	const nextPart: TimelineCompressionPart = {
		type: "compression",
		compressionId,
		status,
		summary: asString(eventData.summary),
		reason: asString(eventData.reason)
	};
	const existingIndex: number = parts.findIndex((part: TimelineBodyPart): boolean => (
		isTimelineBodyPart(part) && part.type === "compression" && part.compressionId === compressionId
	));
	if (existingIndex < 0) {
		parts.push(nextPart);
		return;
	}
	parts[existingIndex] = nextPart;
}

function appendStatusPart(parts: TimelineBodyPart[], statusData: Partial<TimelineStatusPart>): void {
	const nextPart: TimelineStatusPart = {
		type: "status",
		status: statusData.status ?? "message",
		title: statusData.title ?? "",
		details: statusData.details ?? "",
		actionLabel: statusData.actionLabel ?? "",
		actionId: statusData.actionId ?? "",
		code: statusData.code ?? "",
		iconUid: statusData.iconUid ?? "",
		planId: statusData.planId ?? "",
		recommendedReplies: statusData.recommendedReplies
	};
	if (nextPart.status === "error" && nextPart.details.length > 0 && parts.some((part: TimelineBodyPart): boolean => {
		return isTimelineBodyPart(part) && part.type === "status" && part.status === "error" && part.details === nextPart.details;
	})) {
		return;
	}

	parts.push(nextPart);
}

function markRunningImageGenerationFailed(parts: TimelineBodyPart[], error: string): void {
	for (const candidate of parts) {
		if (!isTimelineBodyPart(candidate)) {
			continue;
		}
		const part: TimelineBodyPart = candidate;
		if (part.type === "image_generation" && part.status === "running") {
			part.status = "failed";
			part.error = error;
		}
	}
}

function parsePlanRecommendedReplies(value: unknown): TimelinePlanRecommendedReply[] {
	if (!Array.isArray(value)) {
		return [];
	}

	const replies: TimelinePlanRecommendedReply[] = [];
	for (const item of value.slice(0, 3)) {
		if (!isRecord(item)) {
			continue;
		}
		const label: string = asString(item.label).trim();
		const text: string = asString(item.text).trim();
		const description: string = asString(item.description).trim();
		if (label.length === 0 || text.length === 0) {
			continue;
		}
		replies.push({
			label,
			text,
			description: description.length > 0 ? description : undefined
		});
	}
	return replies;
}

function createPlanClarificationSnapshot(data: Record<string, unknown>): TimelinePlanClarification | null {
	const planId: string = asString(data.planId).trim();
	const question: string = asString(data.question).trim();
	if (planId.length === 0 || question.length === 0) {
		return null;
	}

	const title: string = asString(data.title).trim();
	const requestId: string = asString(data.requestId).trim();
	return {
		planId,
		requestId: requestId.length > 0 ? requestId : planId,
		title: title.length > 0 ? title : "Plan clarification",
		question,
		recommendedReplies: parsePlanRecommendedReplies(data.recommendedReplies)
	};
}

function createPlanPart(eventData: Record<string, unknown>): TimelinePlanPart | null {
	const planId: string = asString(eventData.planId).trim();
	if (planId.length === 0) {
		return null;
	}

	return {
		type: "plan",
		planId,
		title: asString(eventData.title) || "Plan",
		status: asString(eventData.status),
		previewMarkdown: asString(eventData.previewMarkdown) || asString(eventData.markdown)
	};
}

function replaceOrAppendPlanPart(parts: TimelineBodyPart[], planPart: TimelinePlanPart): void {
	const existingIndex: number = parts.findIndex((part: TimelineBodyPart): boolean => {
		return isTimelineBodyPart(part) && part.type === "plan" && part.planId === planPart.planId;
	});

	if (existingIndex < 0) {
		parts.push(planPart);
		return;
	}

	parts[existingIndex] = planPart;
}

function createPlanApprovalSnapshot(eventData: Record<string, unknown>): TimelinePlanApproval | null {
	const planPart: TimelinePlanPart | null = createPlanPart(eventData);
	if (planPart === null || planPart.status !== "ready") {
		return null;
	}

	return {
		planId: planPart.planId,
		requestId: asString(eventData.requestId).trim() || planPart.planId,
		title: planPart.title,
		status: planPart.status,
		previewMarkdown: planPart.previewMarkdown,
		updatedAt: asString(eventData.updatedAt)
	};
}

function getFileEditKey(fileSummary: Record<string, unknown>): string {
	const absolutePath: string = asString(fileSummary.absolutePath);
	if (absolutePath.length > 0) {
		return absolutePath.replaceAll("\\", "/").toLowerCase();
	}

	return asString(fileSummary.path).replaceAll("\\", "/").toLowerCase();
}

function formatFileEditDisplayPath(fileSummary: Record<string, unknown>): string {
	const pathText: string = asString(fileSummary.path).replaceAll("\\", "/");
	const absolutePath: string = asString(fileSummary.absolutePath).replaceAll("\\", "/");
	const workspaceRoot: string = asString(fileSummary.workspaceRoot).replaceAll("\\", "/").replace(/\/+$/u, "");
	if (absolutePath.length > 0 && workspaceRoot.length > 0) {
		const rootPrefix: string = `${workspaceRoot}/`;
		if (absolutePath.toLowerCase().startsWith(rootPrefix.toLowerCase())) {
			return absolutePath.slice(rootPrefix.length);
		}
	}
	if (pathText.length > 0) {
		return pathText;
	}
	return absolutePath;
}

function appendFileEditBatch(fileEditBatches: Record<string, unknown>[], eventData: Record<string, unknown>): void {
	const batch: unknown = eventData.fileEditBatch;
	if (!isRecord(batch) || asString(batch.batchId).length === 0) {
		return;
	}
	fileEditBatches.push(cloneRecord(batch));
}

function createInlineDiffPart(sessionId: string, fileEditBatches: Record<string, unknown>[]): TimelineInlineDiffPart | null {
	if (fileEditBatches.length === 0) {
		return null;
	}

	const batchIds: string[] = [];
	const editedFilesByKey: Map<string, Record<string, unknown>> = new Map();
	const editedFileKeys: string[] = [];
	let undoable: boolean = true;

	for (const batch of fileEditBatches) {
		const batchId: string = asString(batch.batchId);
		if (batchId.length === 0 || batchIds.includes(batchId)) {
			continue;
		}
		batchIds.push(batchId);

		const editedFiles: unknown = batch.editedFiles;
		if (!Array.isArray(editedFiles)) {
			continue;
		}

		for (const fileValue of editedFiles) {
			if (!isRecord(fileValue)) {
				continue;
			}

			const fileSummary: Record<string, unknown> = cloneRecord(fileValue);
			const fileAdditions: number = asNumber(fileSummary.additions);
			const fileDeletions: number = asNumber(fileSummary.deletions);
			const fileKey: string = getFileEditKey(fileSummary);
			if (fileKey.length === 0) {
				continue;
			}

			if (!editedFilesByKey.has(fileKey)) {
				fileSummary.displayPath = formatFileEditDisplayPath(fileSummary);
				fileSummary.additions = 0;
				fileSummary.deletions = 0;
				editedFilesByKey.set(fileKey, fileSummary);
				editedFileKeys.push(fileKey);
			}

			const mergedFile: Record<string, unknown> = editedFilesByKey.get(fileKey)!;
			mergedFile.additions = asNumber(mergedFile.additions) + fileAdditions;
			mergedFile.deletions = asNumber(mergedFile.deletions) + fileDeletions;
			mergedFile.existsAfter = asBoolean(fileSummary.existsAfter, asBoolean(mergedFile.existsAfter));
			mergedFile.afterSha256 = asString(fileSummary.afterSha256) || asString(mergedFile.afterSha256);
			mergedFile.undoable = asBoolean(mergedFile.undoable, true) && asBoolean(fileSummary.undoable, true);
		}
	}

	if (batchIds.length === 0 || editedFileKeys.length === 0) {
		return null;
	}

	const editedFiles: Record<string, unknown>[] = [];
	let additions: number = 0;
	let deletions: number = 0;
	for (const fileKey of editedFileKeys) {
		const editedFile: Record<string, unknown> = editedFilesByKey.get(fileKey)!;
		additions += asNumber(editedFile.additions);
		deletions += asNumber(editedFile.deletions);
		undoable = undoable && asBoolean(editedFile.undoable, true);
		editedFiles.push(editedFile);
	}

	return {
		type: "inline_diff",
		sessionId,
		batchIds,
		editedFileCount: editedFiles.length,
		additions,
		deletions,
		undoable,
		editedFiles
	};
}

function createRunErrorStatus(eventData: Record<string, unknown>): Partial<TimelineStatusPart> {
	return {
		status: "error",
		title: "后端返回错误",
		details: asString(eventData.message) || "Unknown backend error",
		code: asString(eventData.code) || "agent_run_error"
	};
}

function createFailedMessageStatus(message: StoredMessage): Partial<TimelineStatusPart> | null {
	if (message.status !== "failed") {
		return null;
	}

	const errorValue: unknown = message.error;
	const errorRecord: Record<string, unknown> = isRecord(errorValue) ? errorValue : {};
	return {
		status: "error",
		title: "后端返回错误",
		details: asString(errorRecord.message) || "Unknown backend error",
		code: asString(errorRecord.code) || "agent_run_error"
	};
}

function getAgentRunStateStage(event: StoredSessionEvent): string {
	return event.event === "agent.run.state" && isRecord(event.data)
		? asString(event.data.stage)
		: "";
}

function eventCompletesAssistantBlock(event: StoredSessionEvent): boolean {
	const runStage: string = getAgentRunStateStage(event);
	return event.event === "agent.message.done"
		|| event.event === "agent.run.done"
		|| event.event === "workflow.done"
		|| event.event === "ai.done"
		|| event.event === "agent.run.error"
		|| event.event === "workflow.error"
		|| event.event === "agent.run.cancelled"
		|| runStage === "completed"
		|| runStage === "failed"
		|| runStage === "cancelled"
		|| runStage === "interrupted";
}

function getAssistantCompletionStatus(
	events: readonly StoredSessionEvent[],
	assistantMessage?: StoredMessage | undefined
): TimelineAssistantBlock["completionStatus"] {
	if (events.some((event: StoredSessionEvent): boolean => (
		event.event === "agent.run.cancelled" || getAgentRunStateStage(event) === "cancelled"
	))) {
		return "stopped";
	}

	if (assistantMessage?.status === "failed") {
		return undefined;
	}

	if (assistantMessage !== undefined || events.some((event: StoredSessionEvent): boolean => (
		event.event === "agent.message.done"
			|| event.event === "agent.run.done"
			|| event.event === "workflow.done"
			|| event.event === "ai.done"
			|| getAgentRunStateStage(event) === "completed"
	))) {
		return "responded";
	}

	return undefined;
}

function shouldAppendInlineDiff(events: StoredSessionEvent[], assistantMessage?: StoredMessage | undefined): boolean {
	if (assistantMessage !== undefined) {
		return true;
	}
	return events.some(eventCompletesAssistantBlock);
}

function buildAssistantBodyParts(
	sessionId: string,
	events: StoredSessionEvent[],
	messageContent: string,
	requestId: string,
	assistantMessage?: StoredMessage | undefined
): TimelineBodyPart[] {
	const parts: TimelineBodyPart[] = [];
	const fileEditBatches: Record<string, unknown>[] = [];
	const activityAccumulator = createActivityGroupAccumulator();
	let hasMarkdownDelta: boolean = false;
	let hasErrorStatus: boolean = false;
	const recordsHaveMarkdownDelta: boolean = events.some((event: StoredSessionEvent): boolean => event.event === "ai.delta" || event.event === "agent.message.delta");

	if (!recordsHaveMarkdownDelta && messageContent.length > 0) {
		appendMarkdownPart(parts, messageContent);
	}

	for (const event of events) {
		const eventData: Record<string, unknown> = getEventData(event);
		if (eventData.type === undefined) {
			eventData.type = event.event;
		}
		eventData._eventRecordId = event.id;
		Object.assign(eventData, annotateActivityEvent(activityAccumulator, requestId, event.event, eventData));

		if (event.event === "ai.delta" || event.event === "agent.message.delta") {
			const deltaText: string = asString(eventData.text);
			if (deltaText.length > 0) {
				appendMarkdownPart(parts, deltaText);
				hasMarkdownDelta = true;
			}
		} else if (event.event === "agent.message.done") {
			appendFinalMarkdownPart(parts, asString(eventData.text));
		} else if (event.event.startsWith("tool.") || event.event.startsWith("agent.tool.")) {
			const normalizedToolEvent: Record<string, unknown> = normalizeToolEventData(event.event, eventData, event.id);
			appendToolPart(parts, normalizedToolEvent, requestId);
			appendImageGenerationPart(parts, normalizedToolEvent, requestId);
			appendFileEditBatch(fileEditBatches, normalizedToolEvent);
		} else if (event.event === "agent.summary.started") {
			appendSummaryStartPart(parts, eventData);
		} else if (event.event === "agent.context.compression") {
			appendCompressionPart(parts, eventData);
		} else if (event.event === "ai.thinking.delta" || event.event === "agent.thinking.delta") {
			appendThinkingPart(parts, asString(eventData.text), false, getActivityMetadata(eventData));
		} else if (event.event === "ai.thinking.done" || event.event === "agent.thinking.done") {
			appendThinkingPart(parts, "", true, getActivityMetadata(eventData));
		} else if (event.event === "agent.provider.reconnect") {
			appendProviderReconnectPart(parts, eventData);
		} else if (event.event === "ai.status") {
			appendStatusPart(parts, {
				status: asString(eventData.status) || "message",
				title: asString(eventData.title),
				details: asString(eventData.details) || asString(eventData.detail),
				actionLabel: asString(eventData.actionLabel) || asString(eventData.action_label),
				actionId: asString(eventData.actionId) || asString(eventData.action_id),
				code: asString(eventData.code),
				iconUid: asString(eventData.iconUid) || asString(eventData.icon_uid),
				planId: asString(eventData.planId)
			});
		} else if (event.event === "agent.run.error" || event.event === "workflow.error") {
			appendStatusPart(parts, createRunErrorStatus(eventData));
			hasErrorStatus = true;
		} else if (event.event === "agent.run.cancelled") {
			const reason: string = asString(eventData.reason) || "The request was cancelled.";
			markRunningImageGenerationFailed(parts, reason);
		} else if (event.event === "agent.run.state") {
			const stage: string = asString(eventData.stage);
			const terminal: Record<string, unknown> = isRecord(eventData.terminal) ? eventData.terminal : {};
			if (stage === "completed" && asString(terminal.resultStatus) === "blocked") {
				appendStatusPart(parts, {
					status: "warning",
					title: "任务未完成",
					details: asString(terminal.message) || "The task was safely blocked before completion.",
					code: "agent_run_blocked"
				});
			} else if (stage === "failed") {
				const message: string = asString(terminal.message) || "The run failed.";
				markRunningImageGenerationFailed(parts, message);
				appendStatusPart(parts, createRunErrorStatus({
					code: "agent_run_error",
					message
				}));
				hasErrorStatus = true;
			} else if (stage === "cancelled") {
				const reason: string = asString(terminal.message) || "The request was cancelled.";
				markRunningImageGenerationFailed(parts, reason);
			} else if (stage === "interrupted") {
				const interruptedReason: string = asString(eventData.interruptedReason);
				const providerResponseStalled: boolean = interruptedReason === "provider_response_stalled";
				const reason: string = providerResponseStalled
					? "The model provider stopped producing data before the response completed."
					: "The backend stopped before this run reached a terminal state.";
				markRunningImageGenerationFailed(parts, reason);
				appendStatusPart(parts, {
					status: "warning",
					title: providerResponseStalled ? "Model response paused" : "Run interrupted",
					details: `${reason} Retry it from its safe checkpoint.`,
					code: "agent_run_interrupted",
					actionLabel: "Retry from checkpoint",
					actionId: `retry_agent_run:${asString(eventData.runId)}`
				});
			}
		} else if (event.event === "plan.generated" || event.event === "plan.revised") {
			const planPart: TimelinePlanPart | null = createPlanPart(eventData);
			if (planPart !== null) {
				replaceOrAppendPlanPart(parts, planPart);
			}
		} else if (event.event === "plan.approved") {
			appendStatusPart(parts, {
				status: "success",
				title: "计划已批准",
				details: asString(eventData.title),
				code: "plan.approved",
				planId: asString(eventData.planId)
			});
		}
	}

	if (!hasMarkdownDelta && recordsHaveMarkdownDelta && messageContent.length > 0) {
		appendMarkdownPart(parts, messageContent);
	}

	if (!hasErrorStatus && assistantMessage !== undefined) {
		const failedStatus: Partial<TimelineStatusPart> | null = createFailedMessageStatus(assistantMessage);
		if (failedStatus !== null) {
			appendStatusPart(parts, failedStatus);
		}
	}

	if (shouldAppendInlineDiff(events, assistantMessage)) {
		const inlineDiffPart: TimelineInlineDiffPart | null = createInlineDiffPart(sessionId, fileEditBatches);
		if (inlineDiffPart !== null) {
			parts.push(inlineDiffPart);
		}
	}

	removeInvalidTimelineBodyParts(parts);
	return parts;
}

function createUserBlock(message: StoredMessage): TimelineUserBlock {
	const requestId: string = message.requestId ?? "";
	return {
		id: `message:${requestId}:user:${message.createdAt}`,
		type: "user",
		requestId,
		content: message.content,
		sentAtUtc: message.createdAt,
		additionalContext: message.additionalContext
	};
}

function createAssistantBlock(
	sessionId: string,
	requestId: string,
	content: string,
	startedAtUtc: string,
	completedAtUtc: string,
	events: StoredSessionEvent[],
	assistantMessage?: StoredMessage | undefined,
	identityCreatedAt?: string | undefined
): TimelineAssistantBlock {
	const messageCreatedAt: string = identityCreatedAt ?? assistantMessage?.createdAt ?? completedAtUtc;
	const completionStatus: TimelineAssistantBlock["completionStatus"] = getAssistantCompletionStatus(events, assistantMessage);
	return {
		id: assistantMessage !== undefined
			? `message:${requestId}:assistant:${messageCreatedAt}`
			: `assistant-events:${requestId}:${completedAtUtc}`,
		type: "assistant",
		requestId,
		content,
		startedAtUtc,
		completedAtUtc,
		status: assistantMessage?.status === "failed"
			|| events.some((event: StoredSessionEvent): boolean => getAgentRunStateStage(event) === "failed")
			? "failed"
			: completionStatus === "stopped"
				? "stopped"
				: undefined,
		completionStatus,
		bodyParts: buildAssistantBodyParts(sessionId, events, content, requestId, assistantMessage)
	};
}

type TimelineBuildEntry =
	| {
		type: "request";
		requestId: string;
		userMessage?: StoredMessage | undefined;
		assistantMessage?: StoredMessage | undefined;
		assistantIdentityCreatedAt?: string | undefined;
		events: StoredSessionEvent[];
		firstEventAt: string;
		lastEventAt: string;
		orderAt: string;
		sequence: number;
	}
	| {
		type: "standalone";
		message: StoredMessage;
		orderAt: string;
		sequence: number;
	};

function compareTimelineBuildEntries(left: TimelineBuildEntry, right: TimelineBuildEntry): number {
	const timeCompare: number = left.orderAt.localeCompare(right.orderAt);
	if (timeCompare !== 0) {
		return timeCompare;
	}

	return left.sequence - right.sequence;
}

function firstNonEmptyTimestamp(...candidates: Array<string | undefined>): string | undefined {
	return candidates.find((candidate: string | undefined): candidate is string => (
		typeof candidate === "string" && candidate.length > 0
	));
}

function getTimelineEntryOrderAt(entry: Extract<TimelineBuildEntry, { type: "request" }>): string {
	return firstNonEmptyTimestamp(
		entry.userMessage?.createdAt,
		entry.firstEventAt,
		entry.assistantMessage?.createdAt,
		entry.orderAt
	) ?? "";
}

function getOrCreateRequestEntry(
	entries: Map<string, Extract<TimelineBuildEntry, { type: "request" }>>,
	requestId: string,
	orderAt: string,
	sequence: number
): Extract<TimelineBuildEntry, { type: "request" }> {
	const existing: Extract<TimelineBuildEntry, { type: "request" }> | undefined = entries.get(requestId);
	if (existing !== undefined) {
		if (orderAt.length > 0 && (existing.orderAt.length === 0 || orderAt < existing.orderAt)) {
			existing.orderAt = orderAt;
		}
		existing.sequence = Math.min(existing.sequence, sequence);
		return existing;
	}

	const entry: Extract<TimelineBuildEntry, { type: "request" }> = {
		type: "request",
		requestId,
		events: [],
		firstEventAt: "",
		lastEventAt: "",
		orderAt,
		sequence
	};
	entries.set(requestId, entry);
	return entry;
}

function createTimelineBuildEntries(
	messages: StoredMessage[],
	groupedEvents: Map<string, RequestEvents>,
	aliases: Map<string, string>
): TimelineBuildEntry[] {
	const requestEntries: Map<string, Extract<TimelineBuildEntry, { type: "request" }>> = new Map();
	const entries: TimelineBuildEntry[] = [];
	let sequence: number = 0;

	for (const message of messages) {
		const sourceRequestId: string = message.requestId ?? "";
		const requestId: string = aliases.get(sourceRequestId) ?? sourceRequestId;
		if (message.role !== "user" && message.role !== "assistant") {
			sequence += 1;
			continue;
		}

		if (requestId.length === 0) {
			entries.push({
				type: "standalone",
				message,
				orderAt: message.createdAt,
				sequence
			});
			sequence += 1;
			continue;
		}

		const entry = getOrCreateRequestEntry(requestEntries, requestId, message.createdAt, sequence);
		if (message.role === "user" && (entry.userMessage === undefined || message.createdAt < entry.userMessage.createdAt)) {
			entry.userMessage = message;
		}
		if (message.role === "assistant" && (entry.assistantMessage === undefined || message.createdAt > entry.assistantMessage.createdAt)) {
			entry.assistantMessage = message;
		}
		if (message.role === "assistant" && (entry.assistantIdentityCreatedAt === undefined || message.createdAt < entry.assistantIdentityCreatedAt)) {
			entry.assistantIdentityCreatedAt = message.createdAt;
		}
		entry.orderAt = getTimelineEntryOrderAt(entry);
		sequence += 1;
	}

	for (const [requestId, requestEvents] of groupedEvents.entries()) {
		const entry = getOrCreateRequestEntry(requestEntries, requestId, requestEvents.firstEventAt, sequence);
		entry.events = requestEvents.events;
		entry.firstEventAt = requestEvents.firstEventAt;
		entry.lastEventAt = requestEvents.lastEventAt;
		entry.orderAt = getTimelineEntryOrderAt(entry);
		sequence += 1;
	}

	for (const entry of requestEntries.values()) {
		const isOrphanPersistedTurn: boolean = groupedEvents.size > 0
			&& entry.events.length === 0
			&& entry.userMessage !== undefined
			&& entry.assistantMessage !== undefined;
		if (isOrphanPersistedTurn) {
			continue;
		}
		entries.push(entry);
	}
	return entries.sort(compareTimelineBuildEntries);
}

function getTodoIdentities(snapshot: unknown): string[] {
	if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
		return [];
	}

	const record = snapshot as { workflowId?: unknown; runId?: unknown };
	const identities: string[] = [];
	if (typeof record.workflowId === "string" && record.workflowId.length > 0) {
		identities.push(record.workflowId);
	}
	if (typeof record.runId === "string" && record.runId.length > 0) {
		identities.push(record.runId);
	}

	return identities;
}

function shouldClearDismissedSnapshot(snapshot: unknown | null, dismissedIdentities: string[]): boolean {
	if (snapshot === null) {
		return false;
	}
	if (dismissedIdentities.length === 0) {
		return true;
	}

	const snapshotIdentities: string[] = getTodoIdentities(snapshot);
	return snapshotIdentities.length === 0
		|| dismissedIdentities.some((identity: string): boolean => snapshotIdentities.includes(identity));
}

function shouldClearPlanClarificationForEvent(event: StoredSessionEvent, clarification: TimelinePlanClarification | null): boolean {
	if (clarification === null || !isRecord(event.data)) {
		return false;
	}

	if (event.event === "plan.generated" || event.event === "plan.revised" || event.event === "plan.approved" || event.event === "plan.execution.started" || event.event === "plan.error") {
		const planId: string = asString(event.data.planId);
		return planId.length === 0 || planId === clarification.planId;
	}

	if (event.event === "agent.run.error") {
		const planId: string = asString(event.data.planId);
		const requestId: string = asString(event.data.requestId);
		return planId === clarification.planId || requestId === clarification.requestId;
	}
	if (event.event === "agent.run.state") {
		const stage: string = asString(event.data.stage);
		const planId: string = asString(event.data.planId);
		const requestId: string = asString(event.data.requestId);
		return (stage === "failed" || stage === "cancelled")
			&& (planId === clarification.planId || requestId === clarification.requestId);
	}

	return false;
}

function findLatestSnapshots(events: StoredSessionEvent[]): { latestWorkflowSnapshot: unknown | null; latestAgentSnapshot: unknown | null; latestPlanClarification: TimelinePlanClarification | null; latestPlanApproval: TimelinePlanApproval | null } {
	let latestWorkflowSnapshot: unknown | null = null;
	let latestAgentSnapshot: unknown | null = null;
	let latestPlanClarification: TimelinePlanClarification | null = null;
	let latestPlanApproval: TimelinePlanApproval | null = null;
	for (const event of events) {
		if (event.event === "workflow.todo.updated") {
			latestWorkflowSnapshot = event.data;
		}
		if (event.event === "agent.run.snapshot") {
			latestAgentSnapshot = event.data;
		}
		if (event.event === "agent.run.state" && isRecord(event.data)) {
			if (isRecord(event.data.todo)) {
				const todo = structuredClone(event.data.todo);
				const terminal: Record<string, unknown> = isRecord(event.data.terminal) ? event.data.terminal : {};
				if (event.data.stage === "completed" && asString(terminal.resultStatus) !== "blocked") {
					for (const key of ["phases", "todos"] as const) {
					if (!Array.isArray(todo[key])) continue;
					todo[key] = todo[key].map((item: unknown): unknown => (
							isRecord(item)
								&& item.status !== "done"
								&& item.status !== "completed"
								&& item.status !== "success"
								? { ...item, status: "done" }
								: item
						));
					}
				}
				latestAgentSnapshot = todo;
			} else if (event.data.todo === null) {
				latestAgentSnapshot = null;
			}
		}
		if (event.event === "plan.clarification.required" && isRecord(event.data)) {
			latestPlanClarification = createPlanClarificationSnapshot(event.data);
			latestPlanApproval = null;
		}
		if ((event.event === "plan.generated" || event.event === "plan.revised") && isRecord(event.data)) {
			latestPlanApproval = createPlanApprovalSnapshot(event.data);
		}
		if (shouldClearPlanClarificationForEvent(event, latestPlanClarification)) {
			latestPlanClarification = null;
		}
		if ((event.event === "plan.generated" || event.event === "plan.revised" || event.event === "plan.approved" || event.event === "plan.execution.started") && isRecord(event.data)) {
			const planId: string = asString(event.data.planId);
			if ((event.event === "plan.approved" || event.event === "plan.execution.started") && (planId.length === 0 || planId === latestPlanApproval?.planId)) {
				latestPlanApproval = null;
			}
		}
		if (event.event === "workflow.todo.dismissed" || event.event === "agent.todo.dismissed") {
			const dismissedIdentities: string[] = getTodoIdentities(event.data);
			if (shouldClearDismissedSnapshot(latestWorkflowSnapshot, dismissedIdentities)) {
				latestWorkflowSnapshot = null;
			}
			if (shouldClearDismissedSnapshot(latestAgentSnapshot, dismissedIdentities)) {
				latestAgentSnapshot = null;
			}
		}
	}

	return { latestWorkflowSnapshot, latestAgentSnapshot, latestPlanClarification, latestPlanApproval };
}

function withRenderHints(block: TimelineBlock): TimelineBlock {
	return {
		...block,
		renderHints: createRenderHints(block)
	};
}

function createRenderHints(block: TimelineBlock): TimelineRenderHints {
	if (block.type === "user") {
		const contextCount: number = block.additionalContext?.length ?? 0;
		const textRows: number = Math.max(1, Math.ceil(block.content.length / 72));
		return {
			estimatedHeight: Math.max(88, 44 + textRows * 20 + contextCount * 32),
			contentChars: block.content.length,
			bodyPartCount: 0,
			heavyPartCount: contextCount
		};
	}

	let contentChars: number = block.content.length;
	let heavyPartCount: number = 0;
	for (const candidate of block.bodyParts) {
		if (!isTimelineBodyPart(candidate)) {
			continue;
		}
		const part: TimelineBodyPart = candidate;
		if (part.type === "markdown" || part.type === "thinking") {
			contentChars += part.text.length;
		}
		if (part.type === "tool") {
			heavyPartCount += Math.max(1, part.events.length);
		} else if (part.type === "thinking" || part.type === "inline_diff" || part.type === "plan" || part.type === "image_generation") {
			heavyPartCount += 1;
		}
	}

	const textRows: number = Math.max(1, Math.ceil(contentChars / 80));
	return {
		estimatedHeight: Math.max(140, 64 + textRows * 18 + block.bodyParts.length * 34 + heavyPartCount * 20),
		contentChars,
		bodyPartCount: block.bodyParts.length,
		heavyPartCount
	};
}

export function buildCanonicalTimelineBlocks(session: StoredSession): TimelineBuildResult {
	const sourceEvents: StoredSessionEvent[] = [...session.events].sort(compareEvents);
	const requestAliases: Map<string, string> = collectRequestAliases(sourceEvents);
	const groupedEvents: Map<string, RequestEvents> = collectRequestEvents(sourceEvents, requestAliases);
	const timelineEntries: TimelineBuildEntry[] = createTimelineBuildEntries(session.messages, groupedEvents, requestAliases);
	const blocks: TimelineBlock[] = [];

	for (const entry of timelineEntries) {
		if (entry.type === "standalone") {
			if (entry.message.role === "user") {
				blocks.push(createUserBlock(entry.message));
			} else if (entry.message.role === "assistant") {
				blocks.push(createAssistantBlock(
					session.metadata.id,
					"",
					entry.message.content,
					entry.message.createdAt,
					entry.message.createdAt,
					[],
					entry.message
				));
			}
			continue;
		}

		if (entry.userMessage !== undefined) {
			blocks.push(createUserBlock(entry.userMessage));
		}

		if (entry.assistantMessage !== undefined || entry.events.length > 0) {
			const startedAtUtc: string = firstNonEmptyTimestamp(
				entry.userMessage?.createdAt,
				entry.firstEventAt,
				entry.assistantMessage?.createdAt,
				entry.orderAt
			) ?? "";
			const completedAtUtc: string = firstNonEmptyTimestamp(
				entry.assistantMessage?.createdAt,
				entry.lastEventAt,
				startedAtUtc
			) ?? startedAtUtc;
			blocks.push(createAssistantBlock(
				session.metadata.id,
				entry.requestId,
				entry.assistantMessage?.content ?? "",
				startedAtUtc,
				completedAtUtc,
				entry.events,
				entry.assistantMessage,
				entry.assistantIdentityCreatedAt
			));
		}
	}

	const snapshots = findLatestSnapshots(sourceEvents);
	return {
		blocks: blocks.map(withRenderHints),
		eventCount: sourceEvents.length,
		latestWorkflowSnapshot: snapshots.latestWorkflowSnapshot,
		latestAgentSnapshot: snapshots.latestAgentSnapshot,
		latestPlanClarification: snapshots.latestPlanClarification,
		latestPlanApproval: snapshots.latestPlanApproval
	};
}
