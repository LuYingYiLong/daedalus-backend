import assert from "node:assert/strict";
import test from "node:test";
import type { ChatCompletionCreateParamsBase } from "openai/resources/chat/completions";
import { aiChatParamsSchema } from "../../../src/protocol/schema.js";
import { createAnthropicRequestBody } from "../../../src/providers/anthropic-compatible-client.js";
import { createOpenAIResponsesRequestBody } from "../../../src/providers/openai-responses-client.js";
import { applyChatOptions } from "../../../src/providers/provider-chat-completions-client.js";
import { getProviderFallbackModels } from "../../../src/providers/provider-registry.js";
import { resolveReasoningEffort, resolveReasoningEffortForModelChange } from "../../../src/providers/reasoning-effort.js";
import type { ProviderChatOptions } from "../../../src/providers/provider-types.js";

test("reasoning efforts are exposed only for adjustable catalog models", (): void => {
	assert.deepEqual(
		getProviderFallbackModels("openai").find((model) => model.id === "gpt-5.6-sol")?.capabilities.reasoningEfforts,
		[
			{ id: "low", fallback: "low" },
			{ id: "medium", fallback: "medium" },
			{ id: "high", fallback: "high" },
			{ id: "xhigh", fallback: "high" },
			{ id: "max", fallback: "max" }
		]
	);
	assert.deepEqual(
		getProviderFallbackModels("deepseek").find((model) => model.id === "deepseek-v4-pro")?.capabilities.reasoningEfforts,
		[
			{ id: "high", fallback: "high" },
			{ id: "max", fallback: "max" }
		]
	);
	assert.deepEqual(
		getProviderFallbackModels("moonshot").find((model) => model.id === "kimi-k3")?.capabilities.reasoningEfforts,
		[
			{ id: "low", fallback: "low" },
			{ id: "high", fallback: "high" },
			{ id: "max", fallback: "max", default: true }
		]
	);
});

test("reasoning effort normalizes model-specific strength during a model switch", (): void => {
	assert.equal(resolveReasoningEffort("openai", "gpt-5.6-sol", "xhigh"), "xhigh");
	assert.equal(
		resolveReasoningEffortForModelChange("openai", "gpt-5.6-sol", "xhigh", "openai", "gpt-5.5"),
		"high"
	);
	assert.equal(
		resolveReasoningEffortForModelChange("openai", "gpt-5.6-sol", "medium", "deepseek", "deepseek-v4-pro"),
		"high"
	);
	assert.equal(resolveReasoningEffort("moonshot", "kimi-k3", "high"), "high");
	assert.equal(resolveReasoningEffort("moonshot", "kimi-k3", undefined), "max");
});

test("provider request builders forward only supported reasoning parameters", (): void => {
	const params = aiChatParamsSchema.parse({
		message: "Explain the change.",
		options: { reasoningEffort: "xhigh" }
	});
	const openAIRequest = createOpenAIResponsesRequestBody(
		params,
		{ provider: "openai", apiKey: "test", model: "gpt-5.6-sol" },
		[],
		"system"
	) as unknown as Record<string, unknown>;
	assert.deepEqual(openAIRequest.reasoning, { effort: "xhigh" });

	const deepSeekRequest = {
		model: "deepseek-v4-pro",
		messages: []
	} as unknown as ChatCompletionCreateParamsBase;
	const deepSeekOptions: ProviderChatOptions = {
		provider: "deepseek",
		apiKey: "test",
		model: "deepseek-v4-pro"
	};
	applyChatOptions(deepSeekRequest, params, deepSeekOptions);
	assert.equal((deepSeekRequest as unknown as Record<string, unknown>).reasoning_effort, "high");
	assert.deepEqual((deepSeekRequest as unknown as Record<string, unknown>).thinking, { type: "enabled" });

	const kimiRequest = {
		model: "kimi-k3",
		messages: []
	} as unknown as ChatCompletionCreateParamsBase;
	applyChatOptions(kimiRequest, params, { provider: "moonshot", apiKey: "test", model: "kimi-k3" });
	assert.equal((kimiRequest as unknown as Record<string, unknown>).reasoning_effort, "max");
	assert.equal("thinking" in (kimiRequest as unknown as Record<string, unknown>), false);

	const anthropicRequest = createAnthropicRequestBody(
		params,
		{ provider: "openai", apiKey: "test", model: "gpt-5.6-sol" },
		[],
		"system"
	) as unknown as Record<string, unknown>;
	assert.deepEqual(anthropicRequest.output_config, { effort: "xhigh" });
});

test("auxiliary provider requests can disable reasoning without changing model defaults", (): void => {
	const params = aiChatParamsSchema.parse({
		message: "Generate a short JSON object.",
		options: { reasoningEffort: "max", responseFormat: "json" }
	});
	const deepSeekRequest = {
		model: "deepseek-v4-pro",
		messages: []
	} as unknown as ChatCompletionCreateParamsBase;
	applyChatOptions(deepSeekRequest, params, {
		provider: "deepseek",
		apiKey: "test",
		model: "deepseek-v4-pro",
		reasoningMode: "disabled"
	});
	const deepSeekRecord = deepSeekRequest as unknown as Record<string, unknown>;
	assert.equal("reasoning_effort" in deepSeekRecord, false);
	assert.deepEqual(deepSeekRecord.thinking, { type: "disabled" });

	const openAIRequest = createOpenAIResponsesRequestBody(
		params,
		{
			provider: "openai",
			apiKey: "test",
			model: "gpt-5.6-sol",
			reasoningMode: "disabled"
		},
		[],
		"system"
	) as unknown as Record<string, unknown>;
	assert.equal("reasoning" in openAIRequest, false);

	const anthropicRequest = createAnthropicRequestBody(
		params,
		{
			provider: "openai",
			apiKey: "test",
			model: "gpt-5.6-sol",
			reasoningMode: "disabled"
		},
		[],
		"system"
	) as unknown as Record<string, unknown>;
	assert.equal("output_config" in anthropicRequest, false);
});
