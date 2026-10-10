import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
import { getSessionDatabase, runSessionTransaction } from "../session/session-database.js";
import { appendSessionEvent } from "../session/session-store.js";
import type { AgentClarificationContext, AgentQuestionAnswer, AgentQuestionInput } from "../tools/agent-clarification.js";
import type { ClientSession } from "./client-session.js";
import { sendSessionEvent, waitForSessionEventPersistence } from "./session-events.js";

export type AgentClarificationQuestion = AgentQuestionInput & {
	questionId: string;
	sessionId: string;
	runId: string;
	requestId: string;
	toolCallId: string;
	status: "pending" | "answered" | "applied" | "cancelled";
	answer: string | null;
	createdAt: string;
	answeredAt: string | null;
};

export const TEST_AGENT_QUESTION_TOOL_CALL_ID = "dev-test-agent-question";

export function isTestAgentQuestion(question: AgentClarificationQuestion): boolean {
	return question.toolCallId === TEST_AGENT_QUESTION_TOOL_CALL_ID && question.runId === `slash-${question.requestId}`;
}

function fromRow(row: Record<string, unknown>): AgentClarificationQuestion {
	const payload = JSON.parse(String(row.payload_json)) as AgentQuestionInput;
	return {
		...payload,
		questionId: String(row.question_id),
		sessionId: String(row.session_id),
		runId: String(row.run_id),
		requestId: String(row.request_id),
		toolCallId: String(row.tool_call_id),
		status: String(row.status) as AgentClarificationQuestion["status"],
		answer: row.answer === null ? null : String(row.answer),
		createdAt: String(row.created_at),
		answeredAt: row.answered_at === null ? null : String(row.answered_at)
	};
}

export async function readAgentQuestion(questionId: string): Promise<AgentClarificationQuestion | null> {
	const db = await getSessionDatabase();
	const row = db.prepare("SELECT * FROM agent_clarification_questions WHERE question_id = ?").get(questionId) as Record<string, unknown> | undefined;
	return row === undefined ? null : fromRow(row);
}

export async function listAgentQuestions(sessionId: string): Promise<AgentClarificationQuestion[]> {
	const db = await getSessionDatabase();
	return (db.prepare("SELECT * FROM agent_clarification_questions WHERE session_id = ? ORDER BY created_at, question_id").all(sessionId) as Record<string, unknown>[]).map(fromRow);
}

export async function reconcileAgentQuestionEvents(sessionId: string): Promise<void> {
	const questions = await listAgentQuestions(sessionId);
	if (questions.length === 0) return;
	const db = await getSessionDatabase();
	const rows = db.prepare("SELECT event_name, data_json FROM session_events WHERE session_id = ? AND event_name IN ('agent.clarification.required', 'agent.clarification.answered', 'agent.clarification.applied', 'agent.clarification.cancelled')").all(sessionId) as Array<{ event_name: string; data_json: string }>;
	const existing = new Set<string>();
	for (const row of rows) {
		try {
			const data = JSON.parse(row.data_json) as { questionId?: string };
			if (typeof data.questionId === "string") existing.add(`${row.event_name}:${data.questionId}`);
		} catch { /* Corrupt historical events are handled by the session integrity checker. */ }
	}
	for (const question of questions) {
		const requiredKey = `agent.clarification.required:${question.questionId}`;
		if (!existing.has(requiredKey)) await appendSessionEvent(sessionId, question.requestId, "agent.clarification.required", { ...question, status: "pending", answer: null });
		if (question.answer !== null && !existing.has(`agent.clarification.answered:${question.questionId}`)) {
			await appendSessionEvent(sessionId, question.requestId, "agent.clarification.answered", { questionId: question.questionId, runId: question.runId, answer: question.answer, answeredAt: question.answeredAt });
		}
		if (question.status === "applied" && !existing.has(`agent.clarification.applied:${question.questionId}`)) await appendSessionEvent(sessionId, question.requestId, "agent.clarification.applied", { questionId: question.questionId, runId: question.runId });
		if (question.status === "cancelled" && !existing.has(`agent.clarification.cancelled:${question.questionId}`)) await appendSessionEvent(sessionId, question.requestId, "agent.clarification.cancelled", { questionId: question.questionId, runId: question.runId });
	}
}

export async function answerAgentQuestion(questionId: string, sessionId: string, answer: string): Promise<{ question: AgentClarificationQuestion; changed: boolean }> {
	const db = await getSessionDatabase();
	return runSessionTransaction(db, () => {
		const row = db.prepare("SELECT * FROM agent_clarification_questions WHERE question_id = ? AND session_id = ?").get(questionId, sessionId) as Record<string, unknown> | undefined;
		if (row === undefined) throw new Error("agent_question_not_found");
		const current = fromRow(row);
		if (current.status !== "pending") {
			if ((current.status === "answered" || current.status === "applied") && current.answer === answer) return { question: current, changed: false };
			throw new Error(current.status === "cancelled" ? "agent_question_cancelled" : "agent_question_already_answered");
		}
		const answeredAt = new Date().toISOString();
		db.prepare("UPDATE agent_clarification_questions SET status = 'answered', answer = ?, answered_at = ? WHERE question_id = ?").run(answer, answeredAt, questionId);
		return { question: { ...current, status: "answered", answer, answeredAt }, changed: true };
	});
}

export async function cancelAgentQuestions(sessionId: string, runId: string): Promise<string[]> {
	const db = await getSessionDatabase();
	return runSessionTransaction(db, () => {
		const questions = db.prepare("SELECT question_id FROM agent_clarification_questions WHERE session_id = ? AND run_id = ? AND status IN ('pending', 'answered')").all(sessionId, runId) as Array<{ question_id: string }>;
		db.prepare("UPDATE agent_clarification_questions SET status = 'cancelled' WHERE session_id = ? AND run_id = ? AND status IN ('pending', 'answered')").run(sessionId, runId);
		return questions.map((question) => question.question_id);
	});
}

export async function listUnappliedAnswers(sessionId: string, runId?: string): Promise<AgentClarificationQuestion[]> {
	const db = await getSessionDatabase();
	const rows = runId === undefined
		? db.prepare("SELECT * FROM agent_clarification_questions WHERE session_id = ? AND status = 'answered' ORDER BY answered_at, question_id").all(sessionId)
		: db.prepare("SELECT * FROM agent_clarification_questions WHERE session_id = ? AND run_id = ? AND status = 'answered' ORDER BY answered_at, question_id").all(sessionId, runId);
	return (rows as Record<string, unknown>[]).map(fromRow);
}

export async function markAnswersApplied(questionIds: string[]): Promise<void> {
	if (questionIds.length === 0) return;
	const db = await getSessionDatabase();
	runSessionTransaction(db, () => {
		for (const questionId of questionIds) db.prepare("UPDATE agent_clarification_questions SET status = 'applied' WHERE question_id = ? AND status = 'answered'").run(questionId);
	});
}

export function createAgentClarificationControl(socket: WebSocket, session: ClientSession, runId: string, requestId: string): AgentClarificationContext {
	const delivered = new Set<string>();
	return {
		async execute(input: AgentQuestionInput, toolCallId: string): Promise<{ questionId: string; status: "pending" }> {
			if (session.sessionId === undefined) throw new Error("agent_question_session_required");
			const db = await getSessionDatabase();
			const sessionId = session.sessionId;
			const created = runSessionTransaction(db, () => {
				const existing = db.prepare("SELECT * FROM agent_clarification_questions WHERE session_id = ? AND run_id = ? AND tool_call_id = ?").get(sessionId, runId, toolCallId) as Record<string, unknown> | undefined;
				if (existing !== undefined) return { question: fromRow(existing), changed: false };
				const question: AgentClarificationQuestion = {
					...input, questionId: `question-${randomUUID()}`, sessionId, runId, requestId, toolCallId,
					status: "pending", answer: null, createdAt: new Date().toISOString(), answeredAt: null
				};
				db.prepare("INSERT INTO agent_clarification_questions(question_id, session_id, run_id, request_id, tool_call_id, payload_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)")
					.run(question.questionId, sessionId, runId, requestId, toolCallId, JSON.stringify(input), question.createdAt);
				return { question, changed: true };
			});
			if (created.changed) {
				sendSessionEvent(socket, requestId, session, "agent.clarification.required", created.question, requestId);
				await waitForSessionEventPersistence(session);
			}
			return { questionId: created.question.questionId, status: "pending" };
		},
		async takeAnswers(): Promise<AgentQuestionAnswer[]> {
			if (session.sessionId === undefined) return [];
			const db = await getSessionDatabase();
			const rows = db.prepare("SELECT * FROM agent_clarification_questions WHERE session_id = ? AND run_id = ? AND status = 'answered' ORDER BY answered_at, question_id")
				.all(session.sessionId, runId) as Record<string, unknown>[];
			const answers: AgentQuestionAnswer[] = [];
			for (const row of rows) {
				const question = fromRow(row);
				if (question.answer === null || delivered.has(question.questionId)) continue;
				delivered.add(question.questionId);
				answers.push({ questionId: question.questionId, question: question.question, answer: question.answer });
			}
			return answers;
		},
		async commitAnswers(): Promise<void> {
			if (delivered.size === 0) return;
			const ids = [...delivered];
			await markAnswersApplied(ids);
			for (const questionId of ids) sendSessionEvent(socket, requestId, session, "agent.clarification.applied", { questionId, runId }, requestId);
			await waitForSessionEventPersistence(session);
			delivered.clear();
		}
	};
}
