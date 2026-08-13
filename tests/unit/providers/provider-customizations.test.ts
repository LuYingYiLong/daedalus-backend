import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	addCustomModel,
	addCustomProvider,
	ensureCustomProviderDefaultModel,
	ProviderCustomizationError,
	removeCustomProvider,
	updateProviderModelSelection,
	updateModelCustomization
} from "../../../src/providers/provider-customizations-service.js";
import {
	getProviderCustomizationsSnapshot,
	initializeProviderCustomizations
} from "../../../src/providers/provider-customizations-store.js";
import {
	getProviderAdapterFamily,
	getProviderDefaultModelOrNull,
	getProviderFallbackModels,
	mergeProviderModelsWithCatalog
} from "../../../src/providers/provider-registry.js";
import {
	getProviderModelSelectionStatus,
	getProviderModelsCache,
	removeCustomProviderConfig,
	saveProviderConfig,
	saveProviderModelsCache,
	setProviderEnabled
} from "../../../src/providers/provider-config-store.js";
import { installMemorySecretStore, resetSecretStoreDriver } from "../../helpers/secret-store.js";

const allEditableCapabilities = {
	imageInput: false,
	videoInput: false,
	reasoning: false,
	tools: false,
	webSearch: false,
	imageGeneration: false,
	imageEdit: false
} as const;

const allCapabilityUpdates = {
	imageInput: null,
	videoInput: null,
	reasoning: null,
	tools: null,
	webSearch: null,
	imageGeneration: null,
	imageEdit: null
} as const;

async function withTempAppData(run: (root: string) => Promise<void>): Promise<void> {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-provider-customizations-"));
	process.env.USERPROFILE = root;
	try {
		await initializeProviderCustomizations(true);
		await run(root);
	} finally {
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		await initializeProviderCustomizations(true);
		resetSecretStoreDriver();
	}
}

test("provider customization store falls back for missing and corrupt files", async (): Promise<void> => {
	await withTempAppData(async (root: string): Promise<void> => {
		assert.deepEqual(getProviderCustomizationsSnapshot(), {
			schemaVersion: 3,
			providers: {},
			models: {},
			excludedModelIds: {}
		});

		const configDir: string = join(root, ".daedalus", "config");
		await mkdir(configDir, { recursive: true });
		await writeFile(join(configDir, "provider-customizations.json"), "{broken", "utf8");
		await initializeProviderCustomizations(true);

		assert.deepEqual(getProviderCustomizationsSnapshot(), {
			schemaVersion: 3,
			providers: {},
			models: {},
			excludedModelIds: {}
		});
	});
});

test("provider customization store replaces unsupported schema versions", async (): Promise<void> => {
	await withTempAppData(async (root: string): Promise<void> => {
		const configDir: string = join(root, ".daedalus", "config");
		await mkdir(configDir, { recursive: true });
		const filePath: string = join(configDir, "provider-customizations.json");
		await writeFile(filePath, JSON.stringify({
			schemaVersion: 1,
			providers: {},
			models: {}
		}), "utf8");
		await initializeProviderCustomizations(true);
		assert.deepEqual(getProviderCustomizationsSnapshot(), {
			schemaVersion: 3,
			providers: {},
			models: {},
			excludedModelIds: {}
		});
		assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), {
			schemaVersion: 3,
			providers: {},
			models: {},
			excludedModelIds: {}
		});

		await writeFile(filePath, JSON.stringify({
			schemaVersion: 2,
			providers: {},
			models: {
				deepseek: {
					"deepseek-v4-flash": {
						source: "override",
						displayName: "Legacy Flash",
						capabilities: {
							vision: true,
							tools: false
						},
						updatedAt: "2026-08-01T00:00:00.000Z"
					}
				}
			},
			excludedModelIds: {
				deepseek: [" deepseek-v4-flash ", "", "deepseek-v4-flash", 42]
			}
		}), "utf8");
		await initializeProviderCustomizations(true);
		assert.deepEqual(getProviderCustomizationsSnapshot(), {
			schemaVersion: 3,
			providers: {},
			models: {},
			excludedModelIds: {}
		});
		assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), {
			schemaVersion: 3,
			providers: {},
			models: {},
			excludedModelIds: {}
		});
	});
});

test("custom providers persist adapter type and first custom model as default", async (): Promise<void> => {
	await withTempAppData(async (root: string): Promise<void> => {
		const provider: string = await addCustomProvider({
			displayName: "Local Anthropic",
			providerType: "anthropic"
		});
		assert.match(provider, /^custom-[0-9a-f-]{36}$/u);
		assert.equal(getProviderAdapterFamily(provider), "anthropic-compatible");
		assert.equal(getProviderDefaultModelOrNull(provider), null);

		await addCustomModel({
			provider,
			id: "claude-local",
			displayName: "Claude Local",
			contextWindowTokens: 200_000,
			maxOutputTokens: 16_384,
			capabilities: {
				...allEditableCapabilities,
				imageInput: true,
				tools: true
			}
		});
		assert.equal(getProviderDefaultModelOrNull(provider), "claude-local");
		const model = getProviderFallbackModels(provider)[0];
		assert.equal(model?.displayName, "Claude Local");
		assert.equal(model?.contextWindowTokens, 200_000);
		assert.equal(model?.maxOutputTokens, 16_384);
		assert.equal(model?.capabilities.imageInput, true);
		assert.equal(model?.capabilities.tools, true);
		assert.equal(model?.customization?.source, "custom");

		const filePath: string = join(root, ".daedalus", "config", "provider-customizations.json");
		const persisted: string = await readFile(filePath, "utf8");
		assert.match(persisted, /"providerType": "anthropic"/u);
		assert.match(persisted, /"defaultModel": "claude-local"/u);

		await initializeProviderCustomizations(true);
		assert.equal(getProviderDefaultModelOrNull(provider), "claude-local");
	});
});

test("model overrides survive reload and preserve capabilities outside the editable set", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		await saveProviderModelsCache("deepseek", [{
			id: "api-special",
			displayName: "API Special",
			provider: "deepseek",
			endpointType: "openai-chat-completions",
			contextWindowTokens: 200_000,
			maxOutputTokens: 16_000,
			capabilities: {
				reasoning: true,
				reasoningEfforts: [{ id: "high", fallback: "high" }],
				imageGeneration: true,
				imageEdit: true
			}
		}]);
		await updateModelCustomization({
			provider: "deepseek",
			id: "api-special",
			displayName: "My Special",
			contextWindowTokens: 300_000,
			maxOutputTokens: 24_000,
			capabilities: {
				...allCapabilityUpdates,
				imageInput: true,
				webSearch: true,
				tools: true
			}
		});
		await updateModelCustomization({
			provider: "deepseek",
			id: "deepseek-v4-flash",
			displayName: "My Flash",
			contextWindowTokens: null,
			maxOutputTokens: null,
			capabilities: {
				...allCapabilityUpdates,
				imageInput: false,
				webSearch: false,
				reasoning: true,
				tools: true
			}
		});
		assert.equal(
			getProviderFallbackModels("deepseek").find((candidate): boolean => candidate.id === "deepseek-v4-flash")?.displayName,
			"My Flash"
		);

		let cache = await getProviderModelsCache("deepseek");
		let model = mergeProviderModelsWithCatalog("deepseek", cache?.models ?? [])
			.find((candidate): boolean => candidate.id === "api-special");
		assert.equal(model?.displayName, "My Special");
		assert.equal(model?.contextWindowTokens, 300_000);
		assert.equal(model?.maxOutputTokens, 24_000);
		assert.equal(model?.capabilities.vision, true);
		assert.equal(model?.capabilities.imageInput, true);
		assert.equal(model?.capabilities.webSearch, true);
		assert.equal(model?.capabilities.reasoning, true);
		assert.equal(model?.capabilities.tools, true);
		assert.equal(model?.capabilities.imageGeneration, true);
		assert.equal(model?.capabilities.imageEdit, true);
		assert.deepEqual(model?.capabilities.reasoningEfforts, [{ id: "high", fallback: "high" }]);
		assert.deepEqual(model?.customization?.capabilities, {
			imageInput: true,
			webSearch: true,
			tools: true
		});

		await initializeProviderCustomizations(true);
		cache = await getProviderModelsCache("deepseek");
		model = mergeProviderModelsWithCatalog("deepseek", cache?.models ?? [])
			.find((candidate): boolean => candidate.id === "api-special");
		assert.equal(model?.displayName, "My Special");
		assert.equal(model?.capabilities.imageGeneration, true);

		await updateModelCustomization({
			provider: "deepseek",
			id: "api-special",
			displayName: null,
			contextWindowTokens: null,
			maxOutputTokens: null,
			capabilities: {
				...allCapabilityUpdates,
				imageInput: null,
				webSearch: null,
				tools: null
			}
		});
		cache = await getProviderModelsCache("deepseek");
		model = mergeProviderModelsWithCatalog("deepseek", cache?.models ?? [])
			.find((candidate): boolean => candidate.id === "api-special");
		assert.equal(model?.displayName, "API Special");
		assert.equal(model?.contextWindowTokens, 200_000);
		assert.equal(model?.maxOutputTokens, 16_000);
		assert.equal(model?.customization, undefined);
	});
});

test("excluded catalog models disappear and restore their local overrides when re-enabled", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		await updateModelCustomization({
			provider: "deepseek",
			id: "deepseek-v4-flash",
			displayName: "My Flash",
			contextWindowTokens: null,
			maxOutputTokens: null,
			capabilities: {
				...allCapabilityUpdates,
				imageInput: false,
				webSearch: false,
				reasoning: true,
				tools: true
			}
		});
		await updateProviderModelSelection({
			provider: "deepseek",
			enableModelIds: [],
			removeModelIds: ["deepseek-v4-flash"],
			nextDefaultModel: null
		});
		assert.equal(
			mergeProviderModelsWithCatalog("deepseek", []).some((model): boolean => model.id === "deepseek-v4-flash"),
			false
		);
		assert.equal(
			mergeProviderModelsWithCatalog("deepseek", [], { includeExcluded: true })
				.find((model): boolean => model.id === "deepseek-v4-flash")?.displayName,
			"My Flash"
		);

		await initializeProviderCustomizations(true);
		await updateProviderModelSelection({
			provider: "deepseek",
			enableModelIds: ["deepseek-v4-flash"],
			removeModelIds: [],
			nextDefaultModel: null
		});
		const restored = mergeProviderModelsWithCatalog("deepseek", [])
			.find((model): boolean => model.id === "deepseek-v4-flash");
		assert.equal(restored?.displayName, "My Flash");
		assert.equal(restored?.capabilities.tools, true);
	});
});

test("saving an inactive provider does not restore its excluded catalog default", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		installMemorySecretStore();
		await updateProviderModelSelection({
			provider: "moonshot",
			enableModelIds: [],
			removeModelIds: ["kimi-k3"],
			nextDefaultModel: null
		});
		await saveProviderConfig({
			provider: "moonshot",
			apiKey: "test-key",
			activate: false
		});
		const provider = (await getProviderModelSelectionStatus()).providers
			.find((candidate): boolean => candidate.provider === "moonshot");
		assert.notEqual(provider?.selectedModel, "kimi-k3");
		assert.equal(provider?.models.some((model): boolean => model.id === "kimi-k3"), false);
	});
});

test("provider and model conflicts return stable error codes", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		await assert.rejects(
			() => addCustomProvider({ displayName: "deepseek", providerType: "openai" }),
			(error: unknown): boolean => error instanceof ProviderCustomizationError && error.code === "provider_name_conflict"
		);

		const provider: string = await addCustomProvider({
			displayName: "Private Gateway",
			providerType: "openai-responses"
		});
		assert.equal(getProviderAdapterFamily(provider), "openai-responses");
		await addCustomModel({
			provider,
			id: "model-1",
			displayName: "Model 1",
			contextWindowTokens: 128_000,
			maxOutputTokens: 8_192,
			capabilities: allEditableCapabilities
		});
		await assert.rejects(
			() => addCustomModel({
				provider,
				id: "model-1",
				displayName: "Duplicate",
				contextWindowTokens: 128_000,
				maxOutputTokens: 8_192,
				capabilities: allEditableCapabilities
			}),
			(error: unknown): boolean => error instanceof ProviderCustomizationError && error.code === "provider_model_exists"
		);
	});
});

test("custom providers report readiness and cannot activate without model or base URL", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		installMemorySecretStore();
		const provider: string = await addCustomProvider({
			displayName: "Ready Check",
			providerType: "openai"
		});
		await assert.rejects(
			() => saveProviderConfig({ provider }),
			/provider_not_ready/u
		);

		await addCustomModel({
			provider,
			id: "ready-model",
			displayName: "Ready Model",
			contextWindowTokens: 128_000,
			maxOutputTokens: 8_192,
			capabilities: allEditableCapabilities
		});
		await assert.rejects(
			() => saveProviderConfig({ provider, model: "ready-model" }),
			/provider_base_url_required/u
		);

		await saveProviderConfig({
			provider,
			apiKey: "ready-key",
			model: "ready-model",
			baseUrl: "https://gateway.example/v1",
			enabled: true,
			activate: false
		});
		const selection = await getProviderModelSelectionStatus();
		const status = selection.providers.find((candidate): boolean => candidate.provider === provider);
		assert.equal(status?.custom, true);
		assert.equal(status?.providerType, "openai");
		assert.equal(status?.enabled, true);
		assert.equal(status?.ready, true);
		assert.equal(status?.defaultModel, "ready-model");

		await saveProviderConfig({ provider, model: "ready-model" });
		assert.equal((await getProviderModelSelectionStatus()).activeModel.providerId, provider);
	});
});

test("providers cannot be disabled while active or task-routed, while unused custom providers can be removed", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		installMemorySecretStore();
		await assert.rejects(
			() => setProviderEnabled("moonshot", true),
			/provider_api_key_required/u
		);
		const provider: string = await addCustomProvider({
			displayName: "Guarded Gateway",
			providerType: "openai"
		});
		await addCustomModel({
			provider,
			id: "guarded-model",
			displayName: "Guarded Model",
			contextWindowTokens: 128_000,
			maxOutputTokens: 8_192,
			capabilities: allEditableCapabilities
		});
		await saveProviderConfig({
			provider,
			apiKey: "custom-key",
			baseUrl: "https://gateway.example/v1",
			model: "guarded-model",
			modelRouting: {
				sessionTitle: { provider, model: "guarded-model" }
			}
		});

		const activeBlocked = await setProviderEnabled(provider, false);
		assert.deepEqual(activeBlocked, {
			updated: false,
			usages: [
				{ kind: "activeModel", model: "guarded-model" },
				{ kind: "taskRouting", task: "sessionTitle", model: "guarded-model" }
			]
		});

		await saveProviderConfig({
			provider: "deepseek",
			apiKey: "deepseek-key",
			model: "deepseek-v4-flash",
			modelRouting: {
				sessionTitle: null
			}
		});
		const builtInBlocked = await setProviderEnabled("deepseek", false);
		assert.deepEqual(builtInBlocked, {
			updated: false,
			usages: [{ kind: "activeModel", model: "deepseek-v4-flash" }]
		});

		const disabled = await setProviderEnabled(provider, false);
		assert.deepEqual(disabled, { updated: true, usages: [] });
		const status = (await getProviderModelSelectionStatus()).providers
			.find((candidate): boolean => candidate.provider === provider);
		assert.equal(status?.enabled, false);
		assert.equal(status?.ready, false);
		await assert.rejects(
			() => saveProviderConfig({ provider, model: "guarded-model" }),
			/provider_disabled/u
		);

		await saveProviderConfig({
			provider: "moonshot",
			apiKey: "moonshot-key",
			model: "kimi-k3"
		});
		assert.deepEqual(await setProviderEnabled("deepseek", false), { updated: true, usages: [] });
		const deepseekStatus = (await getProviderModelSelectionStatus()).providers
			.find((candidate): boolean => candidate.provider === "deepseek");
		assert.equal(deepseekStatus?.enabled, false);

		const removedConfig = await removeCustomProviderConfig(provider);
		assert.deepEqual(removedConfig, { updated: true, usages: [] });
		await removeCustomProvider(provider);
		assert.equal(
			(await getProviderModelSelectionStatus()).providers.some((candidate): boolean => candidate.provider === provider),
			false
		);
	});
});

test("serialized customization writes do not lose independent providers", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		const providerIds: string[] = await Promise.all([
			addCustomProvider({ displayName: "Gateway A", providerType: "openai" }),
			addCustomProvider({ displayName: "Gateway B", providerType: "openai-responses" })
		]);
		const snapshot = getProviderCustomizationsSnapshot();
		assert.equal(snapshot.providers[providerIds[0]!]?.displayName, "Gateway A");
		assert.equal(snapshot.providers[providerIds[1]!]?.displayName, "Gateway B");
	});
});

test("the first API model can become a custom provider default without activating it", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		const provider: string = await addCustomProvider({
			displayName: "Remote Catalog",
			providerType: "openai"
		});
		await saveProviderModelsCache(provider, [{
			id: "remote-first",
			displayName: "Remote First",
			provider,
			endpointType: "openai-chat-completions",
			contextWindowTokens: 128_000,
			maxOutputTokens: 8_192,
			capabilities: {}
		}]);
		await ensureCustomProviderDefaultModel(provider, "remote-first");

		assert.equal(getProviderDefaultModelOrNull(provider), "remote-first");
	});
});
