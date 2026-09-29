import assert from "node:assert/strict";
import test from "node:test";
import { getPromptCachePolicy, resolvePromptVariant } from "../../../src/usage/prompt-cache-policy.js";
import { withProviderUsageContext } from "../../../src/usage/provider-recorder.js";

test("prompt cache policy keeps a session in one variant and defaults to legacy", (): void => {
	const previous = process.env.DAEDALUS_PROMPT_CACHE_POLICY;
	try {
		delete process.env.DAEDALUS_PROMPT_CACHE_POLICY;
		assert.equal(getPromptCachePolicy(), "legacy");
		assert.equal(resolvePromptVariant("session-a"), "legacy");
		process.env.DAEDALUS_PROMPT_CACHE_POLICY = "canary";
		assert.equal(resolvePromptVariant(), "legacy");
		for (let index = 0; index < 100; index += 1) {
			const sessionId = `session-${index}`;
			assert.equal(resolvePromptVariant(sessionId), resolvePromptVariant(sessionId));
		}
		assert.ok(Array.from({ length: 100 }, (_, index) => resolvePromptVariant(`session-${index}`)).includes("optimized"));
		process.env.DAEDALUS_PROMPT_CACHE_POLICY = "optimized";
		assert.equal(resolvePromptVariant(), "optimized");
	} finally {
		if (previous === undefined) delete process.env.DAEDALUS_PROMPT_CACHE_POLICY;
		else process.env.DAEDALUS_PROMPT_CACHE_POLICY = previous;
	}
});

test("session variant follows routed and auxiliary provider requests", (): void => {
	const previous = process.env.DAEDALUS_PROMPT_CACHE_POLICY;
	process.env.DAEDALUS_PROMPT_CACHE_POLICY = "optimized";
	try {
		const base = withProviderUsageContext({ provider: "deepseek", apiKey: "test" }, {
			requestId: "request-a", sessionId: "session-a", operation: "chat"
		});
		assert.equal(base.usageContext?.promptVariant, "optimized");
		const auxiliary = withProviderUsageContext(base, { operation: "next_step_hints" });
		assert.equal(auxiliary.usageContext?.promptVariant, "optimized");
		assert.equal(auxiliary.usageContext?.sessionId, "session-a");
	} finally {
		if (previous === undefined) delete process.env.DAEDALUS_PROMPT_CACHE_POLICY;
		else process.env.DAEDALUS_PROMPT_CACHE_POLICY = previous;
	}
});
