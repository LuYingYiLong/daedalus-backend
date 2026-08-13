import type { ProviderId } from "../protocol/types.js";
import { readRuntimeAssetTextSync } from "../runtime/runtime-assets.js";
import {
	getCustomProviderRecord,
	getExcludedModelIds,
	getModelCustomizationRecords,
	getProviderCustomizationsSnapshot,
	type CustomProviderRecord,
	type CustomProviderType,
	type EditableModelCapabilities,
	type ModelCustomizationRecord
} from "./provider-customizations-store.js";
import { normalizeProviderModelCapabilities } from "./provider-types.js";
import type {
	AdapterFamily,
	EndpointType,
	ProviderDefinition,
	ProviderEndpointConfig,
	ProviderModelCapabilities,
	ProviderModelInfo,
	ProviderModelListMode
} from "./provider-types.js";

export type {
	AdapterFamily,
	EndpointType,
	ProviderDefinition,
	ProviderEndpointConfig,
	ProviderModelCapabilities,
	ProviderModelInfo,
	ProviderModelListMode
} from "./provider-types.js";
export { normalizeProviderModelCapabilities } from "./provider-types.js";

type RawProviderCatalogEntry = {
	id: string;
	displayName: string;
	authType: "api-key";
	defaultModel: string;
	defaultEndpointType: EndpointType;
	endpointConfigs: Record<string, ProviderEndpointConfig>;
	modelListMode?: ProviderModelListMode | undefined;
	envBaseUrl?: string | undefined;
	envModel?: string | undefined;
};

type RawEndpointConfig = {
	baseUrl: string;
	adapterFamily: AdapterFamily;
	modelsPath?: string | undefined;
	maxTokensField?: "max_tokens" | "max_completion_tokens" | undefined;
	tokenEstimatePath?: string | undefined;
	requiredToolChoice?: "auto" | "omit" | undefined;
	toolCallsSwitch?: unknown;
	temperature?: {
		min?: unknown;
		max?: unknown;
	} | undefined;
};

type RawModelCatalogEntry = {
	id: string;
	displayName: string;
	provider: string;
	endpointType: EndpointType;
	contextWindowTokens: number;
	maxOutputTokens: number;
	capabilities?: ProviderModelCapabilities | undefined;
	ownedBy?: string | undefined;
};

type ProviderCatalog = {
	providers: Record<ProviderId, ProviderDefinition>;
	models: ProviderModelInfo[];
};

const DEFAULT_MODELS_PATH: string = "/models";
const CUSTOM_MODEL_CONTEXT_WINDOW_TOKENS: number = 128_000;
const CUSTOM_MODEL_MAX_OUTPUT_TOKENS: number = 8_192;
export const DEFAULT_PROVIDER_ID: ProviderId = "deepseek";

function readJsonAsset(assetKey: "provider.providers" | "provider.models"): unknown {
	return JSON.parse(readRuntimeAssetTextSync(assetKey)) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string {
	const value: unknown = record[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`Provider catalog field ${key} must be a non-empty string`);
	}
	return value.trim();
}

function readPositiveInteger(record: Record<string, unknown>, key: string): number {
	const value: unknown = record[key];
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`Provider model catalog field ${key} must be a positive number`);
	}
	return Math.floor(value);
}

function isEndpointType(value: unknown): value is EndpointType {
	return value === "openai-chat-completions" || value === "openai-responses" || value === "anthropic-messages";
}

function isAdapterFamily(value: unknown): value is AdapterFamily {
	return value === "openai-compatible" || value === "openai-responses" || value === "anthropic-compatible";
}

function isProviderModelListMode(value: unknown): value is ProviderModelListMode {
	return value === "api-plus-catalog" || value === "catalog-recommended" || value === "catalog-only";
}

function parseTemperatureConstraint(value: unknown, providerId: string, endpointType: string): ProviderEndpointConfig["temperature"] {
	if (value === undefined) {
		return undefined;
	}
	if (!isRecord(value)) {
		throw new Error(`Provider ${providerId} endpoint ${endpointType} temperature must be an object`);
	}
	const min: unknown = value.min;
	const max: unknown = value.max;
	if (
		typeof min !== "number"
		|| typeof max !== "number"
		|| !Number.isFinite(min)
		|| !Number.isFinite(max)
		|| min < 0
		|| max < min
	) {
		throw new Error(`Provider ${providerId} endpoint ${endpointType} has invalid temperature range`);
	}
	return { min, max };
}

function parseEndpointConfig(value: unknown, providerId: string, endpointType: string): ProviderEndpointConfig {
	if (!isRecord(value)) {
		throw new Error(`Provider ${providerId} endpoint ${endpointType} must be an object`);
	}

	const baseUrl: string = readString(value, "baseUrl");
	const adapterFamilyValue: unknown = value.adapterFamily;
	if (!isAdapterFamily(adapterFamilyValue)) {
		throw new Error(`Provider ${providerId} endpoint ${endpointType} has unsupported adapterFamily`);
	}

	const config: ProviderEndpointConfig = {
		baseUrl,
		adapterFamily: adapterFamilyValue,
		modelsPath: typeof value.modelsPath === "string" && value.modelsPath.trim().length > 0
			? value.modelsPath.trim()
			: DEFAULT_MODELS_PATH
	};
	if (value.maxTokensField !== undefined) {
		if (value.maxTokensField !== "max_tokens" && value.maxTokensField !== "max_completion_tokens") {
			throw new Error(`Provider ${providerId} endpoint ${endpointType} has unsupported maxTokensField`);
		}
		config.maxTokensField = value.maxTokensField;
	}
	if (typeof value.tokenEstimatePath === "string" && value.tokenEstimatePath.trim().length > 0) {
		config.tokenEstimatePath = value.tokenEstimatePath.trim();
	}
	if (value.requiredToolChoice !== undefined) {
		if (value.requiredToolChoice !== "auto" && value.requiredToolChoice !== "omit") {
			throw new Error(`Provider ${providerId} endpoint ${endpointType} has unsupported requiredToolChoice`);
		}
		config.requiredToolChoice = value.requiredToolChoice;
	}
	if (value.toolCallsSwitch !== undefined) {
		if (typeof value.toolCallsSwitch !== "boolean") {
			throw new Error(`Provider ${providerId} endpoint ${endpointType} toolCallsSwitch must be a boolean`);
		}
		config.toolCallsSwitch = value.toolCallsSwitch;
	}
	const temperature = parseTemperatureConstraint(value.temperature, providerId, endpointType);
	if (temperature !== undefined) {
		config.temperature = temperature;
	}
	return config;
}

function parseProviders(value: unknown): RawProviderCatalogEntry[] {
	if (!Array.isArray(value)) {
		throw new Error("Provider catalog must be an array");
	}

	return value.map((item: unknown): RawProviderCatalogEntry => {
		if (!isRecord(item)) {
			throw new Error("Provider catalog entry must be an object");
		}

		const id: string = readString(item, "id");
		const defaultEndpointTypeValue: unknown = item.defaultEndpointType;
		if (!isEndpointType(defaultEndpointTypeValue)) {
			throw new Error(`Provider ${id} has unsupported defaultEndpointType`);
		}

		if (item.authType !== "api-key") {
			throw new Error(`Provider ${id} has unsupported authType`);
		}

		if (!isRecord(item.endpointConfigs)) {
			throw new Error(`Provider ${id} endpointConfigs must be an object`);
		}

		const endpointConfigs: Record<string, ProviderEndpointConfig> = {};
		for (const [endpointType, config] of Object.entries(item.endpointConfigs)) {
			if (!isEndpointType(endpointType)) {
				throw new Error(`Provider ${id} endpoint ${endpointType} is not supported`);
			}
			endpointConfigs[endpointType] = parseEndpointConfig(config, id, endpointType);
		}

		return {
			id,
			displayName: readString(item, "displayName"),
			authType: "api-key",
			defaultModel: readString(item, "defaultModel"),
			defaultEndpointType: defaultEndpointTypeValue,
			endpointConfigs,
			modelListMode: isProviderModelListMode(item.modelListMode) ? item.modelListMode : undefined,
			envBaseUrl: typeof item.envBaseUrl === "string" ? item.envBaseUrl : undefined,
			envModel: typeof item.envModel === "string" ? item.envModel : undefined
		};
	});
}

function parseModels(value: unknown): RawModelCatalogEntry[] {
	if (!Array.isArray(value)) {
		throw new Error("Provider model catalog must be an array");
	}

	return value.map((item: unknown): RawModelCatalogEntry => {
		if (!isRecord(item)) {
			throw new Error("Provider model catalog entry must be an object");
		}

		const endpointTypeValue: unknown = item.endpointType;
		if (!isEndpointType(endpointTypeValue)) {
			throw new Error(`Model ${String(item.id)} has unsupported endpointType`);
		}

		const raw: RawModelCatalogEntry = {
			id: readString(item, "id"),
			displayName: readString(item, "displayName"),
			provider: readString(item, "provider"),
			endpointType: endpointTypeValue,
			contextWindowTokens: readPositiveInteger(item, "contextWindowTokens"),
			maxOutputTokens: readPositiveInteger(item, "maxOutputTokens"),
			capabilities: normalizeProviderModelCapabilities(isRecord(item.capabilities) ? item.capabilities as ProviderModelCapabilities : {}),
			ownedBy: typeof item.ownedBy === "string" ? item.ownedBy : undefined
		};
		return raw;
	});
}

function buildCatalog(): ProviderCatalog {
	const rawProviders: RawProviderCatalogEntry[] = parseProviders(readJsonAsset("provider.providers"));
	const rawModels: RawModelCatalogEntry[] = parseModels(readJsonAsset("provider.models"));
	const providerIds: Set<string> = new Set();
	const modelKeys: Set<string> = new Set();
	const modelsByProvider: Map<string, ProviderModelInfo[]> = new Map();

	for (const provider of rawProviders) {
		if (providerIds.has(provider.id)) {
			throw new Error(`Duplicate provider id in catalog: ${provider.id}`);
		}
		providerIds.add(provider.id);
		if (provider.endpointConfigs[provider.defaultEndpointType] === undefined) {
			throw new Error(`Provider ${provider.id} default endpoint is missing from endpointConfigs`);
		}
	}

	for (const rawModel of rawModels) {
		if (!providerIds.has(rawModel.provider)) {
			throw new Error(`Model ${rawModel.id} references unknown provider ${rawModel.provider}`);
		}
		const key: string = `${rawModel.provider}:${rawModel.id}`;
		if (modelKeys.has(key)) {
			throw new Error(`Duplicate model id in catalog: ${key}`);
		}
		modelKeys.add(key);

		const model: ProviderModelInfo = {
			id: rawModel.id,
			displayName: rawModel.displayName,
			provider: rawModel.provider,
			endpointType: rawModel.endpointType,
			contextWindowTokens: rawModel.contextWindowTokens,
			maxOutputTokens: rawModel.maxOutputTokens,
			capabilities: normalizeProviderModelCapabilities(rawModel.capabilities)
		};
		if (rawModel.ownedBy !== undefined) {
			model.ownedBy = rawModel.ownedBy;
		}
		modelsByProvider.set(rawModel.provider, [...(modelsByProvider.get(rawModel.provider) ?? []), model]);
	}

	const providers: Record<ProviderId, ProviderDefinition> = {};
	for (const rawProvider of rawProviders) {
		const fallbackModels: ProviderModelInfo[] = modelsByProvider.get(rawProvider.id) ?? [];
		if (!fallbackModels.some((model: ProviderModelInfo): boolean => model.id === rawProvider.defaultModel)) {
			throw new Error(`Provider ${rawProvider.id} default model ${rawProvider.defaultModel} is missing from model catalog`);
		}

		const defaultEndpoint: ProviderEndpointConfig = rawProvider.endpointConfigs[rawProvider.defaultEndpointType]!;
		const definition: ProviderDefinition = {
			id: rawProvider.id,
			displayName: rawProvider.displayName,
			authType: rawProvider.authType,
			defaultEndpointType: rawProvider.defaultEndpointType,
			defaultBaseUrl: defaultEndpoint.baseUrl,
			defaultModel: rawProvider.defaultModel,
			modelListMode: rawProvider.modelListMode ?? "api-plus-catalog",
			modelsPath: defaultEndpoint.modelsPath,
			endpointConfigs: rawProvider.endpointConfigs,
			fallbackModels
		};
		if (defaultEndpoint.tokenEstimatePath !== undefined) {
			definition.tokenEstimatePath = defaultEndpoint.tokenEstimatePath;
		}
		if (rawProvider.envBaseUrl !== undefined) {
			definition.envBaseUrl = rawProvider.envBaseUrl;
		}
		if (rawProvider.envModel !== undefined) {
			definition.envModel = rawProvider.envModel;
		}
		providers[rawProvider.id] = definition;
	}

	if (providers[DEFAULT_PROVIDER_ID] === undefined) {
		throw new Error(`Default provider ${DEFAULT_PROVIDER_ID} is missing from catalog`);
	}

	return {
		providers,
		models: rawModels.map((rawModel: RawModelCatalogEntry): ProviderModelInfo => {
			const model = (modelsByProvider.get(rawModel.provider) ?? []).find((item: ProviderModelInfo): boolean => item.id === rawModel.id);
			if (model === undefined) {
				throw new Error(`Model ${rawModel.provider}:${rawModel.id} failed catalog normalization`);
			}
			return model;
		})
	};
}

function getCustomProviderEndpoint(providerType: CustomProviderType): {
	endpointType: EndpointType;
	adapterFamily: AdapterFamily;
} {
	switch (providerType) {
		case "openai":
			return {
				endpointType: "openai-chat-completions",
				adapterFamily: "openai-compatible"
			};
		case "openai-responses":
			return {
				endpointType: "openai-responses",
				adapterFamily: "openai-responses"
			};
		case "anthropic":
			return {
				endpointType: "anthropic-messages",
				adapterFamily: "anthropic-compatible"
			};
	}
}

function applyEditableCapabilities(
	base: ProviderModelCapabilities,
	editable: EditableModelCapabilities
): ProviderModelCapabilities {
	const capabilities: ProviderModelCapabilities = { ...base };
	delete capabilities.vision;
	for (const key of [
		"imageInput",
		"videoInput",
		"reasoning",
		"tools",
		"webSearch",
		"imageGeneration",
		"imageEdit"
	] as const) {
		if (editable[key] !== undefined) {
			capabilities[key] = editable[key];
		}
	}
	return normalizeProviderModelCapabilities(capabilities);
}

function applyModelCustomizations(
	provider: ProviderId,
	models: readonly ProviderModelInfo[],
	defaultEndpointType: EndpointType
): ProviderModelInfo[] {
	const customizations: Record<string, ModelCustomizationRecord> = getModelCustomizationRecords(provider);
	const seen: Set<string> = new Set();
	const result: ProviderModelInfo[] = models.map((model: ProviderModelInfo): ProviderModelInfo => {
		seen.add(model.id);
		const baseModel: ProviderModelInfo = { ...model };
		delete baseModel.customization;
		const customization: ModelCustomizationRecord | undefined = customizations[model.id];
		if (customization === undefined) {
			return {
				...baseModel,
				capabilities: { ...model.capabilities }
			};
		}
		const customizedModel: ProviderModelInfo = {
			...baseModel,
			capabilities: applyEditableCapabilities(model.capabilities, customization.capabilities),
			customization: {
				...customization,
				capabilities: { ...customization.capabilities }
			}
		};
		if (customization.displayName !== undefined) {
			customizedModel.displayName = customization.displayName;
		}
		if (customization.contextWindowTokens !== undefined) {
			customizedModel.contextWindowTokens = customization.contextWindowTokens;
		}
		if (customization.maxOutputTokens !== undefined) {
			customizedModel.maxOutputTokens = customization.maxOutputTokens;
		}
		return customizedModel;
	});

	for (const [modelId, customization] of Object.entries(customizations)) {
		if (customization.source !== "custom" || seen.has(modelId)) {
			continue;
		}
		result.push({
			id: modelId,
			displayName: customization.displayName ?? modelId,
			provider,
			endpointType: defaultEndpointType,
			contextWindowTokens: customization.contextWindowTokens ?? CUSTOM_MODEL_CONTEXT_WINDOW_TOKENS,
			maxOutputTokens: customization.maxOutputTokens ?? CUSTOM_MODEL_MAX_OUTPUT_TOKENS,
			capabilities: applyEditableCapabilities({}, customization.capabilities),
			customization: {
				...customization,
				capabilities: { ...customization.capabilities }
			}
		});
	}
	return result;
}

function createCustomProviderDefinition(provider: ProviderId, record: CustomProviderRecord): ProviderDefinition {
	const endpoint = getCustomProviderEndpoint(record.providerType);
	const endpointConfig: ProviderEndpointConfig = {
		baseUrl: "",
		adapterFamily: endpoint.adapterFamily,
		modelsPath: DEFAULT_MODELS_PATH
	};
	return {
		id: provider,
		displayName: record.displayName,
		authType: "api-key",
		defaultEndpointType: endpoint.endpointType,
		defaultBaseUrl: "",
		defaultModel: record.defaultModel,
		modelListMode: "api-plus-catalog",
		modelsPath: DEFAULT_MODELS_PATH,
		endpointConfigs: {
			[endpoint.endpointType]: endpointConfig
		},
		fallbackModels: applyModelCustomizations(provider, [], endpoint.endpointType)
	};
}

const CATALOG: ProviderCatalog = buildCatalog();
export const PROVIDER_DEFINITIONS: Record<ProviderId, ProviderDefinition> = CATALOG.providers;

export function getProviderIds(): ProviderId[] {
	return [
		...Object.keys(CATALOG.providers),
		...Object.keys(getProviderCustomizationsSnapshot().providers)
	];
}

export function getProviderDefinition(provider: ProviderId): ProviderDefinition {
	const definition: ProviderDefinition | undefined = CATALOG.providers[provider];
	if (definition !== undefined) {
		return {
			...definition,
			fallbackModels: applyModelCustomizations(provider, definition.fallbackModels, definition.defaultEndpointType)
		};
	}
	const customProvider: CustomProviderRecord | undefined = getCustomProviderRecord(provider);
	if (customProvider !== undefined) {
		return createCustomProviderDefinition(provider, customProvider);
	}
	throw new Error(`Unknown provider: ${provider}`);
}

export function getProviderDisplayName(provider: ProviderId): string {
	return getProviderDefinition(provider).displayName;
}

export function getProviderDefaultEndpointType(provider: ProviderId): EndpointType {
	return getProviderDefinition(provider).defaultEndpointType;
}

export function getProviderEndpointConfig(provider: ProviderId, endpointType?: EndpointType | undefined): ProviderEndpointConfig {
	const definition: ProviderDefinition = getProviderDefinition(provider);
	const resolvedEndpointType: EndpointType = endpointType ?? definition.defaultEndpointType;
	const endpointConfig: ProviderEndpointConfig | undefined = definition.endpointConfigs[resolvedEndpointType];
	if (endpointConfig === undefined) {
		throw new Error(`Provider ${provider} does not define endpoint ${resolvedEndpointType}`);
	}
	return endpointConfig;
}

export function getProviderAdapterFamily(provider: ProviderId, endpointType?: EndpointType | undefined): AdapterFamily {
	return getProviderEndpointConfig(provider, endpointType).adapterFamily;
}

export function getProviderEndpointTypeForModel(provider: ProviderId, modelId?: string | undefined): EndpointType {
	if (modelId !== undefined && modelId.trim().length > 0) {
		return getCatalogModel(provider, modelId)?.endpointType ?? getProviderDefaultEndpointType(provider);
	}
	return getProviderDefaultEndpointType(provider);
}

export function getProviderAdapterFamilyForModel(provider: ProviderId, modelId?: string | undefined): AdapterFamily {
	return getProviderAdapterFamily(provider, getProviderEndpointTypeForModel(provider, modelId));
}

export function getProviderDefaultBaseUrl(provider: ProviderId): string {
	const definition: ProviderDefinition = getProviderDefinition(provider);
	const envBaseUrl: string | undefined = definition.envBaseUrl !== undefined ? process.env[definition.envBaseUrl] : undefined;
	return envBaseUrl !== undefined && envBaseUrl.trim().length > 0 ? envBaseUrl.trim() : definition.defaultBaseUrl;
}

export function getProviderDefaultModel(provider: ProviderId): string {
	const definition: ProviderDefinition = getProviderDefinition(provider);
	const envModel: string | undefined = definition.envModel !== undefined ? process.env[definition.envModel] : undefined;
	const model: string | null = envModel !== undefined && envModel.trim().length > 0 ? envModel.trim() : definition.defaultModel;
	if (model === null) {
		throw new Error(`provider_not_ready: Provider ${provider} has no models.`);
	}
	return model;
}

export function getProviderDefaultModelOrNull(provider: ProviderId): string | null {
	const definition: ProviderDefinition = getProviderDefinition(provider);
	const envModel: string | undefined = definition.envModel !== undefined ? process.env[definition.envModel] : undefined;
	return envModel !== undefined && envModel.trim().length > 0 ? envModel.trim() : definition.defaultModel;
}

export function getProviderFallbackModels(provider: ProviderId): ProviderModelInfo[] {
	return getProviderDefinition(provider).fallbackModels.map((model: ProviderModelInfo): ProviderModelInfo => ({
		...model,
		capabilities: { ...model.capabilities }
	}));
}

export type MergeProviderModelsOptions = {
	includeExcluded?: boolean | undefined;
};

export function mergeProviderModelsWithCatalog(
	provider: ProviderId,
	models: ProviderModelInfo[],
	options: MergeProviderModelsOptions = {}
): ProviderModelInfo[] {
	const definition: ProviderDefinition = getProviderDefinition(provider);
	const fallbackModels: ProviderModelInfo[] = getProviderFallbackModels(provider);
	let mergedModels: ProviderModelInfo[];
	if (definition.modelListMode === "catalog-recommended" || definition.modelListMode === "catalog-only") {
		mergedModels = fallbackModels;
	} else {
		const fallbackById: Map<string, ProviderModelInfo> = new Map(
			fallbackModels.map((model: ProviderModelInfo): [string, ProviderModelInfo] => [model.id, model])
		);
		const seenModelIds: Set<string> = new Set();
		mergedModels = models.map((model: ProviderModelInfo): ProviderModelInfo => {
			seenModelIds.add(model.id);
			const fallback: ProviderModelInfo | undefined = fallbackById.get(model.id);
			return {
				...model,
				capabilities: normalizeProviderModelCapabilities({
					...(fallback?.capabilities ?? {}),
					...model.capabilities
				})
			};
		});

		for (const fallbackModel of fallbackModels) {
			if (!seenModelIds.has(fallbackModel.id)) {
				mergedModels.push(fallbackModel);
			}
		}
	}

	const customizedModels: ProviderModelInfo[] = applyModelCustomizations(provider, mergedModels, definition.defaultEndpointType);
	if (options.includeExcluded === true) {
		return customizedModels;
	}
	const excludedModelIds: Set<string> = new Set(getExcludedModelIds(provider));
	return excludedModelIds.size === 0
		? customizedModels
		: customizedModels.filter((model: ProviderModelInfo): boolean => !excludedModelIds.has(model.id));
}

export function getCatalogModel(provider: ProviderId, modelId: string): ProviderModelInfo | undefined {
	return getProviderFallbackModels(provider).find((model: ProviderModelInfo): boolean => model.id === modelId);
}

export function getCatalogModels(): ProviderModelInfo[] {
	return getProviderIds().flatMap((provider: ProviderId): ProviderModelInfo[] => getProviderFallbackModels(provider));
}

export function isProviderId(value: unknown): value is ProviderId {
	return typeof value === "string"
		&& (CATALOG.providers[value] !== undefined || getCustomProviderRecord(value) !== undefined);
}

export function isCustomProvider(provider: ProviderId): boolean {
	return getCustomProviderRecord(provider) !== undefined;
}

export function getCustomProviderType(provider: ProviderId): CustomProviderType | null {
	return getCustomProviderRecord(provider)?.providerType ?? null;
}
