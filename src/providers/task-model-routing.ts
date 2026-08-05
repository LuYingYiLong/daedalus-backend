import type { ProviderChatOptions } from "./provider-types.js";
import {
	createEmptyModelRouting,
	getProviderConfigStatus,
	loadProviderConfigWithSecret,
	type ProviderConfigStatus,
	type ProviderModelRouting,
	type ProviderTaskModelRef
} from "./provider-config-store.js";
import { getProviderDefaultModel } from "./provider-registry.js";
import { getProviderAdapterFamily, getProviderEndpointTypeForModel } from "./provider-registry.js";
import { normalizeConfiguredProviderBaseUrl } from "./provider-base-url.js";
import type { ProviderId } from "../protocol/types.js";
import { resolveModelProfile } from "../tokens/model-profiles.js";

export type ProviderTaskModelKind = "imageRecognition" | "workflowPlanner" | "sessionTitle" | "imageGeneration" | "gitCommit" | "commandReview" | "goalEvaluator";

export type ResolvedProviderTaskModel = {
	kind: ProviderTaskModelKind;
	source: "current" | "configured";
	provider: ProviderId;
	model: string;
	options: ProviderChatOptions;
};

export class ProviderTaskModelError extends Error {
	readonly code: "task_model_not_configured" | "task_model_api_key_missing";

	constructor(code: ProviderTaskModelError["code"], message: string) {
		super(message);
		this.name = "ProviderTaskModelError";
		this.code = code;
	}
}

export async function getProviderModelRouting(): Promise<ProviderModelRouting> {
	const status: ProviderConfigStatus = await getProviderConfigStatus();
	return status.modelRouting ?? createEmptyModelRouting();
}

function resolveCurrentModelOptions(kind: ProviderTaskModelKind, currentOptions: ProviderChatOptions): ResolvedProviderTaskModel {
	return {
		kind,
		source: "current",
		provider: currentOptions.provider,
		model: currentOptions.model ?? getProviderDefaultModel(currentOptions.provider),
		options: currentOptions
	};
}

export async function resolveProviderTaskModelOptions(
	kind: ProviderTaskModelKind,
	currentOptions: ProviderChatOptions
): Promise<ResolvedProviderTaskModel> {
	const routing: ProviderModelRouting = await getProviderModelRouting();
	const configuredRef: ProviderTaskModelRef | null = routing[kind];
	if (configuredRef === null) {
		return resolveCurrentModelOptions(kind, currentOptions);
	}

	const config = await loadProviderConfigWithSecret(configuredRef.provider);
	if (config === null || config.apiKey === undefined) {
		throw new ProviderTaskModelError(
			"task_model_api_key_missing",
			`Provider ${configuredRef.provider} API key is not configured for ${kind}.`
		);
	}

	const endpointType = getProviderEndpointTypeForModel(configuredRef.provider, configuredRef.model);
	const options: ProviderChatOptions = {
		provider: configuredRef.provider,
		apiKey: config.apiKey,
		model: configuredRef.model,
		endpointType,
		adapterFamily: getProviderAdapterFamily(configuredRef.provider, endpointType),
		modelProfile: resolveModelProfile(configuredRef.provider, configuredRef.model),
		usageContext: currentOptions.usageContext
	};
	const normalizedBaseUrl: string | undefined = normalizeConfiguredProviderBaseUrl(config.baseUrl);
	if (normalizedBaseUrl !== undefined) {
		options.baseUrl = normalizedBaseUrl;
	}

	return {
		kind,
		source: "configured",
		provider: configuredRef.provider,
		model: configuredRef.model,
		options
	};
}

export async function resolveConfiguredProviderTaskModelOptions(kind: ProviderTaskModelKind): Promise<ResolvedProviderTaskModel> {
	const routing: ProviderModelRouting = await getProviderModelRouting();
	const configuredRef: ProviderTaskModelRef | null = routing[kind];
	if (configuredRef === null) {
		throw new ProviderTaskModelError(
			"task_model_not_configured",
			`No provider model is configured for ${kind}.`
		);
	}

	const config = await loadProviderConfigWithSecret(configuredRef.provider);
	if (config === null || config.apiKey === undefined) {
		throw new ProviderTaskModelError(
			"task_model_api_key_missing",
			`Provider ${configuredRef.provider} API key is not configured for ${kind}.`
		);
	}

	const endpointType = getProviderEndpointTypeForModel(configuredRef.provider, configuredRef.model);
	const options: ProviderChatOptions = {
		provider: configuredRef.provider,
		apiKey: config.apiKey,
		model: configuredRef.model,
		endpointType,
		adapterFamily: getProviderAdapterFamily(configuredRef.provider, endpointType),
		modelProfile: resolveModelProfile(configuredRef.provider, configuredRef.model)
	};
	const normalizedBaseUrl: string | undefined = normalizeConfiguredProviderBaseUrl(config.baseUrl);
	if (normalizedBaseUrl !== undefined) {
		options.baseUrl = normalizedBaseUrl;
	}

	return {
		kind,
		source: "configured",
		provider: configuredRef.provider,
		model: configuredRef.model,
		options
	};
}
