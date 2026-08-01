import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { installMemorySecretStore, installReadOnlySecretStore, installUnavailableSecretStore, resetSecretStoreDriver } from "../../helpers/secret-store.js";
import { getProviderConfigStatus, getProviderModelSelectionStatus, loadProviderConfigWithSecret, saveProviderConfig, saveProviderModelsCache } from "../../../src/providers/provider-config-store.js";
import { resolveProviderTaskModelOptions } from "../../../src/providers/task-model-routing.js";

async function withTempAppData(run: () => Promise<void>): Promise<void> {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const appDataDir: string = await mkdtemp(join(tmpdir(), "daedalus-provider-config-"));
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
	}
}

test("provider config ignores legacy single-provider file and legacy keytar account", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		const configDir: string = join(process.env.USERPROFILE!, ".daedalus", "config");
		await mkdir(configDir, { recursive: true });
		await writeFile(join(configDir, "provider.json"), JSON.stringify({
			provider: "deepseek",
			model: "deepseek-v4-pro",
			baseUrl: "https://legacy.deepseek.example",
			keyStorage: "keytar",
			updatedAt: "2026-07-01T00:00:00.000Z"
		}), "utf8");

		const requestedAccounts: string[] = [];
		installReadOnlySecretStore(async (_service: string, account: string): Promise<string | null> => {
			requestedAccounts.push(account);
			return account === "deepseek_api_key" ? "legacy-key" : null;
		});

		const config = await loadProviderConfigWithSecret();
		const status = await getProviderConfigStatus();

		assert.equal(config, null);
		assert.equal(status.configured, false);
		assert.equal(status.model, null);
		assert.deepEqual(status.current, {
			provider: "deepseek",
			displayName: "DeepSeek",
			configured: false,
			model: "deepseek-v4-flash",
			modelDisplayName: "DeepSeek V4 Flash",
			baseUrl: "https://api.deepseek.com",
			apiKeyMasked: null,
			keyStorage: "keytar",
			updatedAt: null
		});
		assert.deepEqual(status.activeModel, {
			providerId: "deepseek",
			modelId: "deepseek-v4-flash"
		});
		assert.deepEqual(status.modelRouting, {
			imageRecognition: null,
			workflowPlanner: null,
			sessionTitle: null,
			imageGeneration: null,
			gitCommit: null,
			commandReview: null,
			goalEvaluator: null
		});
		assert.equal(requestedAccounts.includes("deepseek_api_key"), false);
		assert.equal(requestedAccounts.includes("provider:deepseek:api_key"), true);
	});
});

test("provider config saves keys under provider-scoped keytar accounts", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		const secrets: Map<string, string> = installMemorySecretStore();

		await saveProviderConfig({
			provider: "deepseek",
			apiKey: "new-key",
			model: "deepseek-v4-flash"
		});
		await saveProviderConfig({
			provider: "zhipu",
			apiKey: "zhipu-key",
			model: "glm-5.2"
		});

		assert.deepEqual([...secrets.keys()], ["provider:deepseek:api_key", "provider:zhipu:api_key"]);
		const configDir: string = join(process.env.USERPROFILE!, ".daedalus", "config");
		const rawConfig: string = await readFile(join(configDir, "provider.json"), "utf8");
		assert.equal(rawConfig.endsWith("\n"), true);
		assert.doesNotMatch(rawConfig, /new-key|zhipu-key/);
		assert.deepEqual((await readdir(configDir)).sort(), ["provider.json"]);
	});
});

test("provider config clears only the provider api key when apiKey is null", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		const deletedAccounts: string[] = [];
		installMemorySecretStore({}, {
			onDelete(account: string): void {
				deletedAccounts.push(account);
			}
		});

		await saveProviderConfig({
			provider: "deepseek",
			apiKey: "deepseek-key",
			model: "deepseek-v4-pro",
			baseUrl: "https://proxy.example/v1"
		});
		await saveProviderModelsCache("deepseek", [{
			id: "deepseek-v4-pro",
			displayName: "DeepSeek V4 Pro",
			provider: "deepseek",
			endpointType: "openai-chat-completions",
			contextWindowTokens: 128_000,
			maxOutputTokens: 8_192,
			capabilities: { tools: true }
		}]);

		await saveProviderConfig({
			provider: "deepseek",
			apiKey: null,
			model: "deepseek-v4-pro",
			baseUrl: "https://proxy.example/v1",
			activate: false
		});

		const status = await getProviderConfigStatus();
		const deepseek = status.providers.find((provider): boolean => provider.provider === "deepseek");
		assert.deepEqual(deletedAccounts, ["provider:deepseek:api_key"]);
		assert.equal(deepseek?.configured, false);
		assert.equal(deepseek?.apiKeyMasked, null);
		assert.equal(deepseek?.model, "deepseek-v4-pro");
		assert.equal(deepseek?.baseUrl, "https://proxy.example/v1");
		assert.equal(deepseek?.modelsCache.length, 1);
		assert.equal(deepseek?.modelsCache[0]?.id, "deepseek-v4-pro");
	});
});

test("provider config migrates v2 provider config to schema v3", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		const configDir: string = join(process.env.USERPROFILE!, ".daedalus", "config");
		const configPath: string = join(configDir, "provider.json");
		await mkdir(configDir, { recursive: true });
		await writeFile(configPath, JSON.stringify({
			schemaVersion: 2,
			activeProvider: "moonshot",
			providers: {
				moonshot: {
					model: "kimi-k2.6",
					baseUrl: "https://proxy.example/v1",
					keyStorage: "keytar",
					updatedAt: "2026-07-01T00:00:00.000Z"
				}
			},
			modelRouting: {
				imageRecognition: { provider: "moonshot", model: "kimi-k2.6" }
			}
		}), "utf8");

		installReadOnlySecretStore(async (_service: string, account: string): Promise<string | null> => {
			return account === "provider:moonshot:api_key" ? "moonshot-key" : null;
		});

		const config = await loadProviderConfigWithSecret();
		const status = await getProviderConfigStatus();
		const rawAfterMigration = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;

		assert.deepEqual(config, {
			provider: "moonshot",
			model: "kimi-k2.6",
			baseUrl: "https://proxy.example/v1",
			apiKey: "moonshot-key"
		});
		assert.equal(status.schemaVersion, 3);
		assert.deepEqual(status.activeModel, {
			providerId: "moonshot",
			modelId: "kimi-k2.6"
		});
		assert.deepEqual(status.current, {
			provider: "moonshot",
			displayName: "Moonshot/Kimi",
			configured: true,
			model: "kimi-k2.6",
			modelDisplayName: "Kimi K2.6",
			baseUrl: "https://proxy.example/v1",
			apiKeyMasked: "moo...-key",
			keyStorage: "keytar",
			updatedAt: "2026-07-01T00:00:00.000Z"
		});
		assert.equal(rawAfterMigration.schemaVersion, 3);
	});
});

test("provider config read paths treat keytar read failures as missing secrets", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		const configDir: string = join(process.env.USERPROFILE!, ".daedalus", "config");
		await mkdir(configDir, { recursive: true });
		await writeFile(join(configDir, "provider.json"), JSON.stringify({
			schemaVersion: 3,
			activeModel: {
				providerId: "deepseek",
				modelId: "deepseek-v4-pro"
			},
			providers: {
				deepseek: {
					model: "deepseek-v4-pro",
					baseUrl: "https://proxy.example/v1",
					keyStorage: "keytar",
					updatedAt: "2026-07-01T00:00:00.000Z"
				}
			},
			modelRouting: {
				imageRecognition: null,
				workflowPlanner: null,
				sessionTitle: null,
				imageGeneration: null,
				gitCommit: null
			}
		}), "utf8");

		installReadOnlySecretStore(async (): Promise<string | null> => {
			throw new Error("The name org.freedesktop.secrets was not provided by any .service files");
		});

		const config = await loadProviderConfigWithSecret();
		const status = await getProviderConfigStatus();

		assert.deepEqual(config, {
			provider: "deepseek",
			model: "deepseek-v4-pro",
			baseUrl: "https://proxy.example/v1",
			apiKey: undefined
		});
		assert.equal(status.configured, false);
		assert.equal(status.apiKeyMasked, null);
		assert.equal(status.current.configured, false);
		assert.equal(status.current.apiKeyMasked, null);
	});
});

test("provider config can read status without an installed keytar module", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		installUnavailableSecretStore();

		const status = await getProviderConfigStatus();
		assert.equal(status.configured, false);
		assert.equal(status.apiKeyMasked, null);

		await assert.rejects(
			saveProviderConfig({
				provider: "deepseek",
				apiKey: "deepseek-key",
				model: "deepseek-v4-flash"
			}),
			(error: unknown): boolean => {
				assert.equal(error instanceof Error, true);
				assert.equal((error as Error).name, "SecretStoreUnavailableError");
				return true;
			}
		);
	});
});

test("provider config persists cross-provider task model routing", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		installReadOnlySecretStore(async (_service: string, account: string): Promise<string | null> => {
			return account === "provider:moonshot:api_key" ? "moonshot-key" : "deepseek-key";
		});

		await saveProviderConfig({
			provider: "deepseek",
			apiKey: "deepseek-key",
			model: "deepseek-v4-flash",
			modelRouting: {
				imageRecognition: { provider: "moonshot", model: "kimi-k2.6" },
				workflowPlanner: { provider: "deepseek", model: "deepseek-v4-pro" },
				sessionTitle: null,
				imageGeneration: { provider: "openai", model: "gpt-image-1" },
				gitCommit: { provider: "deepseek", model: "deepseek-v4-pro" },
				commandReview: null,
				goalEvaluator: { provider: "deepseek", model: "deepseek-v4-pro" }
			}
		});

		const status = await getProviderConfigStatus();
		assert.deepEqual(status.modelRouting, {
			imageRecognition: { provider: "moonshot", model: "kimi-k2.6" },
			workflowPlanner: { provider: "deepseek", model: "deepseek-v4-pro" },
			sessionTitle: null,
			imageGeneration: { provider: "openai", model: "gpt-image-1" },
			gitCommit: { provider: "deepseek", model: "deepseek-v4-pro" },
			commandReview: null,
			goalEvaluator: { provider: "deepseek", model: "deepseek-v4-pro" }
		});
	});
});

test("image generation model routing is explicit and rejects unsupported models", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		const { generateImage, ImageGenerationError } = await import("../../../src/providers/image-generation.js");
		installReadOnlySecretStore(async (): Promise<string | null> => "deepseek-key");

		await assert.rejects(
			(): Promise<unknown> => generateImage({
				sessionId: "session-test",
				prompt: "生成一张测试图"
			}),
			(error: unknown): boolean => {
				assert.equal(error instanceof ImageGenerationError, true);
				assert.equal((error as InstanceType<typeof ImageGenerationError>).code, "image_generation_not_configured");
				return true;
			}
		);

		await saveProviderConfig({
			provider: "deepseek",
			apiKey: "deepseek-key",
			model: "deepseek-v4-flash",
			modelRouting: {
				imageGeneration: { provider: "deepseek", model: "deepseek-v4-flash" }
			}
		});

		await assert.rejects(
			(): Promise<unknown> => generateImage({
				sessionId: "session-test",
				prompt: "生成一张测试图"
			}),
			(error: unknown): boolean => {
				assert.equal(error instanceof ImageGenerationError, true);
				assert.equal((error as InstanceType<typeof ImageGenerationError>).code, "image_generation_not_supported");
				return true;
			}
		);
	});
});

test("provider config saves and clears custom request base url", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		installReadOnlySecretStore(async (): Promise<string | null> => "deepseek-key");

		await saveProviderConfig({
			provider: "deepseek",
			apiKey: "deepseek-key",
			model: "deepseek-v4-flash",
			baseUrl: "https://proxy.example/v1"
		});

		let status = await getProviderConfigStatus();
		assert.equal(status.baseUrl, "https://proxy.example/v1");
		assert.equal(status.providers.find((item) => item.provider === "deepseek")?.baseUrl, "https://proxy.example/v1");

		await saveProviderConfig({
			provider: "deepseek",
			baseUrl: null
		});

		status = await getProviderConfigStatus();
		assert.equal(status.baseUrl, null);
		assert.equal(status.providers.find((item) => item.provider === "deepseek")?.baseUrl, null);
	});
});

test("provider model selection exposes current main model and provider model lists", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		installReadOnlySecretStore(async (_service: string, account: string): Promise<string | null> => {
			return account === "provider:zhipu:api_key" ? "zhipu-key" : null;
		});

		await saveProviderConfig({
			provider: "zhipu",
			apiKey: "zhipu-key",
			model: "glm-5.2"
		});

		const selection = await getProviderModelSelectionStatus();
		const zhipu = selection.providers.find((provider): boolean => provider.provider === "zhipu");

		assert.deepEqual(selection.activeModel, {
			providerId: "zhipu",
			modelId: "glm-5.2"
		});
		assert.equal(selection.current.provider, "zhipu");
		assert.equal(selection.current.model, "glm-5.2");
		assert.equal(selection.current.modelDisplayName, "GLM-5.2");
		assert.equal(zhipu?.selected, true);
		assert.equal(zhipu?.selectedModel, "glm-5.2");
		assert.equal(zhipu?.modelsSource, "fallback");
		assert.equal(zhipu?.models.some((model): boolean => model.id === "glm-5.2"), true);
		const zhipuDefaultModel = zhipu?.models.find((model): boolean => model.id === "glm-5.2");
		assert.equal(zhipuDefaultModel?.capabilities.reasoning, true);
		assert.equal(zhipuDefaultModel?.capabilities.tools, true);
		assert.equal(zhipu?.models.find((model): boolean => model.id === "glm-5v-turbo")?.capabilities.vision, true);
	});
});

test("provider model selection augments cached models with catalog image generation models", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		installReadOnlySecretStore(async (_service: string, account: string): Promise<string | null> => {
			return account === "provider:zhipu:api_key" ? "zhipu-key" : null;
		});
		await saveProviderModelsCache("zhipu", [{
			id: "glm-5.2",
			displayName: "GLM-5.2",
			provider: "zhipu",
			endpointType: "openai-chat-completions",
			contextWindowTokens: 1_000_000,
			maxOutputTokens: 128_000,
			capabilities: {}
		}]);

		const selection = await getProviderModelSelectionStatus();
		const zhipu = selection.providers.find((provider): boolean => provider.provider === "zhipu");

		assert.equal(zhipu?.modelsSource, "cache");
		assert.equal(zhipu?.models.find((model): boolean => model.id === "glm-5.2")?.capabilities.reasoning, true);
		assert.equal(zhipu?.models.find((model): boolean => model.id === "glm-image")?.capabilities.imageGeneration, true);
		assert.equal(zhipu?.models.find((model): boolean => model.id === "cogview-4")?.capabilities.imageGeneration, true);
	});
});

test("task model resolver falls back to current model or resolves configured provider secrets", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		installReadOnlySecretStore(async (_service: string, account: string): Promise<string | null> => {
			if (account === "provider:moonshot:api_key") {
				return "moonshot-key";
			}
			if (account === "provider:deepseek:api_key") {
				return "deepseek-key";
			}
			return null;
		});

		await saveProviderConfig({
			provider: "deepseek",
			apiKey: "deepseek-key",
			model: "deepseek-v4-flash",
			modelRouting: {
				imageRecognition: { provider: "moonshot", model: "kimi-k2.6" },
				gitCommit: { provider: "moonshot", model: "kimi-k2.6" }
			}
		});

		const imageModel = await resolveProviderTaskModelOptions("imageRecognition", {
			provider: "deepseek",
			apiKey: "deepseek-key",
			model: "deepseek-v4-flash"
		});
		assert.equal(imageModel.source, "configured");
		assert.equal(imageModel.provider, "moonshot");
		assert.equal(imageModel.model, "kimi-k2.6");
		assert.equal(imageModel.options.apiKey, "moonshot-key");

		const titleModel = await resolveProviderTaskModelOptions("sessionTitle", {
			provider: "deepseek",
			apiKey: "deepseek-key",
			model: "deepseek-v4-flash"
		});
		assert.equal(titleModel.source, "current");
		assert.equal(titleModel.provider, "deepseek");
		assert.equal(titleModel.model, "deepseek-v4-flash");

		const gitCommitModel = await resolveProviderTaskModelOptions("gitCommit", {
			provider: "deepseek",
			apiKey: "deepseek-key",
			model: "deepseek-v4-flash"
		});
		assert.equal(gitCommitModel.source, "configured");
		assert.equal(gitCommitModel.provider, "moonshot");
		assert.equal(gitCommitModel.model, "kimi-k2.6");
	});
});
