import type WebSocket from "ws";
import type { AdditionalContextItem, ProviderId } from "../protocol/types.js";
import { getProviderDefaultModel, getProviderDisplayName } from "../providers/provider-registry.js";
import { resolveReasoningEffort, resolveReasoningEffortForModelChange } from "../providers/reasoning-effort.js";
import type { PendingApproval } from "../tools/approval-gateway.js";
import type { PendingToolBudget } from "../session/pending-tool-budget.js";
import { serializePendingToolBudget } from "../session/pending-tool-budget.js";
import { resolveModelProfile } from "../tokens/model-profiles.js";
import type {
	ClientSession,
	WorkbenchActiveRun,
	WorkbenchNextStepHint,
	WorkbenchNextStepHints
} from "./client-session.js";
import { serializeMessageQueue } from "./message-queue.js";
import { serializePendingGuide } from "./pending-guides.js";
import { sendSessionEvent } from "./session-events.js";

const MAX_COMPOSER_TEXT_CHARS: number = 20000;
const MAX_WORKBENCH_CONTEXTS: number = 10;
const INACTIVE_AGENT_RUN_STAGES: ReadonlySet<string> = new Set([
	"completed",
	"failed",
	"cancelled",
	"interrupted"
]);

export type WorkbenchAdditionalContextAction =
	| { action: "set"; items: AdditionalContextItem[] }
	| { action: "addOrReplace"; item: AdditionalContextItem }
	| { action: "remove"; contextId: string }
	| { action: "pin"; contextId: string; pinned: boolean }
	| { action: "clearUnpinned" };

export type WorkbenchPatch = {
	clientSequence?: number | undefined;
	composer?: {
		text?: string | undefined;
	chatMode?: "agent" | "ask" | "plan" | "goal" | undefined;
		provider?: ProviderId | undefined;
		model?: string | undefined;
		reasoningEffort?: string | undefined;
		additionalContext?: AdditionalContextItem[] | undefined;
	} | undefined;
	additionalContextAction?: WorkbenchAdditionalContextAction | undefined;
	nextStepHintsAction?: "clear" | undefined;
	activeRun?: Partial<WorkbenchActiveRun> | undefined;
};

function clipText(text: string, maxChars: number): string {
	return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function cloneContext(context: AdditionalContextItem): AdditionalContextItem {
	return { ...context, data: context.data === undefined ? undefined : structuredClone(context.data) };
}

function cloneContexts(contexts: readonly AdditionalContextItem[]): AdditionalContextItem[] {
	return contexts.slice(0, MAX_WORKBENCH_CONTEXTS).map(cloneContext);
}

function getContextDataRecord(context: AdditionalContextItem): Record<string, unknown> {
	return typeof context.data === "object" && context.data !== null && !Array.isArray(context.data)
		? context.data as Record<string, unknown>
		: {};
}

function getContextKey(context: AdditionalContextItem): string {
	if (context.kind === "image" || context.kind === "text_attachment") {
		const attachmentId: unknown = getContextDataRecord(context).attachmentId;
		if (typeof attachmentId === "string" && attachmentId.length > 0) {
			return `${context.kind}\n${attachmentId}`;
		}
	}
	if (context.kind === "script_selection") {
		const data: Record<string, unknown> = getContextDataRecord(context);
		return [
			context.kind,
			context.resourcePath ?? "",
			String(data.lineStart ?? 0),
			String(data.columnStart ?? 0),
			String(data.lineEnd ?? 0),
			String(data.columnEnd ?? 0)
		].join("\n");
	}
	if (context.kind === "filesystem_selection") {
		const selectedPaths: unknown = getContextDataRecord(context).selectedPaths;
		if (Array.isArray(selectedPaths)) {
			return [
				context.kind,
				...selectedPaths.map((item: unknown): string => {
					if (typeof item === "object" && item !== null && !Array.isArray(item)) {
						return String((item as Record<string, unknown>).resourcePath ?? "");
					}
					return "";
				})
			].join("\n");
		}
	}
	if (context.kind === "git_diff_comment") {
		return [context.kind, context.id].join("\n");
	}
	if (context.kind === "message_selection") {
		const data: Record<string, unknown> = getContextDataRecord(context);
		const anchor: Record<string, unknown> = typeof data.anchor === "object" && data.anchor !== null && !Array.isArray(data.anchor)
			? data.anchor as Record<string, unknown>
			: {};
		return [
			context.kind,
			String(anchor.entryId ?? ""),
			String(anchor.segmentKey ?? ""),
			String(anchor.startOffset ?? ""),
			String(anchor.endOffset ?? "")
		].join("\n");
	}
	if (context.kind === "file_selection") {
		const data: Record<string, unknown> = getContextDataRecord(context);
		return [
			context.kind,
			context.resourcePath ?? "",
			String(data.lineStart ?? ""),
			String(data.columnStart ?? ""),
			String(data.lineEnd ?? ""),
			String(data.columnEnd ?? "")
		].join("\n");
	}
	return [context.kind, context.resourcePath ?? "", context.nodePath ?? ""].join("\n");
}

function normalizeContexts(contexts: readonly AdditionalContextItem[]): AdditionalContextItem[] {
	const normalized: AdditionalContextItem[] = [];
	const indexesByKey: Map<string, number> = new Map();
	for (const context of contexts) {
		if (normalized.length >= MAX_WORKBENCH_CONTEXTS && !indexesByKey.has(getContextKey(context))) {
			break;
		}
		const key: string = getContextKey(context);
		const existingIndex: number | undefined = indexesByKey.get(key);
		const cloned: AdditionalContextItem = context.kind === "git_diff_comment"
			? { ...cloneContext(context), pinned: true }
			: context.kind === "message_selection" || context.kind === "file_selection"
				? { ...cloneContext(context), pinned: undefined }
				: cloneContext(context);
		if (existingIndex === undefined) {
			indexesByKey.set(key, normalized.length);
			normalized.push(cloned);
			continue;
		}
		const existing: AdditionalContextItem = normalized[existingIndex] as AdditionalContextItem;
		normalized[existingIndex] = {
			...cloned,
			id: existing.id,
			pinned: existing.pinned
		};
	}
	return normalized;
}

function findContextIndex(contexts: readonly AdditionalContextItem[], contextId: string): number {
	return contexts.findIndex((context: AdditionalContextItem): boolean => context.id === contextId);
}

export function bumpWorkbenchRevision(session: ClientSession): number {
	session.workbenchRevision += 1;
	return session.workbenchRevision;
}

function nextWorkbenchActiveRunSequence(session: ClientSession): number {
	session.workbenchActiveRunSequence += 1;
	return session.workbenchActiveRunSequence;
}

export function getCurrentWorkbenchActiveRunSequence(session: ClientSession): number {
	return session.workbenchActiveRun.sequence ?? session.workbenchActiveRunSequence;
}

export function clearWorkbenchComposer(session: ClientSession, preservePinnedContext: boolean = true): void {
	const now: string = new Date().toISOString();
	session.workbenchComposer = {
		...session.workbenchComposer,
		text: "",
		additionalContext: preservePinnedContext
			? session.workbenchComposer.additionalContext.filter((context: AdditionalContextItem): boolean => context.pinned === true).map(cloneContext)
			: [],
		updatedAt: now
	};
	bumpWorkbenchRevision(session);
}

export function setWorkbenchActiveRun(session: ClientSession, activeRun: Partial<WorkbenchActiveRun>): WorkbenchActiveRun {
	const sequence: number = nextWorkbenchActiveRunSequence(session);
	session.workbenchActiveRun = {
		...session.workbenchActiveRun,
		...activeRun,
		sequence
	};
	if (activeRun.status === "idle") {
		session.workbenchActiveRun = { status: "idle", sequence };
	}
	bumpWorkbenchRevision(session);
	return session.workbenchActiveRun;
}

export function setWorkbenchNextStepHints(
	session: ClientSession,
	hints: WorkbenchNextStepHint[],
	trigger: string | undefined,
	anchorRequestId: string | undefined,
	expectedGeneration?: number | undefined
): WorkbenchNextStepHints | undefined {
	if (
		expectedGeneration !== undefined
		&& expectedGeneration !== session.workbenchNextStepHintGeneration
	) {
		return undefined;
	}
	if (expectedGeneration === undefined) {
		session.workbenchNextStepHintGeneration += 1;
	}
	session.workbenchNextStepHints = {
		hints: hints.map((hint: WorkbenchNextStepHint): WorkbenchNextStepHint => ({ ...hint })),
		trigger,
		anchorRequestId,
		generatedAt: new Date().toISOString()
	};
	bumpWorkbenchRevision(session);
	return session.workbenchNextStepHints;
}

/**
 * A new user turn invalidates any in-flight background suggestion before it
 * can replace the placeholder for that turn.
 */
export function clearWorkbenchNextStepHints(
	session: ClientSession,
	anchorRequestId?: string | undefined,
	bumpRevision: boolean = true
): number {
	session.workbenchNextStepHintGeneration += 1;
	session.workbenchNextStepHints = {
		hints: [],
		anchorRequestId
	};
	if (bumpRevision) {
		bumpWorkbenchRevision(session);
	}
	return session.workbenchNextStepHintGeneration;
}

function serializePendingApproval(session: ClientSession): Record<string, unknown> {
	const pending: PendingApproval[] = session.approvalGateway.listPending();
	const first: PendingApproval | undefined = pending[0];
	return {
		count: pending.length,
		first: first === undefined ? null : {
			approvalId: first.approvalId,
			toolName: first.llmToolName,
			reason: first.reason
		}
	};
}

function getFirstPendingToolBudget(session: ClientSession): PendingToolBudget | undefined {
	return session.pendingToolBudgets.values().next().value as PendingToolBudget | undefined;
}

function deriveActiveRun(session: ClientSession): WorkbenchActiveRun {
	const sequence: number = getCurrentWorkbenchActiveRunSequence(session);
	if (session.approvalGateway.listPending().length > 0) {
		return {
			...session.workbenchActiveRun,
			status: "approval",
			requestId: session.workbenchActiveRun.requestId ?? session.activeRunRequestId,
			sequence
		};
	}
	const pendingToolBudget: PendingToolBudget | undefined = getFirstPendingToolBudget(session);
	if (pendingToolBudget !== undefined) {
		return {
			...session.workbenchActiveRun,
			status: "paused",
			statusCode: "tool_budget",
			requestId: pendingToolBudget.requestId,
			sequence
		};
	}
	if (session.activeRunRequestId !== undefined) {
		return {
			...session.workbenchActiveRun,
			status: session.workbenchActiveRun.status === "cancelling" ? "cancelling" : "streaming",
			requestId: session.activeRunRequestId,
			sequence
		};
	}
	if (session.workbenchActiveRun.status === "idle") {
		return { status: "idle", sequence };
	}
	if (session.workbenchActiveRun.requestId !== undefined) {
		const matchingRun = [...session.agentRuns.values()].find((run): boolean => (
			run.requestId === session.workbenchActiveRun.requestId
			&& !INACTIVE_AGENT_RUN_STAGES.has(run.stage)
		));
		if (matchingRun !== undefined) {
			return {
				...session.workbenchActiveRun,
				sequence
			};
		}
	}
	return { status: "idle", sequence };
}

function applyWorkbenchModelSelection(
	session: ClientSession,
	provider: ProviderId | undefined,
	model: string | undefined
): boolean {
	const nextProvider: ProviderId = provider ?? session.activeProvider;
	const providerChanged: boolean = nextProvider !== session.activeProvider;
	const currentModel: string = session.providerModel ?? getProviderDefaultModel(session.activeProvider);
	const nextModel: string = (model ?? (providerChanged ? getProviderDefaultModel(nextProvider) : currentModel)).trim();
	if (nextModel.length === 0) {
		return false;
	}

	if (!providerChanged && nextModel === currentModel) {
		return false;
	}

	const nextReasoningEffort: string | undefined = resolveReasoningEffortForModelChange(
		session.activeProvider,
		currentModel,
		session.workbenchComposer.reasoningEffort,
		nextProvider,
		nextModel
	);
	session.activeProvider = nextProvider;
	session.providerModel = nextModel;
	session.modelProfile = resolveModelProfile(nextProvider, nextModel);
	session.workbenchComposer.provider = undefined;
	session.workbenchComposer.model = undefined;
	session.workbenchComposer.reasoningEffort = nextReasoningEffort;
	if (providerChanged) {
		session.providerApiKey = undefined;
		session.providerBaseUrl = undefined;
		session.providerRequestOverrides = undefined;
	}
	return true;
}

export function serializeWorkbench(session: ClientSession): Record<string, unknown> {
	const pendingToolBudget: PendingToolBudget | undefined = getFirstPendingToolBudget(session);
	return {
		revision: session.workbenchRevision,
		sessionId: session.sessionId ?? null,
		composer: {
			text: session.workbenchComposer.text,
			chatMode: session.workbenchComposer.chatMode ?? null,
			provider: session.activeProvider,
			providerDisplayName: getProviderDisplayName(session.activeProvider),
			model: session.providerModel ?? session.modelProfile.model,
			reasoningEffort: session.workbenchComposer.reasoningEffort ?? null,
			additionalContext: cloneContexts(session.workbenchComposer.additionalContext),
			updatedAt: session.workbenchComposer.updatedAt
		},
		messageQueue: serializeMessageQueue(session),
		pendingGuides: session.pendingGuides.map(serializePendingGuide),
		activeRun: deriveActiveRun(session),
		pendingApproval: serializePendingApproval(session),
		pendingToolBudget: pendingToolBudget === undefined ? null : serializePendingToolBudget(pendingToolBudget),
		nextStepHints: {
			...session.workbenchNextStepHints,
			hints: session.workbenchNextStepHints.hints.map((hint: WorkbenchNextStepHint): WorkbenchNextStepHint => ({ ...hint }))
		},
		activeSelection: {
			workspaceId: session.activeWorkspace?.id ?? null,
			editorInstanceId: session.editorInstanceId ?? null
		}
	};
}

export function applyWorkbenchPatch(session: ClientSession, patch: WorkbenchPatch): boolean {
	let changed: boolean = false;
	const now: string = new Date().toISOString();
	if (patch.composer !== undefined) {
		if (patch.composer.text !== undefined) {
			session.workbenchComposer.text = clipText(patch.composer.text, MAX_COMPOSER_TEXT_CHARS);
			changed = true;
		}
		if (patch.composer.chatMode !== undefined) {
			session.workbenchComposer.chatMode = patch.composer.chatMode;
			changed = true;
		}
		if (patch.composer.provider !== undefined || patch.composer.model !== undefined) {
			changed = applyWorkbenchModelSelection(session, patch.composer.provider, patch.composer.model) || changed;
		}
		if (patch.composer.reasoningEffort !== undefined) {
			const model: string = session.providerModel ?? session.modelProfile.model;
			const resolved: string | undefined = resolveReasoningEffort(session.activeProvider, model, patch.composer.reasoningEffort);
			if (resolved !== session.workbenchComposer.reasoningEffort) {
				session.workbenchComposer.reasoningEffort = resolved;
				changed = true;
			}
		}
		if (patch.composer.additionalContext !== undefined) {
			session.workbenchComposer.additionalContext = normalizeContexts(patch.composer.additionalContext);
			changed = true;
		}
	}
	if (patch.additionalContextAction !== undefined) {
		const action: WorkbenchAdditionalContextAction = patch.additionalContextAction;
		if (action.action === "set") {
			session.workbenchComposer.additionalContext = normalizeContexts(action.items);
			changed = true;
		} else if (action.action === "addOrReplace") {
			session.workbenchComposer.additionalContext = normalizeContexts([...session.workbenchComposer.additionalContext, action.item]);
			changed = true;
		} else if (action.action === "remove") {
			const index: number = findContextIndex(session.workbenchComposer.additionalContext, action.contextId);
			if (index >= 0) {
				session.workbenchComposer.additionalContext.splice(index, 1);
				changed = true;
			}
		} else if (action.action === "pin") {
			const index: number = findContextIndex(session.workbenchComposer.additionalContext, action.contextId);
			if (index >= 0) {
				const context: AdditionalContextItem = session.workbenchComposer.additionalContext[index] as AdditionalContextItem;
				if (context.kind === "message_selection" || context.kind === "file_selection") {
					return changed;
				}
				session.workbenchComposer.additionalContext[index] = {
					...context,
					pinned: context.kind === "git_diff_comment" ? true : action.pinned
				};
				changed = true;
			}
		} else if (action.action === "clearUnpinned") {
			session.workbenchComposer.additionalContext = session.workbenchComposer.additionalContext
				.filter((context: AdditionalContextItem): boolean => context.pinned === true)
				.map(cloneContext);
			changed = true;
		}
	}
	if (patch.nextStepHintsAction === "clear") {
		clearWorkbenchNextStepHints(session, undefined, false);
		changed = true;
	}
	if (patch.activeRun !== undefined) {
		const sequence: number = nextWorkbenchActiveRunSequence(session);
		session.workbenchActiveRun = {
			...session.workbenchActiveRun,
			...patch.activeRun,
			sequence
		};
		if (patch.activeRun.status === "idle") {
			session.workbenchActiveRun = { status: "idle", sequence };
		}
		changed = true;
	}
	if (changed) {
		session.workbenchComposer.updatedAt = now;
		bumpWorkbenchRevision(session);
	}
	return changed;
}

export function emitWorkbenchUpdated(socket: WebSocket, requestId: string, session: ClientSession): void {
	sendSessionEvent(socket, requestId, session, "session.workbench.updated", {
		type: "session.workbench.updated",
		workbench: serializeWorkbench(session),
		updatedAt: new Date().toISOString()
	});
}
