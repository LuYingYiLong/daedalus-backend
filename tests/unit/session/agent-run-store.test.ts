import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { serializeAgentRunRuntime } from "../../../src/server/agent-run-recovery.js";
import { createClientSession } from "../../../src/server/client-session.js";
import {
	readAgentRunContinuation,
	readAgentRunState,
	saveAgentRunApprovalPause,
	saveAgentRunContinuation,
	saveAgentRunState
} from "../../../src/session/agent-run-store.js";
import type { PendingAiContinuation } from "../../../src/session/pending-continuation.js";
import {
	createAgentRunState,
	transitionAgentRunState
} from "../../../src/workflow/agent-run-state.js";

test("paused agent run state and continuation persist atomically without API keys", async (): Promise<void> => {
	const directory: string = await mkdtemp(join(tmpdir(), "daedalus-agent-run-store-"));
	const databasePath: string = join(directory, "sessions.sqlite3");
		const { getSessionDatabase, resetSessionDatabaseForTests } = await import("../../../src/session/session-database.js");
	await resetSessionDatabaseForTests(databasePath);
	try {
		const { createSession } = await import("../../../src/session/session-store.js");
		const metadata = await createSession("Run persistence", undefined);
		const initial = createAgentRunState({
			sessionId: metadata.id,
			requestId: "request-run-store",
			runId: "run-store",
			now: "2026-07-29T00:00:00.000Z"
		});
		const executing = transitionAgentRunState(initial, "executing", {
			intent: "mutate",
			lane: "lightweight"
		}, "2026-07-29T00:00:01.000Z");
		const paused = transitionAgentRunState(executing, "awaiting_approval", {
			pause: {
				kind: "approval",
				id: "approval-run-store",
				toolName: "mcp_workspace_replace_text_in_file",
				reason: "Write approval"
			}
		}, "2026-07-29T00:00:02.000Z");
		const continuation = {
			params: { message: "Update the file", mode: "agent" },
			options: {
				provider: "deepseek",
				model: "deepseek-v4-flash",
				apiKey: "must-not-persist"
			},
			continuation: {
				messages: [],
				nextStep: 1,
				totalToolResultChars: 0
			},
			userMessage: "Update the file",
			requestId: paused.requestId,
			userCreatedAt: paused.createdAt,
			stream: true
		} as unknown as PendingAiContinuation;

		await saveAgentRunContinuation(paused, {
			kind: "approval",
			pauseId: "approval-run-store",
			revision: paused.revision,
			continuation
		});

		assert.equal((await readAgentRunState(paused.runId))?.revision, paused.revision);
		const restored = await readAgentRunContinuation(paused.runId);
		assert.equal(restored?.kind, "approval");
		assert.equal(
			restored?.kind === "approval" ? restored.continuation.options.apiKey : "unexpected",
			undefined
		);

		const resumed = transitionAgentRunState(paused, "executing", {
			pause: null
		}, "2026-07-29T00:00:03.000Z");
		await saveAgentRunState(resumed);
		assert.equal(await readAgentRunContinuation(paused.runId), null);
		const database = await getSessionDatabase();
		const staleContinuation = database.prepare(
			"SELECT run_id FROM agent_run_continuations WHERE run_id = ?"
		).get(paused.runId);
		assert.equal(staleContinuation, undefined);
		await assert.rejects(
			saveAgentRunContinuation(paused, {
				kind: "approval",
				pauseId: "approval-run-store",
				revision: paused.revision,
				continuation
			}),
			/stale continuation/u
		);

		const runtime = createClientSession(undefined);
		runtime.sessionId = metadata.id;
		runtime.agentRuns.set(resumed.runId, resumed);
		assert.equal(serializeAgentRunRuntime(runtime).activeAgentRun?.stage, "executing");
	} finally {
		await resetSessionDatabaseForTests();
		await rm(directory, { recursive: true, force: true });
	}
});

test("approval request, paused run, and continuation commit atomically", async (): Promise<void> => {
	const directory: string = await mkdtemp(join(tmpdir(), "daedalus-agent-approval-pause-"));
	const databasePath: string = join(directory, "sessions.sqlite3");
	const { resetSessionDatabaseForTests } = await import("../../../src/session/session-database.js");
	await resetSessionDatabaseForTests(databasePath);
	try {
		const { createSession, readApprovalEvents } = await import("../../../src/session/session-store.js");
		const metadata = await createSession("Approval pause", undefined);
		const executing = transitionAgentRunState(createAgentRunState({
			sessionId: metadata.id,
			requestId: "request-approval-pause",
			runId: "run-approval-pause",
			now: "2026-08-05T00:00:00.000Z"
		}), "executing", { intent: "mutate", lane: "lightweight" }, "2026-08-05T00:00:01.000Z");
		const paused = transitionAgentRunState(executing, "awaiting_approval", {
			pause: {
				kind: "approval",
				id: "approval-atomic",
				toolName: "mcp_workspace_replace_text_in_file",
				reason: "Manual mode requires approval"
			}
		}, "2026-08-05T00:00:02.000Z");
		const continuation = {
			params: { message: "Fix the defect", mode: "agent" },
			options: { provider: "deepseek", model: "deepseek-v4-flash", apiKey: "secret" },
			continuation: { messages: [], nextStep: 1, totalToolResultChars: 0 },
			userMessage: "Fix the defect",
			requestId: paused.requestId,
			userCreatedAt: paused.createdAt,
			stream: true
		} as unknown as PendingAiContinuation;

		await saveAgentRunApprovalPause(paused, {
			kind: "approval",
			pauseId: "approval-atomic",
			revision: paused.revision,
			continuation
		}, {
			approvalId: "approval-atomic",
			requestId: paused.requestId,
			data: { approvalId: "approval-atomic", toolName: "mcp_workspace_replace_text_in_file" }
		});

		assert.equal((await readAgentRunState(paused.runId))?.stage, "awaiting_approval");
		assert.equal((await readAgentRunContinuation(paused.runId))?.kind, "approval");
		const approvalEvents = await readApprovalEvents(metadata.id);
		assert.equal(approvalEvents.length, 1);
		assert.equal(approvalEvents[0]?.approvalId, "approval-atomic");
		assert.equal(approvalEvents[0]?.event, "requested");
	} finally {
		await resetSessionDatabaseForTests();
		await rm(directory, { recursive: true, force: true });
	}
});

test("terminal failed run atomically excludes its stored request from future LLM context", async (): Promise<void> => {
	const directory: string = await mkdtemp(join(tmpdir(), "daedalus-agent-run-terminal-context-"));
	const databasePath: string = join(directory, "sessions.sqlite3");
	const { resetSessionDatabaseForTests } = await import("../../../src/session/session-database.js");
	await resetSessionDatabaseForTests(databasePath);
	try {
		const { createSession, openSession, saveSession } = await import("../../../src/session/session-store.js");
		const metadata = await createSession("Terminal context", undefined);
		await saveSession(metadata.id, [{
			role: "user",
			content: "previous task that already wrote files",
			requestId: "request-verification-failed",
			createdAt: "2026-08-04T00:00:00.000Z"
		}]);
		const failed = transitionAgentRunState(createAgentRunState({
			sessionId: metadata.id,
			requestId: "request-verification-failed",
			runId: "run-verification-failed",
			now: "2026-08-04T00:00:00.000Z"
		}), "failed", {
			terminal: {
				resultStatus: "failed",
				message: "git was unavailable during verification",
				completedAt: "2026-08-04T00:00:01.000Z"
			}
		}, "2026-08-04T00:00:01.000Z");

		await saveAgentRunState(failed);

		const opened = await openSession(metadata.id);
		assert.equal(opened.messages.length, 1);
		assert.equal(opened.messages[0]?.excludeFromLlmContext, true);
		assert.equal(opened.messages[0]?.content, "previous task that already wrote files");
	} finally {
		await resetSessionDatabaseForTests();
		await rm(directory, { recursive: true, force: true });
	}
});
