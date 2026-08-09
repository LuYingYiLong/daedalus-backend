import { randomUUID } from "node:crypto";
import type { ProviderId } from "../protocol/types.js";
import {
	getProviderModelsCache
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
	getProviderDisplayName,
	getProviderIds,
	isProviderId,
	mergeProviderModelsWithCatalog,
	type ProviderModelInfo
} from "./provider-registry.js";

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
};

export type AddCustomModelInput = {
	provider: ProviderId;
	id: string;
	displayName: string;
};

export type UpdateModelCustomizationInput = AddCustomModelInput & {
	capabilities: EditableModelCapabilities;
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
			defaultModel: null,
			createdAt: now,
			updatedAt: now
		};
	});
	return providerId;
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
			capabilities: {
				vision: false,
				webSearch: false,
				reasoning: false,
				tools: false
			},
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
	const displayName: string = normalizeRequiredString(input.displayName, "Model name", 120);
	const models: ProviderModelInfo[] = await getEffectiveProviderModels(provider);
	if (!models.some((model: ProviderModelInfo): boolean => model.id === id)) {
		throw new ProviderCustomizationError(
			"provider_model_not_found",
			`Model ${id} does not exist for provider ${provider}.`
		);
	}

	const existing: ModelCustomizationRecord | undefined = getModelCustomizationRecords(provider)[id];
	const now: string = new Date().toISOString();
	await updateProviderCustomizations((draft: ProviderCustomizations): void => {
		const providerModels: Record<string, ModelCustomizationRecord> = draft.models[provider] ?? {};
		providerModels[id] = {
			source: existing?.source ?? "override",
			displayName,
			capabilities: {
				vision: input.capabilities.vision,
				webSearch: input.capabilities.webSearch,
				reasoning: input.capabilities.reasoning,
				tools: input.capabilities.tools
			},
			updatedAt: now
		};
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
