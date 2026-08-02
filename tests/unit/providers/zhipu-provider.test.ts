import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { installReadOnlySecretStore, resetSecretStoreDriver } from "../../helpers/secret-store.js";
import { runOpenAICompatibleAgent } from "../../../src/providers/openai-compatible-agent.js";
import { chatWithOpenAICompatible, streamChatWithOpenAICompatible } from "../../../src/providers/provider-chat-completions-client.js";
import { fetchOpenAICompatibleModels, listProviderModels } from "../../../src/providers/provider-models.js";
import { saveProviderConfig } from "../../../src/providers/provider-config-store.js";
import type { McpHost } from "../../../src/mcp/mcp-host.js";
import type { AiChatParams } from "../../../src/protocol/types.js";
import { ApprovalGateway } from "../../../src/tools/approval-gateway.js";

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

async function withZhipuMockServer(run: (baseUrl: string, requests: RecordedRequest[]) => Promise<void>): Promise<void> {
	const requests: RecordedRequest[] = [];
	const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		if (request.url === "/generated.png") {
			response.writeHead(200, { "Content-Type": "image/png" });
			response.end(GENERATED_PNG);
			return;
		}
		if (request.url === "/models") {
			assert.equal(request.headers.authorization, "Bearer zhipu-test-key");
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ data: [{ id: "glm-5.2", owned_by: "zhipu" }] }));
			return;
		}

		const body: Record<string, unknown> = await readRequestBody(request);
		requests.push({
			url: request.url ?? "",
			authorization: request.headers.authorization,
			body
		});
		if (request.url === "/images/generations") {
			assert.equal(request.headers.authorization, "Bearer zhipu-test-key");
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({
				created: 1,
				data: [{ url: `http://${request.headers.host}/generated.png` }]
			}));
			return;
		}
		if (request.url === "/web_search") {
			assert.equal(request.headers.authorization, "Bearer zhipu-test-key");
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({
				id: "search-zhipu",
				created: 1,
				request_id: body.request_id,
				search_result: [{
					title: "Official source",
					link: "https://example.com/current",
					content: "Current source summary",
					media: "Example",
					publish_date: "2026-07-18"
				}]
			}));
			return;
		}
		assert.equal(request.url, "/chat/completions");
		assert.equal(request.headers.authorization, "Bearer zhipu-test-key");
		if (body.stream === true) {
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.write("data: {\"id\":\"chatcmpl-zhipu\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"glm-5.2\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"stream\"},\"finish_reason\":null}]}\n\n");
			response.end("data: [DONE]\n\n");
			return;
		}
		const tools = Array.isArray(body.tools) ? body.tools as Array<Record<string, unknown>> : [];
		if (tools.some((tool: Record<string, unknown>): boolean => tool.type === "web_search")) {
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({
				id: "chatcmpl-zhipu-search",
				object: "chat.completion",
				created: 1,
				model: "glm-5.2",
				choices: [{
					index: 0,
					message: { role: "assistant", content: "Current answer from web search." },
					finish_reason: "stop"
				}],
				web_search: [{
					title: "Official source",
					link: "https://example.com/current",
					content: "Current source summary",
					media: "Example",
					publish_date: "2026-07-18"
				}]
			}));
			return;
		}

		response.writeHead(200, { "Content-Type": "application/json" });
		response.end(JSON.stringify({
			id: "chatcmpl-zhipu",
			object: "chat.completion",
			created: 1,
			model: "glm-5v-turbo",
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
	process.env.USERPROFILE = await mkdtemp(join(tmpdir(), "daedalus-zhipu-image-"));
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

test("Zhipu OpenAI-compatible requests preserve image input, streaming, and model listing", async (): Promise<void> => {
	await withZhipuMockServer(async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
		const options = { provider: "zhipu" as const, apiKey: "zhipu-test-key", baseUrl, model: "glm-5v-turbo" };
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
			authorization: "Bearer zhipu-test-key",
			body: {
				model: "glm-5v-turbo",
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

		const agentParams: AiChatParams = {
			message: "请读取项目中的一个文件。",
			options: {
				stream: false
			}
		};
		(agentParams.options as Record<string, unknown>).requireToolCallOnFirstStep = true;
		const agentResult = await runOpenAICompatibleAgent(
			agentParams,
			{ ...options, model: "glm-5.2" },
			[],
			"System prompt",
			{} as McpHost,
			new ApprovalGateway(),
			["mcp_godot_read_text_file"]
		);
		assert.equal(agentResult.status, "protocol_violation");
		assert.equal(requests[1]?.body.tool_choice, "auto");

		const chunks: string[] = [];
		for await (const chunk of streamChatWithOpenAICompatible({ message: "Stream this" }, { ...options, model: "glm-5.2" }, [], "System prompt")) {
			chunks.push(chunk);
		}
		assert.deepEqual(chunks, ["stream"]);
		const streamRequest = requests.find((record: RecordedRequest): boolean => record.body.stream === true);
		assert.equal(streamRequest?.body.stream, true);

		const models = await fetchOpenAICompatibleModels({ provider: "zhipu", apiKey: "zhipu-test-key", baseUrl });
		assert.equal(models[0]?.id, "glm-5.2");
		assert.equal(models[0]?.ownedBy, "zhipu");
	});
});

test("Zhipu image generation uses the configured image model and saves a session artifact", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		await withZhipuMockServer(async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
			installReadOnlySecretStore(async (_service: string, account: string): Promise<string | null> => {
				return account === "provider:zhipu:api_key" ? "zhipu-test-key" : null;
			});

			await saveProviderConfig({
				provider: "zhipu",
				apiKey: "zhipu-test-key",
				baseUrl,
				model: "glm-5.2",
				modelRouting: {
					imageGeneration: { provider: "zhipu", model: "glm-image" }
				}
			});

			const sessionStore = await import("../../../src/session/session-store.js");
			const { generateImage } = await import("../../../src/providers/image-generation.js");
			const session = await sessionStore.createSession("Zhipu image generation");
			const result = await generateImage({
				sessionId: session.id,
				prompt: "生成一张蓝色机器人图标",
				aspectRatio: "2:1"
			});

			const imageRequest = requests.find((request: RecordedRequest): boolean => request.url === "/images/generations");
			assert.equal(imageRequest?.authorization, "Bearer zhipu-test-key");
			assert.deepEqual(imageRequest?.body, {
				model: "glm-image",
				prompt: "生成一张蓝色机器人图标\nTarget aspect ratio: 2:1. If the provider canvas is only approximate, preserve this composition as closely as possible.",
				size: "1728x960",
				watermark_enabled: false
			});
			assert.equal(result.provider, "zhipu");
			assert.equal(result.model, "glm-image");
			assert.equal(result.artifacts.length, 1);
			assert.equal(result.artifacts[0]?.byteSize, GENERATED_PNG.byteLength);
			assert.equal(result.artifacts[0]?.storagePath, `attachments/images/${result.artifacts[0]?.imageId}.png`);
			await assert.rejects(
				async (): Promise<void> => {
					await generateImage({
						sessionId: session.id,
						prompt: "把源图改成像素风",
						sourceImages: [{ type: "attachment", id: "image-test" }]
					});
				},
				/Zhipu's official image API does not currently expose/u
			);

			const { executeLlmToolWithIdempotency } = await import("../../../src/tools/tool-idempotency.js");
			const toolResult = await executeLlmToolWithIdempotency(
				{} as never,
				"mcp_image_generate",
				{ prompt: "生成一张红色机器人图标", aspectRatio: "1:1" },
				undefined,
				undefined,
				session.id
			);
			const toolContent = JSON.parse(toolResult.content) as {
				usageHint: string;
				artifacts: Array<{ imageId: string; absolutePath: string; localPath: string; markdownImage: string; storagePath: string }>;
			};
			assert.match(toolContent.usageHint, /absolutePath/u);
			assert.equal(isAbsolute(toolContent.artifacts[0]?.absolutePath ?? ""), true);
			assert.equal(toolContent.artifacts[0]?.localPath, toolContent.artifacts[0]?.absolutePath);
			assert.match(toolContent.artifacts[0]?.localPath ?? "", /attachments[\\/]images[\\/]generated-image-/);
			assert.match(toolContent.artifacts[0]?.markdownImage ?? "", /^!\[generated image\]\(<.+attachments\/images\/generated-image-.+>\)$/u);
			assert.match(toolContent.artifacts[0]?.storagePath ?? "", /^attachments\/images\/generated-image-/);
		});
	});
});

test("Zhipu web search tool uses provider-native web_search and returns sources", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		await withZhipuMockServer(async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
			installReadOnlySecretStore(async (_service: string, account: string): Promise<string | null> => {
				return account === "provider:zhipu:api_key" ? "zhipu-test-key" : null;
			});

			await saveProviderConfig({
				provider: "zhipu",
				apiKey: "zhipu-test-key",
				baseUrl,
				model: "glm-5.2"
			});
			const { updateWebSearchSettings } = await import("../../../src/web-search-settings-store.js");
			await updateWebSearchSettings({
				enabled: true,
				provider: "zhipu",
				model: "glm-5.2",
				maxResults: 20
			});

			const { executeLlmToolWithIdempotency } = await import("../../../src/tools/tool-idempotency.js");
			const toolResult = await executeLlmToolWithIdempotency(
				{} as never,
				"mcp_web_search",
				{ query: "current Daedalus release", reason: "latest version" }
			);
			const searchRequest = requests.find((request: RecordedRequest): boolean => request.url === "/web_search");
			assert.equal(searchRequest?.authorization, "Bearer zhipu-test-key");
			assert.equal(searchRequest?.body.search_query, "current Daedalus release");
			assert.equal(searchRequest?.body.search_engine, "search_std");
			assert.equal(searchRequest?.body.search_intent, false);
			assert.equal(searchRequest?.body.count, 20);
			assert.equal(searchRequest?.body.search_recency_filter, "noLimit");
			assert.equal(searchRequest?.body.content_size, "medium");
			assert.equal(typeof searchRequest?.body.request_id, "string");

			const content = JSON.parse(toolResult.content) as {
				ok: boolean;
				type: string;
				provider: string;
				model: string;
				answer: string;
				results: Array<{ title: string; url: string; summary?: string; source?: string; publishedAt?: string }>;
			};
			assert.equal(content.ok, true);
			assert.equal(content.type, "web_search");
			assert.equal(content.provider, "zhipu");
			assert.equal(content.model, "glm-5.2");
			assert.deepEqual(content.results, [{
				title: "Official source",
				url: "https://example.com/current",
				summary: "Current source summary",
				source: "Example",
				publishedAt: "2026-07-18"
			}]);
		});
	});
});

test("Zhipu web search tool lets explicit maxResults override settings", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		await withZhipuMockServer(async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
			installReadOnlySecretStore(async (_service: string, account: string): Promise<string | null> => {
				return account === "provider:zhipu:api_key" ? "zhipu-test-key" : null;
			});

			await saveProviderConfig({
				provider: "zhipu",
				apiKey: "zhipu-test-key",
				baseUrl,
				model: "glm-5.2"
			});
			const { updateWebSearchSettings } = await import("../../../src/web-search-settings-store.js");
			await updateWebSearchSettings({
				enabled: true,
				provider: "zhipu",
				model: "glm-5.2",
				maxResults: 50
			});

			const { executeLlmToolWithIdempotency } = await import("../../../src/tools/tool-idempotency.js");
			await executeLlmToolWithIdempotency(
				{} as never,
				"mcp_web_search",
				{ query: "current Daedalus release", maxResults: 3 }
			);

			const searchRequest = requests.find((request: RecordedRequest): boolean => request.url === "/web_search");
			assert.equal(searchRequest?.body.count, 3);
		});
	});
});

test("Zhipu web search forwards abort signal to provider request", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		const requests: RecordedRequest[] = [];
		let resolveRequestReceived: (() => void) | undefined;
		const requestReceived = new Promise<void>((resolve: () => void): void => {
			resolveRequestReceived = resolve;
		});
		const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
			const body: Record<string, unknown> = await readRequestBody(request);
			requests.push({
				url: request.url ?? "",
				authorization: request.headers.authorization,
				body
			});
			resolveRequestReceived?.();
			const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
				if (!response.destroyed) {
					response.writeHead(200, { "Content-Type": "application/json" });
					response.end(JSON.stringify({ choices: [{ message: { content: "late" } }] }));
				}
			}, 10_000);
			response.on("close", (): void => {
				clearTimeout(timer);
			});
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		if (address === null || typeof address === "string") {
			throw new Error("Mock server did not expose a TCP port");
		}

		try {
			const baseUrl = `http://127.0.0.1:${address.port}`;
			installReadOnlySecretStore(async (_service: string, account: string): Promise<string | null> => {
				return account === "provider:zhipu:api_key" ? "zhipu-test-key" : null;
			});

			await saveProviderConfig({
				provider: "zhipu",
				apiKey: "zhipu-test-key",
				baseUrl,
				model: "glm-5.2"
			});
			const { updateWebSearchSettings } = await import("../../../src/web-search-settings-store.js");
			await updateWebSearchSettings({
				enabled: true,
				provider: "zhipu",
				model: "glm-5.2"
			});

			const { executeWebSearch } = await import("../../../src/providers/web-search.js");
			const controller = new AbortController();
			const searchPromise = executeWebSearch({ query: "slow current fact" }, controller.signal);
			await requestReceived;
			controller.abort(new Error("Request cancelled"));

			await assert.rejects(
				searchPromise,
				(error: unknown): boolean => {
					return error instanceof Error && /abort|cancel/i.test(`${error.name} ${error.message}`);
				}
			);
			assert.equal(requests[0]?.url, "/web_search");
		} finally {
			server.close();
			await once(server, "close");
		}
	});
});

test("Zhipu provider model list includes local image generation models when API omits them", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		await withZhipuMockServer(async (baseUrl: string): Promise<void> => {
			const result = await listProviderModels("zhipu", "zhipu-test-key", baseUrl, true);

			assert.equal(result.source, "api");
			assert.equal(result.models.some((model): boolean => model.id === "glm-5.2"), true);
			assert.equal(result.models.find((model): boolean => model.id === "glm-image")?.capabilities.imageGeneration, true);
			assert.equal(result.models.find((model): boolean => model.id === "cogview-4-250304")?.capabilities.imageGeneration, true);
			assert.equal(result.models.find((model): boolean => model.id === "cogview-3-flash")?.capabilities.imageGeneration, true);
		});
	});
});
