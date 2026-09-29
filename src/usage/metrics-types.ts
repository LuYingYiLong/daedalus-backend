import type { AdapterFamily, EndpointType } from "../providers/provider-types.js";
import type { PromptVariant } from "./prompt-cache-policy.js";

export type UsageSource = "provider" | "estimated" | "missing";

export type UsageMetricsStatus = "success" | "error" | "cancelled";

export type UsageInputTokenSemantics = "fresh" | "total";

export type UsageTrendBucket = "hour" | "day";
export type UsageOperationClass = "conversation" | "review" | "auxiliary";

export type ProviderUsageContext = {
	requestId: string;
	runId?: string | undefined;
	sessionId?: string | undefined;
	workspaceId?: string | undefined;
	operation: string;
	phaseId?: string | undefined;
	promptVariant?: PromptVariant | undefined;
};

export type NormalizedLlmUsage = {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	rawInputTokens: number;
	totalTokens: number;
	realTotalTokens: number;
	usageSource: UsageSource;
	inputTokenSemantics: UsageInputTokenSemantics;
};

export type UsageMetricsRecordInput = ProviderUsageContext & {
	usageId?: string | undefined;
	provider: string;
	model: string;
	endpointType: EndpointType;
	adapterFamily: AdapterFamily;
	startedAt: string;
	completedAt: string;
	durationMs: number;
	firstTokenMs?: number | undefined;
	status: UsageMetricsStatus;
	errorCode?: string | undefined;
	streaming: boolean;
	usage: NormalizedLlmUsage;
};

export type UsageMetricsLog = {
	usageId: string;
	requestId: string;
	runId?: string | undefined;
	sessionId?: string | undefined;
	workspaceId?: string | undefined;
	operation: string;
	operationClass: UsageOperationClass;
	promptVariant: PromptVariant | "unknown";
	phaseId?: string | undefined;
	provider: string;
	model: string;
	endpointType: EndpointType;
	adapterFamily: AdapterFamily;
	startedAt: string;
	completedAt: string;
	durationMs: number;
	firstTokenMs?: number | undefined;
	status: UsageMetricsStatus;
	errorCode?: string | undefined;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	rawInputTokens: number;
	totalTokens: number;
	realTotalTokens: number;
	cacheHitRate: number;
	usageSource: UsageSource;
	inputTokenSemantics: UsageInputTokenSemantics;
	streaming: boolean;
	estimatedCostUsd?: number | undefined;
};

export type UsageMetricsFilters = {
	startAt?: string | undefined;
	endAt?: string | undefined;
	provider?: string | undefined;
	model?: string | undefined;
	sessionId?: string | undefined;
	workspaceId?: string | undefined;
	operation?: string | undefined;
	operationClass?: UsageOperationClass | undefined;
	promptVariant?: PromptVariant | "unknown" | undefined;
	status?: UsageMetricsStatus | undefined;
	usageSource?: UsageSource | undefined;
};

export type UsageMetricsGroupSummary = {
	key: string;
	requests: number;
	successfulRequests: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	realTotalTokens: number;
	estimatedRows: number;
	providerRows: number;
	cacheHitRate: number;
};

export type UsageMetricsSummary = {
	available: boolean;
	errorMessage?: string | undefined;
	requests: number;
	successfulRequests: number;
	successRate: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	rawInputTokens: number;
	totalTokens: number;
	realTotalTokens: number;
	estimatedRows: number;
	providerRows: number;
	missingRows: number;
	cacheHitRate: number;
	byProvider: UsageMetricsGroupSummary[];
	byModel: UsageMetricsGroupSummary[];
	bySession: UsageMetricsGroupSummary[];
	byWorkspace: UsageMetricsGroupSummary[];
};

export type UsageMetricsLogsListResult = {
	available: boolean;
	errorMessage?: string | undefined;
	logs: UsageMetricsLog[];
	total: number;
	limit: number;
	offset: number;
};

export type UsageMetricsTrendPoint = {
	bucket: string;
	requests: number;
	successfulRequests: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	realTotalTokens: number;
	cacheHitRate: number;
};

export type UsageMetricsTrendsResult = {
	available: boolean;
	errorMessage?: string | undefined;
	bucket: UsageTrendBucket;
	points: UsageMetricsTrendPoint[];
};
