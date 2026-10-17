import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installReadOnlySecretStore, resetSecretStoreDriver } from "../../helpers/secret-store.js";
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
	const appDataDir: string = await mkdtemp(join(tmpdir(), "daedalus-deepseek-provider-"));
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

async function listenOnRandomPort(server: Server): Promise<string> {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("Mock server did not expose a TCP port");
	}
	return `http://127.0.0.1:${address.port}`;
}

async function configureDeepSeekWebSearch(baseUrl: string, maxResults: number): Promise<void> {
	installReadOnlySecretStore(async (_service: string, account: string): Promise<string | null> => {
		return account === "provider:deepseek:api_key" ? "deepseek-test-key" : null;
	});
	await saveProviderConfig({
		provider: "deepseek",
		apiKey: "deepseek-test-key",
		baseUrl,
		model: "deepseek-flash"
	});
	const settings = await import(`../../../src/web-search-settings-store.js?case=${Date.now()}-${Math.random()}`);
	await settings.updateWebSearchSettings({
		enabled: true,
		provider: "deepseek",
		model: "deepseek-flash",
		maxResults
	});
}

test("DeepSeek web search posts to tools/search, retries 504 and normalizes results", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		const requests: RecordedRequest[] = [];
		let searchAttempts: number = 0;
		const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
			const body: Record<string, unknown> = await readRequestBody(request);
			requests.push({
				url: request.url ?? "",
				authorization: request.headers.authorization,
				body
			});
			searchAttempts += 1;
			if (searchAttempts === 1) {
				response.writeHead(504, { "Content-Type": "application/json" });
				response.end(JSON.stringify({
					error: { message: "downstream timeout", type: "server_error", param: null, code: "server_error" }
				}));
				return;
			}
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({
				results: [
					{
						rerank_score: 2.4,
						title: "DeepSeek V4 模型发布",
						url: "https://example.com/deepseek-v4",
						snippet: "短摘要",
						summary: "长摘要：DeepSeek 发布了 V4 模型。",
						content: "",
						site_name: "Example News",
						date: "2026-06-01T00:00:00+00:00"
					},
					{
						title: "重复结果",
						url: "https://example.com/deepseek-v4",
						summary: "重复",
						date: null
					}
				]
			}));
		});
		const baseUrl: string = await listenOnRandomPort(server);

		try {
			await configureDeepSeekWebSearch(baseUrl, 3);
			const { executeWebSearch } = await import(`../../../src/providers/web-search.js?case=${Date.now()}-${Math.random()}`);
			const result = await executeWebSearch({ query: "DeepSeek V4 发布" });

			assert.equal(searchAttempts, 2);
			assert.equal(requests[0]?.url, "/v1/tools/search");
			assert.equal(requests[0]?.authorization, "Bearer deepseek-test-key");
			assert.equal(requests[0]?.body.query, "DeepSeek V4 发布");
			assert.equal(requests[0]?.body.count, 3);
			assert.equal(requests[0]?.body.need_content, false);
			assert.equal(result.type, "web_search");
			assert.equal(result.provider, "deepseek");
			assert.equal(result.model, "deepseek-flash");
			assert.equal(result.answer, "Web search returned 1 result.");
			assert.deepEqual(result.results, [{
				title: "DeepSeek V4 模型发布",
				url: "https://example.com/deepseek-v4",
				summary: "长摘要：DeepSeek 发布了 V4 模型。",
				source: "Example News",
				publishedAt: "2026-06-01T00:00:00+00:00"
			}]);
		} finally {
			server.close();
			await once(server, "close");
		}
	});
});

test("DeepSeek web search does not duplicate /v1 in configured base URLs", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		const requests: RecordedRequest[] = [];
		const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
			requests.push({
				url: request.url ?? "",
				authorization: request.headers.authorization,
				body: await readRequestBody(request)
			});
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ results: [] }));
		});
		const baseUrl: string = await listenOnRandomPort(server);

		try {
			await configureDeepSeekWebSearch(`${baseUrl}/v1`, 100);
			const { executeWebSearch } = await import(`../../../src/providers/web-search.js?case=${Date.now()}-${Math.random()}`);
			const result = await executeWebSearch({ query: "DeepSeek 定价" });

			assert.equal(requests[0]?.url, "/v1/tools/search");
			// maxResults 100 超出该端点的 count 上限，必须被夹到 50。
			assert.equal(requests[0]?.body.count, 50);
			assert.equal(result.answer, "Web search returned 0 results.");
			assert.deepEqual(result.results, []);
		} finally {
			server.close();
			await once(server, "close");
		}
	});
});

test("DeepSeek web search clamps query and ori_question and omits a missing reason", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		const requests: RecordedRequest[] = [];
		const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
			requests.push({
				url: request.url ?? "",
				authorization: request.headers.authorization,
				body: await readRequestBody(request)
			});
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ results: [] }));
		});
		const baseUrl: string = await listenOnRandomPort(server);

		try {
			await configureDeepSeekWebSearch(baseUrl, 2);
			const { executeWebSearch } = await import(`../../../src/providers/web-search.js?case=${Date.now()}-${Math.random()}`);

			await executeWebSearch({ query: "深".repeat(200), reason: "r".repeat(200) });
			await executeWebSearch({ query: "DeepSeek 定价" });

			// 该端点要求 query 与 ori_question 都在 128 个 Unicode 字符以内。
			assert.equal(String(requests[0]?.body.query).length, 128);
			assert.equal(String(requests[0]?.body.ori_question).length, 128);
			assert.equal(requests[0]?.body.query, "深".repeat(128));
			// reason 缺失时必须整条省略，而不是发一个 undefined 或空串。
			assert.equal(Object.hasOwn(requests[1]?.body ?? {}, "ori_question"), false);
			assert.equal(requests[1]?.body.query, "DeepSeek 定价");
		} finally {
			server.close();
			await once(server, "close");
		}
	});
});
