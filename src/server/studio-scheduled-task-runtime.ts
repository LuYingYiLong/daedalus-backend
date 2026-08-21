import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { ServerEvent } from "../protocol/types.js";
import type { ScheduledTaskControlContext, ScheduledTaskToolName } from "../tools/scheduled-task-tools.js";
import { sendJson } from "./send-json.js";

const MAX_PENDING_CALLS: number = 32;
const MAX_RESULT_BYTES: number = 1024 * 1024;
const DEFAULT_TIMEOUT_MS: number = 30_000;

type PendingCall = {
	callId: string;
	socket: WebSocket;
	timer: NodeJS.Timeout;
	resolve: (result: Record<string, unknown>) => void;
	reject: (error: Error) => void;
	abortCleanup?: () => void;
};

export type ScheduledTaskToolResultParams = {
	callId: string;
	ok: boolean;
	result?: Record<string, unknown> | undefined;
	error?: { code: string; message: string; retryable: boolean } | undefined;
};

export class StudioScheduledTaskRuntime {
	private readonly pending: Map<string, PendingCall> = new Map();

	createControl(socket: WebSocket, sessionId: string): ScheduledTaskControlContext {
		return { execute: (toolName, args, signal) => this.execute(socket, sessionId, toolName, args, signal) };
	}

	handleResult(socket: WebSocket, params: ScheduledTaskToolResultParams): void {
		const pending: PendingCall | undefined = this.pending.get(params.callId);
		if (pending === undefined) throw new Error("scheduled_task_call_not_found");
		if (pending.socket !== socket) throw new Error("scheduled_task_result_socket_mismatch");
		if (Buffer.byteLength(JSON.stringify(params.result ?? params.error ?? {}), "utf8") > MAX_RESULT_BYTES) {
			this.reject(pending, new Error("scheduled_task_result_too_large"));
			return;
		}
		this.remove(pending);
		if (params.ok) pending.resolve(params.result ?? {});
		else pending.reject(new Error(`${params.error?.code ?? "scheduled_task_tool_failed"}: ${params.error?.message ?? "Scheduled task operation failed."}`));
	}

	detachSocket(socket: WebSocket): void {
		for (const pending of [...this.pending.values()]) if (pending.socket === socket) this.reject(pending, new Error("scheduled_task_runtime_disconnected"));
	}

	private execute(socket: WebSocket, sessionId: string, toolName: ScheduledTaskToolName, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
		if (socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("scheduled_task_runtime_disconnected"));
		if (this.pending.size >= MAX_PENDING_CALLS) return Promise.reject(new Error("scheduled_task_runtime_busy"));
		if (signal?.aborted) return Promise.reject(new Error("scheduled_task_tool_cancelled"));
		const callId: string = `scheduled-task-${randomUUID()}`;
		return new Promise((resolve, reject): void => {
			const timer: NodeJS.Timeout = setTimeout((): void => {
				const current = this.pending.get(callId);
				if (current !== undefined) this.reject(current, new Error("scheduled_task_tool_timeout"));
			}, DEFAULT_TIMEOUT_MS);
			const pending: PendingCall = { callId, socket, timer, resolve, reject };
			if (signal !== undefined) {
				const onAbort = (): void => {
					if (!this.pending.has(callId)) return;
					sendJson(socket, this.event("scheduled-task.tool.cancel", sessionId, callId, { callId }));
					this.reject(pending, new Error("scheduled_task_tool_cancelled"));
				};
				signal.addEventListener("abort", onAbort, { once: true });
				pending.abortCleanup = (): void => signal.removeEventListener("abort", onAbort);
			}
			this.pending.set(callId, pending);
			sendJson(socket, this.event("scheduled-task.tool.request", sessionId, callId, { callId, sessionId, toolName, args, timeoutMs: DEFAULT_TIMEOUT_MS }));
		});
	}

	private event(event: "scheduled-task.tool.request" | "scheduled-task.tool.cancel", sessionId: string, callId: string, data: Record<string, unknown>): ServerEvent {
		return { protocolVersion: 3, type: "event", eventId: callId, event, sessionId, requestId: callId, runId: callId, sequence: Date.now() * 1000, createdAt: new Date().toISOString(), data };
	}

	private reject(pending: PendingCall, error: Error): void { this.remove(pending); pending.reject(error); }
	private remove(pending: PendingCall): void { clearTimeout(pending.timer); pending.abortCleanup?.(); this.pending.delete(pending.callId); }
}

export const studioScheduledTaskRuntime: StudioScheduledTaskRuntime = new StudioScheduledTaskRuntime();
