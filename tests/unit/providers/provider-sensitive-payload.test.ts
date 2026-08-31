import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createOpenAICompatibleClient } from "../../../src/providers/provider-chat-completions-client.js";
import { createOpenAIResponsesClient } from "../../../src/providers/openai-responses-client.js";
import type { ProviderChatOptions } from "../../../src/providers/provider-types.js";

const IMAGE: string = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6XcAAAAASUVORK5CYII=";
const PRIVATE_PROMPT: string = "fixture-private-grounding-target";
type Client = ReturnType<typeof createOpenAICompatibleClient>;
type Endpoint = "chat" | "responses";

async function sendFixture(client: Client, endpoint: Endpoint): Promise<void> {
	if (endpoint === "chat") {
		await client.chat.completions.create({
			model: "fixture-model",
			messages: [{ role: "user", content: [
				{ type: "image_url", image_url: { url: IMAGE } },
				{ type: "text", text: PRIVATE_PROMPT },
			] }],
		});
		return;
	}
	await client.responses.create({
		model: "fixture-model",
		input: [{ role: "user", content: [
			{ type: "input_image", image_url: IMAGE, detail: "auto" },
			{ type: "input_text", text: PRIVATE_PROMPT },
		] }],
	});
}

function captureConsole(t: TestContext): unknown[][] {
	const captured: unknown[][] = [];
	const original: Console = globalThis.console;
	const capture = (...args: unknown[]): void => { captured.push(args); };
	// SDK 按 logger 对象缓存绑定方法，每个 fixture 需要独立对象
	globalThis.console = { ...original, debug: capture, info: capture, warn: capture, error: capture, log: capture };
	t.after((): void => { globalThis.console = original; });
	return captured;
}

function enableDebugLogging(t: TestContext): void {
	const previous: string | undefined = process.env.OPENAI_LOG;
	process.env.OPENAI_LOG = "debug";
	t.after((): void => {
		if (previous === undefined) delete process.env.OPENAI_LOG;
		else process.env.OPENAI_LOG = previous;
	});
}

for (const endpoint of ["chat", "responses"] as const) {
	for (const flag of [true, false, undefined]) {
		test(`${endpoint} SDK preserves ordinary debug logging but suppresses sensitivePayload=${String(flag)}`, async (t): Promise<void> => {
			enableDebugLogging(t);
			const logs: unknown[][] = captureConsole(t);
			const requests: Array<{ url: string; body: string }> = [];
			t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
				requests.push({ url: String(url), body: String(init?.body) });
				return Response.json(endpoint === "chat"
					? { id: "fixture", choices: [{ message: { role: "assistant", content: "ok" } }] }
					: { id: "fixture", object: "response", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] });
			});
			const options: ProviderChatOptions = {
				provider: "openai", apiKey: "fixture-key", baseUrl: "https://fixture.invalid/v1",
				...(flag === undefined ? {} : { sensitivePayload: flag }),
			};
			const createClient = endpoint === "chat" ? createOpenAICompatibleClient : createOpenAIResponsesClient;
			const sensitiveClient: Client = createClient(options);
			assert.equal(sensitiveClient.logLevel, flag === true ? "off" : "debug");
			assert.equal(logs.length, 0, "Construction must not log the sensitive payload");
			await sendFixture(sensitiveClient, endpoint);
			assert.equal(requests.length, 1);
			assert.equal(requests[0]!.url, `https://fixture.invalid/v1/${endpoint === "chat" ? "chat/completions" : "responses"}`);
			assert.ok(requests[0]!.body.includes(IMAGE), "The image must still reach the mocked transport unchanged");
			assert.ok(requests[0]!.body.includes(PRIVATE_PROMPT));
			assert.equal("sensitivePayload" in JSON.parse(requests[0]!.body), false, "Internal flag must not be sent to the provider");
			if (flag === true) {
				assert.deepEqual(logs, [], "No SDK log method may receive the request body");
			} else {
				assert.ok(JSON.stringify(logs).includes(IMAGE), "Ordinary SDK debug logging must remain unchanged");
				assert.ok(JSON.stringify(logs).includes(PRIVATE_PROMPT));
			}
			assert.equal(process.env.OPENAI_LOG, "debug", "Sensitive requests must not change process logging configuration");
			assert.equal(createClient({ ...options, sensitivePayload: false }).logLevel, "debug");
		});
	}

	test(`${endpoint} SDK also suppresses sensitive error response bodies under OPENAI_LOG=debug`, async (t): Promise<void> => {
		enableDebugLogging(t);
		const logs: unknown[][] = captureConsole(t);
		const fetch = t.mock.method(globalThis, "fetch", async (): Promise<Response> => Response.json({
			error: { message: PRIVATE_PROMPT, image: IMAGE },
		}, { status: 400 }));
		const createClient = endpoint === "chat" ? createOpenAICompatibleClient : createOpenAIResponsesClient;
		const client: Client = createClient({ provider: "openai", apiKey: "fixture-key", baseUrl: "https://fixture.invalid/v1", sensitivePayload: true });
		await assert.rejects(sendFixture(client, endpoint), { status: 400 });
		assert.equal(fetch.mock.callCount(), 1);
		assert.deepEqual(logs, []);
	});
}
