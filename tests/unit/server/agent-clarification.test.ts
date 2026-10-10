import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type WebSocket from "ws";
import type { McpHost } from "../../../src/mcp/mcp-host.js";
import { getSessionDatabase, resetSessionDatabaseForTests } from "../../../src/session/session-database.js";
import { createSession } from "../../../src/session/session-store.js";
import { createClientSession } from "../../../src/server/client-session.js";
import { scheduleClarificationFollowups } from "../../../src/server/chat-orchestrator.js";
import { answerAgentQuestion, cancelAgentQuestions, createAgentClarificationControl, listAgentQuestions, listUnappliedAnswers, reconcileAgentQuestionEvents } from "../../../src/server/agent-clarification.js";
import { agentQuestionSchema } from "../../../src/tools/agent-clarification.js";

test("Agent questions accept zero through five suggestions and reject a sixth", (): void => {
	const base = { title: "Choose a direction", question: "Which direction?" };
	assert.equal(agentQuestionSchema.parse(base).choices.length, 0);
	const choices = Array.from({ length: 5 }, (_, index) => ({ label: `Option ${index}`, text: `Answer ${index}` }));
	assert.equal(agentQuestionSchema.parse({ ...base, choices }).choices.length, 5);
	assert.equal(agentQuestionSchema.safeParse({ ...base, choices: [...choices, choices[0]] }).success, false);
});

test("Agent questions survive reload, dedupe the tool call and answer RPC, and isolate runs", async (): Promise<void> => {
	const directory = await mkdtemp(join(tmpdir(), "daedalus-agent-question-"));
	await resetSessionDatabaseForTests(join(directory, "sessions.sqlite3"));
	try {
		const metadata = await createSession("Question test");
		const session = createClientSession(undefined);
		session.sessionId = metadata.id;
		const socket = { readyState: 3 } as WebSocket;
		const first = createAgentClarificationControl(socket, session, "run-a", "request-a");
		const input = { title: "Help", question: "Which file?", choices: [] };
		const created = await first.execute(input, "call-1");
		const duplicate = await first.execute(input, "call-1");
		assert.equal(duplicate.questionId, created.questionId);
		const other = await createAgentClarificationControl(socket, session, "run-b", "request-b").execute(input, "call-1");
		assert.notEqual(other.questionId, created.questionId);
		assert.equal((await listAgentQuestions(metadata.id)).length, 2);

		const answered = await answerAgentQuestion(created.questionId, metadata.id, "src/main.ts");
		assert.equal(answered.changed, true);
		assert.equal((await answerAgentQuestion(created.questionId, metadata.id, "src/main.ts")).changed, false);
		await assert.rejects(answerAgentQuestion(created.questionId, metadata.id, "another.ts"), /agent_question_already_answered/u);
		assert.deepEqual((await listUnappliedAnswers(metadata.id, "run-a")).map((question) => question.questionId), [created.questionId]);
		assert.equal((await listUnappliedAnswers(metadata.id, "run-b")).length, 0);
		assert.deepEqual((await first.takeAnswers()).map((guidance) => guidance.answer), ["src/main.ts"]);
		assert.deepEqual(await first.takeAnswers(), []);
		assert.equal((await listUnappliedAnswers(metadata.id, "run-a")).length, 1);
		await resetSessionDatabaseForTests(join(directory, "sessions.sqlite3"));
		assert.equal((await listUnappliedAnswers(metadata.id))[0]?.answer, "src/main.ts");
		await first.commitAnswers();
		assert.equal((await listUnappliedAnswers(metadata.id)).length, 0);
		assert.deepEqual(await cancelAgentQuestions(metadata.id, "run-b"), [other.questionId]);
		await assert.rejects(answerAgentQuestion(other.questionId, metadata.id, "too late"), /agent_question_cancelled/u);
	} finally {
		await resetSessionDatabaseForTests();
		await rm(directory, { recursive: true, force: true });
	}
});

test("a late answer queues one linked Agent follow-up behind an already running turn", async (): Promise<void> => {
	const directory = await mkdtemp(join(tmpdir(), "daedalus-agent-followup-"));
	await resetSessionDatabaseForTests(join(directory, "sessions.sqlite3"));
	try {
		const metadata = await createSession("Follow-up test");
		const session = createClientSession(undefined);
		session.sessionId = metadata.id;
		const socket = { readyState: 3 } as WebSocket;
		const question = await createAgentClarificationControl(socket, session, "run-original", "request-original").execute({ title: "Direction", question: "Which API?", choices: [] }, "call-1");
		await answerAgentQuestion(question.questionId, metadata.id, "Keep the existing API");
		session.activeRunRequestId = "run-newer";
		await scheduleClarificationFollowups(socket, session, "run-original", {} as McpHost);
		await scheduleClarificationFollowups(socket, session, "run-original", {} as McpHost);
		assert.equal(session.queuedMessages.length, 1);
		assert.match(session.queuedMessages[0]!.text, /Keep the existing API/u);
		assert.equal(session.queuedMessages[0]!.mode, "agent");
		assert.equal((await listUnappliedAnswers(metadata.id, "run-original")).length, 0);
	} finally {
		await resetSessionDatabaseForTests();
		await rm(directory, { recursive: true, force: true });
	}
});

test("session recovery restores missing question events only once", async (): Promise<void> => {
	const directory = await mkdtemp(join(tmpdir(), "daedalus-agent-recovery-"));
	await resetSessionDatabaseForTests(join(directory, "sessions.sqlite3"));
	try {
		const metadata = await createSession("Recovery test");
		const session = createClientSession(undefined);
		session.sessionId = metadata.id;
		const socket = { readyState: 3 } as WebSocket;
		const question = await createAgentClarificationControl(socket, session, "run-recovery", "request-recovery")
			.execute({ title: "Direction", question: "Which API?", choices: [] }, "call-recovery");
		await answerAgentQuestion(question.questionId, metadata.id, "Use the existing API");
		const db = await getSessionDatabase();
		db.prepare("DELETE FROM session_events WHERE session_id = ? AND event_name = 'agent.clarification.required'").run(metadata.id);

		await reconcileAgentQuestionEvents(metadata.id);
		await reconcileAgentQuestionEvents(metadata.id);
		const rows = db.prepare("SELECT event_name, data_json FROM session_events WHERE session_id = ? AND event_name LIKE 'agent.clarification.%' ORDER BY sequence")
			.all(metadata.id) as Array<{ event_name: string; data_json: string }>;
		assert.deepEqual(rows.map((row) => row.event_name), ["agent.clarification.required", "agent.clarification.answered"]);
		assert.equal(JSON.parse(rows[0]!.data_json).questionId, question.questionId);
		assert.equal(JSON.parse(rows[1]!.data_json).answer, "Use the existing API");
	} finally {
		await resetSessionDatabaseForTests();
		await rm(directory, { recursive: true, force: true });
	}
});
