import type { AiChatParams, ProviderId } from "../protocol/types.js";
import type { AgentContinuation } from "../providers/agent-types.js";
import type { ProviderChatOptions } from "../providers/deepseek-client.js";
import { getProviderAdapterFamily, getProviderDefaultModel, getProviderEndpointTypeForModel } from "../providers/provider-registry.js";
import { resolveModelProfile } from "../tokens/model-profiles.js";
import type { PendingAiContinuation } from "./pending-continuation.js";
import type { PendingApproval } from "../tools/approval-gateway.js";
import { cloneLightweightActionState, type LightweightActionState } from "../workflow/lightweight-action.js";
import type { WorkflowRunState } from "../workflow/types.js";
import type { StoredApprovalEvent } from "./session-store.js";

export type PersistedProviderChatOptions = {
	provider?: ProviderId | undefined;
	model?: string | undefined;
	baseUrl?: string | undefined;
};

export type PersistedPendingAiContinuation = {
	params: AiChatParams;
	options: PersistedProviderChatOptions;
	continuation: AgentContinuation;
	allowedToolNames?: readonly string[] | undefined;
	userMessage: string;
	requestId: string;
	userCreatedAt: string;
	stream: boolean;
	lightweightActionState?: LightweightActionState | undefined;
	agentRunState?: WorkflowRunState | undefined;
	workflowState?: WorkflowRunState | undefined;
};

export type PersistedApprovalRequestedData = {
	approval: PendingApproval;
	continuation?: PersistedPendingAiContinuation | undefined;
	workspaceId?: string | undefined;
	createdAt: string;
};

export type PendingApprovalState = {
	approval: PendingApproval;
	status: "pending" | "interrupted";
	restored: boolean;
	interrupted: boolean;
	requestId: string;
	createdAt: string;
	updatedAt: string;
	continuation?: PersistedPendingAiContinuation | undefined;
	workspaceId?: string | undefined;
	lastError?: string | undefined;
};

export function createPersistedApprovalRequestedData(
	approval: PendingApproval,
	continuation: PendingAiContinuation | undefined,
	workspaceId: string | undefined
): PersistedApprovalRequestedData {
	const data: PersistedApprovalRequestedData = {
		approval,
		createdAt: new Date(approval.createdAt).toISOString()
	};

	if (continuation !== undefined) {
		data.continuation = createPersistedPendingContinuation(continuation);
	}
	if (workspaceId !== undefined) {
		data.workspaceId = workspaceId;
	}

	return data;
}

export function createRuntimePendingContinuation(
	persisted: PersistedPendingAiContinuation,
	apiKey: string
): PendingAiContinuation {
	const provider = persisted.options.provider ?? "deepseek";
	const model: string = persisted.options.model ?? getProviderDefaultModel(provider);
	const endpointType = getProviderEndpointTypeForModel(provider, model);
	const options: ProviderChatOptions = {
		provider,
		apiKey,
		model,
		endpointType,
		adapterFamily: getProviderAdapterFamily(provider, endpointType),
		modelProfile: resolveModelProfile(provider, model)
	};
	if (persisted.options.baseUrl !== undefined) {
		options.baseUrl = persisted.options.baseUrl;
	}

	const continuation: PendingAiContinuation = {
		params: persisted.params,
		options,
		continuation: persisted.continuation,
		userMessage: persisted.userMessage,
		requestId: persisted.requestId,
		userCreatedAt: persisted.userCreatedAt,
		stream: persisted.stream
	};

	if (persisted.allowedToolNames !== undefined) {
		continuation.allowedToolNames = [...persisted.allowedToolNames];
	}
	if (persisted.lightweightActionState !== undefined) {
		continuation.lightweightActionState = cloneLightweightActionState(persisted.lightweightActionState);
	}
	const persistedRunState: WorkflowRunState | undefined = persisted.agentRunState ?? persisted.workflowState;
	if (persistedRunState !== undefined) {
		continuation.agentRunState = persistedRunState;
		continuation.workflowState = persistedRunState;
	}

	return continuation;
}

export function foldPendingApprovalStates(events: StoredApprovalEvent[]): PendingApprovalState[] {
	const states: Map<string, PendingApprovalState> = new Map();
	const sortedEvents: StoredApprovalEvent[] = [...events].sort((left: StoredApprovalEvent, right: StoredApprovalEvent): number => {
		const timeComparison: number = left.createdAt.localeCompare(right.createdAt);
		return timeComparison !== 0 ? timeComparison : left.id.localeCompare(right.id);
	});

	for (const event of sortedEvents) {
		if (event.schemaVersion !== 1) {
			continue;
		}

		if (event.event === "requested") {
			const requestedData: PersistedApprovalRequestedData | null = parseRequestedData(event.data);
			if (requestedData === null) {
				continue;
			}

			states.set(event.approvalId, {
				approval: requestedData.approval,
				status: "pending",
				restored: true,
				interrupted: false,
				requestId: event.requestId,
				createdAt: event.createdAt,
				updatedAt: event.createdAt,
				continuation: requestedData.continuation,
				workspaceId: requestedData.workspaceId
			});
			continue;
		}

		const existing: PendingApprovalState | undefined = states.get(event.approvalId);
		if (existing === undefined) {
			continue;
		}

		if (event.event === "rejected" || event.event === "executed" || event.event === "cancelled") {
			states.delete(event.approvalId);
			continue;
		}

		if (event.event === "executing") {
			existing.status = "interrupted";
			existing.interrupted = true;
			existing.updatedAt = event.createdAt;
			states.set(event.approvalId, existing);
			continue;
		}

		if (event.event === "approved") {
			existing.updatedAt = event.createdAt;
			states.set(event.approvalId, existing);
			continue;
		}

		if (event.event === "failed") {
			existing.status = "pending";
			existing.interrupted = false;
			existing.updatedAt = event.createdAt;
			existing.lastError = extractErrorMessage(event.data);
			states.set(event.approvalId, existing);
		}
	}

	return [...states.values()];
}

export function mergeHydratedPendingApprovalStates(
	hydratedStates: PendingApprovalState[],
	memoryStates: PendingApprovalState[]
): PendingApprovalState[] {
	const mergedStates: PendingApprovalState[] = [...hydratedStates];
	const hydratedIds: Set<string> = new Set(hydratedStates.map((state: PendingApprovalState): string => state.approval.approvalId));

	for (const memoryState of memoryStates) {
		if (!hydratedIds.has(memoryState.approval.approvalId)) {
			mergedStates.push(memoryState);
		}
	}

	return mergedStates;
}

export function serializePendingApprovalState(state: PendingApprovalState): Record<string, unknown> {
	const result: Record<string, unknown> = {
		...state.approval,
		status: state.status,
		restored: state.restored,
		interrupted: state.interrupted,
		requestId: state.requestId,
		createdAt: state.createdAt,
		updatedAt: state.updatedAt
	};

	if (state.lastError !== undefined) {
		result.lastError = state.lastError;
	}
	if (state.workspaceId !== undefined) {
		result.workspaceId = state.workspaceId;
	}

	return result;
}

function createPersistedPendingContinuation(continuation: PendingAiContinuation): PersistedPendingAiContinuation {
	const options: PersistedProviderChatOptions = {
		provider: continuation.options.provider
	};
	if (continuation.options.model !== undefined) {
		options.model = continuation.options.model;
	}
	if (continuation.options.baseUrl !== undefined) {
		options.baseUrl = continuation.options.baseUrl;
	}

	const persisted: PersistedPendingAiContinuation = {
		params: sanitizeAiChatParamsForPersistence(continuation.params),
		options,
		continuation: continuation.continuation,
		userMessage: continuation.userMessage,
		requestId: continuation.requestId,
		userCreatedAt: continuation.userCreatedAt,
		stream: continuation.stream
	};

	if (continuation.allowedToolNames !== undefined) {
		persisted.allowedToolNames = [...continuation.allowedToolNames];
	}
	if (continuation.lightweightActionState !== undefined) {
		persisted.lightweightActionState = cloneLightweightActionState(continuation.lightweightActionState);
	}
	const runState: WorkflowRunState | undefined = continuation.agentRunState ?? continuation.workflowState;
	if (runState !== undefined) {
		persisted.agentRunState = {
			...runState,
			originalParams: sanitizeAiChatParamsForPersistence(runState.originalParams)
		};
	}

	return persisted;
}

function sanitizeAiChatParamsForPersistence(params: AiChatParams): AiChatParams {
	const sanitized: AiChatParams = { ...params };
	const additionalContext = cloneAdditionalContextItems(params.additionalContext);
	if (additionalContext !== undefined) {
		sanitized.additionalContext = additionalContext;
	}
	return sanitized;
}

function cloneAdditionalContextItems(items: AiChatParams["additionalContext"]): AiChatParams["additionalContext"] {
	if (items === undefined || items.length === 0) {
		return undefined;
	}

	return items.map((item) => {
		const clonedItem = { ...item };
		if (item.kind === "image" && item.data !== undefined && typeof item.data === "object" && item.data !== null && !Array.isArray(item.data)) {
			const data: Record<string, unknown> = { ...(item.data as Record<string, unknown>) };
			if (typeof data.attachmentId === "string" && data.attachmentId.length > 0) {
				delete data.dataUrl;
				delete data.thumbnailDataUrl;
			}
			clonedItem.data = data;
		}
		return clonedItem;
	});
}

function parseRequestedData(value: unknown): PersistedApprovalRequestedData | null {
	if (!isRecord(value)) {
		return null;
	}

	const approvalValue: unknown = value.approval;
	if (!isPendingApproval(approvalValue)) {
		return null;
	}

	const data: PersistedApprovalRequestedData = {
		approval: approvalValue,
		createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date(approvalValue.createdAt).toISOString()
	};

	if (isPersistedContinuation(value.continuation)) {
		data.continuation = value.continuation;
	}
	if (typeof value.workspaceId === "string") {
		data.workspaceId = value.workspaceId;
	}

	return data;
}

function isPersistedContinuation(value: unknown): value is PersistedPendingAiContinuation {
	if (!isRecord(value)) {
		return false;
	}

	return isRecord(value.params)
		&& isRecord(value.options)
		&& isRecord(value.continuation)
		&& typeof value.userMessage === "string"
		&& typeof value.requestId === "string"
		&& typeof value.userCreatedAt === "string"
		&& typeof value.stream === "boolean";
}

function isPendingApproval(value: unknown): value is PendingApproval {
	if (!isRecord(value)) {
		return false;
	}

	return typeof value.approvalId === "string"
		&& typeof value.toolCallId === "string"
		&& typeof value.toolName === "string"
		&& typeof value.llmToolName === "string"
		&& isRecord(value.args)
		&& typeof value.reason === "string"
		&& typeof value.createdAt === "number";
}

function extractErrorMessage(value: unknown): string | undefined {
	if (!isRecord(value)) {
		return undefined;
	}

	return typeof value.message === "string" ? value.message : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
