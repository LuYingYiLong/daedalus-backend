import type { ProviderChatOptions } from "../providers/provider-types.js";
import { resolveProviderAdapterFamily, resolveProviderEndpointType } from "../providers/provider-adapter.js";
import { getProviderDefaultModel } from "../providers/provider-registry.js";
import { createTokenCounter } from "../tokens/token-counter-factory.js";
import { logger } from "../logger.js";
import type { NormalizedLlmUsage, ProviderUsageContext, UsageMetricsStatus } from "./metrics-types.js";
import { createEstimatedUsage, createMissingUsage } from "./usage-parser.js";
import { recordUsageMetrics } from "./metrics-store.js";
import { recordActiveProviderTraceUsage } from "../trace/trace-recorder.js";

type ProviderUsageRecordParams = {
	options: ProviderChatOptions;
	requestBody: unknown;
	responseBody?: unknown | undefined;
	outputText?: string | undefined;
	startedAtMs: number;
	firstTokenAtMs?: number | undefined;
	status: UsageMetricsStatus;
	errorCode?: string | undefined;
	streaming: boolean;
	usage?: NormalizedLlmUsage | null | undefined;
};

let tokenCounterPromise: ReturnType<typeof createTokenCounter> | null = null;

function getTokenCounter(): ReturnType<typeof createTokenCounter> {
	if (tokenCounterPromise === null) {
		tokenCounterPromise = createTokenCounter();
	}
	return tokenCounterPromise;
}

function stringifyForEstimate(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return String(value);
	}
}

function createUsageContext(options: ProviderChatOptions): ProviderUsageContext | null {
	const context: ProviderUsageContext | undefined = options.usageContext;
	if (context === undefined || context.requestId.trim().length === 0 || context.operation.trim().length === 0) {
		return null;
	}
	return context;
}

async function estimateUsage(requestBody: unknown, outputText: string | undefined, status: UsageMetricsStatus): Promise<NormalizedLlmUsage> {
	try {
		const counter = await getTokenCounter();
		const inputTokens: number = await counter.countText(stringifyForEstimate(requestBody));
		const outputTokens: number = outputText === undefined || outputText.length === 0
			? 0
			: await counter.countText(outputText);
		return createEstimatedUsage(inputTokens, outputTokens);
	} catch (error: unknown) {
		logger.warn("usage_metrics", "estimate_failed", {
			status,
			message: error instanceof Error ? error.message : String(error)
		});
		return createMissingUsage();
	}
}

function normalizeDurationMs(startedAtMs: number, completedAtMs: number): number {
	return Math.max(0, Math.round(completedAtMs - startedAtMs));
}

function normalizeFirstTokenMs(startedAtMs: number, firstTokenAtMs: number | undefined): number | undefined {
	if (firstTokenAtMs === undefined) {
		return undefined;
	}
	return Math.max(0, Math.round(firstTokenAtMs - startedAtMs));
}

function resolveUsageModel(options: ProviderChatOptions): string {
	return options.model ?? getProviderDefaultModel(options.provider);
}

export function withProviderUsageContext(options: ProviderChatOptions, contextPatch: Partial<ProviderUsageContext>): ProviderChatOptions {
	const existing: ProviderUsageContext | undefined = options.usageContext;
	const requestId: string | undefined = contextPatch.requestId ?? existing?.requestId;
	const operation: string | undefined = contextPatch.operation ?? existing?.operation;
	if (requestId === undefined || operation === undefined) {
		return { ...options };
	}
	return {
		...options,
		usageContext: {
			requestId,
			runId: contextPatch.runId ?? existing?.runId,
			sessionId: contextPatch.sessionId ?? existing?.sessionId,
			workspaceId: contextPatch.workspaceId ?? existing?.workspaceId,
			operation,
			phaseId: contextPatch.phaseId ?? existing?.phaseId
		}
	};
}

export async function recordProviderUsage(params: ProviderUsageRecordParams): Promise<void> {
	const context: ProviderUsageContext | null = createUsageContext(params.options);
	if (context === null) {
		return;
	}

	try {
		const completedAtMs: number = Date.now();
		const usage: NormalizedLlmUsage = params.usage
			?? await estimateUsage(params.requestBody, params.outputText, params.status);
		await recordUsageMetrics({
			requestId: context.requestId,
			runId: context.runId,
			sessionId: context.sessionId,
			workspaceId: context.workspaceId,
			operation: context.operation,
			phaseId: context.phaseId,
			provider: params.options.provider,
			model: resolveUsageModel(params.options),
			endpointType: resolveProviderEndpointType(params.options),
			adapterFamily: resolveProviderAdapterFamily(params.options),
			startedAt: new Date(params.startedAtMs).toISOString(),
			completedAt: new Date(completedAtMs).toISOString(),
			durationMs: normalizeDurationMs(params.startedAtMs, completedAtMs),
			firstTokenMs: normalizeFirstTokenMs(params.startedAtMs, params.firstTokenAtMs),
			status: params.status,
			errorCode: params.errorCode,
			streaming: params.streaming,
			usage
		});
		try {
			await recordActiveProviderTraceUsage({
				usage,
				request: params.requestBody,
				response: params.responseBody,
				outputText: params.outputText
			});
		} catch (error: unknown) {
			logger.warn("trace", "provider_usage_record_failed", {
				requestId: context.requestId,
				provider: params.options.provider,
				model: params.options.model,
				message: error instanceof Error ? error.message : String(error)
			});
		}
	} catch (error: unknown) {
		logger.warn("usage_metrics", "record_failed", {
			requestId: context.requestId,
			operation: context.operation,
			provider: params.options.provider,
			model: params.options.model,
			message: error instanceof Error ? error.message : String(error)
		});
	}
}

export function getProviderUsageStatusForError(error: unknown): UsageMetricsStatus {
	if (error instanceof Error && (error.name === "AbortError" || /cancelled|aborted/i.test(error.message))) {
		return "cancelled";
	}
	return "error";
}

export function getProviderUsageErrorCode(error: unknown): string {
	if (error instanceof Error) {
		const code: unknown = (error as { code?: unknown }).code;
		if (typeof code === "string" && code.length > 0) {
			return code;
		}
		const status: unknown = (error as { status?: unknown }).status;
		if (typeof status === "number") {
			return `http_${status}`;
		}
		return error.name.length > 0 ? error.name : "provider_error";
	}
	return "provider_error";
}
