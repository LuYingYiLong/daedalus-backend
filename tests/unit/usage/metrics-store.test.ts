import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
	getUsageMetricsSummary,
	classifyUsageOperation,
	initializeUsageMetricsStore,
	getUsageMetricsTrends,
	listUsageMetricsLogs,
	recordUsageMetrics,
	resetUsageMetricsStoreForTests
} from "../../../src/usage/metrics-store.js";
import { recordProviderUsage } from "../../../src/usage/provider-recorder.js";

function createRecord(overrides: Partial<Parameters<typeof recordUsageMetrics>[0]> = {}): Parameters<typeof recordUsageMetrics>[0] {
	const usageId: string = overrides.usageId ?? `usage-${Math.random().toString(36).slice(2)}`;
	return {
		usageId,
		requestId: "request-a",
		runId: "run-a",
		sessionId: "session-a",
		workspaceId: "workspace-a",
		operation: "chat",
		provider: "deepseek",
		model: "deepseek-v4-pro",
		endpointType: "openai-chat-completions",
		adapterFamily: "openai-compatible",
		startedAt: "2026-07-21T10:00:00.000Z",
		completedAt: "2026-07-21T10:00:01.000Z",
		durationMs: 1000,
		status: "success",
		streaming: true,
		usage: {
			inputTokens: 60,
			outputTokens: 20,
			cacheReadTokens: 30,
			cacheCreationTokens: 10,
			rawInputTokens: 100,
			totalTokens: 120,
			realTotalTokens: 120,
			usageSource: "provider",
			inputTokenSemantics: "fresh"
		},
		...overrides
	};
}

test("usage metrics store inserts idempotently and aggregates filters", async (): Promise<void> => {
	const root: string = join(tmpdir(), `daedalus-usage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(root, { recursive: true });
	resetUsageMetricsStoreForTests(join(root, "usage.sqlite"));
	try {
		const first = createRecord({ usageId: "usage-a" });
		assert.equal(await recordUsageMetrics(first), true);
		assert.equal(await recordUsageMetrics(first), false);
		assert.equal(await recordUsageMetrics(createRecord({
			usageId: "usage-b",
			requestId: "request-b",
			sessionId: "session-b",
			workspaceId: "workspace-b",
			provider: "moonshot",
			model: "kimi-k3",
			status: "error",
			usage: {
				inputTokens: 10,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				rawInputTokens: 10,
				totalTokens: 10,
				realTotalTokens: 10,
				usageSource: "estimated",
				inputTokenSemantics: "fresh"
			}
		})), true);

		const summary = await getUsageMetricsSummary({ provider: "deepseek" });
		assert.equal(summary.available, true);
		assert.equal(summary.requests, 1);
		assert.equal(summary.successfulRequests, 1);
		assert.equal(summary.providerRows, 1);
		assert.equal(summary.realTotalTokens, 120);
		assert.equal(summary.cacheHitRate, 0.3);
		assert.equal(classifyUsageOperation("action_review"), "review");
		assert.equal(classifyUsageOperation("workflow_phase"), "conversation");
		assert.equal(classifyUsageOperation("session_title"), "auxiliary");
		assert.equal((await getUsageMetricsSummary({ operationClass: "conversation" })).requests, 2);
		assert.equal((await getUsageMetricsSummary({ operationClass: "review" })).requests, 0);
		assert.equal((await getUsageMetricsSummary({ promptVariant: "unknown" })).requests, 2);
		assert.deepEqual(summary.byProvider.map((item) => item.key), ["deepseek"]);

		const logs = await listUsageMetricsLogs({ limit: 10, offset: 0, status: "error" });
		assert.equal(logs.total, 1);
		assert.equal(logs.logs[0]?.provider, "moonshot");
		assert.equal(logs.logs[0]?.usageSource, "estimated");
		assert.equal(logs.logs[0]?.promptVariant, "unknown");

		const trends = await getUsageMetricsTrends({ bucket: "hour" });
		assert.equal(trends.points.length, 1);
		assert.equal(trends.points[0]?.bucket, "2026-07-21T10:00:00Z");
		assert.equal(trends.points[0]?.requests, 2);
	} finally {
		resetUsageMetricsStoreForTests(null);
		await rm(root, { recursive: true, force: true });
	}
});

test("usage metrics migration preserves pre-variant records", async (): Promise<void> => {
	const root: string = join(tmpdir(), `daedalus-usage-migration-${Date.now()}`);
	const dbPath: string = join(root, "usage.sqlite");
	await mkdir(root, { recursive: true });
	const oldDb = new DatabaseSync(dbPath);
	oldDb.exec(`
		PRAGMA user_version = 1;
		CREATE TABLE llm_usage_requests (
			usage_id TEXT PRIMARY KEY, operation TEXT NOT NULL, session_id TEXT,
			workspace_id TEXT, provider TEXT NOT NULL, model TEXT NOT NULL, completed_at TEXT NOT NULL
		);
		INSERT INTO llm_usage_requests (usage_id, operation, provider, model, completed_at)
		VALUES ('old-row', 'chat', 'deepseek', 'deepseek-chat', '2026-09-29T00:00:00Z');
	`);
	oldDb.close();
	resetUsageMetricsStoreForTests(dbPath);
	try {
		const state = await initializeUsageMetricsStore();
		assert.equal(state.available, true);
		if (!state.available) return;
		const columns = state.db.prepare("PRAGMA table_info(llm_usage_requests)").all() as Array<{ name: string }>;
		assert.ok(columns.some((column) => column.name === "prompt_variant"));
		assert.equal((state.db.prepare("SELECT usage_id FROM llm_usage_requests").get() as { usage_id: string }).usage_id, "old-row");
		assert.equal((state.db.prepare("SELECT prompt_variant FROM llm_usage_requests").get() as { prompt_variant: string | null }).prompt_variant, null);
		assert.equal((state.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
	} finally {
		resetUsageMetricsStoreForTests(null);
		await rm(root, { recursive: true, force: true });
	}
});

test("usage summaries filter review calls and prompt variants without mixing unknown usage", async (): Promise<void> => {
	const root: string = join(tmpdir(), `daedalus-usage-filter-${Date.now()}`);
	await mkdir(root, { recursive: true });
	resetUsageMetricsStoreForTests(join(root, "usage.sqlite"));
	try {
		await recordUsageMetrics(createRecord({ usageId: "main", promptVariant: "optimized" }));
		await recordUsageMetrics(createRecord({ usageId: "review", operation: "action_review", promptVariant: "optimized", usage: {
			inputTokens: 20, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0,
			rawInputTokens: 20, totalTokens: 25, realTotalTokens: 25,
			usageSource: "provider", inputTokenSemantics: "fresh"
		} }));
		assert.equal((await getUsageMetricsSummary({ operationClass: "conversation", promptVariant: "optimized" })).cacheHitRate, 0.3);
		assert.equal((await getUsageMetricsSummary({ operationClass: "review", promptVariant: "optimized" })).cacheHitRate, 0);
		assert.equal((await getUsageMetricsSummary({ promptVariant: "legacy" })).requests, 0);
		assert.equal((await listUsageMetricsLogs({ operationClass: "review" })).logs[0]?.promptVariant, "optimized");
	} finally {
		resetUsageMetricsStoreForTests(null);
		await rm(root, { recursive: true, force: true });
	}
});

test("provider recorder estimates missing usage without failing the caller", async (): Promise<void> => {
	const root: string = join(tmpdir(), `daedalus-usage-recorder-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(root, { recursive: true });
	resetUsageMetricsStoreForTests(join(root, "usage.sqlite"));
	try {
		await recordProviderUsage({
			options: {
				provider: "deepseek",
				apiKey: "test-key",
				model: "deepseek-v4-pro",
				endpointType: "openai-chat-completions",
				adapterFamily: "openai-compatible",
				usageContext: {
					requestId: "request-estimated",
					runId: "run-estimated",
					sessionId: "session-estimated",
					workspaceId: "workspace-estimated",
					operation: "direct_answer"
				}
			},
			requestBody: {
				model: "deepseek-v4-pro",
				messages: [{ role: "user", content: "hello" }]
			},
			outputText: "world",
			startedAtMs: Date.now() - 50,
			status: "success",
			streaming: false,
			usage: null
		});

		const logs = await listUsageMetricsLogs({ sessionId: "session-estimated" });
		assert.equal(logs.logs.length, 1);
		assert.equal(logs.logs[0]?.usageSource, "estimated");
		assert.ok((logs.logs[0]?.realTotalTokens ?? 0) > 0);
	} finally {
		resetUsageMetricsStoreForTests(null);
		await rm(root, { recursive: true, force: true });
	}
});
