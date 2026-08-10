import assert from "node:assert/strict";
import test from "node:test";
import {
	classifyProviderError,
	createProviderStatusEvent,
	isProviderContextLengthError,
	isRetryableProviderTransportError
} from "../../../src/providers/provider-error.js";
import { ProviderResponseStalledError } from "../../../src/providers/provider-resilience.js";

test("provider quota errors are classified by status and message", (): void => {
	assert.equal(classifyProviderError({ status: 402, message: "Payment Required" }).code, "provider_quota_exhausted");
	assert.equal(classifyProviderError(new Error("insufficient balance")).code, "provider_quota_exhausted");
	assert.equal(classifyProviderError(new Error("余额不足，请充值")).code, "provider_quota_exhausted");
});

test("generic provider errors stay generic", (): void => {
	const result = classifyProviderError(new Error("upstream timeout"));

	assert.equal(result.code, "provider_error");
	assert.equal(result.message, "upstream timeout");
});

test("interrupted provider streams get a stable actionable error", (): void => {
	const result = classifyProviderError(new TypeError("terminated"));

	assert.equal(isRetryableProviderTransportError(new TypeError("terminated")), true);
	assert.equal(isRetryableProviderTransportError({ message: "request failed", cause: { code: "UND_ERR_SOCKET" } }), true);
	assert.equal(isRetryableProviderTransportError(new DOMException("Request cancelled", "AbortError")), false);
	assert.equal(result.code, "provider_connection_interrupted");
	assert.match(result.message, /connection to the model provider ended unexpectedly/i);
	assert.doesNotMatch(result.message, /^terminated$/i);
});

test("quota status event uses visual status fields", (): void => {
	const event = createProviderStatusEvent(new Error("insufficient quota"));

	assert.equal(event.status, "error");
	assert.equal(event.code, "provider_quota_exhausted");
	assert.equal(event.actionId, "provider-settings");
});

test("interrupted provider status event names the connection failure", (): void => {
	const event = createProviderStatusEvent(new TypeError("terminated"));

	assert.equal(event.status, "error");
	assert.equal(event.code, "provider_connection_interrupted");
	assert.equal(event.title, "Model Connection Interrupted");
});

test("context length recovery only accepts structured provider error codes", (): void => {
	assert.equal(isProviderContextLengthError({ code: "context_length_exceeded" }), true);
	assert.equal(isProviderContextLengthError({ error: { type: "prompt_too_long" } }), true);
	assert.equal(isProviderContextLengthError({ body: { error: { reason: "input_too_long" } } }), true);
	assert.equal(isProviderContextLengthError(new Error("context_length_exceeded")), false);
	assert.equal(isProviderContextLengthError({ code: "invalid_request_error", message: "prompt is too long" }), false);
});

test("silent provider streams are recoverable pauses, not network failures", (): void => {
	const error = new ProviderResponseStalledError(new Error("stream silent"));
	const result = classifyProviderError(error);

	assert.equal(result.code, "provider_response_stalled");
	assert.match(result.message, /stopped producing data/i);
	const event = createProviderStatusEvent(error);
	assert.equal(event.status, "warning");
	assert.equal(event.title, "Model Response Paused");
});
