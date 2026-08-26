export const TRACE_RECORD_KINDS = [
	"turn",
	"prompt",
	"model_call",
	"thinking",
	"tool_call",
	"approval",
	"retry",
	"step",
	"provider_reconnect",
	"final_response",
	"error"
] as const;

export type TraceRecordKind = typeof TRACE_RECORD_KINDS[number];

export type TraceRecordStatus =
	| "pending"
	| "running"
	| "success"
	| "error"
	| "cancelled"
	| "approval_required";

export type TraceDetailLevel = "full" | "summary" | "compacted";

export type TraceRecord = {
	recordId: string;
	parentId?: string | undefined;
	sessionId: string;
	sequence: number;
	turn: number;
	kind: TraceRecordKind;
	status: TraceRecordStatus;
	requestId: string;
	runId?: string | undefined;
	stepId?: string | undefined;
	toolCallId?: string | undefined;
	provider?: string | undefined;
	model?: string | undefined;
	startedAt: string;
	finishedAt?: string | undefined;
	durationMs?: number | undefined;
	inputTokens?: number | undefined;
	outputTokens?: number | undefined;
	detailLevel: TraceDetailLevel;
	summary: Record<string, unknown>;
	contentHash?: string | undefined;
	truncated: boolean;
	hasDetails: boolean;
	revision: number;
};

export type TracePromptSectionKind =
	| "system"
	| "developer"
	| "history"
	| "user"
	| "tools"
	| "workspace"
	| "context"
	| "provider";

export type TracePromptSection = {
	id: string;
	kind: TracePromptSectionKind;
	label: string;
	content?: unknown;
	charCount: number;
	contentHash: string;
	truncated: boolean;
};

export type TraceSummary = {
	revision: number;
	turnCount: number;
	modelCallCount: number;
	toolCallCount: number;
	errorCount: number;
	durationMs: number;
	inputTokens: number;
	outputTokens: number;
	hasDetails: boolean;
};

export type TracePage = {
	revision: number;
	records: TraceRecord[];
	nextCursor?: string | undefined;
};

export type TraceDetail = {
	record: TraceRecord;
	promptSections: TracePromptSection[];
	request?: unknown;
	response?: unknown;
	providerResult?: unknown;
	redactions: string[];
	detailLevel: TraceDetailLevel;
	detailsHidden?: boolean | undefined;
};

export type TracePayload = {
	promptSections?: TracePromptSection[] | undefined;
	request?: unknown;
	response?: unknown;
	thinking?: string | undefined;
	toolInput?: unknown;
	toolOutput?: unknown;
	[key: string]: unknown;
};

export type TraceRecordWrite = Omit<TraceRecord, "sequence" | "turn" | "hasDetails" | "revision"> & {
	turn?: number | undefined;
	payload?: TracePayload | undefined;
	redactedFields?: string[] | undefined;
};
