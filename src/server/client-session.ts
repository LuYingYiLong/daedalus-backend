import type { AdditionalContextItem, AiChatParams, ChatMessage, ModelProfile, ProviderId } from "../protocol/types.js";
import type { SessionMetadata } from "../session/session-store.js";
import type { PendingAiContinuation } from "../session/pending-continuation.js";
import type { PendingToolBudget } from "../session/pending-tool-budget.js";
import { ApprovalGateway } from "../tools/approval-gateway.js";
import { getDefaultModelProfile, resolveModelProfile } from "../tokens/model-profiles.js";
import { getProviderDefaultModel, isProviderId } from "../providers/provider-registry.js";
import { resolveReasoningEffort } from "../providers/reasoning-effort.js";
import type { WorkspaceConfig } from "../workspace/types.js";
import type { AgentRunState } from "../workflow/agent-run-state.js";
import type { ToolRisk } from "../tools/tool-policy.js";
import { createActivityGroupAccumulator, type ActivityGroupAccumulator } from "../session/activity-groups.js";
import type { ProviderRequestOverrides } from "../providers/provider-request-overrides.js";

export type PendingGuide = {
	id: string;
	clientGuideId: string;
	text: string;
	anchorRequestId?: string | undefined;
	createdAt: string;
	updatedAt: string;
};

export type QueuedMessageStatus = "pending" | "sending" | "approval" | "failed" | "cancelled" | "rejected";

export type QueuedMessage = {
	id: number;
	text: string;
	additionalContext: AiChatParams["additionalContext"];
	mode?: "agent" | "ask" | "plan" | "goal" | undefined;
	provider?: ProviderId | undefined;
	model?: string | undefined;
	reasoningEffort?: string | undefined;
	executionPolicy?: "auto" | "read_only" | undefined;
	verificationPolicy?: "required" | "best_effort" | "skip" | undefined;
	outputTarget?: "chat" | "workspace" | undefined;
	skillRefs?: AiChatParams["skillRefs"];
	status: QueuedMessageStatus;
	createdAt: string;
	updatedAt: string;
};

export type WorkbenchComposer = {
	text: string;
	chatMode?: "agent" | "ask" | "plan" | "goal" | undefined;
	provider?: ProviderId | undefined;
	model?: string | undefined;
	reasoningEffort?: string | undefined;
	additionalContext: AdditionalContextItem[];
	updatedAt: string;
};

export type WorkbenchActiveRunStatus = "idle" | "streaming" | "paused" | "approval" | "cancelling";

export type WorkbenchActiveRun = {
	status: WorkbenchActiveRunStatus;
	requestId?: string | undefined;
	startedAt?: string | undefined;
	queueItemId?: number | undefined;
	statusCode?: string | undefined;
	sequence?: number | undefined;
};

export type WorkbenchNextStepHint = {
	title: string;
	message: string;
};

export type WorkbenchNextStepHints = {
	hints: WorkbenchNextStepHint[];
	anchorRequestId?: string | undefined;
	trigger?: string | undefined;
	generatedAt?: string | undefined;
};

export type ThinkingEventBuffer = {
	sessionId: string;
	requestId: string;
	eventName: string;
	data: Record<string, unknown>;
	text: string;
};

export type { PendingAiContinuation } from "../session/pending-continuation.js";

export type ClientSession = {
	activeProvider: ProviderId;
	providerApiKey?: string | undefined;
	providerModel?: string | undefined;
	providerBaseUrl?: string | undefined;
	providerRequestOverrides?: ProviderRequestOverrides | undefined;
	godotExecutablePath?: string | undefined;
	godotProjectPath?: string | undefined;
	messages: ChatMessage[];
	modelProfile: ModelProfile;
	approvalGateway: ApprovalGateway;
	activeWorkspace?: WorkspaceConfig | undefined;
	editorInstanceId?: string | undefined;
	sessionId?: string | undefined;
	sessionTitle?: string | undefined;
	summaryMessage?: ChatMessage | undefined;
	summaryCoveredMessageCount?: number | undefined;
	pendingAiContinuations: Map<string, PendingAiContinuation>;
	pendingToolBudgets: Map<string, PendingToolBudget>;
	aiDeltaEventBuffers: Map<string, ThinkingEventBuffer>;
	thinkingEventBuffers: Map<string, ThinkingEventBuffer>;
	activeAbortControllers: Map<string, AbortController>;
	inFlightRequestIds: Set<string>;
	completedRequestIds: Map<string, number>;
	terminalErrorEventFingerprints: Set<string>;
	eventPersistQueue: Promise<void>;
	pendingGuides: PendingGuide[];
	queuedMessages: QueuedMessage[];
	messageQueueNextId: number;
	messageQueueDrainActive: boolean;
	workbenchRevision: number;
	workbenchActiveRunSequence: number;
	workbenchComposer: WorkbenchComposer;
	workbenchActiveRun: WorkbenchActiveRun;
	workbenchNextStepHints: WorkbenchNextStepHints;
	workbenchClientPatchSequences: Map<string, number>;
	fullSessionLoadPromise?: Promise<void> | undefined;
	activeRunRequestId?: string | undefined;
	agentRuns: Map<string, AgentRunState>;
	agentRunToolCalls: Map<string, Map<string, {
		toolName: string;
		risk: ToolRisk;
		args: Record<string, unknown>;
	}>>;
	activityGroupAccumulators: Map<string, ActivityGroupAccumulator>;
};

export function createClientSession(defaultWorkspace: WorkspaceConfig | undefined): ClientSession {
	return {
		activeProvider: "deepseek",
		messages: [],
		modelProfile: getDefaultModelProfile(),
		approvalGateway: new ApprovalGateway(),
		activeWorkspace: defaultWorkspace,
		pendingAiContinuations: new Map(),
		pendingToolBudgets: new Map(),
		aiDeltaEventBuffers: new Map(),
		thinkingEventBuffers: new Map(),
		activeAbortControllers: new Map(),
		inFlightRequestIds: new Set(),
		completedRequestIds: new Map(),
		terminalErrorEventFingerprints: new Set(),
		pendingGuides: [],
		queuedMessages: [],
		messageQueueNextId: 0,
		messageQueueDrainActive: false,
		workbenchRevision: 0,
		workbenchActiveRunSequence: 0,
		workbenchComposer: {
			text: "",
			additionalContext: [],
			updatedAt: new Date().toISOString()
		},
		workbenchActiveRun: {
			status: "idle"
		},
		workbenchNextStepHints: {
			hints: []
		},
		workbenchClientPatchSequences: new Map(),
		agentRuns: new Map(),
		agentRunToolCalls: new Map(),
		activityGroupAccumulators: new Map(),
		eventPersistQueue: Promise.resolve()
	};
}

export function applyWorkspaceToSession(session: ClientSession, workspace: WorkspaceConfig | undefined): void {
	if (workspace === undefined) {
		session.activeWorkspace = undefined;
		session.godotProjectPath = undefined;
		session.godotExecutablePath = undefined;
		return;
	}

	session.activeWorkspace = workspace;
	session.godotProjectPath = workspace.rootPath;
	session.godotExecutablePath = workspace.godotExecutablePath;
}

export function clearActiveSession(session: ClientSession): void {
	session.sessionId = undefined;
	session.sessionTitle = undefined;
	session.messages = [];
	session.fullSessionLoadPromise = undefined;
	session.summaryMessage = undefined;
	session.summaryCoveredMessageCount = undefined;
	session.pendingToolBudgets.clear();
	session.pendingGuides = [];
	session.queuedMessages = [];
	session.messageQueueNextId = 0;
	session.messageQueueDrainActive = false;
	session.workbenchRevision = 0;
	session.workbenchActiveRunSequence = 0;
	session.workbenchComposer = {
		text: "",
		additionalContext: [],
		updatedAt: new Date().toISOString()
	};
	session.workbenchActiveRun = { status: "idle" };
	session.workbenchNextStepHints = { hints: [] };
	session.workbenchClientPatchSequences.clear();
	session.aiDeltaEventBuffers.clear();
	session.thinkingEventBuffers.clear();
	session.terminalErrorEventFingerprints.clear();
	session.agentRuns.clear();
	session.agentRunToolCalls.clear();
	session.activityGroupAccumulators.clear();
}

export function applySessionMetadata(session: ClientSession, metadata: SessionMetadata): void {
	session.sessionId = metadata.id;
	session.sessionTitle = metadata.title;
	if (metadata.provider !== undefined && isProviderId(metadata.provider)) {
		session.activeProvider = metadata.provider;
		session.providerModel = metadata.model ?? getProviderDefaultModel(metadata.provider);
		session.modelProfile = resolveModelProfile(metadata.provider, session.providerModel);
		session.providerApiKey = undefined;
		session.providerBaseUrl = undefined;
		session.providerRequestOverrides = undefined;
	}
	if (metadata.reasoningEffort !== undefined) {
		const model: string = session.providerModel ?? session.modelProfile.model;
		session.workbenchComposer.reasoningEffort = resolveReasoningEffort(session.activeProvider, model, metadata.reasoningEffort);
	}
}
