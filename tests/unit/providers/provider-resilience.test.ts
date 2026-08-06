import assert from "node:assert/strict";
import test from "node:test";
import type { ToolEvent } from "../../../src/tools/tool-dispatcher.js";
import { createOpenAICompatibleClient } from "../../../src/providers/provider-chat-completions-client.js";
import { createOpenAIResponsesClient } from "../../../src/providers/openai-responses-client.js";
import {
	createProviderReconnectState,
	ProviderConnectionInterruptedError,
	ProviderHttpError,
	classifyProviderRetry,
	runProviderRequestWithResilience
} from "../../../src/providers/provider-resilience.js";
import type { ProviderChatOptions } from "../../../src/providers/provider-types.js";

const providerOptions: ProviderChatOptions = {
	provider: "deepseek",
	apiKey: "test-key",
	model: "deepseek-v4-flash"
};

const immediateSleep = async (): Promise<void> => {};

test("OpenAI SDK clients disable hidden retries and keep the connection timeout explicit", (): void => {
	const chatClient = createOpenAICompatibleClient(providerOptions);
	const responsesClient = createOpenAIResponsesClient({ provider: "openai", apiKey: "test-key" });
	assert.equal(chatClient.maxRetries, 0);
	assert.equal(responsesClient.maxRetries, 0);
	assert.equal(chatClient.timeout, 60_000);
	assert.equal(responsesClient.timeout, 60_000);
});

test("transport failures reconnect and discard only the failed attempt output", async (): Promise<void> => {
	const events: ToolEvent[] = [];
	let calls: number = 0;
	const result: string = await runProviderRequestWithResilience({
		providerOptions,
		onEvent: (event: ToolEvent): void => { events.push(event); },
		sleep: immediateSleep,
		random: (): number => 0.5,
		execute: async ({ onEvent }): Promise<string> => {
			calls += 1;
			if (calls === 1) {
				onEvent?.({ type: "ai.delta", text: "partial🙂" });
				onEvent?.({ type: "ai.thinking.delta", text: "think" });
				throw Object.assign(new Error("terminated"), { code: "UND_ERR_SOCKET" });
			}
			onEvent?.({ type: "ai.delta", text: "complete" });
			return "complete";
		}
	});

	assert.equal(result, "complete");
	assert.equal(calls, 2);
	const reconnects = events.filter((event): event is Extract<ToolEvent, { type: "provider.reconnect" }> => event.type === "provider.reconnect");
	assert.equal(reconnects[0]?.status, "waiting");
	assert.equal(reconnects[0]?.attempt, 1);
	assert.equal(reconnects[0]?.discardedMessageCodePoints, 8);
	assert.equal(reconnects[0]?.discardedThinkingCodePoints, 5);
	assert.equal(reconnects.at(-1)?.status, "recovered");
});

test("eligible transport failures automatically extend from five to fifteen reconnects", async (): Promise<void> => {
	const events: ToolEvent[] = [];
	let calls: number = 0;
	const result: string = await runProviderRequestWithResilience({
		providerOptions,
		onEvent: (event: ToolEvent): void => { events.push(event); },
		sleep: immediateSleep,
		execute: async (): Promise<string> => {
			calls += 1;
			if (calls <= 7) throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } });
			return "ok";
		}
	});

	assert.equal(result, "ok");
	assert.equal(calls, 8);
	const extended = events.find((event: ToolEvent): boolean => (
		event.type === "provider.reconnect" && event.attempt === 6 && event.maxAttempts === 15
	));
	assert.notEqual(extended, undefined);
	assert.equal(extended?.type === "provider.reconnect" ? extended.autoExtended : false, true);
});

test("rate limiting stops after five reconnect attempts", async (): Promise<void> => {
	const events: ToolEvent[] = [];
	let calls: number = 0;
	await assert.rejects(
		runProviderRequestWithResilience({
			providerOptions,
			onEvent: (event: ToolEvent): void => { events.push(event); },
			sleep: immediateSleep,
			execute: async (): Promise<string> => {
				calls += 1;
				throw new ProviderHttpError("rate limited", 429);
			}
		}),
		ProviderConnectionInterruptedError
	);
	assert.equal(calls, 6);
	const reconnects = events.filter((event): event is Extract<ToolEvent, { type: "provider.reconnect" }> => event.type === "provider.reconnect");
	assert.ok(reconnects.every((event): boolean => event.attempt <= event.maxAttempts));
	assert.equal(reconnects.at(-1)?.attempt, 5);
});

test("certificate and proxy authentication failures are not retried", async (): Promise<void> => {
	assert.equal(classifyProviderRetry({ code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE", message: "fetch failed" }).retryable, false);
	assert.equal(classifyProviderRetry(new ProviderHttpError("proxy auth required", 407)).retryable, false);
	assert.equal(classifyProviderRetry({ name: "APIConnectionTimeoutError", message: "Request timed out." }).retryable, true);
	assert.equal(classifyProviderRetry({ cause: { code: "ENOTFOUND" }, message: "fetch failed" }).extensionEligible, true);
	const gateway = classifyProviderRetry(new ProviderHttpError("gateway unavailable", 503, { "retry-after": "2" }), 0);
	assert.equal(gateway.retryAfterMs, 2_000);
	assert.equal(gateway.extensionEligible, true);
	assert.equal(classifyProviderRetry(new ProviderHttpError("server failed", 500)).extensionEligible, false);
	let calls: number = 0;
	await assert.rejects(runProviderRequestWithResilience({
		providerOptions,
		sleep: immediateSleep,
		execute: async (): Promise<string> => {
			calls += 1;
			throw Object.assign(new Error("fetch failed"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" });
		}
	}));
	assert.equal(calls, 1);
});

test("the inactivity watchdog reconnects an otherwise stalled request", async (): Promise<void> => {
	const events: ToolEvent[] = [];
	let calls: number = 0;
	const result: string = await runProviderRequestWithResilience({
		providerOptions,
		onEvent: (event: ToolEvent): void => { events.push(event); },
		inactivityTimeoutMs: 5,
		stallWarningMs: 1,
		sleep: immediateSleep,
		execute: async ({ signal }): Promise<string> => {
			calls += 1;
			if (calls > 1) return "recovered";
			await new Promise<void>((_resolve, reject): void => {
				signal.addEventListener("abort", (): void => reject(signal.reason), { once: true });
			});
			return "unreachable";
		}
	});
	assert.equal(result, "recovered");
	assert.equal(calls, 2);
	const reconnects = events.filter((event): event is Extract<ToolEvent, { type: "provider.reconnect" }> => event.type === "provider.reconnect");
	assert.equal(reconnects[0]?.status, "waiting");
	assert.ok(reconnects.some((event): boolean => event.status === "reconnecting"));
	assert.equal(reconnects.at(-1)?.status, "recovered");
});

test("logical reconnect state is shared across protocol-level provider retries", async (): Promise<void> => {
	const events: ToolEvent[] = [];
	const reconnectState = createProviderReconnectState();
	let calls: number = 0;

	const execute = async (): Promise<string> => {
		calls += 1;
		if (calls === 1 || calls === 3) {
			throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
		}
		return calls === 2 ? "first response" : "second response";
	};

	assert.equal(await runProviderRequestWithResilience({
		providerOptions,
		onEvent: (event: ToolEvent): void => { events.push(event); },
		reconnectState,
		sleep: immediateSleep,
		random: (): number => 0.5,
		execute
	}), "first response");
	assert.equal(await runProviderRequestWithResilience({
		providerOptions,
		onEvent: (event: ToolEvent): void => { events.push(event); },
		reconnectState,
		sleep: immediateSleep,
		random: (): number => 0.5,
		execute
	}), "second response");

	const reconnects = events.filter((event): event is Extract<ToolEvent, { type: "provider.reconnect" }> => event.type === "provider.reconnect");
	assert.ok(reconnects.length > 0);
	assert.equal(new Set(reconnects.map((event): string => event.reconnectId)).size, 1);
	assert.deepEqual(reconnects.map((event): number => event.attempt), [1, 1, 1, 2, 2, 2]);
	assert.deepEqual(reconnects.map((event): number => event.revision), [1, 2, 3, 4, 5, 6]);
	assert.equal(reconnectState.attempt, 2);
	assert.equal(reconnectState.revision, 6);
	assert.ok(reconnects.every((event): boolean => event.attempt <= event.maxAttempts));
});

test("a silent provider stream becomes visible before its reconnect deadline and clears when activity resumes", async (): Promise<void> => {
	const events: ToolEvent[] = [];
	let calls: number = 0;
	const result: string = await runProviderRequestWithResilience({
		providerOptions,
		onEvent: (event: ToolEvent): void => { events.push(event); },
		inactivityTimeoutMs: 40,
		stallWarningMs: 5,
		execute: async ({ onEvent }): Promise<string> => {
			calls += 1;
			await new Promise<void>((resolve): void => { setTimeout(resolve, 12); });
			onEvent?.({ type: "ai.delta", text: "provider resumed" });
			return "provider resumed";
		}
	});

	assert.equal(result, "provider resumed");
	assert.equal(calls, 1);
	const reconnects = events.filter((event): event is Extract<ToolEvent, { type: "provider.reconnect" }> => event.type === "provider.reconnect");
	assert.deepEqual(reconnects.map((event): string => event.status), ["waiting", "recovered"]);
	assert.equal(reconnects[0]?.reason, "idle_timeout");
	assert.equal(reconnects[0]?.attempt, 1);
});

test("late output from a timed-out attempt is ignored", async (): Promise<void> => {
	const events: ToolEvent[] = [];
	let calls: number = 0;
	const result: string = await runProviderRequestWithResilience({
		providerOptions,
		onEvent: (event: ToolEvent): void => { events.push(event); },
		inactivityTimeoutMs: 5,
		sleep: immediateSleep,
		execute: async ({ onEvent }): Promise<string> => {
			calls += 1;
			if (calls === 1) {
				setTimeout((): void => onEvent?.({ type: "ai.delta", text: "stale" }), 8);
				return new Promise<string>(() => {});
			}
			onEvent?.({ type: "ai.delta", text: "current" });
			return "current";
		}
	});
	await new Promise<void>((resolve): void => { setTimeout(resolve, 12); });

	assert.equal(result, "current");
	assert.equal(events.some((event: ToolEvent): boolean => event.type === "ai.delta" && event.text === "stale"), false);
	assert.equal(events.some((event: ToolEvent): boolean => event.type === "ai.delta" && event.text === "current"), true);
});

test("user cancellation aborts retry backoff immediately", async (): Promise<void> => {
	const controller = new AbortController();
	setTimeout((): void => controller.abort(), 10);
	const startedAt: number = Date.now();
	await assert.rejects(runProviderRequestWithResilience({
		providerOptions,
		abortSignal: controller.signal,
		random: (): number => 0.5,
		execute: async (): Promise<string> => {
			throw Object.assign(new Error("terminated"), { code: "ECONNRESET" });
		}
	}), (error: unknown): boolean => error instanceof Error && error.name === "AbortError");
	assert.ok(Date.now() - startedAt < 500);
});
