import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { BrowserControlContext, BrowserToolName } from "../tools/browser-tools.js";
import type { ServerEvent } from "../protocol/types.js";
import { sendJson } from "./send-json.js";
import type { BrowserScope } from "../protocol/external-browser.js";

const MAX_PENDING_CALLS: number = 32;
const MAX_RESULT_BYTES: number = 3 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS: number = 30_000;

type PendingCall = {
	callId: string;
	socket: WebSocket;
	timer: NodeJS.Timeout;
	resolve: (result: Record<string, unknown>) => void;
	reject: (error: Error) => void;
	abortCleanup?: (() => void) | undefined;
};

export type BrowserToolResultParams = {
	callId: string;
	ok: boolean;
	result?: Record<string, unknown> | undefined;
	error?: { code: string; message: string; retryable: boolean } | undefined;
};

export class StudioBrowserToolError extends Error {
	readonly code: string;
	readonly retryable: boolean;

	constructor(code: string, message: string, retryable: boolean = false) {
		super(message);
		this.name = "StudioBrowserToolError";
		this.code = code;
		this.retryable = retryable;
	}
}

export class StudioBrowserRuntime {
	private readonly pending: Map<string, PendingCall> = new Map();

	createControl(socket: WebSocket, sessionId: string): BrowserControlContext {
		return {
			execute: (toolName, args, abortSignal): Promise<Record<string, unknown>> =>
				this.execute(socket, sessionId, toolName, args, abortSignal)
		};
	}

	forwardExternal(socket: WebSocket, scope: BrowserScope, toolCallId: string, operation: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
		return this.execute(socket, scope.sessionId, operation, args, signal, { scope, toolCallId });
	}

	handleResult(socket: WebSocket, params: BrowserToolResultParams): void {
		const pending: PendingCall | undefined = this.pending.get(params.callId);
		if (pending === undefined) {
			throw new StudioBrowserToolError("browser_call_not_found", "Browser tool call is no longer pending.");
		}
		if (pending.socket !== socket) {
			throw new StudioBrowserToolError("browser_result_socket_mismatch", "Browser tool result came from a different Studio connection.");
		}
		if (Buffer.byteLength(JSON.stringify(params.result ?? params.error ?? {}), "utf8") > MAX_RESULT_BYTES) {
			this.rejectPending(pending, new StudioBrowserToolError("browser_result_too_large", "Browser tool result exceeded the 3 MiB limit."));
			return;
		}

		this.removePending(pending);
		if (params.ok) {
			pending.resolve(params.result ?? {});
			return;
		}
		pending.reject(new StudioBrowserToolError(
			params.error?.code ?? "browser_tool_failed",
			params.error?.message ?? "Browser tool execution failed.",
			params.error?.retryable ?? false
		));
	}

	detachSocket(socket: WebSocket): void {
		for (const pending of [...this.pending.values()]) {
			if (pending.socket === socket) {
				this.rejectPending(pending, new StudioBrowserToolError("browser_runtime_disconnected", "Daedalus Studio browser runtime disconnected.", true));
			}
		}
	}

	private execute(socket: WebSocket, sessionId: string, toolName: string, args: Record<string, unknown>, abortSignal?: AbortSignal | undefined, external?: { scope: BrowserScope; toolCallId: string }): Promise<Record<string, unknown>> {
		if (socket.readyState !== WebSocket.OPEN) {
			return Promise.reject(new StudioBrowserToolError("browser_runtime_disconnected", "Daedalus Studio browser runtime is unavailable.", true));
		}
		if (this.pending.size >= MAX_PENDING_CALLS) {
			return Promise.reject(new StudioBrowserToolError("browser_runtime_busy", "Too many browser tool calls are pending.", true));
		}
		if (abortSignal?.aborted) {
			return Promise.reject(new StudioBrowserToolError("browser_tool_cancelled", "Browser tool call was cancelled."));
		}

		const callId: string = `browser-${randomUUID()}`;
		return new Promise<Record<string, unknown>>((resolve, reject): void => {
			const timer: NodeJS.Timeout = setTimeout((): void => {
				const pending: PendingCall | undefined = this.pending.get(callId);
				if (pending !== undefined) {
					sendJson(socket, this.createEvent("browser.tool.cancel", sessionId, callId, { callId, ...(external ? { external: true, ...external } : {}) }, external?.scope));
					this.rejectPending(pending, new StudioBrowserToolError("browser_tool_timeout", "Daedalus Studio browser tool timed out.", false));
				}
			}, DEFAULT_TIMEOUT_MS);
			const pending: PendingCall = { callId, socket, timer, resolve, reject };
			if (abortSignal !== undefined) {
				const handleAbort = (): void => {
					if (!this.pending.has(callId)) return;
					sendJson(socket, this.createEvent("browser.tool.cancel", sessionId, callId, { callId, ...(external ? { external: true, ...external } : {}) }, external?.scope));
					this.rejectPending(pending, new StudioBrowserToolError("browser_tool_cancelled", "Browser tool call was cancelled."));
				};
				abortSignal.addEventListener("abort", handleAbort, { once: true });
				pending.abortCleanup = (): void => abortSignal.removeEventListener("abort", handleAbort);
			}
			this.pending.set(callId, pending);
			sendJson(socket, this.createEvent("browser.tool.request", sessionId, callId, { callId, sessionId, toolName, args, timeoutMs: DEFAULT_TIMEOUT_MS, ...(external ? { external: true, ...external } : {}) }, external?.scope));
		});
	}

	private createEvent(event: "browser.tool.request" | "browser.tool.cancel", sessionId: string, callId: string, data: Record<string, unknown>, scope?: BrowserScope): ServerEvent {
		return { protocolVersion: 3, type: "event", eventId: callId, event, sessionId, requestId: scope?.requestId ?? callId, runId: scope?.runId ?? callId, sequence: Date.now() * 1000, createdAt: new Date().toISOString(), data };
	}

	private rejectPending(pending: PendingCall, error: Error): void {
		this.removePending(pending);
		pending.reject(error);
	}

	private removePending(pending: PendingCall): void {
		clearTimeout(pending.timer);
		pending.abortCleanup?.();
		this.pending.delete(pending.callId);
	}
}

export const studioBrowserRuntime: StudioBrowserRuntime = new StudioBrowserRuntime();
