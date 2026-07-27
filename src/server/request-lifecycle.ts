import WebSocket from "ws";
import type { ClientRequest } from "../protocol/types.js";
import { sendJson } from "./send-json.js";
import { sendSessionEvent } from "./session-events.js";
import type { ClientSession } from "./client-session.js";

const REQUEST_DEDUP_TTL_MS: number = 5 * 60 * 1000;
const MAX_COMPLETED_REQUEST_IDS: number = 512;

function createCancellationError(): Error {
	const error: Error = new Error("Request cancelled");
	error.name = "AbortError";
	return error;
}

/**
 * Cancellation is a control-flow boundary, not a recoverable provider error.
 * Call this before scheduling any follow-up work after an asynchronous step.
 */
export function throwIfAborted(abortSignal?: AbortSignal | undefined): void {
	if (abortSignal?.aborted) {
		throw createCancellationError();
	}
}

/**
 * Stop awaiting orchestration work immediately while the underlying operation
 * receives the same signal and can release its own network/process resources.
 */
export async function awaitWithAbort<T>(operation: Promise<T>, abortSignal?: AbortSignal | undefined): Promise<T> {
	throwIfAborted(abortSignal);
	if (abortSignal === undefined) {
		return await operation;
	}

	return await new Promise<T>((resolve, reject): void => {
		const onAbort = (): void => {
			abortSignal.removeEventListener("abort", onAbort);
			reject(createCancellationError());
		};
		const cleanup = (): void => {
			abortSignal.removeEventListener("abort", onAbort);
		};
		abortSignal.addEventListener("abort", onAbort, { once: true });
		operation.then(
			(value: T): void => {
				cleanup();
				resolve(value);
			},
			(error: unknown): void => {
				cleanup();
				reject(error);
			}
		);
	});
}

export function isCancellationError(error: unknown, abortSignal?: AbortSignal | undefined): boolean {
	if (abortSignal?.aborted) {
		return true;
	}
	if (!(error instanceof Error)) {
		return false;
	}

	return error.name === "AbortError" || error.message.toLowerCase().includes("cancel");
}

export function sendAgentCancelled(socket: WebSocket, requestId: string, session: ClientSession, runId: string = requestId, reason: string = "cancelled"): void {
	sendSessionEvent(socket, requestId, session, "agent.run.cancelled", {
		runId,
		requestId,
		status: "cancelled",
		reason,
		sequence: session.workbenchActiveRun.sequence ?? session.workbenchActiveRunSequence
	}, requestId);
}

export function pruneCompletedRequestIds(session: ClientSession, now: number = Date.now()): void {
	for (const [requestId, completedAt] of session.completedRequestIds.entries()) {
		if (now - completedAt > REQUEST_DEDUP_TTL_MS) {
			session.completedRequestIds.delete(requestId);
		}
	}

	while (session.completedRequestIds.size > MAX_COMPLETED_REQUEST_IDS) {
		const oldestRequestId: string | undefined = session.completedRequestIds.keys().next().value;
		if (oldestRequestId === undefined) {
			break;
		}
		session.completedRequestIds.delete(oldestRequestId);
	}
}

export function beginRequestExecution(socket: WebSocket, request: ClientRequest, session: ClientSession): boolean {
	if (request.id.length === 0) {
		return true;
	}

	pruneCompletedRequestIds(session);
	if (session.inFlightRequestIds.has(request.id)) {
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: {
				duplicate: true,
				ignored: true,
				state: "in_flight",
				method: request.method
			}
		});
		return false;
	}

	if (session.completedRequestIds.has(request.id)) {
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: {
				duplicate: true,
				ignored: true,
				state: "completed",
				method: request.method
			}
		});
		return false;
	}

	session.inFlightRequestIds.add(request.id);
	return true;
}

export function finishRequestExecution(request: ClientRequest, session: ClientSession): void {
	if (request.id.length === 0) {
		return;
	}

	session.inFlightRequestIds.delete(request.id);
	session.completedRequestIds.set(request.id, Date.now());
	pruneCompletedRequestIds(session);
}

export function parseMessage(data: WebSocket.RawData, isBinary: boolean): unknown {
	if (isBinary) {
		throw new Error("Binary messages are not supported");
	}

	const text: string = typeof data === "string" ? data : data.toString("utf8");
	return JSON.parse(text) as unknown;
}
