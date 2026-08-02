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

const GENERATED_JPEG: Buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

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

async function withMiniMaxMockServer(run: (baseUrl: string, requests: RecordedRequest[]) => Promise<void>): Promise<void> {
	const requests: RecordedRequest[] = [];
	const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		if (request.url === "/models") {
			assert.equal(request.headers.authorization, "Bearer minimax-test-key");
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({
				data: [
					{ id: "MiniMax-M3", owned_by: "minimax" },
					{ id: "MiniMax-legacy-unrecommended", owned_by: "minimax" }
				]
			}));
			return;
		}

		if (request.url === "/generated.jpeg") {
			response.writeHead(200, { "Content-Type": "image/jpeg" });
			response.end(GENERATED_JPEG);
			return;
		}

		const body: Record<string, unknown> = await readRequestBody(request);
		requests.push({
			url: request.url ?? "",
			authorization: request.headers.authorization,
			body
		});

		if (request.url === "/image_generation") {
			assert.equal(request.headers.authorization, "Bearer minimax-test-key");
			response.writeHead(200, { "Content-Type": "application/json" });
			if (body.model === "image-01-live") {
				response.end(JSON.stringify({
					base_resp: { status_code: 0, status_msg: "success" },
					data: { image_urls: [`http://${request.headers.host}/generated.jpeg`] }
				}));
				return;
			}
			response.end(JSON.stringify({
				base_resp: { status_code: 0, status_msg: "success" },
				data: {
					image_base64: [GENERATED_JPEG.toString("base64")]
				}
			}));
			return;
		}

		assert.equal(request.url, "/chat/completions");
		assert.equal(request.headers.authorization, "Bearer minimax-test-key");
		response.writeHead(200, { "Content-Type": "application/json" });
		response.end(JSON.stringify({
			id: "chatcmpl-minimax",
			object: "chat.completion",
			created: 1,
			model: "MiniMax-M3",
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
	process.env.USERPROFILE = await mkdtemp(join(tmpdir(), "daedalus-minimax-provider-"));
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

test("MiniMax OpenAI-compatible requests preserve image input and recommended model listing", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		await withMiniMaxMockServer(async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
			const options = {
				provider: "minimax" as const,
				apiKey: "minimax-test-key",
				baseUrl,
				model: "MiniMax-M3"
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
				authorization: "Bearer minimax-test-key",
				body: {
					model: "MiniMax-M3",
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
			assert.equal(await modelSupportsImageInput("minimax", "MiniMax-M3"), true);

			const result = await listProviderModels("minimax", "minimax-test-key", baseUrl, true);
			assert.equal(result.source, "api");
			assert.equal(result.models.length, 10);
			assert.equal(result.models.find((model): boolean => model.id === "MiniMax-M3")?.capabilities.imageInput, true);
			assert.equal(result.models.find((model): boolean => model.id === "MiniMax-M3")?.capabilities.videoInput, true);
			assert.equal(result.models.find((model): boolean => model.id === "image-01")?.capabilities.imageGeneration, true);
			assert.equal(result.models.some((model): boolean => model.id === "MiniMax-legacy-unrecommended"), false);
		});
	});
});

test("MiniMax image generation uses image_generation API and saves base64 artifacts", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		await withMiniMaxMockServer(async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
			installReadOnlySecretStore(async (_service: string, account: string): Promise<string | null> => {
				return account === "provider:minimax:api_key" ? "minimax-test-key" : null;
			});

			await saveProviderConfig({
				provider: "minimax",
				apiKey: "minimax-test-key",
				baseUrl,
				model: "MiniMax-M3",
				modelRouting: {
					imageGeneration: { provider: "minimax", model: "image-01" }
				}
			});

			const sessionStore = await import("../../../src/session/session-store.js");
			const { generateImage } = await import("../../../src/providers/image-generation.js");
			const session = await sessionStore.createSession("MiniMax image generation");
			const result = await generateImage({
				sessionId: session.id,
				prompt: "生成一张蓝色机器人图标",
				aspectRatio: "16:9"
			});

			const imageRequest = requests.find((request: RecordedRequest): boolean => request.url === "/image_generation");
			assert.equal(imageRequest?.authorization, "Bearer minimax-test-key");
			assert.deepEqual(imageRequest?.body, {
				model: "image-01",
				prompt: "生成一张蓝色机器人图标",
				aspect_ratio: "16:9",
				response_format: "base64",
				n: 1,
				prompt_optimizer: true,
				aigc_watermark: false
			});
			assert.equal(result.provider, "minimax");
			assert.equal(result.model, "image-01");
			assert.equal(result.artifacts.length, 1);
			assert.equal(result.artifacts[0]?.mimeType, "image/jpeg");
			assert.equal(result.artifacts[0]?.byteSize, GENERATED_JPEG.byteLength);
			assert.equal(result.artifacts[0]?.storagePath, `attachments/images/${result.artifacts[0]?.imageId}.jpg`);
		});
	});
});

test("MiniMax image generation downloads image_urls when returned by the API", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		await withMiniMaxMockServer(async (baseUrl: string): Promise<void> => {
			installReadOnlySecretStore(async (_service: string, account: string): Promise<string | null> => {
				return account === "provider:minimax:api_key" ? "minimax-test-key" : null;
			});

			await saveProviderConfig({
				provider: "minimax",
				apiKey: "minimax-test-key",
				baseUrl,
				model: "MiniMax-M3",
				modelRouting: {
					imageGeneration: { provider: "minimax", model: "image-01-live" }
				}
			});

			const sessionStore = await import("../../../src/session/session-store.js");
			const { generateImage } = await import("../../../src/providers/image-generation.js");
			const session = await sessionStore.createSession("MiniMax image URL generation");
			const result = await generateImage({
				sessionId: session.id,
				prompt: "生成一张红色机器人图标",
				aspectRatio: "1:1"
			});

			assert.equal(result.provider, "minimax");
			assert.equal(result.model, "image-01-live");
			assert.equal(result.artifacts.length, 1);
			assert.equal(result.artifacts[0]?.mimeType, "image/jpeg");
			assert.equal(result.artifacts[0]?.byteSize, GENERATED_JPEG.byteLength);
			assert.equal(result.artifacts[0]?.storagePath, `attachments/images/${result.artifacts[0]?.imageId}.jpg`);
		});
	});
});
