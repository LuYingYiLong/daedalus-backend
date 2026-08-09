import assert from "node:assert/strict";
import test from "node:test";
import {
	applyProviderRequestOverridesToFetchInit,
	createProviderRequestOverrideFetch,
	normalizeProviderRequestOverrides
} from "../../../src/providers/provider-request-overrides.js";

test("provider request overrides add extension headers and body values without replacing Daedalus fields", async (): Promise<void> => {
	const overrides = normalizeProviderRequestOverrides({
		headers: { "HTTP-Referer": "https://daedalus.example" },
		body: { enable_thinking: false, chat_template_kwargs: { enable_thinking: false } }
	});
	assert.notEqual(overrides, undefined);

	const requestInit: RequestInit = applyProviderRequestOverridesToFetchInit({
		method: "POST",
		headers: {
			Authorization: "Bearer configured-key",
			"Content-Type": "application/json"
		},
		body: JSON.stringify({ model: "deepseek-v4-flash", messages: [], enable_thinking: true })
	}, overrides);

	const headers: Headers = new Headers(requestInit.headers);
	assert.equal(headers.get("Authorization"), "Bearer configured-key");
	assert.equal(headers.get("HTTP-Referer"), "https://daedalus.example");
	assert.deepEqual(JSON.parse(String(requestInit.body)), {
		model: "deepseek-v4-flash",
		messages: [],
		enable_thinking: true,
		chat_template_kwargs: { enable_thinking: false }
	});

	let capturedInit: RequestInit | undefined;
	const requestFetch = createProviderRequestOverrideFetch(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		capturedInit = init;
		return new Response("{}", { status: 200 });
	}, overrides);
	await requestFetch("https://example.test/v1/models", { method: "GET", headers: { Authorization: "Bearer configured-key" } });
	assert.equal(new Headers(capturedInit?.headers).get("HTTP-Referer"), "https://daedalus.example");
	assert.equal(capturedInit?.body, undefined);
});

test("provider request overrides reject protocol-owned request fields and transport headers", (): void => {
	assert.throws(
		(): void => {
			normalizeProviderRequestOverrides({ body: { tools: [] } });
		},
		/provider_request_overrides_invalid: Body property tools is managed by Daedalus/u
	);
	assert.throws(
		(): void => {
			normalizeProviderRequestOverrides({ headers: { Authorization: "Bearer another-key" } });
		},
		/provider_request_overrides_invalid: Header Authorization is managed by Daedalus/u
	);
	assert.throws(
		(): void => {
			normalizeProviderRequestOverrides(JSON.parse('{"body":{"__proto__":{"polluted":true}}}') as unknown);
		},
		/provider_request_overrides_invalid/u
	);
});
