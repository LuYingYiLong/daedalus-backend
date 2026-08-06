export type TimelineActivityStats = {
	editedFiles: number;
	commands: number;
	thoughts: number;
};

export type ActivityGroupAnnotation = {
	activityGroupId: string;
	activityPartId: string;
	activityPartKind: "thinking" | "tool";
	activityGroupStats: TimelineActivityStats;
};

export type ActivityGroupAccumulator = {
	nextGroupSequence: number;
	currentGroup?: ActivityGroupState;
	toolParts: Map<string, ActivityToolPartState>;
};

type ActivityGroupState = {
	id: string;
	nextPartSequence: number;
	currentPartId?: string;
	currentPartKind?: "thinking" | "tool";
	currentThinkingHasText: boolean;
	stats: TimelineActivityStats;
	editedFileRefs: Set<string>;
	countedBatchIds: Set<string>;
	countedTerminalToolCallIds: Set<string>;
	fallbackEditedFiles: number;
};

type ActivityToolPartState = {
	group: ActivityGroupState;
	activityPartId: string;
};

const TERMINAL_RUN_TOOL_PREFIX: string = "mcp_terminal_run_";

export function createActivityGroupAccumulator(): ActivityGroupAccumulator {
	return { nextGroupSequence: 0, toolParts: new Map<string, ActivityToolPartState>() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(data: Record<string, unknown>, key: string): string {
	const value: unknown = data[key];
	return typeof value === "string" ? value.trim() : "";
}

function getNumber(data: Record<string, unknown>, key: string): number {
	const value: unknown = data[key];
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function getToolCallKey(data: Record<string, unknown>): string {
	return getString(data, "toolCallId")
		|| getString(data, "approvalId")
		|| getString(data, "_eventRecordId")
		|| getString(data, "eventId")
		|| getString(data, "toolName")
		|| "tool";
}

function canTrackToolPart(data: Record<string, unknown>): boolean {
	return getString(data, "toolCallId").length > 0 || getString(data, "approvalId").length > 0;
}

function isThinkingEvent(eventName: string): boolean {
	return eventName === "agent.thinking.delta"
		|| eventName === "agent.thinking.done"
		|| eventName === "ai.thinking.delta"
		|| eventName === "ai.thinking.done";
}

function isToolEvent(eventName: string): boolean {
	return eventName.startsWith("agent.tool.") || eventName.startsWith("tool.");
}

function isActivityEvent(eventName: string): boolean {
	return isThinkingEvent(eventName) || isToolEvent(eventName);
}

function isTerminalRunState(data: Record<string, unknown>): boolean {
	const stage: string = getString(data, "stage");
	return stage === "completed" || stage === "failed" || stage === "cancelled" || stage === "interrupted";
}

/**
 * Only semantic, user-visible boundaries close a group. Lifecycle snapshots
 * and workflow phase markers such as `agent.run.state: executing` or
 * `agent.step.outcome` do not produce a timeline body part, so treating them
 * as boundaries fragments one operational batch into many single-item rows.
 */
function closesActivityGroup(eventName: string, data: Record<string, unknown>): boolean {
	if (
		eventName === "agent.message.delta"
		|| eventName === "agent.message.done"
		|| eventName === "ai.delta"
		|| eventName === "ai.done"
		|| eventName === "agent.provider.reconnect"
		|| eventName === "agent.summary.started"
		|| eventName === "agent.context.compression"
		|| eventName === "agent.status"
		|| eventName === "ai.status"
		|| eventName === "agent.run.done"
		|| eventName === "agent.run.error"
		|| eventName === "agent.run.cancelled"
		|| eventName.startsWith("plan.")
	) {
		return true;
	}

	return eventName === "agent.run.state" && isTerminalRunState(data);
}

function isTerminalRunTool(toolName: string): boolean {
	return toolName.startsWith(TERMINAL_RUN_TOOL_PREFIX);
}

function updateEditedFileStats(group: ActivityGroupState, data: Record<string, unknown>): void {
	if (data.ok === false || !isRecord(data.fileEditBatch)) {
		return;
	}

	const batch: Record<string, unknown> = data.fileEditBatch;
	const batchId: string = getString(batch, "batchId");
	if (batchId.length > 0 && group.countedBatchIds.has(batchId)) {
		return;
	}
	if (batchId.length > 0) {
		group.countedBatchIds.add(batchId);
	}

	const batchSourceFolderId: string = getString(batch, "sourceFolderId");
	const editedFiles: unknown = batch.editedFiles;
	if (Array.isArray(editedFiles) && editedFiles.length > 0) {
		for (const fileValue of editedFiles) {
			if (!isRecord(fileValue) || getString(fileValue, "path").length === 0) {
				continue;
			}
			const sourceFolderId: string = getString(fileValue, "sourceFolderId") || batchSourceFolderId;
			group.editedFileRefs.add(`${sourceFolderId}:${getString(fileValue, "path")}`);
		}
		group.stats.editedFiles = group.editedFileRefs.size + group.fallbackEditedFiles;
		return;
	}

	group.fallbackEditedFiles += getNumber(batch, "editedFileCount");
	group.stats.editedFiles = group.editedFileRefs.size + group.fallbackEditedFiles;
}

function getGroupStats(group: ActivityGroupState): TimelineActivityStats {
	return { ...group.stats };
}

export function annotateActivityEvent(
	accumulator: ActivityGroupAccumulator,
	requestKey: string,
	eventName: string,
	data: Record<string, unknown>
): Record<string, unknown> {
	if (!isActivityEvent(eventName)) {
		if (closesActivityGroup(eventName, data)) {
			delete accumulator.currentGroup;
		}
		return data;
	}

	const activityPartKind: "thinking" | "tool" = isThinkingEvent(eventName) ? "thinking" : "tool";
	const activityPartKey: string = activityPartKind === "thinking"
		? "thinking"
		: getToolCallKey(data);
	const trackedToolPart: ActivityToolPartState | undefined = activityPartKind === "tool" && canTrackToolPart(data)
		? accumulator.toolParts.get(activityPartKey)
		: undefined;
	if (trackedToolPart !== undefined) {
		const group: ActivityGroupState = trackedToolPart.group;
		if (eventName === "agent.tool.result" || eventName === "tool.result") {
			updateEditedFileStats(group, data);
		}
		return {
			...data,
			activityGroupId: group.id,
			activityPartId: trackedToolPart.activityPartId,
			activityPartKind,
			activityGroupStats: getGroupStats(group)
		};
	}

	let group: ActivityGroupState | undefined = accumulator.currentGroup;
	if (group === undefined) {
		accumulator.nextGroupSequence += 1;
		group = {
			id: `activity:${requestKey}:${accumulator.nextGroupSequence}`,
			nextPartSequence: 0,
			currentThinkingHasText: false,
			stats: { editedFiles: 0, commands: 0, thoughts: 0 },
			editedFileRefs: new Set<string>(),
			countedBatchIds: new Set<string>(),
			countedTerminalToolCallIds: new Set<string>(),
			fallbackEditedFiles: 0
		};
		accumulator.currentGroup = group;
	}

	if (group.currentPartKind !== activityPartKind || group.currentPartId !== activityPartKey) {
		group.nextPartSequence += 1;
		group.currentPartKind = activityPartKind;
		group.currentPartId = activityPartKey;
		if (activityPartKind === "thinking") {
			group.currentThinkingHasText = false;
		} else if (isTerminalRunTool(getString(data, "toolName")) && !group.countedTerminalToolCallIds.has(activityPartKey)) {
			group.countedTerminalToolCallIds.add(activityPartKey);
			group.stats.commands += 1;
		}
	}
	if (activityPartKind === "thinking" && getString(data, "text").length > 0 && !group.currentThinkingHasText) {
		group.currentThinkingHasText = true;
		group.stats.thoughts += 1;
	}

	if (activityPartKind === "tool" && (eventName === "agent.tool.result" || eventName === "tool.result")) {
		updateEditedFileStats(group, data);
	}

	const annotation: ActivityGroupAnnotation = {
		activityGroupId: group.id,
		activityPartId: `${activityPartKind}:${group.currentPartId}:${group.nextPartSequence}`,
		activityPartKind,
		activityGroupStats: getGroupStats(group)
	};
	if (activityPartKind === "tool" && canTrackToolPart(data)) {
		accumulator.toolParts.set(activityPartKey, { group, activityPartId: annotation.activityPartId });
	}
	return { ...data, ...annotation };
}
