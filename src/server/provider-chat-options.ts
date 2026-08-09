import type { ProviderChatOptions } from "../providers/provider-types.js";
import { normalizeConfiguredProviderBaseUrl } from "../providers/provider-base-url.js";
import { getProviderAdapterFamily, getProviderDefaultModel, getProviderEndpointTypeForModel } from "../providers/provider-registry.js";
import type { ClientSession } from "./client-session.js";

export function createProviderChatOptions(session: ClientSession, apiKey: string): ProviderChatOptions {
	const model: string = session.providerModel ?? getProviderDefaultModel(session.activeProvider);
	const endpointType = getProviderEndpointTypeForModel(session.activeProvider, model);
	const options: ProviderChatOptions = {
		provider: session.activeProvider,
		apiKey,
		model,
		endpointType,
		adapterFamily: getProviderAdapterFamily(session.activeProvider, endpointType),
		modelProfile: session.modelProfile
	};
	const normalizedBaseUrl: string | undefined = normalizeConfiguredProviderBaseUrl(session.providerBaseUrl);
	if (normalizedBaseUrl !== undefined) {
		options.baseUrl = normalizedBaseUrl;
	}
	if (session.providerRequestOverrides !== undefined) {
		options.requestOverrides = session.providerRequestOverrides;
	}

	return options;
}
