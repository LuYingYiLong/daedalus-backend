import assert from "node:assert/strict";
import test from "node:test";
import { redactTraceValue } from "../../../src/trace/trace-redactor.js";

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
