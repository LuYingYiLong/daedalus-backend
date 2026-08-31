import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { updateGeneralSettings } from "../../../src/general-settings-store.js";
import {
	COMPUTER_GROUNDING_MAX_BYTES,
	computerGroundingResultSchema,
	type ComputerVisualGrounding,
} from "../../../src/protocol/computer-grounding.js";
import { computerObservationSchema, type ComputerObservation } from "../../../src/protocol/computer-observation.js";
import { MAX_IMAGE_BYTES } from "../../../src/protocol/image-attachments.js";
import type { AiChatParams, ChatMessage } from "../../../src/protocol/types.js";
import { groundComputerFrame, matchComputerVisualGrounding, parseComputerVisualGrounding } from "../../../src/providers/computer-grounding.js";
import { resolveProviderAdapter } from "../../../src/providers/provider-adapter.js";
import { saveProviderConfig } from "../../../src/providers/provider-config-store.js";
import type { ProviderChatOptions } from "../../../src/providers/provider-types.js";
import { getSessionDatabase, resetSessionDatabaseForTests } from "../../../src/session/session-database.js";
import { beginProviderTrace, completeProviderTrace, recordActiveProviderTraceUsage, runWithProviderTraceContext } from "../../../src/trace/trace-recorder.js";
import { getTraceDetail, getTracePage, getTraceSummary } from "../../../src/trace/trace-store.js";
import { closeUsageMetricsStore, listUsageMetricsLogs, resetUsageMetricsStoreForTests } from "../../../src/usage/metrics-store.js";
import { createEstimatedUsage } from "../../../src/usage/usage-parser.js";
import { installMemorySecretStore, resetSecretStoreDriver } from "../../helpers/secret-store.js";

type Node = ComputerObservation["nodes"][number];
const BOX = { x: 20, y: 20, width: 20, height: 10 };
const VISUAL: ComputerVisualGrounding = {
	coordinateSpace: "image_pixels",
	candidates: [{ description: "Save button", box: BOX }],
};
const PNG: string = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6XcAAAAASUVORK5CYII=";
const PIXEL_BOX = { x: 0, y: 0, width: 1, height: 1 };
const PIXEL_VISUAL: ComputerVisualGrounding = {
	coordinateSpace: "image_pixels",
	candidates: [{ description: "Visible fixture", box: PIXEL_BOX }],
};
const CURRENT_OPTIONS: ProviderChatOptions = {
	provider: "moonshot", model: "kimi-k2.6", apiKey: "fixture-current-key",
	baseUrl: "https://grounding.invalid/v1",
	usageContext: { requestId: "request-fixture", sessionId: "session-fixture", runId: "run-fixture", operation: "chat" },
};

function node(overrides: Partial<Node> = {}): Node {
	return {
		id: "save-button", parentId: null, name: "Save", automationId: "Save", controlType: "Button",
		bounds: { ...BOX }, enabled: true, password: false, supportedActions: ["uia_invoke"],
		...overrides,
	};
}

function frame(overrides: Partial<ComputerObservation> = {}): ComputerObservation {
	return {
		observationId: "frame-fixture", capturedAt: "2026-08-31T00:00:00.000Z", uiaCapturedAt: "2026-08-31T00:00:00.000Z",
		screenBounds: { x: -1920, y: -200, width: 1920, height: 1080 }, width: 100, height: 100, dpi: 144,
		nodes: [node()], texts: [], truncated: false, durationMs: 1,
		...overrides,
	};
}

function request(overrides: Partial<Parameters<typeof groundComputerFrame>[0]> = {}): Parameters<typeof groundComputerFrame>[0] {
	return {
		observation: frame({ width: 1, height: 1, dataUrl: PNG, nodes: [node({ bounds: PIXEL_BOX })] }),
		args: { observationId: "frame-fixture", target: "Find the visible fixture" },
		groundingId: "grounding-fixture", generation: 2, options: CURRENT_OPTIONS, signal: new AbortController().signal,
		...overrides,
	};
}

async function withProviderFixture(t: TestContext, run: () => Promise<void>): Promise<void> {
	const previousProfile: string | undefined = process.env.USERPROFILE;
	process.env.USERPROFILE = await mkdtemp(join(tmpdir(), "daedalus-grounding-"));
	installMemorySecretStore();
	resetUsageMetricsStoreForTests(":memory:");
	const blockedFetch = t.mock.method(globalThis, "fetch", async (): Promise<Response> => { throw new Error("Unexpected network request in fixture"); });
	try {
		await resetSessionDatabaseForTests(join(process.env.USERPROFILE, "sessions.sqlite"));
		const db = await getSessionDatabase();
		const now: string = new Date().toISOString();
		db.prepare("INSERT INTO sessions(session_id, title, workspace_id, metadata_json, archived_at, created_at, updated_at) VALUES (?, ?, NULL, ?, NULL, ?, ?)")
			.run("session-fixture", "Grounding fixture", "{}", now, now);
		await updateGeneralSettings({ developerMode: true });
		await run();
		assert.equal(blockedFetch.mock.callCount(), 0, "No unhandled fetch calls are permitted");
	} finally {
		await closeUsageMetricsStore();
		resetUsageMetricsStoreForTests();
		resetSecretStoreDriver();
		await resetSessionDatabaseForTests();
		if (previousProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousProfile;
	}
}

function completion(text: string): Response {
	return Response.json({
		id: "fixture-completion", object: "chat.completion", model: CURRENT_OPTIONS.model,
		choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }],
		usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
	});
}

async function tracePayload(recordId: string): Promise<Record<string, unknown>> {
	const db = await getSessionDatabase();
	const row = db.prepare("SELECT payload_json FROM trace_payloads WHERE record_id = ?").get(recordId);
	assert.ok(row);
	const serialized: string = String(row.payload_json);
	assert.ok(!serialized.includes(PNG.slice(PNG.indexOf(",") + 1)), "PNG bytes must not be persisted in trace payloads");
	return JSON.parse(serialized) as Record<string, unknown>;
}

test("parses strict JSON or one enclosing json fence without changing pixel coordinates", (): void => {
	const raw: string = JSON.stringify(VISUAL);
	for (const response of [raw, ` \n${raw}\n `, `\n\`\`\`json\n${raw}\n\`\`\`\n`, `\`\`\`json\r\n${raw}\r\n\`\`\``]) {
		assert.deepEqual(parseComputerVisualGrounding(response, frame()), VISUAL);
	}
	const edge = { coordinateSpace: "image_pixels", candidates: [{ description: "edge", box: { x: 99.5, y: 99, width: 0.5, height: 1 } }] };
	assert.deepEqual(parseComputerVisualGrounding(JSON.stringify(edge), frame()), edge);
});

test("rejects malformed JSON, prose, multiple fences, confidence and other unexpected fields", (): void => {
	const raw: string = JSON.stringify(VISUAL);
	const invalid: unknown[] = [null, [], {}, { ...VISUAL, confidence: 1 }, { ...VISUAL, coordinateSpace: "screen_pixels" },
		{ ...VISUAL, candidates: [{ ...VISUAL.candidates[0], confidence: 0.99 }] },
		{ ...VISUAL, candidates: [{ ...VISUAL.candidates[0], nodeId: "save-button" }] },
		{ ...VISUAL, candidates: [{ ...VISUAL.candidates[0], box: { ...BOX, confidence: 1 } }] },
		{ ...VISUAL, candidates: [{ description: " ", box: BOX }] },
		{ ...VISUAL, candidates: [{ description: "x".repeat(1001), box: BOX }] },
		{ ...VISUAL, candidates: Array.from({ length: 6 }, () => VISUAL.candidates[0]) },
	];
	const responses: string[] = [...invalid.map((value): string => JSON.stringify(value)), "", "{", `Answer: ${raw}`, `${raw}\nDone`,
		`${raw}${raw}`, `\`\`\`\n${raw}\n\`\`\``, `\`\`\`javascript\n${raw}\n\`\`\``,
		`\`\`\`json\n${raw}\n\`\`\`\n\`\`\`json\n${raw}\n\`\`\``, `\`\`\`json\n${raw}`,
		raw.replace('"x":20', '"x":NaN'), raw.replace('"x":20', '"x":1e999'),
	];
	for (const response of responses) {
		assert.throws(() => parseComputerVisualGrounding(response, frame()), /computer_grounding_invalid_response/);
	}
});

test("enforces the 16 KiB UTF-8 limit before trimming or unwrapping fences", (): void => {
	const raw: string = JSON.stringify(VISUAL);
	const boundary: string = raw + " ".repeat(COMPUTER_GROUNDING_MAX_BYTES - Buffer.byteLength(raw));
	assert.deepEqual(parseComputerVisualGrounding(boundary, frame()), VISUAL);
	assert.throws(() => parseComputerVisualGrounding(boundary + " ", frame()), /invalid_response/);
	assert.throws(() => parseComputerVisualGrounding(`\`\`\`json\n${boundary}\n\`\`\``, frame()), /invalid_response/);
	const unicode: string = JSON.stringify({ ...VISUAL, candidates: Array.from({ length: 5 }, () => ({ description: "😀".repeat(500), box: BOX })) });
	const padded: string = unicode + " ".repeat(COMPUTER_GROUNDING_MAX_BYTES - Buffer.byteLength(unicode) + 1);
	assert.ok(padded.length < COMPUTER_GROUNDING_MAX_BYTES);
	assert.throws(() => parseComputerVisualGrounding(padded, frame()), /invalid_response/);
});

test("rejects negative, zero, nonnumeric and out-of-image boxes instead of clamping", (): void => {
	for (const box of [
		{ ...BOX, x: -1 }, { ...BOX, y: -1 }, { ...BOX, width: 0 }, { ...BOX, height: -1 },
		{ ...BOX, x: "20" }, { ...BOX, x: 90 }, { ...BOX, y: 95 }, { ...BOX, width: 1e308 },
	]) {
		assert.throws(() => parseComputerVisualGrounding(JSON.stringify({ ...VISUAL, candidates: [{ description: "bad", box }] }), frame()), /invalid_response/);
	}
	for (const width of [0, -1, NaN, Infinity, 1.5, 2561]) {
		assert.throws(() => parseComputerVisualGrounding(JSON.stringify(VISUAL), { width, height: 100 }), /invalid_image_size/);
	}
});

test("matches one enabled nonpassword UIA node with the requested capability in image pixels", (): void => {
	const observation = frame({ nodes: [node({ supportedActions: ["uia_invoke", "uia_toggle"] })] });
	const snapshot = structuredClone(observation);
	const result = matchComputerVisualGrounding(VISUAL, observation);
	assert.equal(result.status, "matched");
	assert.deepEqual(result.candidates, [{ ...VISUAL.candidates[0], status: "matched", nodeId: "save-button", supportedActions: ["uia_invoke", "uia_toggle"] }]);
	assert.equal(matchComputerVisualGrounding(VISUAL, observation, "uia_toggle").status, "matched");
	assert.equal(matchComputerVisualGrounding(VISUAL, observation, "uia_set_value").status, "visual_only");
	result.candidates[0]!.supportedActions!.pop();
	result.candidates[0]!.box.x = 0;
	assert.deepEqual(observation, snapshot);
	assert.equal(VISUAL.candidates[0]!.box.x, 20);
});

test("requires at least 80 percent candidate coverage and a contained center", (): void => {
	assert.equal(matchComputerVisualGrounding(VISUAL, frame({ nodes: [node({ bounds: { ...BOX, x: 24, width: 16 } })] })).status, "matched");
	assert.equal(matchComputerVisualGrounding(VISUAL, frame({ nodes: [node({ bounds: { ...BOX, x: 24.01, width: 15.99 } })] })).status, "visual_only");
	assert.equal(matchComputerVisualGrounding(VISUAL, frame({ nodes: [node({ bounds: { ...BOX, x: 31, width: 20 } })] })).status, "visual_only");
	// 覆盖视觉框即可，不以 UIA 节点面积或 IoU 作分母
	assert.equal(matchComputerVisualGrounding(VISUAL, frame({ nodes: [node({ bounds: { x: 0, y: 0, width: 100, height: 100 } })] })).status, "matched");
});

test("ignores disabled, password, unsupported and invalid-bound nodes without guessing from labels", (): void => {
	for (const candidate of [
		node({ enabled: false }), node({ password: true }), node({ supportedActions: [] }), node({ supportedActions: undefined }),
		node({ supportedActions: ["uia_select"] }), node({ bounds: { ...BOX, width: 0 } }),
		node({ bounds: { ...BOX, x: -1 } }), node({ bounds: { ...BOX, width: Infinity } }),
		node({ bounds: { ...BOX, height: NaN } }), node({ bounds: { ...BOX, width: 100 } }), node({ id: "unsafe/id" }),
	]) {
		assert.equal(matchComputerVisualGrounding(VISUAL, frame({ nodes: [candidate] })).status, "visual_only");
		assert.equal(matchComputerVisualGrounding(VISUAL, frame({ nodes: [candidate, node({ id: "eligible" })] })).candidates[0]?.nodeId, "eligible");
	}
});

test("overlapping eligible nodes stay ambiguous regardless of order, nesting or names", (): void => {
	const nodes = [node({ id: "outer", bounds: { x: 0, y: 0, width: 100, height: 100 } }), node({ parentId: "outer" })];
	for (const ordered of [nodes, [...nodes].reverse()]) {
		const result = matchComputerVisualGrounding(VISUAL, frame({ nodes: ordered }));
		assert.deepEqual(result, { coordinateSpace: "image_pixels", status: "ambiguous", candidates: [{ ...VISUAL.candidates[0], status: "ambiguous" }] });
	}
});

test("multiple visual candidates are globally ambiguous with no executable node IDs", (): void => {
	for (const candidates of [[...VISUAL.candidates, ...VISUAL.candidates], [...VISUAL.candidates, { description: "No UIA match", box: PIXEL_BOX }]]) {
		const result = matchComputerVisualGrounding({ ...VISUAL, candidates }, frame());
		assert.equal(result.status, "ambiguous");
		for (const candidate of result.candidates) {
			assert.equal(candidate.status, "ambiguous");
			assert.equal("nodeId" in candidate, false);
			assert.equal("supportedActions" in candidate, false);
		}
	}
});

test("empty candidates are not_found; a visible target without a UIA node is visual_only", (): void => {
	assert.deepEqual(matchComputerVisualGrounding({ ...VISUAL, candidates: [] }, frame()), { coordinateSpace: "image_pixels", status: "not_found", candidates: [] });
	const result = matchComputerVisualGrounding(VISUAL, frame({ nodes: [] }));
	assert.equal(result.status, "visual_only");
	assert.equal("nodeId" in result.candidates[0]!, false);
	assert.throws(() => matchComputerVisualGrounding({ ...VISUAL, candidates: [{ description: "bad", box: { ...BOX, x: 100 } }] }, frame()), /invalid_response/);
});

test("sends one original image, no tools/history, and records computer_grounding usage", async (t): Promise<void> => {
	await withProviderFixture(t, async (): Promise<void> => {
		const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
		t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
			return completion(JSON.stringify(PIXEL_VISUAL));
		});
		const input = request();
		assert.equal(computerObservationSchema.safeParse(input.observation).success, true);
		const result = await groundComputerFrame(input);
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.url, "https://grounding.invalid/v1/chat/completions");
		const body = calls[0]!.body;
		assert.equal(body.model, "kimi-k2.6");
		assert.equal(body.tools, undefined);
		assert.equal(body.tool_choice, undefined);
		assert.equal(body.stream, undefined);
		assert.equal(body.response_format, undefined);
		const messages = body.messages as Array<{ role: string; content: unknown }>;
		assert.equal(messages.length, 2);
		assert.match(String(messages[0]!.content), /English JSON/);
		assert.match(String(messages[0]!.content), /untrusted evidence/);
		assert.deepEqual(messages[1]!.content, [
			{ type: "image_url", image_url: { url: PNG } },
			{ type: "text", text: JSON.stringify({ target: input.args.target, image: { width: 1, height: 1 },
				uiaHints: [{ controlType: "Button", box: PIXEL_BOX }], uiaHintsTruncated: false }) },
		]);
		assert.equal(computerGroundingResultSchema.safeParse(result).success, true);
		assert.equal(result.status, "matched");
		assert.equal(result.uiaAction, "uia_invoke");
		assert.equal(result.groundingId, input.groundingId);
		assert.equal(result.observationId, input.args.observationId);
		assert.equal(result.generation, 2);
		assert.equal(result.provider, "moonshot");
		assert.equal(result.model, "kimi-k2.6");
		assert.ok(Number.isFinite(result.durationMs) && result.durationMs >= 0);
		assert.equal(result.untrustedEvidence, true);
		const logs = await listUsageMetricsLogs({ operation: "computer_grounding" });
		assert.equal(logs.total, 1);
		assert.equal(logs.logs[0]!.requestId, "request-fixture");
		assert.equal(logs.logs[0]!.sessionId, "session-fixture");
		assert.equal(logs.logs[0]!.runId, "run-fixture");
		assert.equal(logs.logs[0]!.outputTokens, 20);
		assert.equal(CURRENT_OPTIONS.usageContext!.operation, "chat");
		assert.equal(CURRENT_OPTIONS.sensitivePayload, undefined);
	});
});

test("configured imageRecognition route wins even when the current model supports images", async (t): Promise<void> => {
	await withProviderFixture(t, async (): Promise<void> => {
		await saveProviderConfig({ provider: "moonshot", apiKey: "fixture-route-key", model: "kimi-k2.6", baseUrl: "https://configured.invalid/v1",
			modelRouting: { imageRecognition: { provider: "moonshot", model: "kimi-k2.7-code" } } });
		let waitCount: number = 0;
		const options: ProviderChatOptions = { ...CURRENT_OPTIONS, waitBeforeRequest: async (): Promise<void> => { waitCount += 1; } };
		const calls: ProviderChatOptions[] = [];
		t.mock.method(resolveProviderAdapter(CURRENT_OPTIONS), "chat", async (_params: AiChatParams, actualOptions: ProviderChatOptions): Promise<string> => {
			calls.push(actualOptions);
			return JSON.stringify(PIXEL_VISUAL);
		});
		const result = await groundComputerFrame(request({ options }));
		assert.equal(result.model, "kimi-k2.7-code");
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.model, "kimi-k2.7-code");
		assert.equal(calls[0]!.apiKey, "fixture-route-key");
		assert.equal(calls[0]!.baseUrl, "https://configured.invalid/v1");
		assert.equal(calls[0]!.reasoningMode, "disabled");
		assert.equal(calls[0]!.sensitivePayload, true);
		assert.equal(calls[0]!.usageContext?.operation, "computer_grounding");
		assert.equal(waitCount, 1);
	});
});

test("unavailable or text-only configured routes fail closed without current-model fallback", async (t): Promise<void> => {
	await withProviderFixture(t, async (): Promise<void> => {
		const chat = t.mock.method(resolveProviderAdapter(CURRENT_OPTIONS), "chat", async (): Promise<string> => JSON.stringify(PIXEL_VISUAL));
		await saveProviderConfig({ provider: "moonshot", apiKey: "fixture", model: "kimi-k2.6",
			modelRouting: { imageRecognition: { provider: "deepseek", model: "deepseek-v4-flash" } } });
		await assert.rejects(groundComputerFrame(request()), { code: "computer_grounding_model_unavailable", message: "computer_grounding_model_unavailable" });
		await saveProviderConfig({ provider: "deepseek", apiKey: "fixture-text", model: "deepseek-v4-flash" });
		await assert.rejects(groundComputerFrame(request()), /computer_grounding_model_unavailable/);
		assert.equal(chat.mock.callCount(), 0);
	});
});

test("an unconfigured text-only current route also fails before a model request", async (t): Promise<void> => {
	await withProviderFixture(t, async (): Promise<void> => {
		await assert.rejects(groundComputerFrame(request({ options: { provider: "deepseek", apiKey: "fixture", model: "deepseek-v4-flash" } })), /model_unavailable/);
	});
});

test("invalid or oversized model output is rejected after exactly one request", async (t): Promise<void> => {
	await withProviderFixture(t, async (): Promise<void> => {
		for (const text of ["not JSON", JSON.stringify({ ...PIXEL_VISUAL, confidence: 1 }), " ".repeat(COMPUTER_GROUNDING_MAX_BYTES + 1),
			JSON.stringify({ ...PIXEL_VISUAL, candidates: [{ description: "outside", box: { ...PIXEL_BOX, x: 1 } }] })]) {
			const fetch = t.mock.method(globalThis, "fetch", async (): Promise<Response> => completion(text));
			await assert.rejects(groundComputerFrame(request()), /computer_grounding_invalid_response/);
			assert.equal(fetch.mock.callCount(), 1);
		}
	});
});

test("transient and permanent provider errors cannot resend the screenshot or fall back", async (t): Promise<void> => {
	await withProviderFixture(t, async (): Promise<void> => {
		for (const status of [503, 429, 400]) {
			const fetch = t.mock.method(globalThis, "fetch", async (): Promise<Response> => Response.json({ error: { message: "fixture provider failure" } }, { status, headers: { "retry-after": "0" } }));
			await assert.rejects(groundComputerFrame(request()), status === 400 ? /computer_grounding_failed/ : /computer_grounding_retry_disabled/);
			assert.equal(fetch.mock.callCount(), 1);
		}
	});
});

test("missing, malformed, forged-dimension and oversized original images never reach the model", async (t): Promise<void> => {
	await withProviderFixture(t, async (): Promise<void> => {
		const bytes: Buffer = Buffer.alloc(MAX_IMAGE_BYTES + 1);
		Buffer.from(PNG.slice(PNG.indexOf(",") + 1), "base64").copy(bytes);
		for (const observation of [
			frame(), frame({ width: 1, height: 1, dataUrl: "data:image/png;base64,aGVsbG8=" }),
			frame({ dataUrl: PNG }), frame({ dataUrl: PNG.replace("data:image/png", "data:image/jpeg") }),
			frame({ width: 1, height: 1, dataUrl: PNG + "=" }),
			frame({ width: 1, height: 1, dataUrl: `data:image/png;base64,${bytes.toString("base64")}` }),
		]) {
			await assert.rejects(groundComputerFrame(request({ observation })));
		}
	});
});

test("pre-cancelled requests and mismatched observation identity never call the provider", async (t): Promise<void> => {
	await withProviderFixture(t, async (): Promise<void> => {
		await assert.rejects(groundComputerFrame(request({ signal: AbortSignal.abort() })), { name: "AbortError" });
		await assert.rejects(groundComputerFrame(request({ args: { observationId: "other-frame", target: "target" } })), /observation_mismatch/);
	});
});

test("abort is forwarded and late results after cancellation are discarded", async (t): Promise<void> => {
	await withProviderFixture(t, async (): Promise<void> => {
		const controller = new AbortController();
		const chat = t.mock.method(resolveProviderAdapter(CURRENT_OPTIONS), "chat", async (_params: AiChatParams, _options: ProviderChatOptions, _history: ChatMessage[], _system: string, signal?: AbortSignal): Promise<string> => {
			assert.ok(signal);
			controller.abort();
			assert.equal(signal.aborted, true);
			return JSON.stringify(PIXEL_VISUAL);
		});
		await assert.rejects(groundComputerFrame(request({ signal: controller.signal })), { name: "AbortError" });
		assert.equal(chat.mock.callCount(), 1);
	});
});

test("provider overrides cannot smuggle tools into a grounding request", async (t): Promise<void> => {
	await withProviderFixture(t, async (): Promise<void> => {
		await assert.rejects(groundComputerFrame(request({ options: { ...CURRENT_OPTIONS, requestOverrides: { headers: {}, body: { tools: [] } } } })), /computer_grounding_failed/);
	});
});

test("provider error details never escape the grounding error boundary", async (t): Promise<void> => {
	await withProviderFixture(t, async (): Promise<void> => {
		const privateText: string = "private-target https://private.example/v1?token=secret raw-model-response";
		let providerError: unknown;
		const chat = t.mock.method(resolveProviderAdapter(CURRENT_OPTIONS), "chat", async (): Promise<string> => { throw providerError; });
		for (const cause of [new Error(privateText, { cause: { response: privateText } }), { message: privateText }, privateText]) {
			providerError = cause;
			await assert.rejects(groundComputerFrame(request()), (error: unknown): boolean => {
				assert.ok(error instanceof Error);
				assert.equal(error.message, "computer_grounding_failed");
				assert.equal(error.cause, undefined);
				assert.doesNotMatch(`${error.stack} ${JSON.stringify(error)}`, /private-target|private\.example|secret|raw-model-response/);
				return true;
			});
		}
		assert.equal(chat.mock.callCount(), 3);
	});
});

test("preserves the exact AbortSignal reason and safe computer control errors", async (t): Promise<void> => {
	await withProviderFixture(t, async (): Promise<void> => {
		const controller = new AbortController();
		const reason = new Error("computer_grounding_stale");
		const options: ProviderChatOptions = { ...CURRENT_OPTIONS, waitBeforeRequest: async (): Promise<void> => { controller.abort(reason); } };
		await assert.rejects(groundComputerFrame(request({ options, signal: controller.signal })), (error: unknown): boolean => error === reason);
		await assert.rejects(groundComputerFrame(request({ signal: controller.signal })), (error: unknown): boolean => error === reason);
		await assert.rejects(groundComputerFrame(request({ options: { ...CURRENT_OPTIONS, waitBeforeRequest: async (): Promise<void> => { throw new Error("computer_paused"); } } })), { message: "computer_paused" });
	});
});

test("UIA hints contain only capped geometry and safe control types filtered by the requested action", async (t): Promise<void> => {
	await withProviderFixture(t, async (): Promise<void> => {
		const input = request({ args: { observationId: "frame-fixture", target: "Locate target", uiaAction: "uia_toggle" } });
		input.observation.nodes = [
			node({ id: "disabled", bounds: PIXEL_BOX, enabled: false, supportedActions: [] }),
			node({ id: "password", bounds: PIXEL_BOX, password: true, name: "", automationId: "", supportedActions: [] }),
			node({ id: "wrong-action", bounds: PIXEL_BOX }),
			node({ id: "outside", bounds: { ...PIXEL_BOX, x: -1 }, supportedActions: ["uia_toggle"] }),
			...Array.from({ length: 101 }, (_, i): Node => node({
				id: `private-id-${i}`, name: "private-name", automationId: "private-automation", bounds: PIXEL_BOX,
				controlType: i === 0 ? "private control type with instructions" : "CheckBox", supportedActions: ["uia_toggle"],
			})),
		];
		const chat = t.mock.method(resolveProviderAdapter(CURRENT_OPTIONS), "chat", async (params: AiChatParams): Promise<string> => {
			const payload = JSON.parse(params.message) as { uiaHints: unknown[]; uiaHintsTruncated: boolean };
			assert.equal(payload.uiaHintsTruncated, true);
			assert.equal(payload.uiaHints.length, 100);
			assert.deepEqual(payload.uiaHints[0], { controlType: "Custom", box: PIXEL_BOX });
			assert.deepEqual(payload.uiaHints[99], { controlType: "CheckBox", box: PIXEL_BOX });
			assert.doesNotMatch(params.message, /private|automationId|nodeId|supportedActions|uia_toggle|disabled|password|wrong-action|outside/);
			return JSON.stringify(PIXEL_VISUAL);
		});
		const result = await groundComputerFrame(input);
		assert.equal(chat.mock.callCount(), 1);
		assert.equal(result.uiaAction, "uia_toggle");
		assert.equal(result.status, "ambiguous");
		assert.equal(result.candidates[0]!.nodeId, undefined);
	});
});

test("Responses and Anthropic adapters send one original image without tools or forced JSON mode", async (t): Promise<void> => {
	await withProviderFixture(t, async (): Promise<void> => {
		for (const endpointType of ["openai-responses", "anthropic-messages"] as const) {
			const options: ProviderChatOptions = { ...CURRENT_OPTIONS, endpointType,
				adapterFamily: endpointType === "openai-responses" ? "openai-responses" : "anthropic-compatible" };
			const text: string = JSON.stringify(PIXEL_VISUAL);
			const fetch = t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				assert.equal(body.tools, undefined);
				assert.equal(body.tool_choice, undefined);
				assert.equal(body.response_format, undefined);
				assert.equal(body.text, undefined);
				assert.equal(body.stream, undefined);
				if (endpointType === "openai-responses") {
					const input = body.input as Array<{ content: unknown[] }>;
					assert.equal(input.length, 1);
					assert.deepEqual(input[0]!.content[0], { type: "input_image", image_url: PNG, detail: "auto" });
					return Response.json({ id: "response-fixture", object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
						usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } });
				}
				const messages = body.messages as Array<{ content: unknown[] }>;
				assert.equal(messages.length, 1);
				assert.deepEqual(messages[0]!.content[0], { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.slice(PNG.indexOf(",") + 1) } });
				return Response.json({ content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 20 } });
			});
			assert.equal((await groundComputerFrame(request({ options }))).status, "matched");
			assert.equal(fetch.mock.callCount(), 1);
			const record = (await getTracePage({ sessionId: "session-fixture" })).records.at(-1)!;
			assert.equal(record.status, "success");
			assert.equal(record.inputTokens, 10);
			assert.equal(record.outputTokens, 20);
			assert.match(JSON.stringify((await tracePayload(record.recordId)).request), /\[image payload omitted\]/u);
			const failure = t.mock.method(globalThis, "fetch", async (): Promise<Response> => Response.json({ error: { message: "fixture failure" } }, { status: 503, headers: { "retry-after": "0" } }));
			await assert.rejects(groundComputerFrame(request({ options })), /computer_grounding_retry_disabled/);
			assert.equal(failure.mock.callCount(), 1);
		}
	});
});

test("grounding has an independent routed model trace, canonical request ID and redacted image payload", async (t): Promise<void> => {
	await withProviderFixture(t, async (): Promise<void> => {
		await saveProviderConfig({ provider: "moonshot", apiKey: "fixture-route-key", model: "kimi-k2.6", baseUrl: "https://configured.invalid/v1",
			modelRouting: { imageRecognition: { provider: "moonshot", model: "kimi-k2.7-code" } } });
		const options: ProviderChatOptions = { ...CURRENT_OPTIONS, provider: "deepseek", model: "deepseek-v4-flash", traceRequestId: "canonical-request" };
		const outer = await beginProviderTrace({ sessionId: "session-fixture", requestId: options.traceRequestId,
			provider: options.provider, model: options.model, request: { operation: "chat" } });
		assert.ok(outer);
		const metadata = { operation: "computer_grounding", groundingId: "grounding-fixture", observationId: "frame-fixture", generation: 2, uiaAction: "uia_invoke" };
		const fetch = t.mock.method(globalThis, "fetch", async (): Promise<Response> => {
			const pending = (await getTracePage({ sessionId: "session-fixture" })).records.find((record) => record.recordId !== outer);
			assert.ok(pending);
			assert.equal(pending.status, "running");
			assert.deepEqual((await tracePayload(pending.recordId)).request, metadata);
			return completion(JSON.stringify(PIXEL_VISUAL));
		});
		const result = await runWithProviderTraceContext(outer, async () => {
			await recordActiveProviderTraceUsage({ usage: createEstimatedUsage(7, 3), request: { phase: "outer-before" } });
			const located = await groundComputerFrame(request({ options }));
			await recordActiveProviderTraceUsage({ usage: createEstimatedUsage(11, 2), request: { phase: "outer-after" } });
			return located;
		});
		await completeProviderTrace(outer, { status: "success" });
		assert.equal(result.status, "matched");
		assert.equal(fetch.mock.callCount(), 1);
		const records = (await getTracePage({ sessionId: "session-fixture" })).records;
		assert.equal(records.length, 2);
		const vision = records.find((record) => record.recordId !== outer)!;
		const parent = records.find((record) => record.recordId === outer)!;
		assert.equal(vision.kind, "model_call");
		assert.equal(vision.status, "success");
		assert.equal(vision.requestId, "canonical-request");
		assert.equal(vision.runId, "run-fixture");
		assert.equal(vision.provider, "moonshot");
		assert.equal(vision.model, "kimi-k2.7-code");
		assert.equal(vision.inputTokens, 10);
		assert.equal(vision.outputTokens, 20);
		assert.equal(parent.inputTokens, 18);
		assert.equal(parent.outputTokens, 5);
		const summary = await getTraceSummary("session-fixture");
		assert.equal(summary.modelCallCount, 2);
		assert.equal(summary.inputTokens, 28);
		assert.equal(summary.outputTokens, 25);
		const payload = await tracePayload(vision.recordId);
		assert.deepEqual(payload.providerResult, { ...metadata, status: "matched", candidateCount: 1 });
		assert.match(JSON.stringify(payload.request), /\[image payload omitted\]/u);
		assert.deepEqual((await tracePayload(parent.recordId)).request, { phase: "outer-after" });
		const detail = await getTraceDetail("session-fixture", vision.recordId, { developerMode: true });
		assert.ok(detail?.redactions.some((path) => path.includes("image_url")));
	});
});

test("trace completion covers parser and provider errors with stable error codes only", async (t): Promise<void> => {
	await withProviderFixture(t, async (): Promise<void> => {
		for (const invalidResponse of [true, false]) {
			const fetch = t.mock.method(globalThis, "fetch", async (): Promise<Response> => invalidResponse
				? completion("not JSON")
				: Response.json({ error: { message: `private-target https://private.invalid/?token=secret ${PNG}` } }, { status: 400 }));
			const code: string = invalidResponse ? "computer_grounding_invalid_response" : "computer_grounding_failed";
			await assert.rejects(groundComputerFrame(request()), { message: code });
			assert.equal(fetch.mock.callCount(), 1);
			const record = (await getTracePage({ sessionId: "session-fixture" })).records.at(-1)!;
			assert.equal(record.requestId, "request-fixture");
			assert.equal(record.status, "error");
			assert.equal(record.summary.error, code);
			const payload = await tracePayload(record.recordId);
			assert.equal(payload.error, code);
			assert.deepEqual(payload.providerResult, { operation: "computer_grounding", groundingId: "grounding-fixture",
				observationId: "frame-fixture", generation: 2, uiaAction: "uia_invoke" });
			assert.doesNotMatch(JSON.stringify(payload), /private-target|private\.invalid|token=secret/u);
		}
	});
});

test("cancelled trace redacts the reason while the caller receives the exact AbortSignal reason", async (t): Promise<void> => {
	await withProviderFixture(t, async (): Promise<void> => {
		const controller = new AbortController();
		const reason = new Error(`private-target https://private.invalid ${PNG}`);
		const chat = t.mock.method(resolveProviderAdapter(CURRENT_OPTIONS), "chat", async (): Promise<string> => {
			controller.abort(reason);
			return JSON.stringify(PIXEL_VISUAL);
		});
		await assert.rejects(groundComputerFrame(request({ signal: controller.signal })), (error: unknown): boolean => error === reason);
		assert.equal(chat.mock.callCount(), 1);
		const record = (await getTracePage({ sessionId: "session-fixture" })).records[0]!;
		assert.equal(record.status, "cancelled");
		assert.equal(record.summary.error, "computer_cancelled");
		assert.equal((await tracePayload(record.recordId)).error, "computer_cancelled");
		assert.doesNotMatch(JSON.stringify(await tracePayload(record.recordId)), /private-target|private\.invalid/u);
	});
});

test("trace creation failure does not fail grounding or charge vision usage to its outer model call", async (t): Promise<void> => {
	await withProviderFixture(t, async (): Promise<void> => {
		const outer = await beginProviderTrace({ sessionId: "session-fixture", requestId: "request-fixture",
			provider: "deepseek", model: "deepseek-v4-flash", request: { operation: "chat" } });
		assert.ok(outer);
		const db = await getSessionDatabase();
		db.exec("CREATE TRIGGER fail_vision_trace BEFORE INSERT ON trace_records WHEN NEW.provider = 'moonshot' BEGIN SELECT RAISE(FAIL, 'fixture trace unavailable'); END");
		const fetch = t.mock.method(globalThis, "fetch", async (): Promise<Response> => completion(JSON.stringify(PIXEL_VISUAL)));
		await runWithProviderTraceContext(outer, async (): Promise<void> => {
			await recordActiveProviderTraceUsage({ usage: createEstimatedUsage(7, 3), request: { phase: "outer-before" } });
			assert.equal((await groundComputerFrame(request())).status, "matched");
			await recordActiveProviderTraceUsage({ usage: createEstimatedUsage(11, 2), request: { phase: "outer-after" } });
		});
		await completeProviderTrace(outer, { status: "success" });
		assert.equal(fetch.mock.callCount(), 1);
		const summary = await getTraceSummary("session-fixture");
		assert.equal(summary.modelCallCount, 1);
		assert.equal(summary.inputTokens, 18);
		assert.equal(summary.outputTokens, 5);
		assert.deepEqual((await tracePayload(outer)).request, { phase: "outer-after" });
		assert.equal((await listUsageMetricsLogs({ operation: "computer_grounding" })).total, 1);
	});
});

test("trace completion failure preserves both valid grounding and the original parse failure", async (t): Promise<void> => {
	await withProviderFixture(t, async (): Promise<void> => {
		const db = await getSessionDatabase();
		db.exec("CREATE TRIGGER fail_vision_completion BEFORE INSERT ON trace_records WHEN NEW.status IN ('success', 'error') BEGIN SELECT RAISE(FAIL, 'fixture completion unavailable'); END");
		for (const validResponse of [true, false]) {
			const fetch = t.mock.method(globalThis, "fetch", async (): Promise<Response> => completion(validResponse ? JSON.stringify(PIXEL_VISUAL) : "not JSON"));
			if (validResponse) assert.equal((await groundComputerFrame(request())).status, "matched");
			else await assert.rejects(groundComputerFrame(request()), { message: "computer_grounding_invalid_response" });
			assert.equal(fetch.mock.callCount(), 1);
			const record = (await getTracePage({ sessionId: "session-fixture" })).records.at(-1)!;
			assert.equal(record.status, "running");
			assert.equal(record.inputTokens, 10);
			assert.equal(record.outputTokens, 20);
			await tracePayload(record.recordId);
		}
	});
});
