import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildTraceRecordFromEvent, createTraceRecordId, createTurnTraceRecord } from "../../../src/trace/trace-builder.js";
import { compactTracePayloadsInTransaction, completeTraceTurn, getTraceDetail, getTracePage, getTraceSummary, upsertTraceRecord } from "../../../src/trace/trace-store.js";
import { getSessionDatabase, resetSessionDatabaseForTests, runSessionTransaction } from "../../../src/session/session-database.js";

async function withTraceDatabase(run: (sessionId: string) => Promise<void>): Promise<void> {
	const directory: string = await mkdtemp(join(tmpdir(), "daedalus-trace-store-"));
	const databasePath: string = join(directory, "sessions.sqlite");
	await resetSessionDatabaseForTests(databasePath);
	try {
		const db = await getSessionDatabase();
		const sessionId: string = "session-trace-test";
		const now: string = new Date().toISOString();
		db.prepare(`INSERT INTO sessions(session_id, title, workspace_id, metadata_json, archived_at, created_at, updated_at) VALUES (?, ?, NULL, ?, NULL, ?, ?)`)
			.run(sessionId, "Trace test", "{}", now, now);
		db.prepare(`INSERT INTO messages(session_id, sequence, request_id, role, payload_json, created_at) VALUES (?, 1, ?, 'user', ?, ?)`)
			.run(sessionId, "request-1", JSON.stringify({ role: "user", content: "hello", requestId: "request-1", createdAt: now }), now);
		await run(sessionId);
	} finally {
		await resetSessionDatabaseForTests();
		await rm(directory, { recursive: true, force: true });
	}
}

test("trace store groups one canonical turn, paginates records, and redacts payloads", async (): Promise<void> => {
	await withTraceDatabase(async (sessionId: string): Promise<void> => {
		const now: string = new Date().toISOString();
		await upsertTraceRecord(createTurnTraceRecord(sessionId, "request-1", now));
		for (let index: number = 1; index <= 2; index += 1) {
			await upsertTraceRecord({
				recordId: `model-${index}`,
				parentId: createTraceRecordId(sessionId, "request-1", "turn"),
				sessionId,
				kind: "model_call",
				status: "success",
				requestId: "request-1",
				provider: "openai",
				model: "gpt-test",
				startedAt: now,
				finishedAt: now,
				durationMs: 25,
				inputTokens: 10,
				outputTokens: 5,
				detailLevel: "full",
				summary: {},
				truncated: false,
				payload: { request: { Authorization: "Bearer top-secret", prompt: "hello" }, response: { text: "done" } }
			});
		}

		const summary = await getTraceSummary(sessionId);
		assert.equal(summary.turnCount, 1);
		assert.equal(summary.modelCallCount, 2);
		assert.equal(summary.inputTokens, 20);
		assert.equal(summary.outputTokens, 10);
		assert.equal(summary.hasDetails, true);

		const firstPage = await getTracePage({ sessionId, limit: 2 });
		assert.equal(firstPage.records.length, 2);
		assert.ok(firstPage.nextCursor);
		const secondPage = await getTracePage({ sessionId, cursor: firstPage.nextCursor, limit: 2 });
		assert.equal(secondPage.records.length, 1);

		const detail = await getTraceDetail(sessionId, "model-1", { developerMode: true });
		assert.ok(detail);
		assert.equal(JSON.stringify(detail).includes("top-secret"), false);
		assert.ok(detail.redactions.includes("request.Authorization"));
		const hidden = await getTraceDetail(sessionId, "model-1", { developerMode: false });
		assert.equal(hidden?.detailsHidden, true);
		assert.equal(hidden?.request, undefined);
	});
});

test("trace updates merge request and response details while compacted payloads stay irreversible", async (): Promise<void> => {
	await withTraceDatabase(async (sessionId: string): Promise<void> => {
		const startedAt: string = "2026-08-27T00:00:00.000Z";
		const recordId: string = "model-merge";
		await upsertTraceRecord(createTurnTraceRecord(sessionId, "request-1", startedAt));
		await upsertTraceRecord({
			recordId,
			parentId: createTraceRecordId(sessionId, "request-1", "turn"),
			sessionId,
			kind: "model_call",
			status: "running",
			requestId: "request-1",
			startedAt,
			detailLevel: "full",
			summary: { providerAttempt: 1 },
			truncated: false,
			payload: { request: { prompt: "hello" } },
		});
		await upsertTraceRecord({
			recordId,
			parentId: createTraceRecordId(sessionId, "request-1", "turn"),
			sessionId,
			kind: "model_call",
			status: "success",
			requestId: "request-1",
			startedAt,
			finishedAt: "2026-08-27T00:00:01.500Z",
			detailLevel: "full",
			summary: { finishReason: "stop" },
			truncated: false,
			payload: { response: { text: "done" } },
		});

		const detail = await getTraceDetail(sessionId, recordId, { developerMode: true });
		assert.deepEqual(detail?.request, { prompt: "hello" });
		assert.deepEqual(detail?.response, { text: "done" });
		assert.deepEqual(detail?.record.summary, { providerAttempt: 1, finishReason: "stop" });
		assert.equal(detail?.record.durationMs, 1_500);

		const completedTurn = await completeTraceTurn(sessionId, createTraceRecordId(sessionId, "request-1", "turn"), "2026-08-27T00:00:02.000Z", "error");
		assert.equal(completedTurn?.status, "error");
		assert.equal((await getTraceSummary(sessionId)).durationMs, 2_000);

		const db = await getSessionDatabase();
		runSessionTransaction(db, () => compactTracePayloadsInTransaction(db, sessionId, ["request-1"]));
		await upsertTraceRecord({
			recordId,
			parentId: createTraceRecordId(sessionId, "request-1", "turn"),
			sessionId,
			kind: "model_call",
			status: "success",
			requestId: "request-1",
			startedAt,
			finishedAt: "2026-08-27T00:00:03.000Z",
			detailLevel: "full",
			summary: {},
			truncated: false,
			payload: { response: { text: "must not return" } },
		});
		const compactedDetail = await getTraceDetail(sessionId, recordId, { developerMode: true });
		assert.equal(compactedDetail?.detailLevel, "compacted");
		assert.equal(compactedDetail?.response, undefined);
	});
});

test("trace event projection is deterministic and trace compaction is idempotent", async (): Promise<void> => {
	await withTraceDatabase(async (sessionId: string): Promise<void> => {
		const source = {
			id: "event-1",
			requestId: "request-1",
			event: "agent.tool.call",
			data: { runId: "run-1", toolCallId: "tool-1", toolName: "workspace.read_file", args: { path: "src/a.ts" } },
			createdAt: new Date().toISOString(),
			sequence: 1
		};
		const first = buildTraceRecordFromEvent(sessionId, source);
		const second = buildTraceRecordFromEvent(sessionId, source);
		assert.ok(first);
		assert.equal(first.recordId, second?.recordId);
		assert.deepEqual(first.summary.filePaths, ["src/a.ts"]);
		await upsertTraceRecord(first);

		const db = await getSessionDatabase();
		const compacted = runSessionTransaction(db, () => compactTracePayloadsInTransaction(db, sessionId, ["request-1"]));
		assert.equal(compacted.records, 1);
		assert.ok(compacted.removedChars > 0);
		const detail = await getTraceDetail(sessionId, first.recordId, { developerMode: true });
		assert.equal(detail?.detailLevel, "compacted");
		assert.equal(detail?.request, undefined);
		const repeated = runSessionTransaction(db, () => compactTracePayloadsInTransaction(db, sessionId, ["request-1"]));
		assert.deepEqual(repeated, { records: 0, removedChars: 0, recordIds: [] });
	});
});

test("trace event projection folds step lifecycle and marks retries as completed records", (): void => {
	const createdAt: string = "2026-08-27T00:00:00.000Z";
	const stepStarted = buildTraceRecordFromEvent("session-trace-test", {
		id: "step-started",
		requestId: "request-1",
		event: "agent.step.started",
		data: { runId: "run-1", stepRunId: "step-run-1", title: "Inspect" },
		createdAt,
	});
	const stepFinished = buildTraceRecordFromEvent("session-trace-test", {
		id: "step-finished",
		requestId: "request-1",
		event: "agent.step.outcome",
		data: { runId: "run-1", stepRunId: "step-run-1", outcome: { status: "completed" } },
		createdAt,
	});
	assert.ok(stepStarted);
	assert.ok(stepFinished);
	assert.equal(stepStarted.recordId, stepFinished.recordId);
	assert.equal(stepStarted.status, "running");
	assert.equal(stepFinished.status, "success");

	const retry = buildTraceRecordFromEvent("session-trace-test", {
		id: "retry-started",
		requestId: "request-1",
		event: "agent.run.started",
		data: { runId: "run-2", retryOfRunId: "run-1" },
		createdAt,
	});
	assert.equal(retry?.kind, "retry");
	assert.equal(retry?.status, "success");
	assert.equal(retry?.summary.retryOfRunId, "run-1");
});
