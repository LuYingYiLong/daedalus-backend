import type { ProviderId } from "../protocol/types.js";
import {
	getCatalogModel,
	getProviderDefinition,
	getProviderFallbackModels,
	getProviderDefaultEndpointType,
	isCustomProvider,
	isProviderId,
	mergeProviderModelsWithCatalog,
	type ProviderModelCapabilities,
	type ProviderModelInfo,
	normalizeProviderModelCapabilities
} from "./provider-registry.js";
import {
	getProviderConfigStatus,
	getProviderModelsCache,
	saveProviderModelsCache,
	type ProviderConfigStatus,
	type ProviderModelRouting,
	type StoredProviderModelsCache
} from "./provider-config-store.js";
import {
	ensureCustomProviderDefaultModel,
	updateProviderModelSelection
} from "./provider-customizations-service.js";
import { resolveProviderBaseUrl } from "./provider-base-url.js";
import type { ProviderChatOptions } from "./provider-types.js";
import type { ProviderRequestOverrides } from "./provider-request-overrides.js";
import { createProviderRequestOverrideFetch } from "./provider-request-overrides.js";
import { resolveProviderAdapter } from "./provider-adapter.js";
import type { ProviderTaskModelKind } from "./task-model-routing.js";
import { getWebSearchSettings, type WebSearchSettings } from "../web-search-settings-store.js";
import "./provider-adapters.js";

export type ProviderModelsListResult = {
	provider: ProviderId;
	models: ProviderModelInfo[];
	stale: boolean;
	source: "api" | "cache" | "fallback";
	error?: string | undefined;
};

export type DiscoveredProviderModel = Omit<ProviderModelInfo, "provider" | "endpointType">;

export type ProviderModelRemovalGuard =
	| { kind: "activeModel" }
	| { kind: "providerSelection" }
	| { kind: "taskRouting"; task: ProviderTaskModelKind }
	| { kind: "webSearch" };

export type ManagedProviderModel = DiscoveredProviderModel & {
	enabled: boolean;
	removalGuards: ProviderModelRemovalGuard[];
};

export type ProviderModelsDiscoverResult = {
	provider: ProviderId;
	models: DiscoveredProviderModel[];
	managedModels: ManagedProviderModel[];
	source: "api" | "fallback";
	error?: string | undefined;
};

export type SyncProviderModelsInput = {
	provider: ProviderId;
	upsertModels: readonly DiscoveredProviderModel[];
	enableModelIds: readonly string[];
	removeModelIds: readonly string[];
};

export class ProviderModelSyncError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "ProviderModelSyncError";
		this.code = code;
	}
}

const FALLBACK_CONTEXT_WINDOW_TOKENS: number = 128_000;
const FALLBACK_MAX_OUTPUT_TOKENS: number = 8_192;

function createDisplayName(modelId: string): string {
	return modelId
		.split("-")
		.filter((part: string): boolean => part.length > 0)
		.map((part: string): string => part.length <= 3 ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1))
		.join(" ");
}

function inferContextLength(provider: ProviderId, modelId: string, rawContextLength: unknown): number {
	if (typeof rawContextLength === "number" && Number.isFinite(rawContextLength) && rawContextLength > 0) {
		return Math.floor(rawContextLength);
	}

	const fallback: ProviderModelInfo | undefined = getProviderFallbackModels(provider)
		.find((model: ProviderModelInfo): boolean => model.id === modelId);
	return fallback?.contextWindowTokens ?? FALLBACK_CONTEXT_WINDOW_TOKENS;
}

function inferMaxOutputTokens(provider: ProviderId, modelId: string, contextWindowTokens: number): number {
	const fallback: ProviderModelInfo | undefined = getProviderFallbackModels(provider)
		.find((model: ProviderModelInfo): boolean => model.id === modelId);
	return fallback?.maxOutputTokens ?? Math.min(FALLBACK_MAX_OUTPUT_TOKENS, Math.max(4_096, Math.floor(contextWindowTokens / 4)));
}

function normalizeCapabilities(raw: Record<string, unknown>, fallback: ProviderModelInfo | undefined): ProviderModelCapabilities {
	const capabilities: ProviderModelCapabilities = {
		imageInput: typeof raw.supports_image_in === "boolean"
			? raw.supports_image_in
			: typeof raw.input_modalities === "object" && Array.isArray(raw.input_modalities)
				? raw.input_modalities.includes("image")
				: fallback?.capabilities.imageInput,
		videoInput: typeof raw.supports_video_in === "boolean" ? raw.supports_video_in : fallback?.capabilities.videoInput,
		reasoning: typeof raw.supports_reasoning === "boolean" ? raw.supports_reasoning : fallback?.capabilities.reasoning,
		tools: typeof raw.supports_tools === "boolean"
			? raw.supports_tools
			: typeof raw.supports_tool_calling === "boolean"
				? raw.supports_tool_calling
				: fallback?.capabilities.tools,
		webSearch: typeof raw.supports_web_search === "boolean" ? raw.supports_web_search : fallback?.capabilities.webSearch,
		imageGeneration: typeof raw.supports_image_generation === "boolean"
			? raw.supports_image_generation
			: typeof raw.image_generation === "boolean"
				? raw.image_generation
				: fallback?.capabilities.imageGeneration,
		imageEdit: typeof raw.supports_image_edit === "boolean"
			? raw.supports_image_edit
			: typeof raw.image_edit === "boolean"
				? raw.image_edit
				: fallback?.capabilities.imageEdit,
		vision: fallback?.capabilities.vision
	};

	return normalizeProviderModelCapabilities(capabilities);
}

function parseApiModels(provider: ProviderId, value: unknown): ProviderModelInfo[] {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Provider model list response is not an object");
	}

	const data: unknown = (value as Record<string, unknown>).data;
	if (!Array.isArray(data)) {
		throw new Error("Provider model list response does not contain data[]");
	}

	const endpointType = getProviderDefaultEndpointType(provider);
	const models: ProviderModelInfo[] = [];
	for (const item of data) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			continue;
		}

		const record: Record<string, unknown> = item as Record<string, unknown>;
		if (typeof record.id !== "string" || record.id.trim().length === 0) {
			continue;
		}

		const id: string = record.id.trim();
		const fallback: ProviderModelInfo | undefined = getProviderFallbackModels(provider)
			.find((model: ProviderModelInfo): boolean => model.id === id);
		const contextWindowTokens: number = inferContextLength(provider, id, record.context_length);
		const model: ProviderModelInfo = {
			id,
			displayName: fallback?.displayName ?? createDisplayName(id),
			provider,
			endpointType: fallback?.endpointType ?? endpointType,
			contextWindowTokens,
			maxOutputTokens: inferMaxOutputTokens(provider, id, contextWindowTokens),
			capabilities: normalizeCapabilities(record, fallback)
		};
		if (typeof record.owned_by === "string") {
			model.ownedBy = record.owned_by;
		} else if (fallback?.ownedBy !== undefined) {
			model.ownedBy = fallback.ownedBy;
		}
		models.push(model);
	}

	if (models.length === 0) {
		throw new Error("Provider model list response contains no usable models");
	}

	return models;
}

export async function fetchOpenAICompatibleModels(options: ProviderChatOptions): Promise<ProviderModelInfo[]> {
	const endpoint: string = `${resolveProviderBaseUrl(options.provider, options.baseUrl)}${getProviderDefinition(options.provider).modelsPath}`;
	const requestFetch: typeof fetch = createProviderRequestOverrideFetch(globalThis.fetch, options.requestOverrides);
	const response: Response = await requestFetch(endpoint, {
		method: "GET",
		headers: {
			"Authorization": `Bearer ${options.apiKey}`
		}
	});

	if (!response.ok) {
		throw new Error(`Model list request failed with HTTP ${response.status}`);
	}

	const body: unknown = await response.json() as unknown;
	return parseApiModels(options.provider, body);
}

function deduplicateModels(models: readonly ProviderModelInfo[]): ProviderModelInfo[] {
	const modelsById: Map<string, ProviderModelInfo> = new Map();
	for (const model of models) {
		modelsById.set(model.id, model);
	}
	return [...modelsById.values()];
}

function toDiscoveredModel(model: ProviderModelInfo): DiscoveredProviderModel {
	const id: string = model.id.trim();
	const displayName: string = model.displayName.trim().slice(0, 120) || id.slice(0, 120);
	const discovered: DiscoveredProviderModel = {
		id,
		displayName,
		contextWindowTokens: model.contextWindowTokens,
		maxOutputTokens: model.maxOutputTokens,
		capabilities: { ...model.capabilities }
	};
	if (model.ownedBy !== undefined) {
		const ownedBy: string = model.ownedBy.trim().slice(0, 200);
		if (ownedBy.length > 0) {
			discovered.ownedBy = ownedBy;
		}
	}
	return discovered;
}

function toImportableDiscoveredModels(models: readonly ProviderModelInfo[]): DiscoveredProviderModel[] {
	return deduplicateModels(models)
		.filter((model: ProviderModelInfo): boolean => {
			const id: string = model.id.trim();
			return id.length > 0
				&& id.length <= 200
				&& Number.isInteger(model.contextWindowTokens)
				&& model.contextWindowTokens > 0
				&& Number.isInteger(model.maxOutputTokens)
				&& model.maxOutputTokens > 0;
		})
		.map(toDiscoveredModel);
}

function getModelRemovalGuards(
	provider: ProviderId,
	modelId: string,
	status: ProviderConfigStatus,
	webSearchSettings: WebSearchSettings
): ProviderModelRemovalGuard[] {
	const guards: ProviderModelRemovalGuard[] = [];
	if (status.activeModel.providerId === provider && status.activeModel.modelId === modelId) {
		guards.push({ kind: "activeModel" });
	}
	const providerStatus = status.providers.find((item): boolean => item.provider === provider);
	if (providerStatus?.model === modelId && !guards.some((guard: ProviderModelRemovalGuard): boolean => guard.kind === "activeModel")) {
		guards.push({ kind: "providerSelection" });
	}
	for (const [task, modelRef] of Object.entries(status.modelRouting) as [
		ProviderTaskModelKind,
		ProviderModelRouting[ProviderTaskModelKind]
	][]) {
		if (modelRef?.provider === provider && modelRef.model === modelId) {
			guards.push({ kind: "taskRouting", task });
		}
	}
	if (webSearchSettings.provider === provider && webSearchSettings.model === modelId) {
		guards.push({ kind: "webSearch" });
	}
	return guards;
}

async function getManagedProviderModels(provider: ProviderId): Promise<ManagedProviderModel[]> {
	const [cache, status, webSearchSettings] = await Promise.all([
		getProviderModelsCache(provider),
		getProviderConfigStatus(),
		getWebSearchSettings()
	]);
	const allModels: ProviderModelInfo[] = mergeProviderModelsWithCatalog(
		provider,
		cache?.models ?? [],
		{ includeExcluded: true }
	);
	const enabledModelIds: Set<string> = new Set(
		mergeProviderModelsWithCatalog(provider, cache?.models ?? []).map((model: ProviderModelInfo): string => model.id)
	);
	return toImportableDiscoveredModels(allModels).map((model: DiscoveredProviderModel): ManagedProviderModel => ({
		...model,
		enabled: enabledModelIds.has(model.id),
		removalGuards: getModelRemovalGuards(provider, model.id, status, webSearchSettings)
	}));
}

function normalizeModelIds(modelIds: readonly string[], fieldName: string): string[] {
	const normalized: string[] = [];
	const seen: Set<string> = new Set();
	for (const value of modelIds) {
		const modelId: string = value.trim();
		if (modelId.length === 0 || modelId.length > 200) {
			throw new ProviderModelSyncError("provider_model_sync_invalid", `${fieldName} contains an invalid model ID.`);
		}
		if (!seen.has(modelId)) {
			seen.add(modelId);
			normalized.push(modelId);
		}
	}
	return normalized;
}

export async function discoverProviderModels(
	provider: ProviderId,
	apiKey: string | undefined,
	baseUrl: string | undefined,
	requestOverrides?: ProviderRequestOverrides | undefined
): Promise<ProviderModelsDiscoverResult> {
	if (!isProviderId(provider)) {
		throw new Error(`Unknown provider: ${provider}`);
	}

	const options: ProviderChatOptions = { provider, apiKey: apiKey ?? "", baseUrl, requestOverrides };
	try {
		const models: ProviderModelInfo[] = deduplicateModels(
			mergeProviderModelsWithCatalog(
				provider,
				await resolveProviderAdapter(options).listModels(options, true),
				{ includeExcluded: true }
			)
		);
		return {
			provider,
			models: toImportableDiscoveredModels(models),
			managedModels: await getManagedProviderModels(provider),
			source: "api"
		};
	} catch (error: unknown) {
		return {
			provider,
			models: toImportableDiscoveredModels(getProviderFallbackModels(provider)),
			managedModels: await getManagedProviderModels(provider),
			source: "fallback",
			error: error instanceof Error ? error.message : "Failed to discover provider models"
		};
	}
}

export async function importProviderModels(
	provider: ProviderId,
	models: readonly DiscoveredProviderModel[]
): Promise<ProviderModelInfo[]> {
	if (!isProviderId(provider)) {
		throw new Error(`Unknown provider: ${provider}`);
	}

	const existing: StoredProviderModelsCache | undefined = await getProviderModelsCache(provider);
	const modelsById: Map<string, ProviderModelInfo> = new Map(
		(existing?.models ?? []).map((model: ProviderModelInfo): [string, ProviderModelInfo] => [model.id, model])
	);
	const endpointType = getProviderDefaultEndpointType(provider);
	for (const model of models) {
		const fallback: ProviderModelInfo | undefined = getCatalogModel(provider, model.id);
		const imported: ProviderModelInfo = {
			id: model.id,
			displayName: model.displayName,
			provider,
			endpointType: fallback?.endpointType ?? endpointType,
			contextWindowTokens: model.contextWindowTokens,
			maxOutputTokens: model.maxOutputTokens,
			capabilities: normalizeProviderModelCapabilities(model.capabilities)
		};
		if (model.ownedBy !== undefined) {
			imported.ownedBy = model.ownedBy;
		}
		modelsById.set(imported.id, imported);
	}

	const mergedModels: ProviderModelInfo[] = [...modelsById.values()];
	if (models.length > 0) {
		await saveProviderModelsCache(provider, mergedModels);
		await ensureCustomProviderDefaultModel(provider, models[0]!.id);
	}
	return mergeProviderModelsWithCatalog(provider, mergedModels);
}

export async function syncProviderModels(input: SyncProviderModelsInput): Promise<ProviderModelInfo[]> {
	if (!isProviderId(input.provider)) {
		throw new ProviderModelSyncError("provider_not_found", `Unknown provider: ${input.provider}`);
	}
	const enableModelIds: string[] = normalizeModelIds(input.enableModelIds, "enableModelIds");
	const removeModelIds: string[] = normalizeModelIds(input.removeModelIds, "removeModelIds");
	const enableModelIdSet: Set<string> = new Set(enableModelIds);
	const removeModelIdSet: Set<string> = new Set(removeModelIds);
	for (const modelId of enableModelIds) {
		if (removeModelIdSet.has(modelId)) {
			throw new ProviderModelSyncError(
				"provider_model_sync_conflict",
				`Model ${modelId} cannot be enabled and removed in the same operation.`
			);
		}
	}

	const upsertModelsById: Map<string, DiscoveredProviderModel> = new Map();
	for (const model of input.upsertModels) {
		const modelId: string = model.id.trim();
		if (modelId.length === 0 || modelId.length > 200) {
			throw new ProviderModelSyncError("provider_model_sync_invalid", "upsertModels contains an invalid model ID.");
		}
		if (removeModelIdSet.has(modelId)) {
			throw new ProviderModelSyncError(
				"provider_model_sync_conflict",
				`Model ${modelId} cannot be upserted and removed in the same operation.`
			);
		}
		upsertModelsById.set(modelId, { ...model, id: modelId });
	}

	const managedModels: ManagedProviderModel[] = await getManagedProviderModels(input.provider);
	const managedById: Map<string, ManagedProviderModel> = new Map(
		managedModels.map((model: ManagedProviderModel): [string, ManagedProviderModel] => [model.id, model])
	);
	for (const modelId of removeModelIds) {
		const model: ManagedProviderModel | undefined = managedById.get(modelId);
		if (model === undefined || !model.enabled) {
			throw new ProviderModelSyncError(
				"provider_model_not_enabled",
				`Model ${modelId} is not currently enabled for provider ${input.provider}.`
			);
		}
		if (model.removalGuards.length > 0) {
			const guardKinds: string = model.removalGuards.map((guard: ProviderModelRemovalGuard): string => {
				return guard.kind === "taskRouting" ? `${guard.kind}:${guard.task}` : guard.kind;
			}).join(", ");
			throw new ProviderModelSyncError(
				"provider_model_in_use",
				`Model ${modelId} cannot be removed because it is referenced by ${guardKinds}.`
			);
		}
	}
	for (const modelId of enableModelIds) {
		if (!managedById.has(modelId) && !upsertModelsById.has(modelId)) {
			throw new ProviderModelSyncError(
				"provider_model_not_found",
				`Model ${modelId} is not available for provider ${input.provider}.`
			);
		}
	}

	const upsertModels: DiscoveredProviderModel[] = [...upsertModelsById.values()];
	if (upsertModels.length > 0) {
		await importProviderModels(input.provider, upsertModels);
	}

	const cache: StoredProviderModelsCache | undefined = await getProviderModelsCache(input.provider);
	const allModels: ProviderModelInfo[] = mergeProviderModelsWithCatalog(
		input.provider,
		cache?.models ?? [],
		{ includeExcluded: true }
	);
	const currentlyEnabled: Set<string> = new Set(
		mergeProviderModelsWithCatalog(input.provider, cache?.models ?? []).map((model: ProviderModelInfo): string => model.id)
	);
	const nextEnabledModelIds: Set<string> = new Set(currentlyEnabled);
	for (const modelId of enableModelIdSet) {
		nextEnabledModelIds.add(modelId);
	}
	for (const modelId of removeModelIdSet) {
		nextEnabledModelIds.delete(modelId);
	}
	const orderedNextModelIds: string[] = allModels
		.map((model: ProviderModelInfo): string => model.id)
		.filter((modelId: string): boolean => nextEnabledModelIds.has(modelId));
	const currentDefaultModel: string | null = getProviderDefinition(input.provider).defaultModel;
	const nextDefaultModel: string | null = isCustomProvider(input.provider)
		? currentDefaultModel !== null && nextEnabledModelIds.has(currentDefaultModel)
			? currentDefaultModel
			: orderedNextModelIds[0] ?? null
		: null;

	await updateProviderModelSelection({
		provider: input.provider,
		enableModelIds,
		removeModelIds,
		nextDefaultModel
	});
	return mergeProviderModelsWithCatalog(input.provider, cache?.models ?? []);
}

export async function listProviderModels(
	provider: ProviderId,
	apiKey: string | undefined,
	baseUrl: string | undefined,
	refresh: boolean = false,
	requestOverrides?: ProviderRequestOverrides | undefined
): Promise<ProviderModelsListResult> {
	if (getProviderDefinition(provider).modelListMode === "catalog-only") {
		return { provider, models: mergeProviderModelsWithCatalog(provider, []), stale: false, source: "fallback" };
	}

	const options: ProviderChatOptions = { provider, apiKey: apiKey ?? "", baseUrl, requestOverrides };
	if (apiKey !== undefined && refresh) {
		try {
			const models: ProviderModelInfo[] = mergeProviderModelsWithCatalog(provider, await resolveProviderAdapter(options).listModels(options, refresh));
			await saveProviderModelsCache(provider, models);
			if (models[0] !== undefined) {
				await ensureCustomProviderDefaultModel(provider, models[0].id);
			}
			return { provider, models, stale: false, source: "api" };
		} catch (error: unknown) {
			const cache: StoredProviderModelsCache | undefined = await getProviderModelsCache(provider);
			if (cache !== undefined) {
				return {
					provider,
					models: mergeProviderModelsWithCatalog(provider, cache.models),
					stale: true,
					source: "cache",
					error: error instanceof Error ? error.message : "Failed to fetch provider models"
				};
			}

			return {
				provider,
				models: mergeProviderModelsWithCatalog(provider, []),
				stale: true,
				source: "fallback",
				error: error instanceof Error ? error.message : "Failed to fetch provider models"
			};
		}
	}

	const cache: StoredProviderModelsCache | undefined = await getProviderModelsCache(provider);
	if (cache !== undefined) {
		return { provider, models: mergeProviderModelsWithCatalog(provider, cache.models), stale: true, source: "cache" };
	}

	if (apiKey !== undefined) {
		try {
			const models: ProviderModelInfo[] = mergeProviderModelsWithCatalog(provider, await resolveProviderAdapter(options).listModels(options));
			await saveProviderModelsCache(provider, models);
			if (models[0] !== undefined) {
				await ensureCustomProviderDefaultModel(provider, models[0].id);
			}
			return { provider, models, stale: false, source: "api" };
		} catch (error: unknown) {
			return {
				provider,
				models: mergeProviderModelsWithCatalog(provider, []),
				stale: true,
				source: "fallback",
				error: error instanceof Error ? error.message : "Failed to fetch provider models"
			};
		}
	}

	return { provider, models: mergeProviderModelsWithCatalog(provider, []), stale: true, source: "fallback" };
}
