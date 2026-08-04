import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ChatMessage } from "../../../src/protocol/types.js";
import { createClientSession } from "../../../src/server/client-session.js";
import type { ClientSession } from "../../../src/server/client-session.js";
import { selectMessagesWithinBudget, summarizeMessagesAsSummary } from "../../../src/session/session-compressor.js";
import type { TokenCounter } from "../../../src/tokens/token-counter.js";
import { createAgentRunState, transitionAgentRunState } from "../../../src/workflow/agent-run-state.js";

async function withTempAppData<T>(
	fn: (
		store: typeof import("../../../src/session/session-store.js"),
		transcriptHistory: typeof import("../../../src/server/transcript-history.js")
	) => Promise<T>
): Promise<T> {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const appDataDir: string = await fs.mkdtemp(path.join(os.tmpdir(), "godot-daedalus-token-budget-appdata-"));
	process.env.USERPROFILE = appDataDir;

	try {
		const suffix: string = `${Date.now()}-${Math.random()}`;
		const store = await import(`../../../src/session/session-store.js?case=${suffix}`);
		const transcriptHistory = await import(`../../../src/server/transcript-history.js?case=${suffix}`);
		return await fn(store, transcriptHistory);
	} finally {
		const { resetSessionDatabaseForTests } = await import("../../../src/session/session-database.js");
		await resetSessionDatabaseForTests();
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		await fs.rm(appDataDir, { recursive: true, force: true });
	}
}

test("failed transcript-only turns persist but stay out of LLM context", async (): Promise<void> => {
	await withTempAppData(async (store, transcriptHistory): Promise<void> => {
		const metadata = await store.createSession("Failed turn", "workspace-a");
		const session: ClientSession = createClientSession(undefined);
		session.sessionId = metadata.id;
		session.sessionTitle = metadata.title;

		const saved = await transcriptHistory.appendFailedChatTurnToSession(
			session,
			"帮我修改脚本",
			{
				code: "agent_run_error",
				message: "总结阶段不能调用工具"
			},
			"request-failed",
			"2026-07-08T00:00:00.000Z",
			"2026-07-08T00:00:01.000Z"
		);

		assert.equal(saved, true);
		assert.equal(session.messages.length, 2);
		assert.equal(session.messages.every((message: ChatMessage): boolean => message.excludeFromLlmContext === true), true);
		assert.equal(session.messages[1]?.status, "failed");
		assert.deepEqual(session.messages[1]?.error, {
			code: "agent_run_error",
			message: "总结阶段不能调用工具"
		});

		const opened = await store.openSession(metadata.id);
		assert.equal(opened.messages.length, 2);
		assert.equal(opened.messages[0]?.excludeFromLlmContext, true);
		assert.equal(opened.messages[1]?.status, "failed");

		assert.deepEqual(transcriptHistory.filterLlmContextMessages(session.messages), []);
		assert.equal(summarizeMessagesAsSummary(session.messages), "");
		const selected = await selectMessagesWithinBudget(session.messages, 10000, {
			countText(text: string): Promise<number> {
				return Promise.resolve(text.length);
			},
			countMessages(messages: ChatMessage[]): Promise<number> {
				return Promise.resolve(messages.reduce((sum: number, message: ChatMessage): number => sum + message.content.length, 0));
			}
		} satisfies TokenCounter);
		assert.deepEqual(selected, []);

		await store.appendSessionEvent(metadata.id, "request-failed", "agent.run.error", {
			code: "agent_run_error",
			message: "总结阶段不能调用工具"
		});
		const rewound = await store.rewindSessionFromRequest(metadata.id, "request-failed");
		assert.equal(rewound.length, 0);
		assert.equal((await store.openSession(metadata.id)).events.length, 0);
	});
});

test("session history excludes failed, cancelled and interrupted run requests", async (): Promise<void> => {
	const transcriptHistory = await import("../../../src/server/transcript-history.js");
	const session: ClientSession = createClientSession(undefined);
	session.messages = [
		{ role: "user", content: "failed task", requestId: "request-failed" },
		{ role: "user", content: "cancelled task", requestId: "request-cancelled" },
		{ role: "user", content: "interrupted task", requestId: "request-interrupted" },
		{ role: "user", content: "completed task", requestId: "request-completed" },
		{ role: "assistant", content: "completed answer", requestId: "request-completed" },
		{ role: "user", content: "current task", requestId: "request-current" }
	];
	const failed = transitionAgentRunState(createAgentRunState({
		sessionId: "session-history",
		requestId: "request-failed"
	}), "failed", {
		terminal: {
			resultStatus: "failed",
			message: "verification failed",
			completedAt: "2026-08-04T00:00:00.000Z"
		}
	});
	const cancelled = transitionAgentRunState(createAgentRunState({
		sessionId: "session-history",
		requestId: "request-cancelled"
	}), "cancelled", {
		terminal: {
			resultStatus: "cancelled",
			message: "cancelled",
			completedAt: "2026-08-04T00:00:00.000Z"
		}
	});
	const interrupted = transitionAgentRunState(createAgentRunState({
		sessionId: "session-history",
		requestId: "request-interrupted"
	}), "interrupted", {
		interruptedReason: "backend_restart"
	});
	const completed = transitionAgentRunState(
		transitionAgentRunState(createAgentRunState({
			sessionId: "session-history",
			requestId: "request-completed"
		}), "finalizing"),
		"completed",
		{
			terminal: {
				resultStatus: "completed",
				completedAt: "2026-08-04T00:00:00.000Z"
			}
		}
	);
	for (const run of [failed, cancelled, interrupted, completed]) {
		session.agentRuns.set(run.runId, run);
	}

	assert.deepEqual(
		transcriptHistory.filterSessionLlmContextMessages(session).map((message: ChatMessage): string => message.content),
		["completed task", "completed answer", "current task"]
	);
	assert.equal(session.messages.some((message: ChatMessage): boolean => message.content === "interrupted task"), true);

	const completedRetry = transitionAgentRunState(
		transitionAgentRunState(createAgentRunState({
			sessionId: "session-history",
			requestId: "request-interrupted-retry",
			rootRequestId: interrupted.rootRequestId,
			retryOfRunId: interrupted.runId
		}), "finalizing"),
		"completed",
		{
			terminal: {
				resultStatus: "completed",
				completedAt: "2026-08-04T00:01:00.000Z"
			}
		}
	);
	session.agentRuns.set(completedRetry.runId, completedRetry);
	session.messages.push({
		role: "assistant",
		content: "interrupted task completed after retry",
		requestId: completedRetry.requestId
	});
	assert.deepEqual(
		transcriptHistory.filterSessionLlmContextMessages(session).map((message: ChatMessage): string => message.content),
		[
			"interrupted task",
			"completed task",
			"completed answer",
			"current task",
			"interrupted task completed after retry"
		]
	);
});

test("chat turn persistence reuses pre-saved user message", async (): Promise<void> => {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const appDataDir: string = await fs.mkdtemp(path.join(os.tmpdir(), "godot-daedalus-token-budget-chat-"));
	process.env.USERPROFILE = appDataDir;
	try {
		const store = await import("../../../src/session/session-store.js");
		const tokenBudget = await import("../../../src/server/token-budget.js");
		const metadata = await store.createSession("Streaming turn", undefined);
		const session: ClientSession = createClientSession(undefined);
		session.sessionId = metadata.id;
		session.sessionTitle = metadata.title;

		const userSaved = await tokenBudget.appendUserMessageToSession(
			session,
			"生成一张科幻战机图",
			"request-streaming",
			"2026-07-16T00:00:00.000Z",
			[{ id: "ctx-style", kind: "file", title: "style.txt", source: "manual", summary: "key art" }]
		);
		assert.equal(userSaved, true);
		assert.equal((await store.openSession(metadata.id)).messages.length, 1);

		const turnSaved = await tokenBudget.appendChatTurnToSession(
			session,
			[],
			"生成一张科幻战机图",
			"已生成图片。",
			"request-streaming",
			"2026-07-16T00:00:00.000Z",
			"2026-07-16T00:00:03.000Z",
			[{ id: "ctx-style", kind: "file", title: "style.txt", source: "manual", summary: "key art" }]
		);
		assert.equal(turnSaved, true);
		assert.equal(session.messages.length, 2);
		assert.equal(session.messages.filter((message: ChatMessage): boolean => message.requestId === "request-streaming" && message.role === "user").length, 1);
		assert.equal(session.messages[0]?.additionalContext?.[0]?.title, "style.txt");

		const duplicateSaved = await tokenBudget.appendChatTurnToSession(
			session,
			[],
			"生成一张科幻战机图",
			"已生成图片。",
			"request-streaming"
		);
		assert.equal(duplicateSaved, false);

		const retrySaved = await tokenBudget.appendChatTurnToSession(
			session,
			[],
			"生成一张科幻战机图",
			"从安全检查点完成重试。",
			"request-retry",
			"2026-07-16T00:00:04.000Z",
			"2026-07-16T00:00:05.000Z",
			undefined,
			false
		);
		assert.equal(retrySaved, true);
		assert.equal(
			session.messages.some((message: ChatMessage): boolean => (
				message.requestId === "request-retry" && message.role === "user"
			)),
			false
		);

		const opened = await store.openSession(metadata.id);
		assert.equal(opened.messages.length, 3);
		assert.deepEqual(opened.messages.map((message: ChatMessage): string => message.role), ["user", "assistant", "assistant"]);
	} finally {
		const { resetSessionDatabaseForTests } = await import("../../../src/session/session-database.js");
		await resetSessionDatabaseForTests();
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		await fs.rm(appDataDir, { recursive: true, force: true });
	}
});

test("chat turn persistence merges with stored messages instead of overwriting from stale memory", async (): Promise<void> => {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const appDataDir: string = await fs.mkdtemp(path.join(os.tmpdir(), "godot-daedalus-token-budget-merge-"));
	process.env.USERPROFILE = appDataDir;
	try {
		const store = await import("../../../src/session/session-store.js");
		const tokenBudget = await import("../../../src/server/token-budget.js");
		const metadata = await store.createSession("Merge turn", undefined);
		const session: ClientSession = createClientSession(undefined);
		session.sessionId = metadata.id;
		session.sessionTitle = metadata.title;
		session.messages = [];

		await store.saveSession(metadata.id, [
			{
				role: "user",
				content: "旧问题",
				requestId: "request-old",
				createdAt: "2026-07-16T00:00:00.000Z"
			},
			{
				role: "assistant",
				content: "旧回答",
				requestId: "request-old",
				createdAt: "2026-07-16T00:00:01.000Z"
			}
		]);

		const saved = await tokenBudget.appendUserMessageToSession(
			session,
			"新问题",
			"request-new",
			"2026-07-16T00:01:00.000Z"
		);

		assert.equal(saved, true);
		const opened = await store.openSession(metadata.id);
		assert.deepEqual(opened.messages.map((message: ChatMessage): string => message.requestId ?? ""), [
			"request-old",
			"request-old",
			"request-new"
		]);
		assert.deepEqual(session.messages.map((message: ChatMessage): string => message.requestId ?? ""), [
			"request-old",
			"request-old",
			"request-new"
		]);
	} finally {
		const { resetSessionDatabaseForTests } = await import("../../../src/session/session-database.js");
		await resetSessionDatabaseForTests();
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		await fs.rm(appDataDir, { recursive: true, force: true });
	}
});

test("concurrent chat persistence serializes writes by session", async (): Promise<void> => {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const appDataDir: string = await fs.mkdtemp(path.join(os.tmpdir(), "godot-daedalus-token-budget-concurrent-"));
	process.env.USERPROFILE = appDataDir;
	try {
		const store = await import("../../../src/session/session-store.js");
		const tokenBudget = await import("../../../src/server/token-budget.js");
		const transcriptHistory = await import("../../../src/server/transcript-history.js");
		const metadata = await store.createSession("Concurrent turn", undefined);
		const session: ClientSession = createClientSession(undefined);
		session.sessionId = metadata.id;
		session.sessionTitle = metadata.title;

		await Promise.all([
			tokenBudget.appendUserMessageToSession(
				session,
				"first question",
				"request-first",
				"2026-07-16T00:00:00.000Z"
			),
			tokenBudget.appendChatTurnToSession(
				session,
				[],
				"second question",
				"second answer",
				"request-second",
				"2026-07-16T00:00:01.000Z",
				"2026-07-16T00:00:02.000Z"
			),
			transcriptHistory.appendFailedChatTurnToSession(
				session,
				"third question",
				{ code: "provider_error", message: "failed" },
				"request-third",
				"2026-07-16T00:00:03.000Z",
				"2026-07-16T00:00:04.000Z"
			)
		]);

		const opened = await store.openSession(metadata.id);
		assert.deepEqual(opened.messages.map((message: ChatMessage): string => `${message.requestId}:${message.role}`), [
			"request-first:user",
			"request-second:user",
			"request-second:assistant",
			"request-third:user",
			"request-third:assistant"
		]);
	} finally {
		const { resetSessionDatabaseForTests } = await import("../../../src/session/session-database.js");
		await resetSessionDatabaseForTests();
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		await fs.rm(appDataDir, { recursive: true, force: true });
	}
});
