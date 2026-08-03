import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import type { McpHost } from "../../../src/mcp/mcp-host.js";
import { chatWithProvider } from "../../../src/providers/deepseek-client.js";
import { runAnthropicCompatibleAgent, runAnthropicCompatibleAgentStreaming } from "../../../src/providers/anthropic-compatible-agent.js";
import { listProviderModels } from "../../../src/providers/provider-models.js";
import { modelSupportsImageInput } from "../../../src/providers/provider-image-content.js";
import { createProviderChatOptions } from "../../../src/server/provider-chat-options.js";
import type { ClientSession } from "../../../src/server/client-session.js";
import { resolveModelProfile } from "../../../src/tokens/model-profiles.js";
import { ApprovalGateway } from "../../../src/tools/approval-gateway.js";
import type { ToolEvent } from "../../../src/tools/tool-dispatcher.js";

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

function writeAnthropicSseChunk(response: ServerResponse, value: Record<string, unknown>): void {
	response.write(`event: ${String(value.type)}\n`);
	response.write(`data: ${JSON.stringify(value)}\n\n`);
}

function createMockMcpHost(): McpHost {
	return {
		getActiveWorkspaceId(): string | undefined {
			return "workspace-1";
		},
		async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
			assert.equal(serverId, "godot_diagnostics");
			assert.equal(toolName, "lsp_get_status");
			assert.deepEqual(args, {});
			return {
				content: [{
					type: "text",
					text: "LSP is available."
				}]
			};
		}
	} as unknown as McpHost;
}

async function withOpenCodeGoMockServer(run: (baseUrl: string, requests: RecordedRequest[]) => Promise<void>): Promise<void> {
	const requests: RecordedRequest[] = [];
	const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		if (request.url === "/models") {
			assert.equal(request.headers.authorization, "Bearer opencode-go-test-key");
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({
				data: [
					{ id: "kimi-k3", owned_by: "opencode", context_length: 256000 },
					{ id: "minimax-m3", owned_by: "opencode", context_length: 1000000 },
					{ id: "qwen3.7-plus", owned_by: "opencode", context_length: 1000000 },
					{ id: "unsupported-extra-model", owned_by: "opencode", context_length: 8192 }
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

		assert.equal(request.headers.authorization, "Bearer opencode-go-test-key");
		response.writeHead(200, { "Content-Type": request.url === "/messages" && body.stream === true ? "text/event-stream" : "application/json" });

		if (request.url === "/chat/completions") {
			response.end(JSON.stringify({
				id: "chatcmpl-opencode-go",
				object: "chat.completion",
				created: 1,
				model: "kimi-k3",
				choices: [{
					index: 0,
					message: { role: "assistant", content: "OpenCode Go OpenAI response." },
					finish_reason: "stop"
				}]
			}));
			return;
		}

		assert.equal(request.url, "/messages");
		if (body.stream === true) {
			writeAnthropicSseChunk(response, {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" }
			});
			writeAnthropicSseChunk(response, {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "streamed " }
			});
			writeAnthropicSseChunk(response, {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "anthropic response" }
			});
			writeAnthropicSseChunk(response, {
				type: "content_block_stop",
				index: 0
			});
			writeAnthropicSseChunk(response, { type: "message_stop" });
			response.end();
			return;
		}

		const messagesJson: string = JSON.stringify(body.messages);
		if (messagesJson.includes("tool_result")) {
			response.end(JSON.stringify({
				id: "msg-opencode-go-final",
				type: "message",
				role: "assistant",
				model: "minimax-m3",
				content: [{ type: "text", text: "LSP status checked." }],
				stop_reason: "end_turn"
			}));
			return;
		}
		if (Array.isArray(body.tools)) {
			response.end(JSON.stringify({
				id: "msg-opencode-go-tool",
				type: "message",
				role: "assistant",
				model: "minimax-m3",
				content: [{
					type: "tool_use",
					id: "toolu-opencode-go-lsp",
					name: "mcp_godot_lsp_get_status",
					input: {}
				}],
				stop_reason: "tool_use"
			}));
			return;
		}
		response.end(JSON.stringify({
			id: "msg-opencode-go",
			type: "message",
			role: "assistant",
			model: "minimax-m3",
			content: [{ type: "text", text: "OpenCode Go Anthropic response." }],
			stop_reason: "end_turn"
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

async function withInterruptedAnthropicStreamMockServer(run: (baseUrl: string, requests: RecordedRequest[]) => Promise<void>): Promise<void> {
	const requests: RecordedRequest[] = [];
	const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		const body: Record<string, unknown> = await readRequestBody(request);
		requests.push({ url: request.url ?? "", authorization: request.headers.authorization, body });
		response.writeHead(200, { "Content-Type": "text/event-stream" });
		writeAnthropicSseChunk(response, {
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" }
		});
		writeAnthropicSseChunk(response, {
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: requests.length === 1 ? "partial" : "complete" }
		});
		writeAnthropicSseChunk(response, { type: "content_block_stop", index: 0 });
		if (requests.length > 1) writeAnthropicSseChunk(response, { type: "message_stop" });
		response.end();
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Mock server did not expose a TCP port");
	try {
		await run(`http://127.0.0.1:${address.port}`, requests);
	} finally {
		server.close();
		await once(server, "close");
	}
}

async function withTempAppData(run: () => Promise<void>): Promise<void> {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	process.env.USERPROFILE = await mkdtemp(join(tmpdir(), "daedalus-opencode-go-provider-"));
	try {
		await run();
	} finally {
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		mock.restoreAll();
	}
}

function createSession(providerModel: string, baseUrl: string): ClientSession {
	return {
		activeProvider: "opencode_go",
		providerModel,
		providerBaseUrl: baseUrl,
		messages: [],
		modelProfile: resolveModelProfile("opencode_go", providerModel)
	} as unknown as ClientSession;
}

test("OpenCode Go selects endpoint by model catalog entry", async (): Promise<void> => {
	await withOpenCodeGoMockServer(async (baseUrl: string): Promise<void> => {
		const openAiOptions = createProviderChatOptions(createSession("kimi-k3", baseUrl), "opencode-go-test-key");
		assert.equal(openAiOptions.endpointType, "openai-chat-completions");
		assert.equal(openAiOptions.adapterFamily, "openai-compatible");

		const anthropicOptions = createProviderChatOptions(createSession("minimax-m3", baseUrl), "opencode-go-test-key");
		assert.equal(anthropicOptions.endpointType, "anthropic-messages");
		assert.equal(anthropicOptions.adapterFamily, "anthropic-compatible");
	});
});

test("OpenCode Go uses OpenAI-compatible chat for openai-chat-completions models", async (): Promise<void> => {
	await withOpenCodeGoMockServer(async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
		const text = await chatWithProvider(
			{ message: "Hello" },
			createProviderChatOptions(createSession("kimi-k3", baseUrl), "opencode-go-test-key"),
			[],
			"System prompt"
		);

		assert.equal(text, "OpenCode Go OpenAI response.");
		assert.deepEqual(requests[0], {
			url: "/chat/completions",
			authorization: "Bearer opencode-go-test-key",
			body: {
				model: "kimi-k3",
				messages: [
					{ role: "system", content: "System prompt" },
					{ role: "user", content: "Hello" }
				]
			}
		});
	});
});

test("OpenCode Go Anthropic-compatible chat preserves image blocks", async (): Promise<void> => {
	await withOpenCodeGoMockServer(async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
		const text = await chatWithProvider(
			{
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
			},
			createProviderChatOptions(createSession("minimax-m3", baseUrl), "opencode-go-test-key"),
			[],
			"System prompt"
		);

		assert.equal(text, "OpenCode Go Anthropic response.");
		assert.deepEqual(requests[0], {
			url: "/messages",
			authorization: "Bearer opencode-go-test-key",
			body: {
				model: "minimax-m3",
				max_tokens: 16000,
				system: "System prompt",
				messages: [{
					role: "user",
					content: [
						{
							type: "image",
							source: {
								type: "base64",
								media_type: "image/png",
								data: "AAAA"
							}
						},
						{ type: "text", text: "Describe this image" }
					]
				}]
			}
		});
		assert.equal(await modelSupportsImageInput("opencode_go", "minimax-m3"), true);
	});
});

test("OpenCode Go model refresh keeps only recommended mixed-endpoint models", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		await withOpenCodeGoMockServer(async (baseUrl: string): Promise<void> => {
			const result = await listProviderModels("opencode_go", "opencode-go-test-key", baseUrl, true);

			assert.equal(result.source, "api");
			assert.equal(result.models.length, 16);
			assert.equal(result.models.find((model): boolean => model.id === "kimi-k3")?.endpointType, "openai-chat-completions");
			assert.equal(result.models.find((model): boolean => model.id === "minimax-m3")?.endpointType, "anthropic-messages");
			assert.equal(result.models.find((model): boolean => model.id === "qwen3.7-plus")?.endpointType, "anthropic-messages");
			assert.equal(result.models.some((model): boolean => model.id === "unsupported-extra-model"), false);
		});
	});
});

test("OpenCode Go Anthropic-compatible agent executes tool_use and returns tool_result", async (): Promise<void> => {
	await withOpenCodeGoMockServer(async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
		const result = await runAnthropicCompatibleAgent(
			{ message: "Check LSP status" },
			createProviderChatOptions(createSession("minimax-m3", baseUrl), "opencode-go-test-key"),
			[],
			"System prompt",
			createMockMcpHost(),
			new ApprovalGateway(),
			["mcp_godot_lsp_get_status"]
		);

		assert.deepEqual(result, {
			status: "completed",
			text: "LSP status checked."
		});
		assert.equal(requests.length, 2);
		const firstTools = requests[0]?.body.tools as Array<{ name?: string; input_schema?: Record<string, unknown> }> | undefined;
		assert.equal(firstTools?.[0]?.name, "mcp_godot_lsp_get_status");
		assert.equal(firstTools?.[0]?.input_schema?.type, "object");
		assert.match(JSON.stringify(requests[1]?.body.messages), /tool_result/u);
		assert.match(JSON.stringify(requests[1]?.body.messages), /toolu-opencode-go-lsp/u);
	});
});

test("OpenCode Go Anthropic-compatible streaming agent emits text deltas", async (): Promise<void> => {
	await withOpenCodeGoMockServer(async (baseUrl: string): Promise<void> => {
		const deltas: string[] = [];
		const result = await runAnthropicCompatibleAgentStreaming(
			{ message: "Stream" },
			createProviderChatOptions(createSession("qwen3.7-plus", baseUrl), "opencode-go-test-key"),
			[],
			"System prompt",
			createMockMcpHost(),
			new ApprovalGateway(),
			[],
			(event): void => {
				if (event.type === "ai.delta") {
					deltas.push(event.text);
				}
			}
		);

		assert.deepEqual(deltas, ["streamed ", "anthropic response"]);
		assert.deepEqual(result, {
			status: "completed",
			text: "streamed anthropic response"
		});
	});
});

test("Anthropic-compatible streaming reconnects when message_stop is missing", async (): Promise<void> => {
	await withInterruptedAnthropicStreamMockServer(async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
		const events: ToolEvent[] = [];
		const result = await runAnthropicCompatibleAgentStreaming(
			{ message: "Stream" },
			createProviderChatOptions(createSession("qwen3.7-plus", baseUrl), "opencode-go-test-key"),
			[],
			"System prompt",
			createMockMcpHost(),
			new ApprovalGateway(),
			[],
			(event: ToolEvent): void => { events.push(event); }
		);

		assert.equal(result.status, "completed");
		assert.equal(result.text, "complete");
		assert.equal(requests.length, 2);
		const reconnects = events.filter((event): event is Extract<ToolEvent, { type: "provider.reconnect" }> => event.type === "provider.reconnect");
		assert.equal(reconnects[0]?.status, "waiting");
		assert.equal(reconnects[0]?.discardedMessageCodePoints, 7);
		assert.equal(reconnects.at(-1)?.status, "recovered");
	});
});
