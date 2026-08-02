import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installReadOnlySecretStore, resetSecretStoreDriver } from "../../helpers/secret-store.js";
import { listProviderModels } from "../../../src/providers/provider-models.js";
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

async function withDashScopeMockServer(run: (baseUrl: string, requests: RecordedRequest[]) => Promise<void>): Promise<void> {
	const requests: RecordedRequest[] = [];
	const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		if (request.url === "/generated.png") {
			response.writeHead(200, { "Content-Type": "image/png" });
			response.end(GENERATED_PNG);
			return;
		}
		if (request.url === "/compatible-mode/v1/models") {
			assert.equal(request.headers.authorization, "Bearer dashscope-test-key");
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({
				data: [
					{ id: "qwen3.7-plus", owned_by: "dashscope" },
					{ id: "qwen-legacy-unrecommended", owned_by: "dashscope" }
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
		assert.equal(request.url, "/api/v1/services/aigc/multimodal-generation/generation");
		assert.equal(request.headers.authorization, "Bearer dashscope-test-key");
		response.writeHead(200, { "Content-Type": "application/json" });
		response.end(JSON.stringify({
			output: {
				choices: [{
					message: {
						content: [{ image: `http://${request.headers.host}/generated.png` }]
					}
				}]
			}
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
	process.env.USERPROFILE = await mkdtemp(join(tmpdir(), "daedalus-dashscope-image-"));
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

function getOnlyImageRequest(requests: RecordedRequest[]): RecordedRequest {
	const request: RecordedRequest | undefined = requests.find((item: RecordedRequest): boolean => item.url === "/api/v1/services/aigc/multimodal-generation/generation");
	if (request === undefined) {
		throw new Error("DashScope image request was not recorded");
	}
	return request;
}

test("DashScope provider model list keeps the recommended catalog when API returns extra models", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		await withDashScopeMockServer(async (baseUrl: string): Promise<void> => {
			const result = await listProviderModels("dashscope", "dashscope-test-key", `${baseUrl}/compatible-mode/v1`, true);

			assert.equal(result.source, "api");
			assert.equal(result.models.length, 20);
			assert.equal(result.models.some((model): boolean => model.id === "qwen3.7-plus"), true);
			assert.equal(result.models.some((model): boolean => model.id === "qwen-legacy-unrecommended"), false);
			assert.equal(result.models.find((model): boolean => model.id === "qwen-image-2.0-pro")?.capabilities.imageGeneration, true);
			assert.equal(result.models.find((model): boolean => model.id === "qwen-image-2.0-pro")?.capabilities.imageEdit, true);
			assert.equal(result.models.find((model): boolean => model.id === "qwen-image-max")?.capabilities.imageGeneration, true);
			assert.equal(result.models.find((model): boolean => model.id === "qwen-image-max")?.capabilities.imageEdit, undefined);
			assert.equal(result.models.find((model): boolean => model.id === "qwen-image-edit")?.capabilities.imageGeneration, undefined);
			assert.equal(result.models.find((model): boolean => model.id === "qwen-image-edit")?.capabilities.imageEdit, true);
		});
	});
});

test("DashScope image edit sends source images and saves a session artifact", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		await withDashScopeMockServer(async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
			installReadOnlySecretStore(async (_service: string, account: string): Promise<string | null> => {
				return account === "provider:dashscope:api_key" ? "dashscope-test-key" : null;
			});

			await saveProviderConfig({
				provider: "dashscope",
				apiKey: "dashscope-test-key",
				baseUrl: `${baseUrl}/compatible-mode/v1`,
				model: "qwen3.7-plus",
				modelRouting: {
					imageGeneration: { provider: "dashscope", model: "qwen-image-2.0-pro" }
				}
			});

			const sessionStore = await import("../../../src/session/session-store.js");
			const attachments = await import("../../../src/session/session-attachments.js");
			const { generateImage } = await import("../../../src/providers/image-generation.js");
			const session = await sessionStore.createSession("DashScope image edit");
			const dataUrl: string = "data:image/png;base64,c291cmNlLWltYWdl";
			const context = await attachments.saveImageAttachment({
				sessionId: session.id,
				mimeType: "image/png",
				dataUrl,
				byteSize: Buffer.byteLength("source-image"),
				title: "Source image"
			});
			const attachmentId: string = String((context.data as Record<string, unknown>).attachmentId);
			const result = await generateImage({
				sessionId: session.id,
				prompt: "把源图改成低多边形 Godot 道具图标",
				aspectRatio: "16:9",
				count: 2,
				sourceImages: [{ type: "attachment", id: attachmentId }]
			});

			const imageRequest = getOnlyImageRequest(requests);
			assert.equal(imageRequest.authorization, "Bearer dashscope-test-key");
			assert.deepEqual(imageRequest.body, {
				model: "qwen-image-2.0-pro",
				input: {
					messages: [{
						role: "user",
						content: [
							{ image: dataUrl },
							{ text: "把源图改成低多边形 Godot 道具图标" }
						]
					}]
				},
				parameters: {
					n: 2,
					negative_prompt: " ",
					watermark: false,
					prompt_extend: true,
					size: "1280*720"
				}
			});
			assert.equal(result.provider, "dashscope");
			assert.equal(result.model, "qwen-image-2.0-pro");
			assert.deepEqual(result.sourceImages, [{ type: "attachment", id: attachmentId }]);
			assert.equal(result.artifacts.length, 1);
			assert.equal(result.artifacts[0]?.byteSize, GENERATED_PNG.byteLength);
			assert.equal(result.artifacts[0]?.provider, "dashscope");
		});
	});
});

test("DashScope edit-only model requires a source image and omits unsupported optional parameters", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		await withDashScopeMockServer(async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
			installReadOnlySecretStore(async (_service: string, account: string): Promise<string | null> => {
				return account === "provider:dashscope:api_key" ? "dashscope-test-key" : null;
			});

			await saveProviderConfig({
				provider: "dashscope",
				apiKey: "dashscope-test-key",
				baseUrl: `${baseUrl}/compatible-mode/v1`,
				model: "qwen3.7-plus",
				modelRouting: {
					imageGeneration: { provider: "dashscope", model: "qwen-image-edit" }
				}
			});

			const sessionStore = await import("../../../src/session/session-store.js");
			const attachments = await import("../../../src/session/session-attachments.js");
			const { generateImage } = await import("../../../src/providers/image-generation.js");
			const session = await sessionStore.createSession("DashScope edit-only");
			await assert.rejects(
				async (): Promise<void> => {
					await generateImage({
						sessionId: session.id,
						prompt: "生成一张新的图"
					});
				},
				/requires at least one source image/u
			);

			const dataUrl: string = "data:image/jpeg;base64,c291cmNlLWpwZWc=";
			const context = await attachments.saveImageAttachment({
				sessionId: session.id,
				mimeType: "image/jpeg",
				dataUrl,
				byteSize: Buffer.byteLength("source-jpeg"),
				title: "Source jpeg"
			});
			const attachmentId: string = String((context.data as Record<string, unknown>).attachmentId);
			await generateImage({
				sessionId: session.id,
				prompt: "把源图变成夜晚版本",
				aspectRatio: "9:16",
				count: 4,
				sourceImages: [{ type: "attachment", id: attachmentId }]
			});

			const imageRequest = getOnlyImageRequest(requests);
			assert.deepEqual(imageRequest.body.parameters, {
				n: 1,
				negative_prompt: " ",
				watermark: false
			});
		});
	});
});

test("DashScope image-only models cap output count at one", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		await withDashScopeMockServer(async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
			installReadOnlySecretStore(async (_service: string, account: string): Promise<string | null> => {
				return account === "provider:dashscope:api_key" ? "dashscope-test-key" : null;
			});

			await saveProviderConfig({
				provider: "dashscope",
				apiKey: "dashscope-test-key",
				baseUrl: `${baseUrl}/compatible-mode/v1`,
				model: "qwen3.7-plus",
				modelRouting: {
					imageGeneration: { provider: "dashscope", model: "qwen-image-max" }
				}
			});

			const sessionStore = await import("../../../src/session/session-store.js");
			const { generateImage } = await import("../../../src/providers/image-generation.js");
			const session = await sessionStore.createSession("DashScope image max");
			await generateImage({
				sessionId: session.id,
				prompt: "生成一张 Godot 风格像素小屋",
				count: 4
			});

			const imageRequest = getOnlyImageRequest(requests);
			assert.equal(imageRequest.body.model, "qwen-image-max");
			assert.deepEqual(imageRequest.body.parameters, {
				n: 1,
				negative_prompt: " ",
				watermark: false,
				prompt_extend: true,
				size: "1024*1024"
			});
		});
	});
});
