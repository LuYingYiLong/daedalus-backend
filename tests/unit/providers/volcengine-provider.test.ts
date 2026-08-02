import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installReadOnlySecretStore, resetSecretStoreDriver } from "../../helpers/secret-store.js";
import { chatWithOpenAICompatible } from "../../../src/providers/provider-chat-completions-client.js";
import { listProviderModels } from "../../../src/providers/provider-models.js";
import { modelSupportsImageInput } from "../../../src/providers/provider-image-content.js";
import { saveProviderConfig } from "../../../src/providers/provider-config-store.js";

const GENERATED_PNG: Buffer = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlDkAAAAASUVORK5CYII=", "base64");

type RecordedRequest = {
	url: string;
	authorization: string | undefined;
	body: Record<string, unknown>;
};

async function readRequestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	let text = "";
	for await (const chunk of request) {
		text += String(chunk);
	}
	return JSON.parse(text) as Record<string, unknown>;
}

async function withVolcengineMockServer(run: (baseUrl: string, requests: RecordedRequest[]) => Promise<void>): Promise<void> {
	const requests: RecordedRequest[] = [];
	const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		if (request.url === "/models") {
			assert.equal(request.headers.authorization, "Bearer volcengine-test-key");
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({
				data: [
					{ id: "doubao-seed-evolving", owned_by: "volcengine" },
					{ id: "doubao-legacy-unrecommended", owned_by: "volcengine" }
				]
			}));
			return;
		}

		const body: Record<string, unknown> = await readRequestBody(request);
		requests.push({
			url: request.url ?? "",
			authorization: request.headers.authorization,
			body
		});

		if (request.url === "/images/generations") {
			assert.equal(request.headers.authorization, "Bearer volcengine-test-key");
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({
				created: 1,
				output_format: "png",
				data: [{
					b64_json: GENERATED_PNG.toString("base64"),
					revised_prompt: "blue robot icon"
				}]
			}));
			return;
		}

		assert.equal(request.url, "/chat/completions");
		assert.equal(request.headers.authorization, "Bearer volcengine-test-key");
		response.writeHead(200, { "Content-Type": "application/json" });
		response.end(JSON.stringify({
			id: "chatcmpl-volcengine",
			object: "chat.completion",
			created: 1,
			model: "doubao-seed-evolving",
			choices: [{
				index: 0,
				message: { role: "assistant", content: "image understood" },
				finish_reason: "stop"
			}]
		}));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("Mock server did not expose a TCP port");
	}

	try {
		await run(`http://127.0.0.1:${address.port}`, requests);
	} finally {
		server.close();
		await once(server, "close");
	}
}

async function withTempAppData(run: () => Promise<void>): Promise<void> {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	process.env.USERPROFILE = await mkdtemp(join(tmpdir(), "daedalus-volcengine-provider-"));
	try {
		await run();
	} finally {
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		resetSecretStoreDriver();
	}
}

test("Volcengine Ark OpenAI-compatible requests preserve image input and model listing", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		await withVolcengineMockServer(async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
			const options = {
				provider: "volcengine" as const,
				apiKey: "volcengine-test-key",
				baseUrl,
				model: "doubao-seed-evolving"
			};
			const text = await chatWithOpenAICompatible({
				message: "Describe this image",
				additionalContext: [{
					id: "image-1",
					kind: "image",
					title: "Scene",
					source: "manual",
					data: {
						mimeType: "image/png",
						dataUrl: "data:image/png;base64,AAAA",
						byteSize: 3
					}
				}]
			}, options, [], "System prompt");

			assert.equal(text, "image understood");
			assert.deepEqual(requests[0], {
				url: "/chat/completions",
				authorization: "Bearer volcengine-test-key",
				body: {
					model: "doubao-seed-evolving",
					messages: [
						{ role: "system", content: "System prompt" },
						{
							role: "user",
							content: [
								{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
								{ type: "text", text: "Describe this image" }
							]
						}
					]
				}
			});
			assert.equal(await modelSupportsImageInput("volcengine", "doubao-seed-evolving"), true);

			const result = await listProviderModels("volcengine", "volcengine-test-key", baseUrl, true);
			assert.equal(result.source, "api");
			assert.equal(result.models.length, 3);
			assert.equal(result.models.find((model): boolean => model.id === "doubao-seed-evolving")?.capabilities.imageInput, true);
			assert.equal(result.models.find((model): boolean => model.id === "doubao-seedream-5-0-pro-260628")?.capabilities.imageGeneration, true);
			assert.equal(result.models.some((model): boolean => model.id === "doubao-legacy-unrecommended"), false);
		});
	});
});

test("Volcengine Ark image generation uses Seedream and saves a session artifact", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		await withVolcengineMockServer(async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
			installReadOnlySecretStore(async (_service: string, account: string): Promise<string | null> => {
				return account === "provider:volcengine:api_key" ? "volcengine-test-key" : null;
			});

			await saveProviderConfig({
				provider: "volcengine",
				apiKey: "volcengine-test-key",
				baseUrl,
				model: "doubao-seed-evolving",
				modelRouting: {
					imageGeneration: { provider: "volcengine", model: "doubao-seedream-5-0-pro-260628" }
				}
			});

			const sessionStore = await import("../../../src/session/session-store.js");
			const { generateImage } = await import("../../../src/providers/image-generation.js");
			const session = await sessionStore.createSession("Volcengine image generation");
			const result = await generateImage({
				sessionId: session.id,
				prompt: "生成一张蓝色机器人图标",
				aspectRatio: "16:9"
			});

			const imageRequest = requests.find((request: RecordedRequest): boolean => request.url === "/images/generations");
			assert.equal(imageRequest?.authorization, "Bearer volcengine-test-key");
			assert.deepEqual(imageRequest?.body, {
				model: "doubao-seedream-5-0-pro-260628",
				prompt: "生成一张蓝色机器人图标",
				n: 1,
				size: "1536x1024",
				response_format: "url",
				watermark: false
			});
			assert.equal(result.provider, "volcengine");
			assert.equal(result.model, "doubao-seedream-5-0-pro-260628");
			assert.equal(result.artifacts.length, 1);
			assert.equal(result.artifacts[0]?.byteSize, GENERATED_PNG.byteLength);
			assert.equal(result.artifacts[0]?.storagePath, `attachments/images/${result.artifacts[0]?.imageId}.png`);
		});
	});
});
