import type WebSocket from "ws";
import type { McpHost } from "../mcp/mcp-host.js";
import type { ClientSession } from "./client-session.js";
import { createPendingGuide, serializePendingGuide } from "./pending-guides.js";
import { sendSessionEvent } from "./session-events.js";

type TerminalJobWakeup = {
	socket: WebSocket;
	requestId: string;
	persistRequestId: string;
	session: ClientSession;
	mcpHost: McpHost;
	jobId: string;
	runId: string;
	stepRunId: string;
	timer: NodeJS.Timeout;
};

const wakeups: Map<string, TerminalJobWakeup> = new Map();
const resumingJobs: Set<string> = new Set();

function readJsonResult(content: unknown): Record<string, unknown> | null {
	if (typeof content !== "object" || content === null || !("content" in content)) {
		return null;
	}
	const items: unknown = (content as { content?: unknown }).content;
	if (!Array.isArray(items)) {
		return null;
	}
	const first: unknown = items[0];
	if (typeof first !== "object" || first === null || !("text" in first)) {
		return null;
	}
	const text: unknown = (first as { text?: unknown }).text;
	if (typeof text !== "string") {
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(text);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: null;
	} catch {
		return null;
	}
}

function createWakeGuideText(record: Record<string, unknown>): string {
	return [
		"The Terminal long-running task timer has fired. Use the current terminal output to decide the next step.",
		`jobId: ${String(record.jobId ?? "")}`,
		`status: ${String(record.status ?? "unknown")}`,
		`durationMs: ${String(record.durationMs ?? "unknown")}`,
		`exitCode: ${String(record.exitCode ?? "unknown")}`,
		"",
		"stdoutTail:",
		String(record.stdoutTail ?? ""),
		"",
		"stderrTail:",
		String(record.stderrTail ?? "")
	].join("\n");
}

async function handleWakeup(wakeup: TerminalJobWakeup): Promise<void> {
	wakeups.delete(wakeup.jobId);
	let record: Record<string, unknown> = {
		jobId: wakeup.jobId,
		status: "unknown"
	};
	try {
		const result: unknown = await wakeup.mcpHost.callTool("terminal", "get_terminal_job_status", { jobId: wakeup.jobId });
		record = readJsonResult(result) ?? record;
	} catch (error: unknown) {
		record = {
			...record,
			status: "status_error",
			error: error instanceof Error ? error.message : "Failed to read terminal job status"
		};
	}

	const status: string = String(record.status ?? "unknown");
	const eventName = status === "completed"
		? "terminal.job.completed"
		: status === "failed" || status === "timed_out" || status === "spawn_error"
			? "terminal.job.failed"
			: status === "cancelled"
				? "terminal.job.cancelled"
				: "terminal.job.timer";
	sendSessionEvent(wakeup.socket, wakeup.requestId, wakeup.session, eventName, {
		...record,
		runId: wakeup.runId,
		stepRunId: wakeup.stepRunId
	}, wakeup.persistRequestId);

	if (resumingJobs.has(wakeup.jobId)) {
		sendSessionEvent(wakeup.socket, wakeup.requestId, wakeup.session, "terminal.job.resume_skipped", {
			jobId: wakeup.jobId,
			reason: "resume_already_running",
			runId: wakeup.runId,
			stepRunId: wakeup.stepRunId
		}, wakeup.persistRequestId);
		return;
	}

	resumingJobs.add(wakeup.jobId);
	try {
		const guide = createPendingGuide(`terminal-job-${wakeup.jobId}`, createWakeGuideText(record), wakeup.persistRequestId);
		wakeup.session.pendingGuides.push(guide);
		sendSessionEvent(wakeup.socket, wakeup.requestId, wakeup.session, "terminal.job.resume_started", {
			jobId: wakeup.jobId,
			runId: wakeup.runId,
			stepRunId: wakeup.stepRunId,
			guide: serializePendingGuide(guide)
		}, wakeup.persistRequestId);
	} finally {
		resumingJobs.delete(wakeup.jobId);
	}
}

export function scheduleTerminalJobWakeup(params: {
	socket: WebSocket;
	requestId: string;
	persistRequestId: string;
	session: ClientSession;
	mcpHost: McpHost;
	jobId: string;
	wakeAfterMs: number;
	runId: string;
	stepRunId: string;
}): void {
	const existing: TerminalJobWakeup | undefined = wakeups.get(params.jobId);
	if (existing !== undefined) {
		clearTimeout(existing.timer);
	}

	const timer: NodeJS.Timeout = setTimeout((): void => {
		void handleWakeup(wakeups.get(params.jobId) ?? {
			...params,
			timer
		});
	}, params.wakeAfterMs);

	wakeups.set(params.jobId, {
		...params,
		timer
	});
}
