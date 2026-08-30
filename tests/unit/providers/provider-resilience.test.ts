import assert from "node:assert/strict";
import test from "node:test";
import type { ToolEvent } from "../../../src/tools/tool-dispatcher.js";
import { createOpenAICompatibleClient, createTransportActivityFetch } from "../../../src/providers/provider-chat-completions-client.js";
import { createOpenAIResponsesClient } from "../../../src/providers/openai-responses-client.js";
import {
	createProviderReconnectState,
	ProviderConnectionInterruptedError,
	ProviderResponseStalledError,
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

test("computer pause gates every network attempt including reconnects", async () => {
  let calls = 0, waits = 0;
  let resume!: () => void;
  const paused = new Promise<void>(resolve => { resume = resolve; });
  const result = runProviderRequestWithResilience({
    providerOptions: { ...providerOptions, waitBeforeRequest: async () => { if (++waits === 2) await paused; } },
    sleep: immediateSleep,
    execute: async () => {
      if (++calls === 1) throw Object.assign(new Error("terminated"), { code: "UND_ERR_SOCKET" });
      return "resumed";
    }
  });
  for (let i = 0; i < 20 && waits < 2; i++) await Promise.resolve();
  assert.equal(waits, 2);
  assert.equal(calls, 1);
  resume();
  assert.equal(await result, "resumed");
  assert.equal(calls, 2);
});

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

test("post-tool transport failures use a bounded budget and never auto-extend", async (): Promise<void> => {
	const events: ToolEvent[] = [];
	let calls: number = 0;
	await assert.rejects(
		runProviderRequestWithResilience({
			providerOptions,
			reconnectBudget: "after_tool",
			onEvent: (event: ToolEvent): void => { events.push(event); },
			sleep: immediateSleep,
			execute: async (): Promise<string> => {
				calls += 1;
				throw Object.assign(new Error("fetch failed"), { code: "ECONNRESET" });
			}
		}),
		ProviderConnectionInterruptedError
	);

	assert.equal(calls, 3);
	const reconnects = events.filter((event): event is Extract<ToolEvent, { type: "provider.reconnect" }> => event.type === "provider.reconnect");
	assert.ok(reconnects.length > 0);
	assert.ok(reconnects.every((event): boolean => event.maxAttempts === 2 && event.autoExtended === false));
	assert.equal(reconnects.at(-1)?.status, "failed");
	assert.equal(reconnects.at(-1)?.attempt, 2);
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

test("the first streamed byte has a longer allowance than later stream gaps", async (): Promise<void> => {
	let calls: number = 0;
	const result = await runProviderRequestWithResilience({
		providerOptions,
		inactivityTimeoutMs: 5,
		firstActivityTimeoutMs: 30,
		stallWarningMs: 1,
		execute: async ({ markActivity }): Promise<string> => {
			calls += 1;
			await new Promise<void>((resolve): void => { setTimeout(resolve, 12); });
			markActivity();
			return "first byte arrived";
		}
	});

	assert.equal(result, "first byte arrived");
	assert.equal(calls, 1);
});

test("non-streaming requests use the provider request deadline instead of the stream inactivity watchdog", async (): Promise<void> => {
	const result = await runProviderRequestWithResilience({
		providerOptions,
		inactivityTimeoutMs: 5,
		watchInactivity: false,
		execute: async (): Promise<string> => {
			await new Promise<void>((resolve): void => { setTimeout(resolve, 12); });
			return "completed";
		}
	});

	assert.equal(result, "completed");
});

test("transport activity fetch reports raw response bytes before SDK event parsing", async (): Promise<void> => {
	const encoder = new TextEncoder();
	let activityCount: number = 0;
	const source = new ReadableStream<Uint8Array>({
		start(controller: ReadableStreamDefaultController<Uint8Array>): void {
			controller.enqueue(encoder.encode(": heartbeat\\n\\n"));
			controller.enqueue(encoder.encode("data: {\\\"choices\\\":[]}\\n\\n"));
			controller.close();
		}
	});
	const fetchWithActivity = createTransportActivityFetch(
		async (): Promise<Response> => new Response(source, { status: 200 }),
		(): void => { activityCount += 1; }
	);
	const response: Response = await fetchWithActivity("https://provider.test/stream");
	const reader: ReadableStreamDefaultReader<Uint8Array> = response.body!.getReader();
	while (!(await reader.read()).done) {
		// Drain the stream exactly as an SDK parser would.
	}

	assert.equal(activityCount, 2);
});

test("a repeatedly silent provider stream stops after the bounded idle reconnect budget", async (): Promise<void> => {
	const events: ToolEvent[] = [];
	let calls: number = 0;
	await assert.rejects(
		runProviderRequestWithResilience({
			providerOptions,
			onEvent: (event: ToolEvent): void => { events.push(event); },
			inactivityTimeoutMs: 5,
			stallWarningMs: 1,
			sleep: immediateSleep,
			execute: async ({ signal }): Promise<string> => {
				calls += 1;
				await new Promise<void>((_resolve, reject): void => {
					signal.addEventListener("abort", (): void => reject(signal.reason), { once: true });
				});
				return "unreachable";
			}
		}),
		ProviderResponseStalledError
	);

	assert.equal(calls, 3);
	const reconnects = events.filter((event): event is Extract<ToolEvent, { type: "provider.reconnect" }> => event.type === "provider.reconnect");
	assert.ok(reconnects.length > 0);
	assert.ok(reconnects.some((event): boolean => event.maxAttempts === 2));
	assert.ok(reconnects.every((event): boolean => event.maxAttempts !== 15 && event.autoExtended === false));
	assert.equal(reconnects.at(-1)?.status, "failed");
	assert.equal(reconnects.at(-1)?.attempt, 2);
});

test("a reconnect with one fragment and then silence uses the short recovery watchdog", async (): Promise<void> => {
	const events: ToolEvent[] = [];
	let calls: number = 0;
	const result: string = await runProviderRequestWithResilience({
		providerOptions,
		onEvent: (event: ToolEvent): void => { events.push(event); },
		inactivityTimeoutMs: 50,
		stallWarningMs: 10,
		postReconnectInactivityTimeoutMs: 5,
		sleep: immediateSleep,
		execute: async ({ signal, onEvent }): Promise<string> => {
			calls += 1;
			if (calls === 1) throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
			if (calls === 2) {
				onEvent?.({ type: "ai.thinking.delta", text: "partial recovery" });
				await new Promise<void>((_resolve, reject): void => {
					signal.addEventListener("abort", (): void => reject(signal.reason), { once: true });
				});
			}
			return "completed after the second recovery";
		}
	});

	assert.equal(result, "completed after the second recovery");
	assert.equal(calls, 3);
	const reconnects = events.filter((event): event is Extract<ToolEvent, { type: "provider.reconnect" }> => event.type === "provider.reconnect");
	assert.ok(reconnects.some((event): boolean => event.status === "waiting" && event.attempt === 2));
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
