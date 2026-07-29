import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	discoverProviderModels,
	importProviderModels,
	ProviderModelSyncError,
	syncProviderModels,
	type DiscoveredProviderModel
} from "../../../src/providers/provider-models.js";
import {
	getProviderModelSelectionStatus,
	getProviderModelsCache,
	saveProviderConfig,
	saveProviderModelsCache
} from "../../../src/providers/provider-config-store.js";
import {
	addCustomModel,
	addCustomProvider,
	updateModelCustomization
} from "../../../src/providers/provider-customizations-service.js";
import { initializeProviderCustomizations } from "../../../src/providers/provider-customizations-store.js";
import { getProviderDefaultModelOrNull } from "../../../src/providers/provider-registry.js";

async function listen(server: Server): Promise<string> {
	await new Promise<void>((resolve): void => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert.notEqual(address, null);
	assert.equal(typeof address, "object");
	return `http://127.0.0.1:${String((address as { port: number }).port)}`;
}

async function withTempAppData(run: () => Promise<void>): Promise<void> {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-provider-discovery-"));
	process.env.USERPROFILE = root;
	try {
		await initializeProviderCustomizations(true);
		await run();
	} finally {
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		await initializeProviderCustomizations(true);
	}
}

test("provider discovery uses fresh API metadata without writing the model cache", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		const server: Server = createServer((request, response): void => {
			assert.equal(request.url, "/models");
			assert.equal(request.headers.authorization, "Bearer discovery-key");
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({
				data: [
					{
						id: "deepseek-v4-pro",
						context_length: 256_000,
						supports_reasoning: false,
						supports_tools: true
					},
					{
						id: "remote-extra",
						context_length: 64_000,
						supports_tools: true
					}
				]
			}));
		});
		const baseUrl: string = await listen(server);
		try {
			const result = await discoverProviderModels("deepseek", "discovery-key", baseUrl);
			assert.equal(result.source, "api");
			assert.equal(result.error, undefined);
			assert.equal(result.models.find((model): boolean => model.id === "deepseek-v4-pro")?.contextWindowTokens, 256_000);
			assert.equal(result.models.find((model): boolean => model.id === "deepseek-v4-pro")?.capabilities.reasoning, false);
			assert.equal(result.models.find((model): boolean => model.id === "remote-extra")?.capabilities.tools, true);
			assert.equal(result.models.some((model): boolean => model.id === "deepseek-v4-flash"), true);
			assert.equal(await getProviderModelsCache("deepseek"), undefined);
		} finally {
			server.close();
		}
	});
});

test("provider discovery falls back to catalog without mutating an existing cache", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		await saveProviderModelsCache("deepseek", [{
			id: "kept-model",
			displayName: "Kept Model",
			provider: "deepseek",
			endpointType: "openai-chat-completions",
			contextWindowTokens: 32_000,
			maxOutputTokens: 4_096,
			capabilities: {}
		}]);
		const server: Server = createServer((_request, response): void => {
			response.writeHead(401, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ error: "invalid key" }));
		});
		const baseUrl: string = await listen(server);
		try {
			const result = await discoverProviderModels("deepseek", "bad-key", baseUrl);
			assert.equal(result.source, "fallback");
			assert.match(result.error ?? "", /HTTP 401/u);
			assert.equal(result.models.some((model): boolean => model.id === "deepseek-v4-pro"), true);
			assert.deepEqual((await getProviderModelsCache("deepseek"))?.models.map((model): string => model.id), ["kept-model"]);
		} finally {
			server.close();
		}
	});
});

test("provider model import upserts selected models and preserves local overrides and unselected cache entries", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		await saveProviderModelsCache("deepseek", [{
			id: "kept-model",
			displayName: "Kept Model",
			provider: "deepseek",
			endpointType: "openai-chat-completions",
			contextWindowTokens: 32_000,
			maxOutputTokens: 4_096,
			capabilities: {}
		}, {
			id: "deepseek-v4-pro",
			displayName: "Old Remote Name",
			provider: "deepseek",
			endpointType: "openai-chat-completions",
			contextWindowTokens: 128_000,
			maxOutputTokens: 8_192,
			capabilities: { reasoning: true }
		}]);
		await updateModelCustomization({
			provider: "deepseek",
			id: "deepseek-v4-pro",
			displayName: "My Pro",
			capabilities: {
				vision: false,
				webSearch: false,
				reasoning: true,
				tools: true
			}
		});

		const imported: DiscoveredProviderModel[] = [{
			id: "deepseek-v4-pro",
			displayName: "Fresh Remote Name",
			contextWindowTokens: 256_000,
			maxOutputTokens: 16_384,
			capabilities: { reasoning: false, tools: false }
		}, {
			id: "new-model",
			displayName: "New Model",
			contextWindowTokens: 64_000,
			maxOutputTokens: 8_192,
			capabilities: { tools: true }
		}];
		await importProviderModels("deepseek", imported);

		const cache = await getProviderModelsCache("deepseek");
		assert.equal(cache?.models.some((model): boolean => model.id === "kept-model"), true);
		assert.equal(cache?.models.find((model): boolean => model.id === "deepseek-v4-pro")?.displayName, "Fresh Remote Name");
		assert.equal(cache?.models.find((model): boolean => model.id === "new-model")?.capabilities.tools, true);

		const selection = await getProviderModelSelectionStatus();
		const deepseek = selection.providers.find((provider): boolean => provider.provider === "deepseek");
		assert.equal(deepseek?.models.find((model): boolean => model.id === "deepseek-v4-pro")?.displayName, "My Pro");
		assert.equal(deepseek?.models.find((model): boolean => model.id === "deepseek-v4-pro")?.capabilities.tools, true);
	});
});

test("provider model sync removes and restores models while protecting referenced models", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		await assert.rejects(
			() => syncProviderModels({
				provider: "deepseek",
				upsertModels: [],
				enableModelIds: [],
				removeModelIds: ["deepseek-v4-flash"]
			}),
			(error: unknown): boolean => {
				return error instanceof ProviderModelSyncError && error.code === "provider_model_in_use";
			}
		);

		await updateModelCustomization({
			provider: "deepseek",
			id: "deepseek-v4-pro",
			displayName: "Restorable Pro",
			capabilities: {
				vision: false,
				webSearch: false,
				reasoning: true,
				tools: true
			}
		});
		let models = await syncProviderModels({
			provider: "deepseek",
			upsertModels: [],
			enableModelIds: [],
			removeModelIds: ["deepseek-v4-pro"]
		});
		assert.equal(models.some((model): boolean => model.id === "deepseek-v4-pro"), false);

		const server: Server = createServer((_request, response): void => {
			response.writeHead(401, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ error: "invalid key" }));
		});
		const baseUrl: string = await listen(server);
		try {
			const discovery = await discoverProviderModels("deepseek", "bad-key", baseUrl);
			const removed = discovery.managedModels.find((model): boolean => model.id === "deepseek-v4-pro");
			assert.equal(removed?.enabled, false);
			assert.equal(removed?.displayName, "Restorable Pro");
		} finally {
			server.close();
		}

		models = await syncProviderModels({
			provider: "deepseek",
			upsertModels: [],
			enableModelIds: ["deepseek-v4-pro"],
			removeModelIds: []
		});
		assert.equal(
			models.find((model): boolean => model.id === "deepseek-v4-pro")?.displayName,
			"Restorable Pro"
		);
	});
});

test("custom provider default follows the remaining enabled models", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		const provider: string = await addCustomProvider({
			displayName: "Selection Gateway",
			providerType: "openai"
		});
		await addCustomModel({ provider, id: "first", displayName: "First" });
		await addCustomModel({ provider, id: "second", displayName: "Second" });
		assert.equal(getProviderDefaultModelOrNull(provider), "first");

		await syncProviderModels({
			provider,
			upsertModels: [],
			enableModelIds: [],
			removeModelIds: ["first"]
		});
		assert.equal(getProviderDefaultModelOrNull(provider), "second");

		await syncProviderModels({
			provider,
			upsertModels: [],
			enableModelIds: [],
			removeModelIds: ["second"]
		});
		assert.equal(getProviderDefaultModelOrNull(provider), null);
		const providerStatus = (await getProviderModelSelectionStatus()).providers
			.find((candidate): boolean => candidate.provider === provider);
		assert.equal(providerStatus?.models.length, 0);
		assert.equal(providerStatus?.ready, false);
	});
});

test("provider model management reports provider, task routing, and web search guards", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		await saveProviderConfig({
			provider: "deepseek",
			model: "deepseek-v4-pro",
			activate: false,
			modelRouting: {
				workflowPlanner: {
					provider: "deepseek",
					model: "deepseek-v4-pro"
				}
			}
		});
		const server: Server = createServer((_request, response): void => {
			response.writeHead(401, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ error: "invalid key" }));
		});
		const baseUrl: string = await listen(server);
		try {
			const discovery = await discoverProviderModels("deepseek", "bad-key", baseUrl);
			const guarded = discovery.managedModels.find((model): boolean => model.id === "deepseek-v4-pro");
			assert.deepEqual(guarded?.removalGuards, [
				{ kind: "providerSelection" },
				{ kind: "taskRouting", task: "workflowPlanner" }
			]);
		} finally {
			server.close();
		}

		await assert.rejects(
			() => syncProviderModels({
				provider: "zhipu",
				upsertModels: [],
				enableModelIds: [],
				removeModelIds: ["glm-5.2"]
			}),
			(error: unknown): boolean => {
				return error instanceof ProviderModelSyncError
					&& error.code === "provider_model_in_use"
					&& /webSearch/u.test(error.message);
			}
		);
	});
});
