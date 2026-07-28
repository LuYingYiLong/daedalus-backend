import type WebSocket from "ws";
import type { ClientRequest } from "../../protocol/types.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession } from "../client-session.js";
import { sendJson } from "../send-json.js";
import type { ProviderId } from "../../protocol/types.js";
import { resolveModelProfile } from "../../tokens/model-profiles.js";
import { getProviderDefaultModel } from "../../providers/provider-registry.js";
import { clearProviderConfig, getProviderConfigStatus, getProviderModelSelectionStatus, loadProviderConfigWithSecret, saveProviderConfig, type ProviderConfigWithSecret } from "../../providers/provider-config-store.js";
import { listProviderModels } from "../../providers/provider-models.js";
import { normalizeConfiguredProviderBaseUrl } from "../../providers/provider-base-url.js";
import { applyProviderConfigToRuntime, ensureProviderConfigured, resetProviderRuntime } from "../../application/provider-session-service.js";
import { SecretStoreUnavailableError } from "../../secrets/secret-store.js";
import { logger } from "../../logger.js";
import { getClientConnection } from "../client-connections.js";
import {
	addCustomModel,
	addCustomProvider,
	ProviderCustomizationError,
	updateModelCustomization
} from "../../providers/provider-customizations-service.js";

export { ensureProviderConfigured } from "../../application/provider-session-service.js";

export async function handleProviderRequest(socket: WebSocket, request: ClientRequest, session: ClientSession, mcpHost: McpHost): Promise<void> {
	if (
		(request.method === "provider.custom.add" || request.method === "provider.model.add" || request.method === "provider.model.update")
		&& getClientConnection(socket)?.clientType !== "studio"
	) {
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: false,
			error: {
				code: "studio_only",
				message: `${request.method} is only available to Daedalus Studio.`
			}
		});
		return;
	}

	switch (request.method) {
	case "provider.configure":
		session.activeProvider = request.params.provider;
		session.providerApiKey = request.params.apiKey;
		session.providerModel = request.params.model;
		session.providerBaseUrl = normalizeConfiguredProviderBaseUrl(request.params.baseUrl);
		session.modelProfile = resolveModelProfile(request.params.provider, request.params.model ?? getProviderDefaultModel(request.params.provider));
		logger.info("provider", "configured_runtime", {
			provider: request.params.provider,
			model: session.providerModel ?? session.modelProfile.model,
			hasApiKey: request.params.apiKey.length > 0,
			hasBaseUrl: request.params.baseUrl !== undefined,
			sessionId: session.sessionId
		});

		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: {
				provider: request.params.provider,
				configured: true,
				model: session.providerModel ?? session.modelProfile.model,
				modelProfile: session.modelProfile
			}
		});
		break;

	case "provider.config.get":
		try {
			const config: ProviderConfigWithSecret | null = await loadProviderConfigWithSecret();
			if (config !== null) {
				applyProviderConfigToRuntime(session, config);
			}

			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: await getProviderConfigStatus()
			});
		} catch (error: unknown) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "provider_config_error",
					message: error instanceof Error ? error.message : "Failed to read provider config"
				}
			});
		}
		break;

	case "provider.current.get":
	case "provider.modelSelection.get":
		try {
			const config: ProviderConfigWithSecret | null = await loadProviderConfigWithSecret();
			if (config !== null) {
				applyProviderConfigToRuntime(session, config);
			}

			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: await getProviderModelSelectionStatus()
			});
		} catch (error: unknown) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "provider_config_error",
					message: error instanceof Error ? error.message : "Failed to read provider model selection"
				}
			});
		}
		break;

	case "provider.config.set":
		try {
			await saveProviderConfig(request.params);
			const config: ProviderConfigWithSecret | null = await loadProviderConfigWithSecret();
			if (config !== null) {
				applyProviderConfigToRuntime(session, config);
			}
			logger.info("provider", "config_saved", {
				provider: request.params.provider,
				model: request.params.model,
				hasApiKey: request.params.apiKey !== undefined,
				hasBaseUrl: request.params.baseUrl !== undefined,
				sessionId: session.sessionId
			});

			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: await getProviderConfigStatus()
			});
		} catch (error: unknown) {
			logger.error("provider", "config_save_failed", error, {
				provider: request.params.provider,
				sessionId: session.sessionId
			});
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: error instanceof SecretStoreUnavailableError ? error.code : "provider_config_error",
					message: error instanceof Error ? error.message : "Failed to save provider config"
				}
			});
		}
		break;

	case "provider.config.clear":
		try {
			const providerToClear: ProviderId | undefined = request.params?.provider;
			const clearedActiveProvider: boolean = providerToClear === undefined || providerToClear === session.activeProvider;
			const status = await clearProviderConfig(providerToClear);
			if (clearedActiveProvider) {
				resetProviderRuntime(session, status.activeProvider);
			}
			logger.info("provider", "config_cleared", {
				provider: providerToClear ?? "all",
				clearedActiveProvider,
				sessionId: session.sessionId
			});

			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: status
			});
		} catch (error: unknown) {
			logger.error("provider", "config_clear_failed", error, {
				provider: request.params?.provider,
				sessionId: session.sessionId
			});
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "provider_config_error",
					message: error instanceof Error ? error.message : "Failed to clear provider config"
				}
			});
		}
		break;

	case "provider.models.list": {
		const provider: ProviderId = request.params?.provider ?? session.activeProvider;
		const startedAtMs: number = Date.now();
		try {
			const config: ProviderConfigWithSecret | null = await loadProviderConfigWithSecret(provider);
			const apiKey: string | undefined = provider === session.activeProvider
				? session.providerApiKey ?? config?.apiKey
				: config?.apiKey;
			const baseUrl: string | undefined = normalizeConfiguredProviderBaseUrl(provider === session.activeProvider
				? session.providerBaseUrl ?? config?.baseUrl
				: config?.baseUrl);
			const result = await listProviderModels(
				provider,
				apiKey,
				baseUrl,
				request.params?.refresh === true
			);
			logger.info("provider", "models_listed", {
				provider,
				refresh: request.params?.refresh === true,
				hasApiKey: apiKey !== undefined,
				hasBaseUrl: baseUrl !== undefined,
				modelCount: result.models.length,
				stale: result.stale,
				durationMs: Date.now() - startedAtMs,
				sessionId: session.sessionId
			});
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result
			});
		} catch (error: unknown) {
			logger.error("provider", "models_list_failed", error, {
				provider,
				refresh: request.params?.refresh === true,
				durationMs: Date.now() - startedAtMs,
				sessionId: session.sessionId
			});
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "provider_models_error",
					message: error instanceof Error ? error.message : "Failed to list provider models"
				}
			});
		}
		break;
	}

	case "provider.custom.add":
		try {
			const providerId: ProviderId = await addCustomProvider(request.params);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					providerId,
					selection: await getProviderModelSelectionStatus()
				}
			});
		} catch (error: unknown) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: error instanceof ProviderCustomizationError ? error.code : "provider_customization_error",
					message: error instanceof Error ? error.message : "Failed to add custom provider"
				}
			});
		}
		break;

	case "provider.model.add":
		try {
			await addCustomModel(request.params);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: await getProviderModelSelectionStatus()
			});
		} catch (error: unknown) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: error instanceof ProviderCustomizationError ? error.code : "provider_customization_error",
					message: error instanceof Error ? error.message : "Failed to add provider model"
				}
			});
		}
		break;

	case "provider.model.update":
		try {
			await updateModelCustomization(request.params);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: await getProviderModelSelectionStatus()
			});
		} catch (error: unknown) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: error instanceof ProviderCustomizationError ? error.code : "provider_customization_error",
					message: error instanceof Error ? error.message : "Failed to update provider model"
				}
			});
		}
		break;

		default:
			throw new Error(`Unsupported provider method: ${request.method}`);
	}
}
