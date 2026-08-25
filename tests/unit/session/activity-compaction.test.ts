import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function withTempProfile<T>(fn: (store: typeof import("../../../src/session/session-store.js"), compaction: typeof import("../../../src/session/activity-compaction.js")) => Promise<T>): Promise<T> {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const profile: string = await fs.mkdtemp(path.join(os.tmpdir(), "daedalus-activity-compaction-"));
	process.env.USERPROFILE = profile;
	try {
		const store = await import(`../../../src/session/session-store.js?case=${Date.now()}-${Math.random()}`);
		const compaction = await import(`../../../src/session/activity-compaction.js?case=${Date.now()}-${Math.random()}`);
		return await fn(store, compaction);
	} finally {
		const { resetSessionDatabaseForTests } = await import("../../../src/session/session-database.js");
		await resetSessionDatabaseForTests();
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		await fs.rm(profile, { recursive: true, force: true });
	}
}

function createMessage(role: "user" | "assistant", requestId: string, sequence: number): {
	role: "user" | "assistant";
	content: string;
	requestId: string;
	createdAt: string;
} {
	return {
		role,
		content: role === "user" ? `request ${requestId}` : `reply ${requestId}`,
		requestId,
		createdAt: new Date(1_700_000_000_000 + sequence * 1000).toISOString()
	};
}

test("activity compaction keeps the latest ten completed turns and preserves summaries", async (): Promise<void> => {
	await withTempProfile(async (store, compaction): Promise<void> => {
		const session = await store.createSession("Compaction");
		const { getSessionDatabase } = await import("../../../src/session/session-database.js");
		for (let index: number = 1; index <= 11; index += 1) {
			const requestId: string = `request-${index}`;
			await store.appendMessage(session.id, createMessage("user", requestId, index * 2));
			await store.appendSessionEvent(session.id, requestId, "agent.thinking.delta", {
				type: "agent.thinking.delta",
				text: `private thought ${index}`
			});
			await store.appendSessionEvent(session.id, requestId, "agent.thinking.done", {
				type: "agent.thinking.done",
				done: true
			});
			await store.appendSessionEvent(session.id, requestId, "agent.tool.call", {
				type: "agent.tool.call",
				toolName: "workspace.read_file",
				toolCallId: `tool-${index}`,
				args: { path: `src/file-${index}.ts`, secret: "remove-me" }
			});
			await store.appendSessionEvent(session.id, requestId, "agent.tool.progress", {
				type: "agent.tool.progress",
				toolName: "workspace.read_file",
				toolCallId: `tool-${index}`,
				output: "terminal output that should be removed"
			});
			await store.appendSessionEvent(session.id, requestId, "agent.tool.result", {
				type: "agent.tool.result",
				toolName: "workspace.read_file",
				toolCallId: `tool-${index}`,
				ok: true,
				summary: `summary ${index}`,
				result: { content: "large result that should be removed" }
			});
			await store.appendApprovalEvent(session.id, `approval-${index}`, requestId, "approved", {
				approvalId: `approval-${index}`,
				status: "approved"
			});
			await store.appendMessage(session.id, createMessage("assistant", requestId, index * 2 + 1));
		}

		const db = await getSessionDatabase();
		const revisionBefore: number = Number((db.prepare("SELECT revision FROM session_search_source_state WHERE session_id = ?").get(session.id) as { revision: number }).revision);
		const result = await compaction.compactSessionActivity(session.id);
		assert.equal(result.completedTurns, 11);
		assert.equal(result.retainedTurns, 10);
		assert.deepEqual(result.compactedRequestIds, ["request-1"]);
		assert.equal(result.compactedEvents, 5);

		const opened = await store.openSession(session.id);
		const oldEvents = opened.events.filter((event): boolean => event.requestId === "request-1");
		const compactedEvents = oldEvents.filter((event): boolean => (
			typeof event.data === "object" && event.data !== null && (event.data as Record<string, unknown>).compacted === true
		));
		assert.equal(compactedEvents.length, 5);
		const compactedToolCall = compactedEvents.find((event): boolean => event.event === "agent.tool.call");
		assert.ok(compactedToolCall);
		assert.equal((compactedToolCall.data as Record<string, unknown>).toolName, "workspace.read_file");
		assert.deepEqual((compactedToolCall.data as Record<string, unknown>).filePaths, ["src/file-1.ts"]);
		assert.equal("args" in (compactedToolCall.data as Record<string, unknown>), false);
		assert.equal("output" in (compactedToolCall.data as Record<string, unknown>), false);
		assert.equal((compactedEvents.find((event): boolean => event.event === "agent.tool.result")?.data as Record<string, unknown>).summary, "summary 1");
		assert.equal(opened.messages.filter((message): boolean => message.requestId === "request-1").length, 2);
		assert.equal((await store.readApprovalEvents(session.id)).length, 11);
		const timeline = await store.openSessionRecentTimeline(session.id, 100);
		const oldBlock = timeline.timelineBlocks.find((block): boolean => block.requestId === "request-1" && block.type === "assistant");
		assert.ok(oldBlock);
		assert.equal(oldBlock.type, "assistant");
		assert.equal(oldBlock.bodyParts.some((part): boolean => part.type === "thinking" && part.detailLevel === "compacted"), true);
		assert.equal(oldBlock.bodyParts.some((part): boolean => part.type === "tool" && part.detailLevel === "compacted"), true);
		const revisionAfter: number = Number((db.prepare("SELECT revision FROM session_search_source_state WHERE session_id = ?").get(session.id) as { revision: number }).revision);
		assert.ok(revisionAfter > revisionBefore);

		const recentToolCall = opened.events.find((event): boolean => event.requestId === "request-11" && event.event === "agent.tool.call");
		assert.ok(recentToolCall);
		assert.equal("args" in (recentToolCall.data as Record<string, unknown>), true);

		const second = await compaction.compactSessionActivity(session.id);
		assert.equal(second.compactedEvents, 0);
		assert.equal(second.skipped, "nothing_to_compact");
	});
});

test("activity compaction skips sessions with an active run", async (): Promise<void> => {
	await withTempProfile(async (store, compaction): Promise<void> => {
		const session = await store.createSession("Active compaction");
		const { getSessionDatabase } = await import("../../../src/session/session-database.js");
		const db = await getSessionDatabase();
		const now: string = new Date().toISOString();
		db.prepare(`
			INSERT INTO agent_runs(
				run_id, session_id, request_id, root_request_id, retry_of_run_id, revision,
				stage, state_json, checkpoint_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, NULL, 1, ?, ?, ?, ?, ?)
		`).run("active-run", session.id, "request-1", "request-1", "executing", "{}", "{}", now, now);

		const result = await compaction.compactSessionActivity(session.id);
		assert.equal(result.skipped, "active_run");
	});
});

test("activity compaction counts canonical user request ids once and does not compact retained turns", async (): Promise<void> => {
	await withTempProfile(async (_store, compaction): Promise<void> => {
		const messages = [
			createMessage("user", "request-1", 1),
			createMessage("assistant", "request-1", 2),
			createMessage("user", "request-2", 3),
			createMessage("assistant", "request-2", 4)
		];
		const events = [
			{ id: "1", requestId: "request-1", event: "agent.tool.call", data: {}, createdAt: "" },
			{ id: "2", requestId: "request-1", event: "agent.tool.result", data: {}, createdAt: "" },
			{ id: "3", requestId: "request-2", event: "agent.tool.call", data: {}, createdAt: "" }
		];
		const selection = compaction.getCompactionRequestIds(messages, events, 10);
		assert.deepEqual(selection.completedRequestIds, ["request-1", "request-2"]);
		assert.deepEqual(selection.compactedRequestIds, []);

		const compacted = compaction.compactTimelineEvent({
			event: "agent.tool.result",
			data: {
				type: "agent.tool.result",
				toolName: "terminal.run",
				toolCallId: "tool-1",
				ok: true,
				result: { output: "remove" }
			}
		});
		assert.ok(compacted);
		assert.equal(compacted.data.detailLevel, "compacted");
		assert.equal(compacted.data.toolName, "terminal.run");
		assert.equal("result" in compacted.data, false);

		const alreadyCompacted = compaction.compactTimelineEvent({
			event: "agent.tool.result",
			data: { compacted: true, detailLevel: "compacted", toolName: "terminal.run" }
		});
		assert.equal(alreadyCompacted, null);
	});
});
