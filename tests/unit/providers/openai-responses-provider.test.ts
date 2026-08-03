import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import test from "node:test";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { ResponseFunctionToolCall } from "openai/resources/responses/responses";
import type { McpHost } from "../../../src/mcp/mcp-host.js";
import { aiChatParamsSchema, providerIdSchema } from "../../../src/protocol/schema.js";
import type { AiChatParams, ChatMessage } from "../../../src/protocol/types.js";
import {
	createOpenAIResponseInput,
	createOpenAIResponsesRequestBody
} from "../../../src/providers/openai-responses-client.js";
import {
	convertResponsesToolCalls,
	convertToolDefinitions,
	runOpenAIResponsesAgent,
	runOpenAIResponsesAgentStreaming
} from "../../../src/providers/openai-responses-agent.js";
import type { ToolEvent } from "../../../src/tools/tool-dispatcher.js";
import { getProviderDefaultBaseUrl, getProviderDefaultModel, getProviderIds } from "../../../src/providers/provider-registry.js";
import { ApprovalGateway } from "../../../src/tools/approval-gateway.js";

type RecordedRequest = {
	url: string;
	body: Record<string, unknown>;
};

async function readRequestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	let text: string = "";
	for await (const chunk of request) {
		text += String(chunk);
	}
	return JSON.parse(text) as Record<string, unknown>;
}

function createResponseMessage(text: string): Record<string, unknown> {
	return {
		type: "message",
		id: `msg-${Date.now()}`,
		status: "completed",
		role: "assistant",
		content: [{
			type: "output_text",
			text,
			annotations: []
		}]
	};
}

function createMockMcpHost(): McpHost {
	return {
		getActiveWorkspaceId(): string | undefined {
			return undefined;
		},
		async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
			assert.equal(serverId, "godot");
			assert.equal(toolName, "read_text_file");
			assert.equal(args.relativePath, "tic_tac_toe_game.gd");
			return {
				content: [{
					type: "text",
					text: "extends Node\n"
				}]
			};
		}
	} as unknown as McpHost;
}

async function withResponsesMissingToolCallRetryMockServer(run: (baseUrl: string, requests: RecordedRequest[]) => Promise<void>): Promise<void> {
	const requests: RecordedRequest[] = [];
	const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		const body: Record<string, unknown> = await readRequestBody(request);
		requests.push({ url: request.url ?? "", body });
		assert.equal(request.url, "/responses");

		response.writeHead(200, { "Content-Type": "application/json" });
		if (requests.length === 1) {
			response.end(JSON.stringify({
				id: "resp-text-only",
				object: "response",
				created_at: 1,
				model: "gpt-5.6-sol",
				output_text: "先确认项目状态。",
				output: [createResponseMessage("先确认项目状态。")]
			}));
			return;
		}

		if (requests.length === 2) {
			response.end(JSON.stringify({
				id: "resp-tool",
				object: "response",
				created_at: 1,
				model: "gpt-5.6-sol",
				output_text: "",
				output: [{
					type: "function_call",
					id: "fc-read",
					call_id: "call-read",
					name: "mcp_godot_read_text_file",
					arguments: "{\"relativePath\":\"tic_tac_toe_game.gd\"}",
					status: "completed"
				}]
			}));
			return;
		}

		response.end(JSON.stringify({
			id: "resp-final",
			object: "response",
			created_at: 1,
			model: "gpt-5.6-sol",
			output_text: "读取完成。",
			output: [createResponseMessage("读取完成。")]
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

async function withInterruptedResponsesStreamMockServer(run: (baseUrl: string, requests: RecordedRequest[]) => Promise<void>): Promise<void> {
	const requests: RecordedRequest[] = [];
	const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		const body: Record<string, unknown> = await readRequestBody(request);
		requests.push({ url: request.url ?? "", body });
		response.writeHead(200, { "Content-Type": "text/event-stream" });
		const text: string = requests.length === 1 ? "partial" : "complete";
		response.write(`data: ${JSON.stringify({
			type: "response.output_text.delta",
			sequence_number: 0,
			item_id: "message-1",
			output_index: 0,
			content_index: 0,
			delta: text
		})}\n\n`);
		if (requests.length > 1) {
			response.write(`data: ${JSON.stringify({
				type: "response.completed",
				sequence_number: 1,
				response: {
					id: "response-recovered",
					object: "response",
					created_at: 1,
					model: "gpt-5.6-sol",
					status: "completed",
					output: [],
					output_text: text
				}
			})}\n\n`);
		}
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

test("provider schema and registry include official OpenAI provider", (): void => {
	assert.equal(providerIdSchema.safeParse("openai").success, true);
	assert.equal(providerIdSchema.safeParse("anthropic").success, true);
	assert.equal(providerIdSchema.safeParse("Anthropic").success, false);
	assert.ok(getProviderIds().includes("openai"));
	assert.equal(getProviderDefaultModel("openai"), "gpt-5.6-sol");
	assert.equal(getProviderDefaultBaseUrl("openai"), "https://api.openai.com/v1");
});

test("OpenAI Responses request builder maps instructions, input, stream-safe options, and store false", (): void => {
	const params: AiChatParams = {
		message: "解释这个脚本",
		options: {
			temperature: 0.2,
			topP: 0.9,
			maxTokens: 1234,
			responseFormat: "json"
		}
	};
	const history: ChatMessage[] = [
		{ role: "user", content: "上一轮问题" },
		{ role: "assistant", content: "上一轮回答" }
	];

	const requestBody = createOpenAIResponsesRequestBody(
		params,
		{ provider: "openai", apiKey: "test-key" },
		history,
		"稳定系统指令"
	);

	assert.equal(requestBody.model, "gpt-5.6-sol");
	assert.equal(requestBody.instructions, "稳定系统指令");
	assert.equal(requestBody.store, false);
	assert.equal(requestBody.temperature, 0.2);
	assert.equal(requestBody.top_p, 0.9);
	assert.equal(requestBody.max_output_tokens, 1234);
	assert.deepEqual(requestBody.text, { format: { type: "json_object" } });
	assert.deepEqual(requestBody.input, [
		{ type: "message", role: "user", content: "上一轮问题" },
		{ type: "message", role: "assistant", content: "上一轮回答", phase: "final_answer" },
		{ type: "message", role: "user", content: "解释这个脚本" }
	]);
});

test("OpenAI Responses input builder maps current image context to input_image parts", (): void => {
	const params: AiChatParams = {
		message: "看这张图",
		additionalContext: [{
			id: "image-1",
			kind: "image",
			title: "screenshot",
			source: "manual",
			data: {
				mimeType: "image/png",
				dataUrl: "data:image/png;base64,AAAA",
				byteSize: 3
			}
		}]
	};

	const input = createOpenAIResponseInput(params, []);
	assert.deepEqual(input, [{
		type: "message",
		role: "user",
		content: [
			{ type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "auto" },
			{ type: "input_text", text: "看这张图" }
		]
	}]);
});

test("OpenAI Responses tools and function calls map to existing tool dispatcher shape", (): void => {
	const chatTool: ChatCompletionTool = {
		type: "function",
		function: {
			name: "godot_read_file",
			description: "Read a file",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string" }
				}
			}
		}
	};
	const responsesTools = convertToolDefinitions([chatTool]);
	assert.deepEqual(responsesTools, [{
		type: "function",
		name: "godot_read_file",
		description: "Read a file",
		parameters: chatTool.function.parameters,
		strict: false
	}]);

	const responsesToolCall: ResponseFunctionToolCall = {
		type: "function_call",
		call_id: "call-1",
		name: "godot_read_file",
		arguments: "{\"path\":\"res://main.gd\"}"
	};
	assert.deepEqual(convertResponsesToolCalls([responsesToolCall], new Set(["godot_read_file"])), [{
		id: "call-1",
		type: "function",
		function: {
			name: "godot_read_file",
			arguments: "{\"path\":\"res://main.gd\"}"
		}
	}]);
	assert.deepEqual(convertResponsesToolCalls([responsesToolCall], new Set(["other_tool"])), []);
});

test("OpenAI Responses agent retries required first tool call text responses", async (): Promise<void> => {
	await withResponsesMissingToolCallRetryMockServer(async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
		const params: AiChatParams = {
			message: "读取 tic_tac_toe_game.gd",
			options: {
				stream: false
			}
		};
		(params.options as Record<string, unknown>).requireToolCallOnFirstStep = true;

		const result = await runOpenAIResponsesAgent(
			params,
			{ provider: "openai", apiKey: "test-key", baseUrl, model: "gpt-5.6-sol" },
			[],
			"System prompt",
			createMockMcpHost(),
			new ApprovalGateway(),
			["mcp_godot_read_text_file"]
		);

		assert.equal(result.status, "completed");
		assert.equal(result.text, "读取完成。");
		assert.equal(requests.length, 3);
		assert.equal(requests[0]?.body.tool_choice, "required");
		assert.match(JSON.stringify(requests[1]?.body.input), /输出了正文/);
		assert.match(JSON.stringify(requests[1]?.body.input), /mcp_godot_read_text_file/);
	});
});

test("OpenAI Responses streaming reconnects when response.completed is missing", async (): Promise<void> => {
	await withInterruptedResponsesStreamMockServer(async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
		const events: ToolEvent[] = [];
		const result = await runOpenAIResponsesAgentStreaming(
			{ message: "Stream", options: { stream: true } },
			{ provider: "openai", apiKey: "test-key", baseUrl, model: "gpt-5.6-sol" },
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

test("ai.chat schema continues accepting ask mode with OpenAI provider configured separately", (): void => {
	assert.equal(aiChatParamsSchema.safeParse({
		message: "这段代码为什么错？",
		mode: "ask",
		options: {
			workflow: "single",
			stream: true
		}
	}).success, true);
});
