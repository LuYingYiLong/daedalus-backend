import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { getUsageMetricsDbPath } from "../app-paths.js";
import { logger } from "../logger.js";
import { broadcastGlobalEvent } from "../server/client-connections.js";
import type {
	UsageMetricsFilters,
	UsageOperationClass,
	UsageMetricsGroupSummary,
	UsageMetricsLog,
	UsageMetricsLogsListResult,
	UsageMetricsRecordInput,
	UsageMetricsSummary,
	UsageMetricsTrendPoint,
	UsageMetricsTrendsResult,
	UsageTrendBucket
} from "./metrics-types.js";
import { calculateCacheHitRate } from "./usage-parser.js";

type StoreState =
	| {
		available: true;
		db: DatabaseSync;
	}
	| {
		available: false;
		errorMessage: string;
	};

type QueryParts = {
	whereSql: string;
	params: SQLInputValue[];
};

const DB_SCHEMA_VERSION: number = 2;
const DEFAULT_LOG_LIMIT: number = 100;
const MAX_LOG_LIMIT: number = 500;
const CONVERSATION_OPERATIONS: ReadonlySet<string> = new Set([
	"chat", "direct_answer", "read", "probe", "lightweight", "agent_loop",
	"tool_assisted", "workflow", "workflow_phase", "tool_answer", "stop_hook_continuation"
]);
const OPERATION_CLASS_SQL: string = `CASE WHEN operation = 'action_review' THEN 'review' WHEN operation IN (${[...CONVERSATION_OPERATIONS].map((operation: string): string => `'${operation}'`).join(", ")}) THEN 'conversation' ELSE 'auxiliary' END`;

export function classifyUsageOperation(operation: string): UsageOperationClass {
	return operation === "action_review" ? "review" : CONVERSATION_OPERATIONS.has(operation) ? "conversation" : "auxiliary";
}

let storeStatePromise: Promise<StoreState> | null = null;
let testDbPathOverride: string | null = null;
let availabilitySnapshot: { available: boolean | null; errorMessage?: string | undefined } = { available: null };

function resolveUsageDbPath(): string {
	const envPath: string | undefined = process.env.DAEDALUS_USAGE_DB_PATH;
	if (envPath !== undefined && envPath.trim().length > 0) {
		return envPath;
	}
	if (testDbPathOverride !== null) {
		return testDbPathOverride;
	}
	return getUsageMetricsDbPath();
}

function clampLogLimit(limit: number | undefined): number {
	if (limit === undefined) {
		return DEFAULT_LOG_LIMIT;
	}
	return Math.min(MAX_LOG_LIMIT, Math.max(1, Math.floor(limit)));
}

function normalizeOffset(offset: number | undefined): number {
	if (offset === undefined) {
		return 0;
	}
	return Math.max(0, Math.floor(offset));
}

function toNumber(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "bigint") {
		return Number(value);
	}
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed: number = Number(value);
		return Number.isFinite(parsed) ? parsed : 0;
	}
	return 0;
}

function toStringOrUndefined(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toNullableString(value: string | undefined): string | null {
	return value === undefined ? null : value;
}

function getCacheHitRateFromRow(row: Record<string, unknown>): number {
	return calculateCacheHitRate(
		toNumber(row.input_tokens),
		toNumber(row.cache_read_tokens),
		toNumber(row.cache_creation_tokens)
	);
}

function createUnavailableSummary(errorMessage: string): UsageMetricsSummary {
	return {
		available: false,
		errorMessage,
		requests: 0,
		successfulRequests: 0,
		successRate: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		rawInputTokens: 0,
		totalTokens: 0,
		realTotalTokens: 0,
		estimatedRows: 0,
		providerRows: 0,
		missingRows: 0,
		cacheHitRate: 0,
		byProvider: [],
		byModel: [],
		bySession: [],
		byWorkspace: []
	};
}

function createUnavailableLogs(errorMessage: string, limit: number, offset: number): UsageMetricsLogsListResult {
	return {
		available: false,
		errorMessage,
		logs: [],
		total: 0,
		limit,
		offset
	};
}

function createUnavailableTrends(errorMessage: string, bucket: UsageTrendBucket): UsageMetricsTrendsResult {
	return {
		available: false,
		errorMessage,
		bucket,
		points: []
	};
}

function migrate(db: DatabaseSync): void {
	db.exec(`
		PRAGMA journal_mode = WAL;
		CREATE TABLE IF NOT EXISTS llm_usage_requests (
			usage_id TEXT PRIMARY KEY,
			request_id TEXT NOT NULL,
			run_id TEXT,
			session_id TEXT,
			workspace_id TEXT,
			operation TEXT NOT NULL,
			prompt_variant TEXT,
			phase_id TEXT,
			provider TEXT NOT NULL,
			model TEXT NOT NULL,
			endpoint_type TEXT NOT NULL,
			adapter_family TEXT NOT NULL,
			started_at TEXT NOT NULL,
			completed_at TEXT NOT NULL,
			duration_ms INTEGER NOT NULL,
			first_token_ms INTEGER,
			status TEXT NOT NULL,
			error_code TEXT,
			input_tokens INTEGER NOT NULL,
			output_tokens INTEGER NOT NULL,
			cache_read_tokens INTEGER NOT NULL,
			cache_creation_tokens INTEGER NOT NULL,
			raw_input_tokens INTEGER NOT NULL,
			total_tokens INTEGER NOT NULL,
			real_total_tokens INTEGER NOT NULL,
			usage_source TEXT NOT NULL,
			input_token_semantics TEXT NOT NULL,
			streaming INTEGER NOT NULL,
			estimated_cost_usd REAL
		);
		CREATE INDEX IF NOT EXISTS idx_llm_usage_completed_at ON llm_usage_requests (completed_at);
		CREATE INDEX IF NOT EXISTS idx_llm_usage_provider_model ON llm_usage_requests (provider, model);
		CREATE INDEX IF NOT EXISTS idx_llm_usage_session ON llm_usage_requests (session_id);
		CREATE INDEX IF NOT EXISTS idx_llm_usage_workspace ON llm_usage_requests (workspace_id);
	`);
	const columns = db.prepare("PRAGMA table_info(llm_usage_requests)").all() as Array<{ name: string }>;
	if (!columns.some((column): boolean => column.name === "prompt_variant")) {
		db.exec("ALTER TABLE llm_usage_requests ADD COLUMN prompt_variant TEXT");
	}
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_llm_usage_operation ON llm_usage_requests (operation);
		CREATE INDEX IF NOT EXISTS idx_llm_usage_prompt_variant ON llm_usage_requests (prompt_variant);
		PRAGMA user_version = ${DB_SCHEMA_VERSION};
	`);
}

async function openStore(): Promise<StoreState> {
	try {
		const sqliteModule = await import("node:sqlite");
		const dbPath: string = resolveUsageDbPath();
		mkdirSync(dirname(dbPath), { recursive: true });
		const db = new sqliteModule.DatabaseSync(dbPath, {
			timeout: 5000
		});
		migrate(db);
		availabilitySnapshot = { available: true };
		return {
			available: true,
			db
		};
	} catch (error: unknown) {
		const errorMessage: string = error instanceof Error ? error.message : String(error);
		logger.warn("usage_metrics", "sqlite_unavailable", { message: errorMessage });
		availabilitySnapshot = { available: false, errorMessage };
		return {
			available: false,
			errorMessage
		};
	}
}

export function getUsageMetricsAvailabilitySnapshot(): { available: boolean | null; errorMessage?: string | undefined } {
	return { ...availabilitySnapshot };
}

export async function initializeUsageMetricsStore(): Promise<StoreState> {
	if (storeStatePromise === null) {
		storeStatePromise = openStore();
	}
	return storeStatePromise;
}

function createFilterQuery(filters: UsageMetricsFilters | undefined): QueryParts {
	const where: string[] = [];
	const params: SQLInputValue[] = [];
	if (filters?.startAt !== undefined) {
		where.push("completed_at >= ?");
		params.push(filters.startAt);
	}
	if (filters?.endAt !== undefined) {
		where.push("completed_at <= ?");
		params.push(filters.endAt);
	}
	if (filters?.provider !== undefined) {
		where.push("provider = ?");
		params.push(filters.provider);
	}
	if (filters?.model !== undefined) {
		where.push("model = ?");
		params.push(filters.model);
	}
	if (filters?.sessionId !== undefined) {
		where.push("session_id = ?");
		params.push(filters.sessionId);
	}
	if (filters?.workspaceId !== undefined) {
		where.push("workspace_id = ?");
		params.push(filters.workspaceId);
	}
	if (filters?.operation !== undefined) {
		where.push("operation = ?");
		params.push(filters.operation);
	}
	if (filters?.operationClass !== undefined) {
		where.push(`${OPERATION_CLASS_SQL} = ?`);
		params.push(filters.operationClass);
	}
	if (filters?.promptVariant !== undefined) {
		where.push("COALESCE(prompt_variant, 'unknown') = ?");
		params.push(filters.promptVariant);
	}
	if (filters?.status !== undefined) {
		where.push("status = ?");
		params.push(filters.status);
	}
	if (filters?.usageSource !== undefined) {
		where.push("usage_source = ?");
		params.push(filters.usageSource);
	}
	return {
		whereSql: where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`,
		params
	};
}

function mapAggregateRow(row: Record<string, unknown> | undefined): Omit<UsageMetricsSummary, "available" | "errorMessage" | "byProvider" | "byModel" | "bySession" | "byWorkspace"> {
	const requests: number = toNumber(row?.requests);
	const successfulRequests: number = toNumber(row?.successful_requests);
	const inputTokens: number = toNumber(row?.input_tokens);
	const cacheReadTokens: number = toNumber(row?.cache_read_tokens);
	const cacheCreationTokens: number = toNumber(row?.cache_creation_tokens);
	return {
		requests,
		successfulRequests,
		successRate: requests <= 0 ? 0 : successfulRequests / requests,
		inputTokens,
		outputTokens: toNumber(row?.output_tokens),
		cacheReadTokens,
		cacheCreationTokens,
		rawInputTokens: toNumber(row?.raw_input_tokens),
		totalTokens: toNumber(row?.total_tokens),
		realTotalTokens: toNumber(row?.real_total_tokens),
		estimatedRows: toNumber(row?.estimated_rows),
		providerRows: toNumber(row?.provider_rows),
		missingRows: toNumber(row?.missing_rows),
		cacheHitRate: calculateCacheHitRate(inputTokens, cacheReadTokens, cacheCreationTokens)
	};
}

function selectAggregate(db: DatabaseSync, filters: UsageMetricsFilters | undefined): Record<string, unknown> | undefined {
	const query: QueryParts = createFilterQuery(filters);
	return db.prepare(`
		SELECT
			COUNT(*) AS requests,
			SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successful_requests,
			COALESCE(SUM(input_tokens), 0) AS input_tokens,
			COALESCE(SUM(output_tokens), 0) AS output_tokens,
			COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
			COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
			COALESCE(SUM(raw_input_tokens), 0) AS raw_input_tokens,
			COALESCE(SUM(total_tokens), 0) AS total_tokens,
			COALESCE(SUM(real_total_tokens), 0) AS real_total_tokens,
			SUM(CASE WHEN usage_source = 'estimated' THEN 1 ELSE 0 END) AS estimated_rows,
			SUM(CASE WHEN usage_source = 'provider' THEN 1 ELSE 0 END) AS provider_rows,
			SUM(CASE WHEN usage_source = 'missing' THEN 1 ELSE 0 END) AS missing_rows
		FROM llm_usage_requests
		${query.whereSql}
	`).get(...query.params);
}

function mapGroupRow(row: Record<string, unknown>): UsageMetricsGroupSummary {
	const requests: number = toNumber(row.requests);
	const successfulRequests: number = toNumber(row.successful_requests);
	const inputTokens: number = toNumber(row.input_tokens);
	const cacheReadTokens: number = toNumber(row.cache_read_tokens);
	const cacheCreationTokens: number = toNumber(row.cache_creation_tokens);
	return {
		key: String(row.group_key ?? ""),
		requests,
		successfulRequests,
		inputTokens,
		outputTokens: toNumber(row.output_tokens),
		cacheReadTokens,
		cacheCreationTokens,
		realTotalTokens: toNumber(row.real_total_tokens),
		estimatedRows: toNumber(row.estimated_rows),
		providerRows: toNumber(row.provider_rows),
		cacheHitRate: calculateCacheHitRate(inputTokens, cacheReadTokens, cacheCreationTokens)
	};
}

function selectGroups(db: DatabaseSync, groupColumn: string, filters: UsageMetricsFilters | undefined): UsageMetricsGroupSummary[] {
	const query: QueryParts = createFilterQuery(filters);
	return db.prepare(`
		SELECT
			COALESCE(${groupColumn}, '') AS group_key,
			COUNT(*) AS requests,
			SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successful_requests,
			COALESCE(SUM(input_tokens), 0) AS input_tokens,
			COALESCE(SUM(output_tokens), 0) AS output_tokens,
			COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
			COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
			COALESCE(SUM(real_total_tokens), 0) AS real_total_tokens,
			SUM(CASE WHEN usage_source = 'estimated' THEN 1 ELSE 0 END) AS estimated_rows,
			SUM(CASE WHEN usage_source = 'provider' THEN 1 ELSE 0 END) AS provider_rows
		FROM llm_usage_requests
		${query.whereSql}
		GROUP BY ${groupColumn}
		ORDER BY real_total_tokens DESC, requests DESC
		LIMIT 100
	`).all(...query.params).map(mapGroupRow);
}

function mapLogRow(row: Record<string, unknown>): UsageMetricsLog {
	const inputTokens: number = toNumber(row.input_tokens);
	const cacheReadTokens: number = toNumber(row.cache_read_tokens);
	const cacheCreationTokens: number = toNumber(row.cache_creation_tokens);
	const estimatedCostValue: number = toNumber(row.estimated_cost_usd);
	return {
		usageId: String(row.usage_id ?? ""),
		requestId: String(row.request_id ?? ""),
		runId: toStringOrUndefined(row.run_id),
		sessionId: toStringOrUndefined(row.session_id),
		workspaceId: toStringOrUndefined(row.workspace_id),
		operation: String(row.operation ?? ""),
		operationClass: classifyUsageOperation(String(row.operation ?? "")),
		promptVariant: String(row.prompt_variant ?? "unknown") as UsageMetricsLog["promptVariant"],
		phaseId: toStringOrUndefined(row.phase_id),
		provider: String(row.provider ?? ""),
		model: String(row.model ?? ""),
		endpointType: String(row.endpoint_type ?? "openai-chat-completions") as UsageMetricsLog["endpointType"],
		adapterFamily: String(row.adapter_family ?? "openai-compatible") as UsageMetricsLog["adapterFamily"],
		startedAt: String(row.started_at ?? ""),
		completedAt: String(row.completed_at ?? ""),
		durationMs: toNumber(row.duration_ms),
		firstTokenMs: row.first_token_ms === null ? undefined : toNumber(row.first_token_ms),
		status: String(row.status ?? "error") as UsageMetricsLog["status"],
		errorCode: toStringOrUndefined(row.error_code),
		inputTokens,
		outputTokens: toNumber(row.output_tokens),
		cacheReadTokens,
		cacheCreationTokens,
		rawInputTokens: toNumber(row.raw_input_tokens),
		totalTokens: toNumber(row.total_tokens),
		realTotalTokens: toNumber(row.real_total_tokens),
		cacheHitRate: calculateCacheHitRate(inputTokens, cacheReadTokens, cacheCreationTokens),
		usageSource: String(row.usage_source ?? "missing") as UsageMetricsLog["usageSource"],
		inputTokenSemantics: String(row.input_token_semantics ?? "fresh") as UsageMetricsLog["inputTokenSemantics"],
		streaming: toNumber(row.streaming) === 1,
		estimatedCostUsd: estimatedCostValue > 0 ? estimatedCostValue : undefined
	};
}

export async function recordUsageMetrics(input: UsageMetricsRecordInput): Promise<boolean> {
	const state: StoreState = await initializeUsageMetricsStore();
	if (!state.available) {
		return false;
	}

	const usageId: string = input.usageId ?? randomUUID();
	const result = state.db.prepare(`
		INSERT OR IGNORE INTO llm_usage_requests (
			usage_id,
			request_id,
			run_id,
			session_id,
			workspace_id,
			operation,
			prompt_variant,
			phase_id,
			provider,
			model,
			endpoint_type,
			adapter_family,
			started_at,
			completed_at,
			duration_ms,
			first_token_ms,
			status,
			error_code,
			input_tokens,
			output_tokens,
			cache_read_tokens,
			cache_creation_tokens,
			raw_input_tokens,
			total_tokens,
			real_total_tokens,
			usage_source,
			input_token_semantics,
			streaming,
			estimated_cost_usd
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
	`).run(
		usageId,
		input.requestId,
		toNullableString(input.runId),
		toNullableString(input.sessionId),
		toNullableString(input.workspaceId),
		input.operation,
		toNullableString(input.promptVariant),
		toNullableString(input.phaseId),
		input.provider,
		input.model,
		input.endpointType,
		input.adapterFamily,
		input.startedAt,
		input.completedAt,
		input.durationMs,
		input.firstTokenMs ?? null,
		input.status,
		toNullableString(input.errorCode),
		input.usage.inputTokens,
		input.usage.outputTokens,
		input.usage.cacheReadTokens,
		input.usage.cacheCreationTokens,
		input.usage.rawInputTokens,
		input.usage.totalTokens,
		input.usage.realTotalTokens,
		input.usage.usageSource,
		input.usage.inputTokenSemantics,
		input.streaming ? 1 : 0
	);
	if (Number(result.changes) <= 0) {
		return false;
	}

	broadcastGlobalEvent(input.requestId, "usage.metrics.recorded", {
		usageId,
		requestId: input.requestId,
		runId: input.runId,
		sessionId: input.sessionId,
		workspaceId: input.workspaceId,
		operation: input.operation,
		provider: input.provider,
		model: input.model,
		status: input.status,
		usageSource: input.usage.usageSource,
		realTotalTokens: input.usage.realTotalTokens,
		completedAt: input.completedAt
	});
	return true;
}

export async function getUsageMetricsSummary(filters?: UsageMetricsFilters | undefined): Promise<UsageMetricsSummary> {
	const state: StoreState = await initializeUsageMetricsStore();
	if (!state.available) {
		return createUnavailableSummary(state.errorMessage);
	}
	const aggregate = mapAggregateRow(selectAggregate(state.db, filters));
	return {
		available: true,
		...aggregate,
		byProvider: selectGroups(state.db, "provider", filters),
		byModel: selectGroups(state.db, "provider || '/' || model", filters),
		bySession: selectGroups(state.db, "session_id", filters),
		byWorkspace: selectGroups(state.db, "workspace_id", filters)
	};
}

export async function listUsageMetricsLogs(params?: (UsageMetricsFilters & { limit?: number | undefined; offset?: number | undefined }) | undefined): Promise<UsageMetricsLogsListResult> {
	const limit: number = clampLogLimit(params?.limit);
	const offset: number = normalizeOffset(params?.offset);
	const state: StoreState = await initializeUsageMetricsStore();
	if (!state.available) {
		return createUnavailableLogs(state.errorMessage, limit, offset);
	}
	const filters: UsageMetricsFilters | undefined = params;
	const query: QueryParts = createFilterQuery(filters);
	const totalRow = state.db.prepare(`
		SELECT COUNT(*) AS total
		FROM llm_usage_requests
		${query.whereSql}
	`).get(...query.params);
	const logs = state.db.prepare(`
		SELECT *
		FROM llm_usage_requests
		${query.whereSql}
		ORDER BY completed_at DESC, usage_id DESC
		LIMIT ? OFFSET ?
	`).all(...query.params, limit, offset).map(mapLogRow);

	return {
		available: true,
		logs,
		total: toNumber(totalRow?.total),
		limit,
		offset
	};
}

function getBucketExpression(bucket: UsageTrendBucket): string {
	if (bucket === "hour") {
		return "strftime('%Y-%m-%dT%H:00:00Z', completed_at)";
	}
	return "strftime('%Y-%m-%dT00:00:00Z', completed_at)";
}

function mapTrendRow(row: Record<string, unknown>): UsageMetricsTrendPoint {
	const inputTokens: number = toNumber(row.input_tokens);
	const cacheReadTokens: number = toNumber(row.cache_read_tokens);
	const cacheCreationTokens: number = toNumber(row.cache_creation_tokens);
	return {
		bucket: String(row.bucket ?? ""),
		requests: toNumber(row.requests),
		successfulRequests: toNumber(row.successful_requests),
		inputTokens,
		outputTokens: toNumber(row.output_tokens),
		cacheReadTokens,
		cacheCreationTokens,
		realTotalTokens: toNumber(row.real_total_tokens),
		cacheHitRate: calculateCacheHitRate(inputTokens, cacheReadTokens, cacheCreationTokens)
	};
}

export async function getUsageMetricsTrends(params?: (UsageMetricsFilters & { bucket?: UsageTrendBucket | undefined }) | undefined): Promise<UsageMetricsTrendsResult> {
	const bucket: UsageTrendBucket = params?.bucket ?? "day";
	const state: StoreState = await initializeUsageMetricsStore();
	if (!state.available) {
		return createUnavailableTrends(state.errorMessage, bucket);
	}
	const filters: UsageMetricsFilters | undefined = params;
	const query: QueryParts = createFilterQuery(filters);
	const bucketExpression: string = getBucketExpression(bucket);
	const points: UsageMetricsTrendPoint[] = state.db.prepare(`
		SELECT
			${bucketExpression} AS bucket,
			COUNT(*) AS requests,
			SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successful_requests,
			COALESCE(SUM(input_tokens), 0) AS input_tokens,
			COALESCE(SUM(output_tokens), 0) AS output_tokens,
			COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
			COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
			COALESCE(SUM(real_total_tokens), 0) AS real_total_tokens
		FROM llm_usage_requests
		${query.whereSql}
		GROUP BY bucket
		ORDER BY bucket ASC
	`).all(...query.params).map(mapTrendRow);

	return {
		available: true,
		bucket,
		points
	};
}

export function resetUsageMetricsStoreForTests(dbPath: string | null = null): void {
	const statePromise: Promise<StoreState> | null = storeStatePromise;
	storeStatePromise = null;
	testDbPathOverride = dbPath;
	availabilitySnapshot = { available: null };
	void statePromise?.then((state: StoreState): void => {
		if (state.available) {
			state.db.close();
		}
	});
}

export async function closeUsageMetricsStore(): Promise<void> {
	const statePromise: Promise<StoreState> | null = storeStatePromise;
	storeStatePromise = null;
	if (statePromise === null) {
		return;
	}
	const state: StoreState = await statePromise;
	if (state.available) {
		state.db.close();
	}
}
