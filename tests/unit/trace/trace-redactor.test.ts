import assert from "node:assert/strict";
import test from "node:test";
import { redactTraceValue } from "../../../src/trace/trace-redactor.js";

test("computer input text is redacted in structured and provider-encoded arguments", () => {
  const args = { observationId: "frame-kept", action: { type: "text", text: "private-entered-content" } };
  const result = redactTraceValue({ args, function: { name: "mcp_computer_action", arguments: JSON.stringify(args) } });
  assert.equal(JSON.stringify(result.value).includes("private-entered-content"), false);
  assert.equal(JSON.stringify(result.value).includes("frame-kept"), true);
  assert.ok(result.redactedFields.length >= 2);
  assert.equal(args.action.text, "private-entered-content");
});

test("trace excludes hydrated image pixels and grant secrets without changing evidence references", (): void => {
	const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
	const input = {
		accessId: "grant-private",
		toolText: '{"accessId":"grant-private","observationId":"obs-kept"}',
		image_url: { url: `data:image/png;base64,${image}` },
		source: { type: "base64", media_type: "image/png", data: image },
		inlineData: { mimeType: "image/png", data: image },
		reference: { source: "computer_observation", sessionId: "session-1", observationId: "obs-kept" }
	};
	const redacted = redactTraceValue(input);
	const serialized = JSON.stringify(redacted.value);
	assert.equal(serialized.includes(image), false);
	assert.equal(serialized.includes("grant-private"), false);
	assert.ok(serialized.includes("obs-kept"));
	assert.ok(redacted.redactedFields.includes("source.data"));
	assert.equal(input.source.data, image);
});

test("trace redactor removes credentials from keys, headers, URLs, and free text", (): void => {
	const redacted = redactTraceValue({
		Authorization: "Bearer secret-token-value",
		headers: { Cookie: "session=secret", "x-api-key": "key-value" },
		env: { OPENAI_API_KEY: "sk-live-secret-value", NORMAL_VALUE: "kept" },
		text: "Authorization: Bearer abc.def and OPENAI_API_KEY=sk-another-secret-value",
		url: "https://user:password@example.com/path?api_key=query-secret&mode=full",
		inputTokens: 42
	});
	const serialized: string = JSON.stringify(redacted.value);
	assert.equal(serialized.includes("secret-token-value"), false);
	assert.equal(serialized.includes("session=secret"), false);
	assert.equal(serialized.includes("key-value"), false);
	assert.equal(serialized.includes("sk-live-secret-value"), false);
	assert.equal(serialized.includes("sk-another-secret-value"), false);
	assert.equal(serialized.includes("user:password"), false);
	assert.equal(serialized.includes("query-secret"), false);
	assert.equal((redacted.value as { inputTokens: number }).inputTokens, 42);
	assert.ok(redacted.redactedFields.includes("Authorization"));
	assert.ok(redacted.redactedFields.includes("headers.Cookie"));
});
