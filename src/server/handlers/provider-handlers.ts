import type WebSocket from "ws";
import type { ClientRequest } from "../../protocol/types.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession } from "../client-session.js";
import { sendJson } from "../send-json.js";
import type { ProviderId } from "../../protocol/types.js";
import { resolveModelProfile } from "../../tokens/model-profiles.js";
import { getProviderDefaultModel } from "../../providers/provider-registry.js";
import { clearProviderConfig, getProviderConfigStatus, getProviderModelSelectionStatus, getProviderUsage, loadProviderConfigWithSecret, removeCustomProviderConfig, saveProviderConfig, setProviderEnabled, type ProviderConfigWithSecret } from "../../providers/provider-config-store.js";
import {
	discoverProviderModels,
	importProviderModels,
	listProviderModels,
	ProviderModelSyncError,
	syncProviderModels
} from "../../providers/provider-models.js";
import { normalizeConfiguredProviderBaseUrl } from "../../providers/provider-base-url.js";
import { applyProviderConfigToRuntime, ensureProviderConfigured, resetProviderRuntime } from "../../application/provider-session-service.js";
import { SecretStoreUnavailableError } from "../../secrets/secret-store.js";
import { logger } from "../../logger.js";
import { getClientConnection } from "../client-connections.js";
import {
	addCustomModel,
	addCustomProvider,
	ProviderCustomizationError,
	removeCustomProvider,
	updateModelCustomization
} from "../../providers/provider-customizations-service.js";

export { ensureProviderConfigured } from "../../application/provider-session-service.js";

export async function handleProviderRequest(socket: WebSocket, request: ClientRequest, session: ClientSession, mcpHost: McpHost): Promise<void> {
	if (
		(
			request.method === "provider.custom.add"
			|| request.method === "provider.usage.get"
			|| request.method === "provider.setEnabled"
			|| request.method === "provider.custom.remove"
			|| request.method === "provider.model.add"
			|| request.method === "provider.model.update"
			|| request.method === "provider.models.discover"
			|| request.method === "provider.models.import"
			|| request.method === "provider.models.sync"
		)
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
		session.providerRequestOverrides = undefined;
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
				hasRequestOverrides: request.params.requestOverrides !== undefined,
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
			const requestOverrides = provider === session.activeProvider
				? session.providerRequestOverrides ?? config?.requestOverrides
				: config?.requestOverrides;
			const result = await listProviderModels(
				provider,
				apiKey,
				baseUrl,
				request.params?.refresh === true,
				requestOverrides
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

	case "provider.models.discover": {
		const provider: ProviderId = request.params.provider;
		const startedAtMs: number = Date.now();
		try {
			const config: ProviderConfigWithSecret | null = await loadProviderConfigWithSecret(provider);
			const apiKey: string | undefined = request.params.apiKey ?? config?.apiKey;
			const baseUrlInput: string | undefined = request.params.baseUrl === null
				? undefined
				: request.params.baseUrl ?? config?.baseUrl;
			const baseUrl: string | undefined = normalizeConfiguredProviderBaseUrl(baseUrlInput);
			const result = await discoverProviderModels(provider, apiKey, baseUrl, config?.requestOverrides);
			logger.info("provider", "models_discovered", {
				provider,
				hasTransientApiKey: request.params.apiKey !== undefined,
				hasTransientBaseUrl: request.params.baseUrl !== undefined,
				modelCount: result.models.length,
				source: result.source,
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
			logger.error("provider", "models_discover_failed", error, {
				provider,
				durationMs: Date.now() - startedAtMs,
				sessionId: session.sessionId
			});
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "provider_models_discover_error",
					message: error instanceof Error ? error.message : "Failed to discover provider models"
				}
			});
		}
		break;
	}

	case "provider.models.import": {
		const provider: ProviderId = request.params.provider;
		try {
			await importProviderModels(provider, request.params.models);
			logger.info("provider", "models_imported", {
				provider,
				modelCount: request.params.models.length,
				sessionId: session.sessionId
			});
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: await getProviderModelSelectionStatus()
			});
		} catch (error: unknown) {
			logger.error("provider", "models_import_failed", error, {
				provider,
				modelCount: request.params.models.length,
				sessionId: session.sessionId
			});
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "provider_models_import_error",
					message: error instanceof Error ? error.message : "Failed to import provider models"
				}
			});
		}
		break;
	}

	case "provider.models.sync": {
		const provider: ProviderId = request.params.provider;
		try {
			await syncProviderModels(request.params);
			logger.info("provider", "models_synced", {
				provider,
				upsertCount: request.params.upsertModels.length,
				enabledCount: request.params.enableModelIds.length,
				removedCount: request.params.removeModelIds.length,
				sessionId: session.sessionId
			});
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: await getProviderModelSelectionStatus()
			});
		} catch (error: unknown) {
			logger.error("provider", "models_sync_failed", error, {
				provider,
				upsertCount: request.params.upsertModels.length,
				enabledCount: request.params.enableModelIds.length,
				removedCount: request.params.removeModelIds.length,
				sessionId: session.sessionId
			});
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: error instanceof ProviderModelSyncError ? error.code : "provider_models_sync_error",
					message: error instanceof Error ? error.message : "Failed to synchronize provider models"
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

	case "provider.setEnabled":
		try {
			const mutation = await setProviderEnabled(request.params.provider, request.params.enabled);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					...mutation,
					selection: await getProviderModelSelectionStatus()
				}
			});
		} catch (error: unknown) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: error instanceof ProviderCustomizationError ? error.code : "provider_state_error",
					message: error instanceof Error ? error.message : "Failed to update provider state"
				}
			});
		}
		break;

	case "provider.usage.get":
		try {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					usages: await getProviderUsage(request.params.provider)
				}
			});
		} catch (error: unknown) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: error instanceof ProviderCustomizationError ? error.code : "provider_state_error",
					message: error instanceof Error ? error.message : "Failed to read provider usage"
				}
			});
		}
		break;

	case "provider.custom.remove":
		try {
			const mutation = await removeCustomProviderConfig(request.params.provider);
			if (mutation.updated) {
				await removeCustomProvider(request.params.provider);
			}
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					...mutation,
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
					message: error instanceof Error ? error.message : "Failed to remove custom provider"
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
