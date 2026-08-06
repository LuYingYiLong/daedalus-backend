import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import test from "node:test";
import {
	createFallbackSessionTitle,
	generateSessionTitle,
	isFirstSessionUserTurn,
	normalizeGeneratedSessionTitle,
	shouldApplyGeneratedSessionTitle
} from "../../../src/server/session-title.js";
import type { ChatMessage } from "../../../src/protocol/types.js";
import type { ProviderChatOptions } from "../../../src/providers/provider-types.js";

type RecordedRequest = {
	body: Record<string, unknown>;
};

async function readRequestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	let text: string = "";
	for await (const chunk of request) {
		text += String(chunk);
	}
	return JSON.parse(text) as Record<string, unknown>;
}

async function withSessionTitleMockServer(run: (baseUrl: string, requests: RecordedRequest[]) => Promise<void>): Promise<void> {
	const requests: RecordedRequest[] = [];
	const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		assert.equal(request.url, "/chat/completions");
		const body: Record<string, unknown> = await readRequestBody(request);
		requests.push({ body });

		response.writeHead(200, { "Content-Type": "application/json" });
		if (requests.length === 1) {
			response.end(JSON.stringify({
				id: "chatcmpl-title-empty",
				object: "chat.completion",
				created: 1,
				model: "deepseek-v4-flash",
				choices: [{
					index: 0,
					message: {
						role: "assistant",
						reasoning_content: "先提炼用户目标，但输出预算已耗尽。",
						content: ""
					},
					finish_reason: "length"
				}]
			}));
			return;
		}

		response.end(JSON.stringify({
			id: "chatcmpl-title-success",
			object: "chat.completion",
			created: 1,
			model: "deepseek-v4-flash",
			choices: [{
				index: 0,
				message: {
					role: "assistant",
					content: "本地井字棋"
				},
				finish_reason: "stop"
			}]
		}));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (typeof address !== "object" || address === null) {
		throw new Error("Mock server did not expose a TCP address.");
	}
	try {
		await run(`http://127.0.0.1:${address.port}`, requests);
	} finally {
		server.close();
		await once(server, "close");
	}
}

test("fallback session title is language-neutral and based on user message", (): void => {
	assert.equal(createFallbackSessionTitle("/skill   修复 Godot 启动流程"), "修复 Godot 启动流程");
	assert.equal(createFallbackSessionTitle("abcdefghijklmnopqrstuvwxyz0123456789"), "abcdefghijklmnopqrstuvwxyz01");
	assert.equal(createFallbackSessionTitle(""), "Untitled");
});

test("auto title applies only when title has not changed since scheduling", (): void => {
	assert.equal(shouldApplyGeneratedSessionTitle("Any localized placeholder", "Any localized placeholder"), true);
	assert.equal(shouldApplyGeneratedSessionTitle("任意语言的临时标题", "任意语言的临时标题"), true);
	assert.equal(shouldApplyGeneratedSessionTitle("Temporary", "User renamed"), false);
});

test("generated title is cleaned and clipped", (): void => {
	assert.equal(normalizeGeneratedSessionTitle("\"标题：修复后端启动失败。\""), "修复后端启动失败");
	const clipped: string = normalizeGeneratedSessionTitle("abcdefghijklmnopqrstuvwxyz0123456789");
	assert.equal(clipped, "abcdefghijklmnopqrstuvwxyz01");
	assert.equal(clipped.length, 28);
});

test("title generation retries after an empty response with reasoning disabled", async (): Promise<void> => {
	await withSessionTitleMockServer(async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
		const options: ProviderChatOptions = {
			provider: "deepseek",
			apiKey: "test-key",
			baseUrl,
			model: "deepseek-v4-flash"
		};

		const title: string = await generateSessionTitle("帮我写一个本地井字棋", options);

		assert.equal(title, "本地井字棋");
		assert.equal(requests.length, 2);
		assert.equal(requests[0]?.body.max_tokens, 40);
		assert.equal(requests[1]?.body.max_tokens, 64);
		assert.deepEqual(requests[0]?.body.thinking, { type: "disabled" });
		assert.deepEqual(requests[1]?.body.thinking, { type: "disabled" });
		assert.match(JSON.stringify(requests[1]?.body.messages), /直接输出标题/);
	});
});

test("first-turn detection ignores a user message pre-persisted for the current request", (): void => {
	const currentRequestMessage: ChatMessage = {
		role: "user",
		content: "创建一个井字棋",
		requestId: "request-current"
	};

	assert.equal(isFirstSessionUserTurn([], "request-current"), true);
	assert.equal(isFirstSessionUserTurn([currentRequestMessage], "request-current"), true);
	assert.equal(isFirstSessionUserTurn([
		currentRequestMessage,
		{ role: "user", content: "上一轮消息", requestId: "request-previous" }
	], "request-current"), false);
});

test("title generation is scheduled before plan and agent execution branch", async (): Promise<void> => {
	const source: string = await import("node:fs/promises").then(({ readFile }) => (
		readFile(new URL("../../../src/server/chat-orchestrator.ts", import.meta.url), "utf8")
	));
	const scheduleIndex: number = source.indexOf("maybeScheduleSessionTitleGeneration(socket, request.id");
	const planBranchIndex: number = source.indexOf('if (effectiveParams.mode === "plan")');
	const userPersistenceIndex: number = source.indexOf("await appendUserMessageToSession(", scheduleIndex);

	assert.ok(scheduleIndex >= 0);
	assert.ok(planBranchIndex > scheduleIndex);
	assert.ok(userPersistenceIndex > scheduleIndex);
});
