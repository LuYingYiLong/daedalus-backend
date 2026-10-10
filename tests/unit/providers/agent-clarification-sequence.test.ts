import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import type { McpHost } from "../../../src/mcp/mcp-host.js";
import { runAnthropicCompatibleAgent } from "../../../src/providers/anthropic-compatible-agent.js";
import { runOpenAICompatibleAgent } from "../../../src/providers/openai-compatible-agent.js";
import { runOpenAIResponsesAgent } from "../../../src/providers/openai-responses-agent.js";
import { ApprovalGateway } from "../../../src/tools/approval-gateway.js";
import type { ToolExecutionContext } from "../../../src/tools/tool-catalog.js";

type Protocol = "chat" | "responses" | "anthropic";

async function withMockProvider(protocol: Protocol, run: (baseUrl: string, requests: Record<string, unknown>[]) => Promise<void>): Promise<void> {
	const requests: Record<string, unknown>[] = [];
	const server = createServer(async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		let body = "";
		for await (const chunk of request) body += String(chunk);
		requests.push(JSON.parse(body) as Record<string, unknown>);
		assert.equal(request.url, protocol === "chat" ? "/chat/completions" : protocol === "responses" ? "/responses" : "/messages");
		const text = requests.length === 1 ? "Independent work completed." : "Clarification applied.";
		response.writeHead(200, { "Content-Type": "application/json" });
		if (protocol === "chat") {
			response.end(JSON.stringify({ id: `chat-${requests.length}`, object: "chat.completion", created: 1, model: "deepseek-chat", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] }));
		} else if (protocol === "responses") {
			response.end(JSON.stringify({ id: `response-${requests.length}`, object: "response", created_at: 1, model: "gpt-5.6-sol", output_text: text, output: [{ type: "message", id: `message-${requests.length}`, status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }] }));
		} else {
			response.end(JSON.stringify({ id: `message-${requests.length}`, type: "message", role: "assistant", model: "minimax-m3", content: [{ type: "text", text }], stop_reason: "end_turn" }));
		}
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Mock server has no TCP port");
	try {
		await run(`http://127.0.0.1:${address.port}`, requests);
	} finally {
		server.close();
		await once(server, "close");
	}
}

for (const protocol of ["chat", "responses", "anthropic"] as const) {
	test(`${protocol} keeps the assistant turn before a mid-response user clarification`, async (): Promise<void> => {
		await withMockProvider(protocol, async (baseUrl, requests): Promise<void> => {
			let takeCount = 0;
			let commitCount = 0;
			const toolContext: ToolExecutionContext = {
				agentClarification: {
					async execute(): Promise<{ questionId: string; status: "pending" }> { throw new Error("Unexpected tool call"); },
					async takeAnswers(): Promise<Array<{ questionId: string; question: string; answer: string }>> {
						takeCount += 1;
						return takeCount === 2 ? [{ questionId: "question-1", question: "Which API?", answer: "Keep the existing API" }] : [];
					},
					async commitAnswers(): Promise<void> { commitCount += 1; }
				}
			};
			const host = {} as McpHost;
			const gateway = new ApprovalGateway();
			const result = protocol === "chat"
				? await runOpenAICompatibleAgent({ message: "Continue working" }, { provider: "deepseek", apiKey: "test", baseUrl, model: "deepseek-chat" }, [], "System prompt", host, gateway, [], undefined, undefined, undefined, toolContext)
				: protocol === "responses"
					? await runOpenAIResponsesAgent({ message: "Continue working" }, { provider: "openai", apiKey: "test", baseUrl, model: "gpt-5.6-sol" }, [], "System prompt", host, gateway, [], undefined, undefined, undefined, toolContext)
					: await runAnthropicCompatibleAgent({ message: "Continue working" }, { provider: "opencode_go", apiKey: "test", baseUrl, model: "minimax-m3", endpointType: "anthropic-messages" }, [], "System prompt", host, gateway, [], undefined, undefined, undefined, toolContext);
			assert.equal(result.status, "completed");
			assert.equal(result.text, "Clarification applied.");
			assert.equal(requests.length, 2);
			assert.equal(commitCount, 2);
			const messages = protocol === "chat" ? requests[1]!.messages : protocol === "responses" ? requests[1]!.input : requests[1]!.messages;
			const serialized = JSON.stringify(messages);
			assert.ok(serialized.indexOf("Independent work completed.") >= 0);
			assert.ok(serialized.indexOf("Keep the existing API") > serialized.indexOf("Independent work completed."));
		});
	});
}
