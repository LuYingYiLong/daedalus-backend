import assert from "node:assert/strict";
import test from "node:test";
import { awaitWithAbort, isCancellationError, throwIfAborted } from "../../../src/server/request-lifecycle.js";

test("awaitWithAbort stops orchestration immediately when a request is cancelled", async (): Promise<void> => {
	const controller: AbortController = new AbortController();
	let resolveOperation: (() => void) | undefined;
	const operation: Promise<void> = new Promise<void>((resolve): void => {
		resolveOperation = resolve;
	});
	const waiting: Promise<void> = awaitWithAbort(operation, controller.signal);

	controller.abort();
	await assert.rejects(waiting, (error: unknown): boolean => isCancellationError(error, controller.signal));
	resolveOperation?.();
});

test("throwIfAborted uses a cancellation error that callers do not recover as a provider failure", (): void => {
	const controller: AbortController = new AbortController();
	controller.abort();

	assert.throws(
		(): void => throwIfAborted(controller.signal),
		(error: unknown): boolean => isCancellationError(error, controller.signal)
	);
});
