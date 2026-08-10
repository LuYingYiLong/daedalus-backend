import type { WorkspaceFileRef } from "../workspace/source-context.js";

export const CONTEXT_LEDGER_SCHEMA_VERSION = 1 as const;

export type ContextBlockKind = "user" | "assistant" | "tool" | "terminal" | "summary";
export type ContextCompressionLevel = "raw" | "capture" | "distill" | "condense";
export type ContextBlockStatus = "active" | "compressed";

export type StructuredContextFailure = {
	code: string;
	message: string;
	fileRefs: WorkspaceFileRef[];
};

export type StructuredContextSummary = {
	userGoals: string[];
	constraints: string[];
	decisions: string[];
	workspaceFacts: string[];
	changedFiles: WorkspaceFileRef[];
	verification: string[];
	unresolvedFailures: StructuredContextFailure[];
	pendingApprovals: string[];
	openQuestions: string[];
	nextActions: string[];
};

export type ContextBlock = {
	schemaVersion: typeof CONTEXT_LEDGER_SCHEMA_VERSION;
	blockId: string;
	sessionId: string;
	requestId?: string | undefined;
	kind: ContextBlockKind;
	level: ContextCompressionLevel;
	status: ContextBlockStatus;
	tokenEstimate: number;
	sourceFolderId?: string | undefined;
	fileRefs: WorkspaceFileRef[];
	protectedReason?: string | undefined;
	coveredBlockIds: string[];
	coveredMessageKeys: string[];
	content: string;
	summary?: StructuredContextSummary | undefined;
	createdAt: string;
	updatedAt: string;
};

export type ContextCompressionSource = "model" | "automatic" | "manual" | "emergency" | "local_fallback";
export type ContextCompressionStatus = "running" | "completed" | "failed";

export type ContextCompressionRecord = {
	compressionId: string;
	sessionId: string;
	requestId?: string | undefined;
	generation: number;
	level: Exclude<ContextCompressionLevel, "raw">;
	source: ContextCompressionSource;
	status: ContextCompressionStatus;
	beforeTokens: number;
	afterTokens: number;
	savedTokens: number;
	coveredBlockIds: string[];
	summaryBlockId?: string | undefined;
	warning?: string | undefined;
	createdAt: string;
	updatedAt: string;
};

export type ActiveContextLedger = {
	generation: number;
	activeSummaries: ContextBlock[];
	coveredMessageKeys: Set<string>;
};

export type ContextBudgetSnapshot = {
	inputTokens: number;
	outputReserveTokens: number;
	safetyMarginTokens: number;
	contextWindowTokens: number;
	committedTokens: number;
	availableTokens: number;
	inputPercent: number;
	outputReservePercent: number;
	safetyMarginPercent: number;
	committedPercent: number;
	availablePercent: number;
	pressure: "low" | "moderate" | "high" | "critical";
	shouldNudge: boolean;
	shouldAutoCompress: boolean;
	shouldEmergencyCompress: boolean;
};

export type AgentContextState = {
	schemaVersion: typeof CONTEXT_LEDGER_SCHEMA_VERSION;
	generation: number;
	activeSummaryBlockIds: string[];
	compactedToolResultBlockIds: string[];
};

export function createEmptyStructuredContextSummary(): StructuredContextSummary {
	return {
		userGoals: [],
		constraints: [],
		decisions: [],
		workspaceFacts: [],
		changedFiles: [],
		verification: [],
		unresolvedFailures: [],
		pendingApprovals: [],
		openQuestions: [],
		nextActions: []
	};
}
