import type { ProviderId } from "../protocol/types.js";
import {
	getProviderDefinition,
	getProviderFallbackModels,
	getProviderDefaultEndpointType,
	mergeProviderModelsWithCatalog,
	type ProviderModelCapabilities,
	type ProviderModelInfo,
	normalizeProviderModelCapabilities
} from "./provider-registry.js";
import { getProviderModelsCache, saveProviderModelsCache, type StoredProviderModelsCache } from "./provider-config-store.js";
import { ensureCustomProviderDefaultModel } from "./provider-customizations-service.js";
import { resolveProviderBaseUrl } from "./provider-base-url.js";
import type { ProviderChatOptions } from "./provider-types.js";
import { resolveProviderAdapter } from "./provider-adapter.js";
import "./provider-adapters.js";

export type ProviderModelsListResult = {
	provider: ProviderId;
	models: ProviderModelInfo[];
	stale: boolean;
	source: "api" | "cache" | "fallback";
	error?: string | undefined;
};

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
	const response: Response = await fetch(endpoint, {
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

export async function listProviderModels(
	provider: ProviderId,
	apiKey: string | undefined,
	baseUrl: string | undefined,
	refresh: boolean = false
): Promise<ProviderModelsListResult> {
	if (getProviderDefinition(provider).modelListMode === "catalog-only") {
		return { provider, models: getProviderFallbackModels(provider), stale: false, source: "fallback" };
	}

	const options: ProviderChatOptions = { provider, apiKey: apiKey ?? "", baseUrl };
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
				models: getProviderFallbackModels(provider),
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
				models: getProviderFallbackModels(provider),
				stale: true,
				source: "fallback",
				error: error instanceof Error ? error.message : "Failed to fetch provider models"
			};
		}
	}

	return { provider, models: getProviderFallbackModels(provider), stale: true, source: "fallback" };
}
