import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import test from "node:test";
import { continueOpenAICompatibleAgent, createMissingRequiredToolCallCorrectionMessage, createToolProtocolCorrectionMessage, resolveRequiredToolChoice, runOpenAICompatibleAgent, runOpenAICompatibleAgentStreaming, shouldDisableThinkingForToolCalls, shouldSkipRequiredToolChoice, type OpenAICompatibleAgentContinuation } from "../../../src/providers/openai-compatible-agent.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { McpHost } from "../../../src/mcp/mcp-host.js";
import type { AiChatParams } from "../../../src/protocol/types.js";
import type { ToolEvent } from "../../../src/tools/tool-dispatcher.js";
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

function writeSseChunk(response: ServerResponse, value: Record<string, unknown>): void {
	response.write(`data: ${JSON.stringify(value)}\n\n`);
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
					text: "extends Node\nfunc reset_game() -> void:\n\tpass\n"
				}]
			};
		}
	} as unknown as McpHost;
}

async function withStreamingAgentMockServer(run: (baseUrl: string, requests: RecordedRequest[]) => Promise<void>): Promise<void> {
	const requests: RecordedRequest[] = [];
	const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		const body: Record<string, unknown> = await readRequestBody(request);
		requests.push({ url: request.url ?? "", body });
		assert.equal(request.url, "/chat/completions");

		if (requests.length === 1) {
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			writeSseChunk(response, {
				id: "chatcmpl-tool",
				object: "chat.completion.chunk",
				created: 1,
				model: "glm-5.2",
				choices: [{
					index: 0,
					delta: {
						tool_calls: [{
							index: 0,
							id: "call-read",
							type: "function",
							function: {
								name: "mcp_godot_read_text_file",
								arguments: "{\"relativePath\":\"tic_tac_toe_game.gd\"}"
							}
						}]
					},
					finish_reason: null
				}]
			});
			response.end("data: [DONE]\n\n");
			return;
		}

		if (requests.length === 2) {
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			writeSseChunk(response, {
				id: "chatcmpl-thinking-only",
				object: "chat.completion.chunk",
				created: 1,
				model: "glm-5.2",
				choices: [{
					index: 0,
					delta: {
						reasoning_content: "已经读取文件，但这次模型只返回了思考内容。"
					},
					finish_reason: null
				}]
			});
			response.end("data: [DONE]\n\n");
			return;
		}

		response.writeHead(200, { "Content-Type": "application/json" });
		response.end(JSON.stringify({
			id: "chatcmpl-final",
			object: "chat.completion",
			created: 1,
			model: "glm-5.2",
			choices: [{
				index: 0,
				message: { role: "assistant", content: "tic_tac_toe_game.gd 的逻辑入口是 reset_game。" },
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

async function withInterruptedStreamingMockServer(run: (baseUrl: string, requests: RecordedRequest[]) => Promise<void>): Promise<void> {
	const requests: RecordedRequest[] = [];
	const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		const body: Record<string, unknown> = await readRequestBody(request);
		requests.push({ url: request.url ?? "", body });
		assert.equal(request.url, "/chat/completions");

		if (requests.length === 1) {
			response.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Content-Length": "65536",
				"Connection": "close"
			});
			writeSseChunk(response, {
				id: "chatcmpl-interrupted",
				object: "chat.completion.chunk",
				created: 1,
				model: "deepseek-v4-flash",
				choices: [{
					index: 0,
					delta: { reasoning_content: "Inspecting the project before editing." },
					finish_reason: null
				}]
			});
			await new Promise<void>((resolve): void => {
				setImmediate(resolve);
			});
			response.destroy(new Error("simulated stream interruption"));
			return;
		}

		response.writeHead(200, { "Content-Type": "text/event-stream" });
		writeSseChunk(response, {
			id: "chatcmpl-recovered",
			object: "chat.completion.chunk",
			created: 1,
			model: "deepseek-v4-flash",
			choices: [{
				index: 0,
				delta: { content: "Recovered response" },
				finish_reason: null
			}]
		});
		response.end("data: [DONE]\n\n");
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

async function withRecoveryThenProtocolRetryMockServer(run: (baseUrl: string, requests: RecordedRequest[]) => Promise<void>): Promise<void> {
	const requests: RecordedRequest[] = [];
	const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		const body: Record<string, unknown> = await readRequestBody(request);
		requests.push({ url: request.url ?? "", body });
		assert.equal(request.url, "/chat/completions");

		if (requests.length === 1 || requests.length === 3) {
			response.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Content-Length": "65536",
				"Connection": "close"
			});
			if (requests.length === 1) {
				writeSseChunk(response, {
					id: "chatcmpl-initial-interrupted",
					object: "chat.completion.chunk",
					created: 1,
					model: "deepseek-v4-flash",
					choices: [{
						index: 0,
						delta: { reasoning_content: "先检查请求状态。" },
						finish_reason: null
					}]
				});
			}
			await new Promise<void>((resolve): void => { setImmediate(resolve); });
			response.destroy(new Error("simulated stream interruption"));
			return;
		}

		response.writeHead(200, { "Content-Type": "text/event-stream" });
		if (requests.length === 2) {
			writeSseChunk(response, {
				id: "chatcmpl-thinking-only-after-recovery",
				object: "chat.completion.chunk",
				created: 1,
				model: "deepseek-v4-flash",
				choices: [{
					index: 0,
					delta: { reasoning_content: "恢复后重新判断工具调用。" },
					finish_reason: null
				}]
				});
		} else {
			writeSseChunk(response, {
				id: "chatcmpl-final-after-protocol-retry",
				object: "chat.completion.chunk",
				created: 1,
				model: "deepseek-v4-flash",
				choices: [{
					index: 0,
					delta: { content: "恢复链已完成。" },
					finish_reason: null
				}]
			});
		}
		response.end("data: [DONE]\n\n");
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

async function withMissingToolCallRetryMockServer(run: (baseUrl: string, requests: RecordedRequest[]) => Promise<void>, firstDelta: Record<string, unknown> = {
	reasoning_content: "我将调用 mcp_godot_read_text_file 读取文件。"
}): Promise<void> {
	const requests: RecordedRequest[] = [];
	const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		const body: Record<string, unknown> = await readRequestBody(request);
		requests.push({ url: request.url ?? "", body });
		assert.equal(request.url, "/chat/completions");

		response.writeHead(200, { "Content-Type": "text/event-stream" });
		if (requests.length === 1) {
			writeSseChunk(response, {
				id: "chatcmpl-thinking-only",
				object: "chat.completion.chunk",
				created: 1,
				model: "glm-5.2",
				choices: [{
					index: 0,
					delta: firstDelta,
					finish_reason: null
				}]
			});
			response.end("data: [DONE]\n\n");
			return;
		}

		if (requests.length === 2) {
			writeSseChunk(response, {
				id: "chatcmpl-tool-after-retry",
				object: "chat.completion.chunk",
				created: 1,
				model: "glm-5.2",
				choices: [{
					index: 0,
					delta: {
						tool_calls: [{
							index: 0,
							id: "call-read",
							type: "function",
							function: {
								name: "mcp_godot_read_text_file",
								arguments: "{\"relativePath\":\"tic_tac_toe_game.gd\"}"
							}
						}]
					},
					finish_reason: null
				}]
			});
			response.end("data: [DONE]\n\n");
			return;
		}

		writeSseChunk(response, {
			id: "chatcmpl-final",
			object: "chat.completion.chunk",
			created: 1,
			model: "glm-5.2",
			choices: [{
				index: 0,
				delta: {
					content: "读取完成。"
				},
				finish_reason: null
			}]
		});
		response.end("data: [DONE]\n\n");
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

async function withRepeatedMissingToolCallRetryMockServer(run: (baseUrl: string, requests: RecordedRequest[]) => Promise<void>): Promise<void> {
	const requests: RecordedRequest[] = [];
	const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		const body: Record<string, unknown> = await readRequestBody(request);
		requests.push({ url: request.url ?? "", body });
		assert.equal(request.url, "/chat/completions");

		response.writeHead(200, { "Content-Type": "text/event-stream" });
		if (requests.length <= 2) {
			writeSseChunk(response, {
				id: "chatcmpl-prelude-only",
				object: "chat.completion.chunk",
				created: 1,
				model: "glm-5.2",
				choices: [{
					index: 0,
					delta: {
						content: "我会调用 mcp_godot_read_text_file 读取文件。"
					},
					finish_reason: null
				}]
			});
			response.end("data: [DONE]\n\n");
			return;
		}

		if (requests.length === 3) {
			writeSseChunk(response, {
				id: "chatcmpl-tool-after-second-retry",
				object: "chat.completion.chunk",
				created: 1,
				model: "glm-5.2",
				choices: [{
					index: 0,
					delta: {
						tool_calls: [{
							index: 0,
							id: "call-read",
							type: "function",
							function: {
								name: "mcp_godot_read_text_file",
								arguments: "{\"relativePath\":\"tic_tac_toe_game.gd\"}"
							}
						}]
					},
					finish_reason: null
				}]
			});
			response.end("data: [DONE]\n\n");
			return;
		}

		writeSseChunk(response, {
			id: "chatcmpl-final",
			object: "chat.completion.chunk",
			created: 1,
			model: "glm-5.2",
			choices: [{
				index: 0,
				delta: {
					content: "读取完成。"
				},
				finish_reason: null
			}]
		});
		response.end("data: [DONE]\n\n");
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

async function withReasoningOnlyMockServer(run: (baseUrl: string, requests: RecordedRequest[]) => Promise<void>): Promise<void> {
	const requests: RecordedRequest[] = [];
	const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		const body: Record<string, unknown> = await readRequestBody(request);
		requests.push({ url: request.url ?? "", body });
		assert.equal(request.url, "/chat/completions");

		response.writeHead(200, { "Content-Type": "text/event-stream" });
		writeSseChunk(response, {
			id: "chatcmpl-thinking-only",
			object: "chat.completion.chunk",
			created: 1,
			model: "glm-5.2",
			choices: [{
				index: 0,
				delta: {
					reasoning_content: "我知道下一步应该调用工具，但这次响应没有真实工具调用。"
				},
				finish_reason: null
			}]
		});
		response.end("data: [DONE]\n\n");
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

async function withMiniMaxThinkTagMockServer(streaming: boolean, run: (baseUrl: string, requests: RecordedRequest[]) => Promise<void>, streamChunks: string[] = ["<thi", "nk>先分析一下", "</thi", "nk>最终答案。"]): Promise<void> {
	const requests: RecordedRequest[] = [];
	const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		const body: Record<string, unknown> = await readRequestBody(request);
		requests.push({ url: request.url ?? "", body });
		assert.equal(request.url, "/chat/completions");

		if (streaming) {
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			for (const content of streamChunks) {
				writeSseChunk(response, {
					id: "chatcmpl-minimax-thinking",
					object: "chat.completion.chunk",
					created: 1,
					model: "MiniMax-M3",
					choices: [{
						index: 0,
						delta: { content },
						finish_reason: null
					}]
				});
			}
			response.end("data: [DONE]\n\n");
			return;
		}

		response.writeHead(200, { "Content-Type": "application/json" });
		response.end(JSON.stringify({
			id: "chatcmpl-minimax-thinking",
			object: "chat.completion",
			created: 1,
			model: "MiniMax-M3",
			choices: [{
				index: 0,
				message: { role: "assistant", content: "<think>先分析一下</think>最终答案。" },
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

async function withApprovalToolCallMockServer(run: (baseUrl: string, requests: RecordedRequest[]) => Promise<void>): Promise<void> {
	const requests: RecordedRequest[] = [];
	const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		const body: Record<string, unknown> = await readRequestBody(request);
		requests.push({ url: request.url ?? "", body });
		assert.equal(request.url, "/chat/completions");

		response.writeHead(200, { "Content-Type": "application/json" });
		response.end(JSON.stringify({
			id: "chatcmpl-approval",
			object: "chat.completion",
			created: 1,
			model: "deepseek-chat",
			choices: [{
				index: 0,
				message: {
					role: "assistant",
					content: null,
					tool_calls: [{
						id: "call-write",
						type: "function",
						function: {
							name: "mcp_godot_create_text_file",
							arguments: JSON.stringify({
								relativePath: "approval-test.md",
								content: "hello",
								approvalReason: "Create a small file to test the approval UI."
							})
						}
					}]
				},
				finish_reason: "tool_calls"
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

async function withApprovalContinuationMockServer(run: (baseUrl: string, requests: RecordedRequest[]) => Promise<void>): Promise<void> {
	const requests: RecordedRequest[] = [];
	const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		const body: Record<string, unknown> = await readRequestBody(request);
		requests.push({ url: request.url ?? "", body });
		response.writeHead(200, { "Content-Type": "application/json" });
		response.end(JSON.stringify({
			id: `chatcmpl-approval-continuation-${requests.length}`,
			object: "chat.completion",
			created: 1,
			model: "deepseek-chat",
			choices: [{
				index: 0,
				message: requests.length === 1 ? {
					role: "assistant",
					content: null,
					tool_calls: [{
						id: "call-write",
						type: "function",
						function: {
							name: "mcp_godot_create_text_file",
							arguments: JSON.stringify({ relativePath: "approval-test.md", content: "hello" })
						}
					}]
				} : {
					role: "assistant",
					content: "Approved tool result is sufficient; the task is complete."
				},
				finish_reason: requests.length === 1 ? "tool_calls" : "stop"
			}]
		}));
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

test("DeepSeek V4 thinking models skip required tool_choice", (): void => {
	const tools: ChatCompletionTool[] = [{
		type: "function",
		function: {
			name: "mcp_godot_create_scene",
			description: "Create a scene",
			parameters: {
				type: "object",
				properties: {}
			}
		}
	}];
	assert.equal(shouldSkipRequiredToolChoice({
		provider: "deepseek",
		apiKey: "test-key",
		model: "deepseek-v4-pro"
	}), true);
	assert.equal(shouldDisableThinkingForToolCalls({
		provider: "deepseek",
		apiKey: "test-key",
		model: "deepseek-v4-pro"
	}, tools), true);
	assert.equal(shouldDisableThinkingForToolCalls({
		provider: "deepseek",
		apiKey: "test-key",
		model: "deepseek-v4-pro"
	}, []), false);
	assert.equal(shouldSkipRequiredToolChoice({
		provider: "deepseek",
		apiKey: "test-key",
		model: "deepseek-v4-flash"
	}), true);
	assert.equal(shouldSkipRequiredToolChoice({
		provider: "deepseek",
		apiKey: "test-key",
		model: "deepseek-chat"
	}), false);
	assert.equal(shouldSkipRequiredToolChoice({
		provider: "moonshot",
		apiKey: "test-key",
		model: "deepseek-v4-pro"
	}), true);
	assert.equal(shouldDisableThinkingForToolCalls({
		provider: "moonshot",
		apiKey: "test-key",
		model: "kimi-k2.7-code"
	}, tools), false);
	assert.equal(shouldSkipRequiredToolChoice({
		provider: "zhipu",
		apiKey: "test-key",
		model: "glm-5.2"
	}), false);
	assert.equal(resolveRequiredToolChoice({
		provider: "zhipu",
		apiKey: "test-key",
		model: "glm-5.2"
	}), "auto");
});

test("tool protocol correction prompt distinguishes tool and no-tool phases", (): void => {
	const toolPrompt: string = createToolProtocolCorrectionMessage(["mcp_godot_read_text_file"]);
	assert.match(toolPrompt, /tool_calls/);
	assert.match(toolPrompt, /mcp_godot_read_text_file/);
	assert.match(toolPrompt, /不要再输出 <tool>、<tools>/);
	assert.match(toolPrompt, /没有成功的工具结果时，不得声称已经查询/);

	const noToolPrompt: string = createToolProtocolCorrectionMessage([]);
	assert.match(noToolPrompt, /当前阶段没有可用工具/);
	assert.match(noToolPrompt, /自然语言结果/);

	const missingToolCallPrompt: string = createMissingRequiredToolCallCorrectionMessage(["mcp_godot_read_text_file"]);
	assert.match(missingToolCallPrompt, /没有通过 API tool_calls 调用工具/);
	assert.match(missingToolCallPrompt, /thinking\/reasoning_content/);
	assert.match(missingToolCallPrompt, /mcp_godot_read_text_file/);
	assert.match(missingToolCallPrompt, /不要输出 <tool>、<tools>/);
	assert.match(missingToolCallPrompt, /在收到成功的工具结果前/);

	const visibleTextMissingToolCallPrompt: string = createMissingRequiredToolCallCorrectionMessage(["mcp_godot_read_text_file"], true);
	assert.match(visibleTextMissingToolCallPrompt, /输出了正文/);
	assert.match(visibleTextMissingToolCallPrompt, /正文、thinking\/reasoning_content/);
});

test("MiniMax streaming agent extracts think tags into thinking events", async (): Promise<void> => {
	await withMiniMaxThinkTagMockServer(true, async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
		const deltas: string[] = [];
		const thinking: string[] = [];
		let thinkingDoneCount: number = 0;
		const result = await runOpenAICompatibleAgentStreaming(
			{ message: "回答一下", options: { stream: true } },
			{ provider: "minimax", apiKey: "test-key", baseUrl, model: "MiniMax-M3" },
			[],
			"System prompt",
			createMockMcpHost(),
			new ApprovalGateway(),
			[],
			(event): void => {
				if (event.type === "ai.delta") {
					deltas.push(event.text);
				}
				if (event.type === "ai.thinking.delta") {
					thinking.push(event.text);
				}
				if (event.type === "ai.thinking.done") {
					thinkingDoneCount += 1;
				}
			}
		);

		assert.equal(result.status, "completed");
		assert.equal(result.text, "最终答案。");
		assert.deepEqual(deltas, ["最终答案。"]);
		assert.deepEqual(thinking, ["先分析一下"]);
		assert.equal(thinkingDoneCount, 1);
		assert.equal(requests.length, 1);
	});
});

test("MiniMax streaming agent opens thinking when think tag arrives before text", async (): Promise<void> => {
	await withMiniMaxThinkTagMockServer(true, async (baseUrl: string): Promise<void> => {
		const thinking: string[] = [];
		let thinkingDoneCount: number = 0;
		const result = await runOpenAICompatibleAgentStreaming(
			{ message: "回答一下", options: { stream: true } },
			{ provider: "minimax", apiKey: "test-key", baseUrl, model: "MiniMax-M3" },
			[],
			"System prompt",
			createMockMcpHost(),
			new ApprovalGateway(),
			[],
			(event): void => {
				if (event.type === "ai.thinking.delta") {
					thinking.push(event.text);
				}
				if (event.type === "ai.thinking.done") {
					thinkingDoneCount += 1;
				}
			}
		);

		assert.equal(result.status, "completed");
		assert.equal(result.text, "最终答案。");
		assert.deepEqual(thinking, ["", "先分析一下"]);
		assert.equal(thinkingDoneCount, 1);
	}, ["<", "think", ">", "先分析一下", "</", "think", ">", "最终答案。"]);
});

test("MiniMax non-streaming agent strips think tags from visible text", async (): Promise<void> => {
	await withMiniMaxThinkTagMockServer(false, async (baseUrl: string): Promise<void> => {
		const thinking: string[] = [];
		let thinkingDoneCount: number = 0;
		const result = await runOpenAICompatibleAgent(
			{ message: "回答一下" },
			{ provider: "minimax", apiKey: "test-key", baseUrl, model: "MiniMax-M3" },
			[],
			"System prompt",
			createMockMcpHost(),
			new ApprovalGateway(),
			[],
			(event): void => {
				if (event.type === "ai.thinking.delta") {
					thinking.push(event.text);
				}
				if (event.type === "ai.thinking.done") {
					thinkingDoneCount += 1;
				}
			}
		);

		assert.equal(result.status, "completed");
		assert.equal(result.text, "最终答案。");
		assert.deepEqual(thinking, ["先分析一下"]);
		assert.equal(thinkingDoneCount, 1);
	});
});

test("agent uses model-provided approval reason and strips it from pending args", async (): Promise<void> => {
	await withApprovalToolCallMockServer(async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
		const gateway = new ApprovalGateway();
		const approvalEvents: Record<string, unknown>[] = [];
		const result = await runOpenAICompatibleAgent(
			{ message: "create a test file" },
			{ provider: "deepseek", apiKey: "test-key", baseUrl, model: "deepseek-chat" },
			[],
			"System prompt",
			createMockMcpHost(),
			gateway,
			["mcp_godot_create_text_file"],
			(event): void => {
				if (event.type === "tool.approval_required") {
					approvalEvents.push(event);
				}
			}
		);

		assert.equal(result.status, "approval_required");
		assert.equal(result.reason, "Create a small file to test the approval UI.");
		assert.equal(requests.length, 1);
		const pending = gateway.listPending()[0];
		assert.notEqual(pending, undefined);
		assert.equal(pending?.reason, "Create a small file to test the approval UI.");
		assert.deepEqual(pending?.args, {
			relativePath: "approval-test.md",
			content: "hello"
		});
		assert.equal(approvalEvents.length, 1);
		assert.equal(approvalEvents[0]?.reason, "Create a small file to test the approval UI.");
		assert.deepEqual(approvalEvents[0]?.args, {
			relativePath: "approval-test.md",
			content: "hello"
		});
	});
});

test("streaming agent finalizes when tool follow-up only returns reasoning content", async (): Promise<void> => {
	await withStreamingAgentMockServer(async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
		const events: string[] = [];
		const params: AiChatParams = {
			message: "解读一下 tic_tac_toe_game.gd",
			options: {
				stream: true
			}
		};
		(params.options as Record<string, unknown>).requireToolCallOnFirstStep = true;

		const result = await runOpenAICompatibleAgentStreaming(
			params,
			{ provider: "zhipu", apiKey: "test-key", baseUrl, model: "glm-5.2" },
			[],
			"System prompt",
			createMockMcpHost(),
			new ApprovalGateway(),
			["mcp_godot_read_text_file"],
			(event): void => {
				if (event.type === "ai.delta") {
					events.push(event.text);
				}
			}
		);

		assert.equal(result.status, "completed");
		assert.equal(result.text, "tic_tac_toe_game.gd 的逻辑入口是 reset_game。");
		assert.deepEqual(events, ["tic_tac_toe_game.gd 的逻辑入口是 reset_game。"]);
		assert.equal(requests.length, 3);
		assert.equal(requests[0]?.body.stream, true);
		assert.equal(requests[1]?.body.stream, true);
		assert.equal(requests[2]?.body.stream, undefined);
		assert.match(JSON.stringify(requests[2]?.body.messages), /只返回了 thinking\/reasoning_content/);
	});
});

test("streaming agent announces a tool before dispatching it", async (): Promise<void> => {
	await withStreamingAgentMockServer(async (baseUrl: string): Promise<void> => {
		const events: string[] = [];
		const result = await runOpenAICompatibleAgentStreaming(
			{ message: "Read the file", options: { stream: true } },
			{ provider: "zhipu", apiKey: "test-key", baseUrl, model: "glm-5.2" },
			[],
			"System prompt",
			createMockMcpHost(),
			new ApprovalGateway(),
			["mcp_godot_read_text_file"],
			(event): void => {
				events.push(event.type);
			}
		);

		assert.equal(result.status, "completed");
		const preparingIndex: number = events.indexOf("tool.preparing");
		const callIndex: number = events.indexOf("tool.call");
		assert.ok(preparingIndex >= 0);
		assert.ok(callIndex > preparingIndex);
	});
});

test("streaming agent safely retries an interrupted reasoning-only response", async (): Promise<void> => {
	await withInterruptedStreamingMockServer(async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
		const visibleDeltas: string[] = [];
		const thinkingDeltas: string[] = [];
		const result = await runOpenAICompatibleAgentStreaming(
			{ message: "Inspect the project", options: { stream: true } },
			{ provider: "deepseek", apiKey: "test-key", baseUrl, model: "deepseek-v4-flash" },
			[],
			"System prompt",
			createMockMcpHost(),
			new ApprovalGateway(),
			["mcp_godot_read_text_file"],
			(event): void => {
				if (event.type === "ai.delta") visibleDeltas.push(event.text);
				if (event.type === "ai.thinking.delta") thinkingDeltas.push(event.text);
			}
		);

		assert.equal(result.status, "completed");
		assert.equal(result.text, "Recovered response");
		assert.deepEqual(visibleDeltas, ["Recovered response"]);
		assert.deepEqual(thinkingDeltas, ["Inspecting the project before editing."]);
		assert.equal(requests.length, 2);
	});
});

test("recovery followed by protocol correction keeps one reconnect chain", async (): Promise<void> => {
	await withRecoveryThenProtocolRetryMockServer(async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
		const reconnects: Array<Extract<ToolEvent, { type: "provider.reconnect" }>> = [];
		const result = await runOpenAICompatibleAgentStreaming(
			{ message: "Inspect the project", options: { stream: true } },
			{ provider: "deepseek", apiKey: "test-key", baseUrl, model: "deepseek-v4-flash" },
			[],
			"System prompt",
			createMockMcpHost(),
			new ApprovalGateway(),
			["mcp_godot_read_text_file"],
			(event): void => {
				if (event.type === "provider.reconnect") reconnects.push(event);
			}
		);

		assert.equal(result.status, "completed");
		assert.equal(result.text, "恢复链已完成。");
		assert.equal(requests.length, 4);
		assert.ok(reconnects.length > 0);
		assert.equal(new Set(reconnects.map((event): string => event.reconnectId)).size, 1);
		assert.ok(reconnects.every((event): boolean => event.attempt <= event.maxAttempts));
		assert.ok(reconnects.every((event: Extract<ToolEvent, { type: "provider.reconnect" }>, index: number): boolean => (
			index === 0 || event.revision > reconnects[index - 1]!.revision
		)));
	});
});

test("streaming agent reports protocol violation when first response only returns reasoning content", async (): Promise<void> => {
	await withReasoningOnlyMockServer(async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
		const params: AiChatParams = {
			message: "读取项目结构",
			options: {
				stream: true
			}
		};

		const result = await runOpenAICompatibleAgentStreaming(
			params,
			{ provider: "zhipu", apiKey: "test-key", baseUrl, model: "glm-5.2" },
			[],
			"System prompt",
			createMockMcpHost(),
			new ApprovalGateway(),
			["mcp_godot_get_project_summary"]
		);

		assert.equal(result.status, "protocol_violation");
		assert.match(result.reason, /thinking\/reasoning_content/);
		assert.equal(requests.length, 3);
		assert.match(JSON.stringify(requests[1]?.body.messages), /二选一/);
	});
});

test("streaming agent retries when required first tool call returns only reasoning", async (): Promise<void> => {
	await withMissingToolCallRetryMockServer(async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
		const params: AiChatParams = {
			message: "读取 tic_tac_toe_game.gd",
			options: {
				stream: true
			}
		};
		(params.options as Record<string, unknown>).requireToolCallOnFirstStep = true;

		const result = await runOpenAICompatibleAgentStreaming(
			params,
			{ provider: "zhipu", apiKey: "test-key", baseUrl, model: "glm-5.2" },
			[],
			"System prompt",
			createMockMcpHost(),
			new ApprovalGateway(),
			["mcp_godot_read_text_file"]
		);

		assert.equal(result.status, "completed");
		assert.equal(result.text, "读取完成。");
		assert.equal(requests.length, 3);
		assert.match(JSON.stringify(requests[1]?.body.messages), /没有通过 API tool_calls 调用工具/);
	});
});

test("streaming agent retries when required first tool call returns only prelude text", async (): Promise<void> => {
	await withMissingToolCallRetryMockServer(async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
		const events: string[] = [];
		const params: AiChatParams = {
			message: "验证脚本语法",
			options: {
				stream: true
			}
		};
		(params.options as Record<string, unknown>).requireToolCallOnFirstStep = true;

		const result = await runOpenAICompatibleAgentStreaming(
			params,
			{ provider: "zhipu", apiKey: "test-key", baseUrl, model: "glm-5.2" },
			[],
			"System prompt",
			createMockMcpHost(),
			new ApprovalGateway(),
			["mcp_godot_read_text_file"],
			(event): void => {
				if (event.type === "ai.delta") {
					events.push(event.text);
				}
			}
		);

		assert.equal(result.status, "completed");
		assert.equal(result.text, "读取完成。");
		assert.deepEqual(events, ["读取完成。"]);
		assert.equal(requests.length, 3);
		assert.match(JSON.stringify(requests[1]?.body.messages), /当前阶段要求先调用工具/);
		assert.match(JSON.stringify(requests[1]?.body.messages), /输出了正文/);
	}, {
		content: "先确认 Godot 版本，同时运行语法检查。"
	});
});

test("approved continuation does not require a second first-step tool call", async (): Promise<void> => {
	await withApprovalContinuationMockServer(async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
		const params: AiChatParams = {
			message: "Create and verify a small file",
			options: { requireToolCallOnFirstStep: true } as AiChatParams["options"] & Record<string, unknown>
		};
		const gateway = new ApprovalGateway();
		const initial = await runOpenAICompatibleAgent(
			params,
			{ provider: "deepseek", apiKey: "test-key", baseUrl, model: "deepseek-chat" },
			[],
			"System prompt",
			createMockMcpHost(),
			gateway,
			["mcp_godot_create_text_file"]
		);
		assert.equal(initial.status, "approval_required");
		if (initial.status !== "approval_required") return;
		const continued = await continueOpenAICompatibleAgent(
			params,
			{ provider: "deepseek", apiKey: "test-key", baseUrl, model: "deepseek-chat" },
			initial.continuation as OpenAICompatibleAgentContinuation,
			{ toolCallId: "call-write", content: JSON.stringify({ ok: true, validationStatus: "passed" }) },
			createMockMcpHost(),
			gateway,
			["mcp_godot_create_text_file"]
		);
		assert.equal(continued.status, "completed");
		assert.equal(continued.status === "completed" ? continued.text : "", "Approved tool result is sufficient; the task is complete.");
		assert.equal(requests.length, 2);
	});
});

test("streaming agent suppresses DeepSeek tools wrappers and retries with API tool calls", async (): Promise<void> => {
	await withMissingToolCallRetryMockServer(async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
		const events: string[] = [];
		const result = await runOpenAICompatibleAgentStreaming(
			{
				message: "Read the attached text.",
				options: { stream: true }
			},
			{ provider: "zhipu", apiKey: "test-key", baseUrl, model: "glm-5.2" },
			[],
			"System prompt",
			createMockMcpHost(),
			new ApprovalGateway(),
			["mcp_godot_read_text_file"],
			(event): void => {
				if (event.type === "ai.delta") {
					events.push(event.text);
				}
			}
		);

		assert.equal(result.status, "completed");
		assert.equal(result.text, "读取完成。");
		assert.equal(requests.length, 3);
		assert.match(JSON.stringify(requests[1]?.body.messages), /tool_calls/);
		assert.doesNotMatch(events.join(""), /<\/?tool(?:s|_calls?)?(?:\s|>)/);
	}, {
		content: [
			"I will inspect the available tools.",
			"",
			"<tools>",
			"<mcp_godot_read_text_file>",
			"<relativePath>tic_tac_toe_game.gd</relativePath>",
			"</mcp_godot_read_text_file>",
			"</tools>"
		].join("\n")
	});
});

test("streaming agent tolerates two required tool-call prelude retries", async (): Promise<void> => {
	await withRepeatedMissingToolCallRetryMockServer(async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
		const params: AiChatParams = {
			message: "验证脚本语法",
			options: {
				stream: true
			}
		};
		(params.options as Record<string, unknown>).requireToolCallOnFirstStep = true;

		const result = await runOpenAICompatibleAgentStreaming(
			params,
			{ provider: "zhipu", apiKey: "test-key", baseUrl, model: "glm-5.2" },
			[],
			"System prompt",
			createMockMcpHost(),
			new ApprovalGateway(),
			["mcp_godot_read_text_file"]
		);

		assert.equal(result.status, "completed");
		assert.equal(result.text, "读取完成。");
		assert.equal(requests.length, 4);
		assert.match(JSON.stringify(requests[1]?.body.messages), /当前阶段要求先调用工具/);
		assert.match(JSON.stringify(requests[2]?.body.messages), /当前阶段要求先调用工具/);
	});
});
