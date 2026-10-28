import assert from "node:assert/strict";
import test from "node:test";
import { createProviderRequestFetch } from "../../../src/providers/provider-request-transport.js";
import type { ProviderChatOptions } from "../../../src/providers/provider-types.js";

test("OpenCode Go requests identify Daedalus and reuse the conversation session", async (): Promise<void> => {
	const captured: Headers[] = [];
	const fetchImpl: typeof fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		captured.push(new Headers(init?.headers));
		return new Response("{}", { status: 200 });
	};
	const options: ProviderChatOptions = {
		provider: "opencode_go",
		apiKey: "test-key",
		usageContext: { requestId: "request-1", sessionId: "session-1", operation: "chat" },
		requestOverrides: { headers: { "x-opencode-session": "wrong-session", "User-Agent": "generic-sdk" }, body: {} }
	};
	const requestFetch: typeof fetch = createProviderRequestFetch(fetchImpl, options);
	await requestFetch("https://example.test/chat/completions", { headers: { Authorization: "Bearer test-key" } });
	await requestFetch("https://example.test/chat/completions", { headers: { Authorization: "Bearer test-key" } });

	assert.equal(captured.length, 2);
	for (const headers of captured) {
		assert.equal(headers.get("x-opencode-session"), "session-1");
		assert.match(headers.get("User-Agent") ?? "", /^daedalus-backend\/\d+\.\d+\.\d+$/u);
		assert.equal(headers.get("Authorization"), "Bearer test-key");
	}
});

test("OpenCode Go one-off requests get distinct stable routing keys", async (): Promise<void> => {
	const sessions: string[] = [];
	const fetchImpl: typeof fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		sessions.push(new Headers(init?.headers).get("x-opencode-session") ?? "");
		return new Response("{}", { status: 200 });
	};
	const options: ProviderChatOptions = { provider: "opencode_go", apiKey: "test-key" };
	const first: typeof fetch = createProviderRequestFetch(fetchImpl, options);
	await first("https://example.test/models");
	await first("https://example.test/models");
	await createProviderRequestFetch(fetchImpl, options)("https://example.test/models");

	assert.match(sessions[0] ?? "", /^daedalus-[0-9a-f-]{36}$/u);
	assert.equal(sessions[0], sessions[1]);
	assert.notEqual(sessions[0], sessions[2]);
});

test("other providers keep their existing request transport", (): void => {
	const fetchImpl: typeof fetch = async (): Promise<Response> => new Response("{}", { status: 200 });
	assert.equal(createProviderRequestFetch(fetchImpl, { provider: "deepseek", apiKey: "test-key" }), fetchImpl);
});
