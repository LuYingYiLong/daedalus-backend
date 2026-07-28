import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChatCompletionCreateParamsBase } from "openai/resources/chat/completions";
import { installReadOnlySecretStore, resetSecretStoreDriver } from "../../helpers/secret-store.js";
import type { AiChatParams } from "../../../src/protocol/types.js";
import { applyChatOptions } from "../../../src/providers/provider-chat-completions-client.js";
import { listProviderModels } from "../../../src/providers/provider-models.js";
import { saveProviderConfig } from "../../../src/providers/provider-config-store.js";

type RecordedRequest = {
	url: string;
	authorization: string | undefined;
	body: Record<string, unknown>;
};

async function readRequestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	let text: string = "";
	for await (const chunk of request) {
		text += String(chunk);
	}
	return text.length === 0 ? {} : JSON.parse(text) as Record<string, unknown>;
}

async function withTempAppData(run: () => Promise<void>): Promise<void> {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const appDataDir: string = await mkdtemp(join(tmpdir(), "daedalus-mimo-provider-"));
	process.env.USERPROFILE = appDataDir;
	try {
		await run();
	} finally {
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		resetSecretStoreDriver();
		await rm(appDataDir, { recursive: true, force: true });
	}
}

test("MiMo maps maxTokens to max_completion_tokens", (): void => {
	const requestBody: ChatCompletionCreateParamsBase = {
		model: "mimo-v2.5-pro",
		messages: [{ role: "user", content: "hello" }]
	};
	const params = {
		message: "hello",
		options: { maxTokens: 4096 }
	} as AiChatParams;

	applyChatOptions(requestBody, params, {
		provider: "mimo",
		apiKey: "mimo-test-key",
		model: "mimo-v2.5-pro"
	});

	const raw: Record<string, unknown> = requestBody as unknown as Record<string, unknown>;
	assert.equal(raw.max_completion_tokens, 4096);
	assert.equal(raw.max_tokens, undefined);
});

test("MiMo model refresh excludes speech models and web search normalizes citations", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		const requests: RecordedRequest[] = [];
		let searchAttempts: number = 0;
		const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
			if (request.url === "/models") {
				assert.equal(request.headers.authorization, "Bearer mimo-test-key");
				response.writeHead(200, { "Content-Type": "application/json" });
				response.end(JSON.stringify({
					object: "list",
					data: [
						{ id: "mimo-v2.5-pro", object: "model", owned_by: "xiaomi" },
						{ id: "mimo-v2.5", object: "model", owned_by: "xiaomi" },
						{ id: "mimo-v2.5-asr", object: "model", owned_by: "xiaomi" }
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
			searchAttempts += 1;
			if (searchAttempts === 1) {
				response.writeHead(429, { "Content-Type": "application/json", "Retry-After": "0" });
				response.end(JSON.stringify({ error: { message: "rate limited" } }));
				return;
			}
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({
				id: "mimo-search",
				object: "chat.completion",
				model: "mimo-v2.5-pro",
				choices: [{
					index: 0,
					finish_reason: "stop",
					message: {
						role: "assistant",
						content: "Current answer.",
						annotations: [
							{
								type: "url_citation",
								url: "https://example.com/current",
								title: "Official source",
								summary: "Current source summary",
								site_name: "Example",
								publish_time: "2026-07-28T00:00:00+08:00"
							},
							{
								type: "url_citation",
								url: "https://example.com/current",
								title: "Duplicate source"
							}
						]
					}
				}]
			}));
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		if (address === null || typeof address === "string") {
			throw new Error("Mock server did not expose a TCP port");
		}
		const baseUrl: string = `http://127.0.0.1:${address.port}`;

		try {
			installReadOnlySecretStore(async (_service: string, account: string): Promise<string | null> => {
				return account === "provider:mimo:api_key" ? "mimo-test-key" : null;
			});
			await saveProviderConfig({
				provider: "mimo",
				apiKey: "mimo-test-key",
				baseUrl,
				model: "mimo-v2.5-pro"
			});
			const models = await listProviderModels("mimo", "mimo-test-key", baseUrl, true);
			assert.deepEqual(models.models.map((model) => model.id), ["mimo-v2.5-pro", "mimo-v2.5"]);

			const settings = await import(`../../../src/web-search-settings-store.js?case=${Date.now()}-${Math.random()}`);
			await settings.updateWebSearchSettings({
				enabled: true,
				provider: "mimo",
				model: "mimo-v2.5-pro",
				maxResults: 5,
				maxKeywords: 3
			});
			const { executeWebSearch } = await import(`../../../src/providers/web-search.js?case=${Date.now()}-${Math.random()}`);
			const result = await executeWebSearch({ query: "current release" });

			assert.equal(searchAttempts, 2);
			assert.equal(requests[0]?.url, "/chat/completions");
			assert.equal(requests[0]?.authorization, "Bearer mimo-test-key");
			assert.deepEqual(requests[0]?.body.thinking, { type: "disabled" });
			assert.equal(requests[0]?.body.max_completion_tokens, 4096);
			const tools = requests[0]?.body.tools as Array<Record<string, unknown>>;
			assert.equal(tools[0]?.type, "web_search");
			assert.equal(tools[0]?.max_keyword, 3);
			assert.equal(tools[0]?.force_search, true);
			assert.equal(tools[0]?.limit, 2);
			assert.equal(result.answer, "Current answer.");
			assert.deepEqual(result.results, [{
				title: "Official source",
				url: "https://example.com/current",
				summary: "Current source summary",
				source: "Example",
				publishedAt: "2026-07-28T00:00:00+08:00"
			}]);
		} finally {
			server.close();
			await once(server, "close");
		}
	});
});
