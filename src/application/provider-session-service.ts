import type { ModelProfile, ProviderId } from "../protocol/types.js";
import { getDefaultModelProfile, resolveModelProfile } from "../tokens/model-profiles.js";
import { getProviderDefaultModel } from "../providers/provider-registry.js";
import { loadProviderConfigWithSecret, type ProviderConfigWithSecret } from "../providers/provider-config-store.js";
import { normalizeConfiguredProviderBaseUrl } from "../providers/provider-base-url.js";
import { cloneProviderRequestOverrides, type ProviderRequestOverrides } from "../providers/provider-request-overrides.js";

export type ProviderSessionRuntime = {
	activeProvider: ProviderId;
	providerApiKey?: string | undefined;
	providerModel?: string | undefined;
	providerBaseUrl?: string | undefined;
	providerRequestOverrides?: ProviderRequestOverrides | undefined;
	modelProfile: ModelProfile;
};

export function applyProviderConfigToRuntime(runtime: ProviderSessionRuntime, config: ProviderConfigWithSecret): void {
	runtime.activeProvider = config.provider;
	runtime.providerApiKey = config.apiKey;
	runtime.providerModel = config.model ?? getProviderDefaultModel(config.provider);
	runtime.providerBaseUrl = normalizeConfiguredProviderBaseUrl(config.baseUrl);
	runtime.providerRequestOverrides = cloneProviderRequestOverrides(config.requestOverrides);
	runtime.modelProfile = resolveModelProfile(config.provider, config.model ?? getProviderDefaultModel(config.provider));
}

export async function ensureProviderConfigured(runtime: ProviderSessionRuntime): Promise<string | undefined> {
	if (runtime.providerApiKey !== undefined) {
		return runtime.providerApiKey;
	}

	const config: ProviderConfigWithSecret | null = await loadProviderConfigWithSecret(runtime.activeProvider);
	if (config === null || config.apiKey === undefined) {
		return undefined;
	}

	runtime.providerApiKey = config.apiKey;
	runtime.providerBaseUrl = normalizeConfiguredProviderBaseUrl(config.baseUrl);
	runtime.providerRequestOverrides = cloneProviderRequestOverrides(config.requestOverrides);
	const model: string = runtime.providerModel ?? config.model ?? getProviderDefaultModel(runtime.activeProvider);
	runtime.providerModel = model;
	runtime.modelProfile = resolveModelProfile(runtime.activeProvider, model);
	return runtime.providerApiKey;
}

export function resetProviderRuntime(runtime: ProviderSessionRuntime, provider: ProviderId): void {
	runtime.activeProvider = provider;
	runtime.providerApiKey = undefined;
	runtime.providerModel = undefined;
	runtime.providerBaseUrl = undefined;
	runtime.providerRequestOverrides = undefined;
	runtime.modelProfile = getDefaultModelProfile(provider);
}
