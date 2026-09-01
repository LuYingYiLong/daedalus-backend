import { createHash, randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { ServerEvent } from "../protocol/types.js";
import type {
	GodotRuntimeControlContext,
	GodotRuntimeStartIdentity,
} from "../tools/godot-runtime-control.js";
import { getClientConnection } from "./client-connections.js";
import { sendJson } from "./send-json.js";

// First launches can spend a significant amount of time importing project
// resources before the Runtime Bridge is able to complete its handshake.
const START_TIMEOUT_MS: number = 5 * 60_000;
const MAX_PENDING_STARTS: number = 4;
const MAX_RESULT_BYTES: number = 64 * 1024;

type PendingStart = {
	callId: string;
	socket: WebSocket;
	timer: NodeJS.Timeout;
	resolve: (result: Record<string, unknown>) => void;
	reject: (error: Error) => void;
	abortCleanup?: (() => void) | undefined;
};

export type GodotRuntimeStartResultParams = {
	callId: string;
	ok: boolean;
	result?: Record<string, unknown> | undefined;
	error?: {
		code: string;
		message: string;
		retryable: boolean;
	} | undefined;
};

export class StudioGodotRuntimeError extends Error {
	readonly code: string;
	readonly retryable: boolean;

	constructor(code: string, message: string, retryable: boolean = false) {
		super(message);
		this.name = "StudioGodotRuntimeError";
		this.code = code;
		this.retryable = retryable;
	}
}

export class StudioGodotRuntime {
	private readonly pending: Map<string, PendingStart> = new Map();
	private readonly operations: Map<string, {
		socket: WebSocket;
		argsHash: string;
		promise: Promise<Record<string, unknown>>;
	}> = new Map();
	private sequence: number = 0;

	createControl(socket: WebSocket, sessionId: string, workspaceId: string): GodotRuntimeControlContext {
		const connectionId: string | undefined = getClientConnection(socket)?.connectionId;
		return {
			start: (
				args: Record<string, unknown>,
				identity: GodotRuntimeStartIdentity,
				abortSignal?: AbortSignal | undefined,
			): Promise<Record<string, unknown>> => {
				if (connectionId === undefined || getClientConnection(socket)?.connectionId !== connectionId) {
					return Promise.reject(new StudioGodotRuntimeError(
						"runtime_test_studio_disconnected",
						"The Studio connection for this Runtime Test is no longer available.",
						true,
					));
				}
				const operationKey: string = [connectionId, sessionId, identity.requestId, identity.toolCallId].join(":");
				const argsHash: string = createHash("sha256").update(JSON.stringify(args)).digest("hex");
				const existing = this.operations.get(operationKey);
				if (existing !== undefined) {
					if (existing.socket !== socket || existing.argsHash !== argsHash) {
						return Promise.reject(new StudioGodotRuntimeError(
							"runtime_test_start_mismatch",
							"The repeated Runtime Test start request did not match its original scope.",
						));
					}
					return existing.promise;
				}
				const promise: Promise<Record<string, unknown>> = this.start(
					socket,
					sessionId,
					workspaceId,
					identity,
					args,
					abortSignal,
				);
				this.operations.set(operationKey, { socket, argsHash, promise });
				void promise.finally((): void => {
					setTimeout((): void => {
						this.operations.delete(operationKey);
					}, 5 * 60_000).unref();
				}).catch((): void => undefined);
				return promise;
			},
		};
	}

	handleResult(socket: WebSocket, params: GodotRuntimeStartResultParams): void {
		const pending: PendingStart | undefined = this.pending.get(params.callId);
		if (pending === undefined) {
			throw new StudioGodotRuntimeError(
				"runtime_test_start_not_found",
				"The Runtime Test start request is no longer pending.",
			);
		}
		if (pending.socket !== socket) {
			throw new StudioGodotRuntimeError(
				"runtime_test_start_connection_mismatch",
				"The Runtime Test start result came from a different Studio connection.",
			);
		}
		if (Buffer.byteLength(JSON.stringify(params.result ?? params.error ?? {}), "utf8") > MAX_RESULT_BYTES) {
			this.rejectPending(pending, new StudioGodotRuntimeError(
				"runtime_test_start_result_too_large",
				"The Runtime Test start result exceeded the 64 KiB limit.",
			));
			return;
		}

		this.removePending(pending);
		if (params.ok) {
			pending.resolve(params.result ?? {});
			return;
		}
		pending.reject(new StudioGodotRuntimeError(
			params.error?.code ?? "runtime_test_start_failed",
			params.error?.message ?? "The visible Runtime Test failed to start.",
			params.error?.retryable ?? false,
		));
	}

	detachSocket(socket: WebSocket): void {
		for (const pending of [...this.pending.values()]) {
			if (pending.socket !== socket) continue;
			this.rejectPending(pending, new StudioGodotRuntimeError(
				"runtime_test_studio_disconnected",
				"Daedalus Studio disconnected while starting the Runtime Test.",
				true,
			));
		}
		for (const [key, operation] of this.operations) {
			if (operation.socket === socket) this.operations.delete(key);
		}
	}

	private start(
		socket: WebSocket,
		sessionId: string,
		workspaceId: string,
		identity: GodotRuntimeStartIdentity,
		args: Record<string, unknown>,
		abortSignal?: AbortSignal | undefined,
	): Promise<Record<string, unknown>> {
		if (socket.readyState !== WebSocket.OPEN) {
			return Promise.reject(new StudioGodotRuntimeError(
				"runtime_test_studio_disconnected",
				"Daedalus Studio is unavailable for a visible Runtime Test.",
				true,
			));
		}
		if (abortSignal?.aborted) {
			return Promise.reject(new StudioGodotRuntimeError(
				"runtime_test_start_cancelled",
				"The Runtime Test start request was cancelled.",
			));
		}
		if (this.pending.size >= MAX_PENDING_STARTS) {
			return Promise.reject(new StudioGodotRuntimeError(
				"runtime_test_start_busy",
				"Too many Runtime Test start requests are pending.",
				true,
			));
		}

		const callId: string = `godot-runtime-start-${randomUUID()}`;
		return new Promise<Record<string, unknown>>((resolve, reject): void => {
			const timer: NodeJS.Timeout = setTimeout((): void => {
				const pending: PendingStart | undefined = this.pending.get(callId);
				if (pending === undefined) return;
				this.emit(socket, "godot.runtimeTest.start.cancel", sessionId, identity.requestId, callId, { callId });
				this.rejectPending(pending, new StudioGodotRuntimeError(
					"runtime_test_start_timeout",
					"The visible Runtime Test did not connect within 5 minutes.",
					true,
				));
			}, START_TIMEOUT_MS);
			const pending: PendingStart = { callId, socket, timer, resolve, reject };
			if (abortSignal !== undefined) {
				const handleAbort = (): void => {
					if (!this.pending.has(callId)) return;
					this.emit(socket, "godot.runtimeTest.start.cancel", sessionId, identity.requestId, callId, { callId });
					this.rejectPending(pending, new StudioGodotRuntimeError(
						"runtime_test_start_cancelled",
						"The Runtime Test start request was cancelled.",
					));
				};
				abortSignal.addEventListener("abort", handleAbort, { once: true });
				pending.abortCleanup = (): void => abortSignal.removeEventListener("abort", handleAbort);
			}
			this.pending.set(callId, pending);
			this.emit(socket, "godot.runtimeTest.start.request", sessionId, identity.requestId, callId, {
				...args,
				callId,
				sessionId,
				workspaceId,
				toolCallId: identity.toolCallId,
				timeoutMs: START_TIMEOUT_MS,
			});
		});
	}

	private emit(
		socket: WebSocket,
		event: "godot.runtimeTest.start.request" | "godot.runtimeTest.start.cancel",
		sessionId: string,
		requestId: string,
		callId: string,
		data: Record<string, unknown>,
	): void {
		const envelope: ServerEvent = {
			protocolVersion: 3,
			type: "event",
			eventId: callId,
			event,
			sessionId,
			requestId,
			runId: requestId,
			sequence: ++this.sequence,
			createdAt: new Date().toISOString(),
			data,
		};
		sendJson(socket, envelope);
	}

	private rejectPending(pending: PendingStart, error: Error): void {
		this.removePending(pending);
		pending.reject(error);
	}

	private removePending(pending: PendingStart): void {
		clearTimeout(pending.timer);
		pending.abortCleanup?.();
		this.pending.delete(pending.callId);
	}
}

export const studioGodotRuntime: StudioGodotRuntime = new StudioGodotRuntime();

export function getStudioGodotRuntimeControl(
	socket: WebSocket,
	sessionId: string | undefined,
	workspaceId: string | undefined,
): GodotRuntimeControlContext | undefined {
	const connection = getClientConnection(socket);
	if (connection?.clientType !== "studio"
		|| connection.capabilities.godotRuntimeTest !== true
		|| sessionId === undefined
		|| workspaceId === undefined) {
		return undefined;
	}
	// The launch tool is available only after the desktop transport explicitly
	// advertises support. New Studio builds include this bit in the initial hello,
	// so tool discovery and the event listener share one negotiated lifetime.
	return studioGodotRuntime.createControl(socket, sessionId, workspaceId);
}
