import { randomUUID } from "node:crypto";
import type { ProviderId } from "../protocol/types.js";
import {
	getProviderModelsCache,
	saveProviderModelsCache
} from "./provider-config-store.js";
import {
	getCustomProviderRecord,
	getExcludedModelIds,
	getModelCustomizationRecords,
	initializeProviderCustomizations,
	updateProviderCustomizations,
	type CustomProviderType,
	type EditableModelCapabilities,
	type ModelCustomizationRecord,
	type ProviderCustomizations
} from "./provider-customizations-store.js";
import {
	getProviderDefaultEndpointType,
	getProviderDisplayName,
	getProviderIds,
	isProviderId,
	mergeProviderModelsWithCatalog,
	type ProviderModelInfo
} from "./provider-registry.js";
import type { BaseReasoningEffort, ProviderReasoningEffortOption } from "./provider-types.js";
import { normalizeProviderWebsiteUrl } from "./provider-website.js";

export class ProviderCustomizationError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "ProviderCustomizationError";
		this.code = code;
	}
}

export type AddCustomProviderInput = {
	displayName: string;
	providerType: CustomProviderType;
	websiteUrl?: string | null | undefined;
};

export type UpdateCustomProviderInput = {
	provider: ProviderId;
	displayName: string;
	providerType: CustomProviderType;
	websiteUrl?: string | null | undefined;
};

export type AddCustomModelInput = {
	provider: ProviderId;
	id: string;
	displayName: string;
	contextWindowTokens: number;
	maxOutputTokens: number;
	capabilities: {
		[K in keyof EditableModelCapabilities]-?: boolean;
	};
	reasoningEfforts: ProviderReasoningEffortOption[];
};

type ModelCapabilityUpdate = {
	[K in keyof EditableModelCapabilities]-?: boolean | null;
};

export type UpdateModelCustomizationInput = {
	provider: ProviderId;
	id: string;
	displayName: string | null;
	contextWindowTokens: number | null;
	maxOutputTokens: number | null;
	capabilities: ModelCapabilityUpdate;
	reasoningEfforts: ProviderReasoningEffortOption[] | null;
};

export type UpdateProviderModelSelectionInput = {
	provider: ProviderId;
	enableModelIds: readonly string[];
	removeModelIds: readonly string[];
	nextDefaultModel: string | null;
};

function normalizeRequiredString(value: string, fieldName: string, maxLength: number): string {
	const normalized: string = value.trim();
	if (normalized.length === 0 || normalized.length > maxLength) {
		throw new ProviderCustomizationError(
			"provider_customization_invalid",
			`${fieldName} must contain between 1 and ${maxLength} characters.`
		);
	}
	return normalized;
}

function createCustomProviderId(): ProviderId {
	return `custom-${randomUUID()}`;
}

async function getEffectiveProviderModels(provider: ProviderId): Promise<ProviderModelInfo[]> {
	const cache = await getProviderModelsCache(provider);
	return mergeProviderModelsWithCatalog(provider, cache?.models ?? []);
}

export async function addCustomProvider(input: AddCustomProviderInput): Promise<ProviderId> {
	await initializeProviderCustomizations();
	const displayName: string = normalizeRequiredString(input.displayName, "Provider name", 80);
	const websiteUrl: string | undefined = normalizeWebsiteUrl(input.websiteUrl);
	const nameKey: string = displayName.toLocaleLowerCase();
	if (getProviderIds().some((provider: ProviderId): boolean => getProviderDisplayName(provider).toLocaleLowerCase() === nameKey)) {
		throw new ProviderCustomizationError(
			"provider_name_conflict",
			`A provider named ${displayName} already exists.`
		);
	}

	const providerId: ProviderId = createCustomProviderId();
	const now: string = new Date().toISOString();
	await updateProviderCustomizations((draft: ProviderCustomizations): void => {
		if (Object.values(draft.providers).some((provider): boolean => provider.displayName.toLocaleLowerCase() === nameKey)) {
			throw new ProviderCustomizationError(
				"provider_name_conflict",
				`A provider named ${displayName} already exists.`
			);
		}
		draft.providers[providerId] = {
			displayName,
			providerType: input.providerType,
			websiteUrl: websiteUrl ?? null,
			defaultModel: null,
			createdAt: now,
			updatedAt: now
		};
	});
	return providerId;
}

export async function updateCustomProvider(input: UpdateCustomProviderInput): Promise<void> {
	await initializeProviderCustomizations();
	if (!isProviderId(input.provider) || getCustomProviderRecord(input.provider) === undefined) {
		throw new ProviderCustomizationError("provider_not_custom", `Provider ${input.provider} is not a custom provider.`);
	}
	const displayName: string = normalizeRequiredString(input.displayName, "Provider name", 80);
	const websiteUrl: string | undefined = normalizeWebsiteUrl(input.websiteUrl);
	const nameKey: string = displayName.toLocaleLowerCase();
	if (getProviderIds().some((provider: ProviderId): boolean => {
		return provider !== input.provider && getProviderDisplayName(provider).toLocaleLowerCase() === nameKey;
	})) {
		throw new ProviderCustomizationError(
			"provider_name_conflict",
			`A provider named ${displayName} already exists.`
		);
	}

	const previousProviderType: CustomProviderType = getCustomProviderRecord(input.provider)!.providerType;
	await updateProviderCustomizations((draft: ProviderCustomizations): void => {
		const record = draft.providers[input.provider];
		if (record === undefined) {
			throw new ProviderCustomizationError("provider_not_custom", `Provider ${input.provider} is not a custom provider.`);
		}
		record.displayName = displayName;
		record.providerType = input.providerType;
		record.websiteUrl = websiteUrl ?? null;
		record.updatedAt = new Date().toISOString();
	});

	if (previousProviderType !== input.providerType) {
		const cached = await getProviderModelsCache(input.provider);
		if (cached !== undefined) {
			const endpointType = getProviderDefaultEndpointType(input.provider);
			await saveProviderModelsCache(input.provider, cached.models.map((model: ProviderModelInfo): ProviderModelInfo => ({
				...model,
				endpointType
			})));
		}
	}
}

function normalizePositiveInteger(value: number, fieldName: string): number {
	if (!Number.isInteger(value) || value <= 0 || value > 2_000_000_000) {
		throw new ProviderCustomizationError(
			"provider_customization_invalid",
			`${fieldName} must be a positive integer.`
		);
	}
	return value;
}

function normalizeCapabilityOverrides(
	capabilities: EditableModelCapabilities
): EditableModelCapabilities {
	const normalized: EditableModelCapabilities = {};
	for (const key of [
		"imageInput",
		"videoInput",
		"reasoning",
		"tools",
		"webSearch",
		"imageGeneration",
		"imageEdit"
	] as const) {
		if (typeof capabilities[key] === "boolean") {
			normalized[key] = capabilities[key];
		}
	}
	return normalized;
}

function normalizeWebsiteUrl(value: string | null | undefined): string | undefined {
	try {
		return normalizeProviderWebsiteUrl(value);
	} catch (error: unknown) {
		throw new ProviderCustomizationError(
			"provider_website_invalid",
			error instanceof Error ? error.message : "Provider website URL is invalid."
		);
	}
}

function normalizeReasoningEfforts(
	efforts: readonly ProviderReasoningEffortOption[]
): ProviderReasoningEffortOption[] {
	if (efforts.length > 16) {
		throw new ProviderCustomizationError(
			"provider_customization_invalid",
			"Reasoning effort options cannot contain more than 16 entries."
		);
	}
	const normalized: ProviderReasoningEffortOption[] = [];
	const ids: Set<string> = new Set();
	let defaultSeen: boolean = false;
	for (const effort of efforts) {
		const id: string = normalizeRequiredString(effort.id, "Reasoning effort ID", 32);
		const fallback: BaseReasoningEffort = effort.fallback;
		if (ids.has(id) || (effort.default === true && defaultSeen)) {
			throw new ProviderCustomizationError(
				"provider_customization_invalid",
				ids.has(id)
					? `Reasoning effort ID ${id} is duplicated.`
					: "Only one reasoning effort can be the default."
			);
		}
		ids.add(id);
		defaultSeen ||= effort.default === true;
		normalized.push({
			id,
			fallback,
			...(effort.default === true ? { default: true } : {})
		});
	}
	return normalized;
}

function hasModelOverrides(record: ModelCustomizationRecord): boolean {
	return record.displayName !== undefined
		|| record.contextWindowTokens !== undefined
		|| record.maxOutputTokens !== undefined
		|| record.reasoningEfforts !== undefined
		|| Object.keys(record.capabilities).length > 0;
}

export async function removeCustomProvider(provider: ProviderId): Promise<void> {
	await initializeProviderCustomizations();
	if (!isProviderId(provider) || getCustomProviderRecord(provider) === undefined) {
		throw new ProviderCustomizationError("provider_not_custom", `Provider ${provider} is not a custom provider.`);
	}
	await updateProviderCustomizations((draft: ProviderCustomizations): void => {
		delete draft.providers[provider];
		delete draft.models[provider];
		delete draft.excludedModelIds[provider];
	});
}

export async function addCustomModel(input: AddCustomModelInput): Promise<void> {
	await initializeProviderCustomizations();
	const provider: ProviderId = input.provider;
	if (!isProviderId(provider)) {
		throw new ProviderCustomizationError("provider_not_found", `Unknown provider: ${provider}`);
	}
	const id: string = normalizeRequiredString(input.id, "Model ID", 200);
	const displayName: string = normalizeRequiredString(input.displayName, "Model name", 120);
	const contextWindowTokens: number = normalizePositiveInteger(input.contextWindowTokens, "Context window tokens");
	const maxOutputTokens: number = normalizePositiveInteger(input.maxOutputTokens, "Maximum output tokens");
	const capabilities: EditableModelCapabilities = normalizeCapabilityOverrides(input.capabilities);
	const reasoningEfforts: ProviderReasoningEffortOption[] = capabilities.reasoning === false
		? []
		: normalizeReasoningEfforts(input.reasoningEfforts);
	const models: ProviderModelInfo[] = await getEffectiveProviderModels(provider);
	if (models.some((model: ProviderModelInfo): boolean => model.id === id)) {
		throw new ProviderCustomizationError(
			"provider_model_exists",
			`Model ${id} already exists for provider ${provider}.`
		);
	}

	const now: string = new Date().toISOString();
	await updateProviderCustomizations((draft: ProviderCustomizations): void => {
		const providerModels: Record<string, ModelCustomizationRecord> = draft.models[provider] ?? {};
		if (providerModels[id] !== undefined) {
			throw new ProviderCustomizationError(
				"provider_model_exists",
				`Model ${id} already exists for provider ${provider}.`
			);
		}
		providerModels[id] = {
			source: "custom",
			displayName,
			contextWindowTokens,
			maxOutputTokens,
			capabilities,
			reasoningEfforts,
			updatedAt: now
		};
		draft.models[provider] = providerModels;
		const customProvider = draft.providers[provider];
		if (customProvider !== undefined && customProvider.defaultModel === null) {
			customProvider.defaultModel = id;
			customProvider.updatedAt = now;
		}
	});
}

export async function updateModelCustomization(input: UpdateModelCustomizationInput): Promise<void> {
	await initializeProviderCustomizations();
	const provider: ProviderId = input.provider;
	if (!isProviderId(provider)) {
		throw new ProviderCustomizationError("provider_not_found", `Unknown provider: ${provider}`);
	}
	const id: string = normalizeRequiredString(input.id, "Model ID", 200);
	const models: ProviderModelInfo[] = await getEffectiveProviderModels(provider);
	if (!models.some((model: ProviderModelInfo): boolean => model.id === id)) {
		throw new ProviderCustomizationError(
			"provider_model_not_found",
			`Model ${id} does not exist for provider ${provider}.`
		);
	}

	const existing: ModelCustomizationRecord | undefined = getModelCustomizationRecords(provider)[id];
	const source: ModelCustomizationRecord["source"] = existing?.source ?? "override";
	const displayName: string | undefined = input.displayName === null
		? undefined
		: normalizeRequiredString(input.displayName, "Model name", 120);
	const contextWindowTokens: number | undefined = input.contextWindowTokens === null
		? undefined
		: normalizePositiveInteger(input.contextWindowTokens, "Context window tokens");
	const maxOutputTokens: number | undefined = input.maxOutputTokens === null
		? undefined
		: normalizePositiveInteger(input.maxOutputTokens, "Maximum output tokens");
	if (source === "custom" && (displayName === undefined || contextWindowTokens === undefined || maxOutputTokens === undefined)) {
		throw new ProviderCustomizationError(
			"provider_customization_invalid",
			"Custom models require a name, context window, and maximum output token limit."
		);
	}
	const capabilities: EditableModelCapabilities = { ...(existing?.capabilities ?? {}) };
	for (const [key, value] of Object.entries(input.capabilities)) {
		const capabilityKey: keyof EditableModelCapabilities = key as keyof EditableModelCapabilities;
		if (value === null) {
			delete capabilities[capabilityKey];
		} else if (typeof value === "boolean") {
			capabilities[capabilityKey] = value;
		}
	}
	const reasoningEfforts: ProviderReasoningEffortOption[] | undefined = capabilities.reasoning === false
		? []
		: input.reasoningEfforts === null
			? undefined
			: normalizeReasoningEfforts(input.reasoningEfforts);
	if (source === "custom" && reasoningEfforts === undefined) {
		throw new ProviderCustomizationError(
			"provider_customization_invalid",
			"Custom models require explicit reasoning effort options."
		);
	}
	const now: string = new Date().toISOString();
	await updateProviderCustomizations((draft: ProviderCustomizations): void => {
		const providerModels: Record<string, ModelCustomizationRecord> = draft.models[provider] ?? {};
		const record: ModelCustomizationRecord = {
			source,
			capabilities,
			updatedAt: now
		};
		if (displayName !== undefined) {
			record.displayName = displayName;
		}
		if (contextWindowTokens !== undefined) {
			record.contextWindowTokens = contextWindowTokens;
		}
		if (maxOutputTokens !== undefined) {
			record.maxOutputTokens = maxOutputTokens;
		}
		if (reasoningEfforts !== undefined) {
			record.reasoningEfforts = reasoningEfforts;
		}
		if (source === "override" && !hasModelOverrides(record)) {
			delete providerModels[id];
			if (Object.keys(providerModels).length === 0) {
				delete draft.models[provider];
			} else {
				draft.models[provider] = providerModels;
			}
			return;
		}
		providerModels[id] = record;
		draft.models[provider] = providerModels;
	});
}

export async function ensureCustomProviderDefaultModel(provider: ProviderId, modelId: string): Promise<void> {
	await initializeProviderCustomizations();
	const customProvider = getCustomProviderRecord(provider);
	if (customProvider === undefined || customProvider.defaultModel !== null) {
		return;
	}
	const normalizedModelId: string = normalizeRequiredString(modelId, "Model ID", 200);
	const now: string = new Date().toISOString();
	await updateProviderCustomizations((draft: ProviderCustomizations): void => {
		const providerRecord = draft.providers[provider];
		if (providerRecord !== undefined && providerRecord.defaultModel === null) {
			providerRecord.defaultModel = normalizedModelId;
			providerRecord.updatedAt = now;
		}
	});
}

export async function updateProviderModelSelection(input: UpdateProviderModelSelectionInput): Promise<void> {
	await initializeProviderCustomizations();
	if (!isProviderId(input.provider)) {
		throw new ProviderCustomizationError("provider_not_found", `Unknown provider: ${input.provider}`);
	}
	const enableModelIds: Set<string> = new Set(
		input.enableModelIds.map((modelId: string): string => normalizeRequiredString(modelId, "Model ID", 200))
	);
	const removeModelIds: Set<string> = new Set(
		input.removeModelIds.map((modelId: string): string => normalizeRequiredString(modelId, "Model ID", 200))
	);
	for (const modelId of enableModelIds) {
		if (removeModelIds.has(modelId)) {
			throw new ProviderCustomizationError(
				"provider_model_selection_conflict",
				`Model ${modelId} cannot be enabled and removed in the same operation.`
			);
		}
	}
	const nextDefaultModel: string | null = input.nextDefaultModel === null
		? null
		: normalizeRequiredString(input.nextDefaultModel, "Default model ID", 200);
	const now: string = new Date().toISOString();
	await updateProviderCustomizations((draft: ProviderCustomizations): void => {
		const excluded: Set<string> = new Set(draft.excludedModelIds[input.provider] ?? []);
		for (const modelId of enableModelIds) {
			excluded.delete(modelId);
		}
		for (const modelId of removeModelIds) {
			excluded.add(modelId);
		}
		const sortedExcluded: string[] = [...excluded].sort((left: string, right: string): number => left.localeCompare(right));
		if (sortedExcluded.length === 0) {
			delete draft.excludedModelIds[input.provider];
		} else {
			draft.excludedModelIds[input.provider] = sortedExcluded;
		}

		const customProvider = draft.providers[input.provider];
		if (customProvider !== undefined && customProvider.defaultModel !== nextDefaultModel) {
			customProvider.defaultModel = nextDefaultModel;
			customProvider.updatedAt = now;
		}
	});
}

export function isProviderModelExcluded(provider: ProviderId, modelId: string): boolean {
	return getExcludedModelIds(provider).includes(modelId);
}

export function getProviderReadiness(provider: ProviderId, models: readonly ProviderModelInfo[]): boolean {
	return isProviderId(provider) && models.length > 0;
}
