import { readFile, rm } from "node:fs/promises";
import { getProviderConfigPath } from "../app-paths.js";
import { writeJsonFileAtomic } from "../json-file-store.js";
import type { ProviderId } from "../protocol/types.js";
import { deleteSecret, readSecret, writeSecret } from "../secrets/secret-store.js";
import {
	DEFAULT_PROVIDER_ID,
	getCustomProviderType,
	getProviderDefaultBaseUrl,
	getProviderDefaultModel,
	getProviderDefaultModelOrNull,
	getProviderDisplayName,
	getProviderFallbackModels,
	getProviderIds,
	isCustomProvider,
	isProviderId,
	mergeProviderModelsWithCatalog,
	normalizeProviderModelCapabilities,
	type ProviderModelInfo
} from "./provider-registry.js";
import type { CustomProviderType } from "./provider-customizations-store.js";
import type { ModelRef } from "./provider-types.js";
import {
	cloneProviderRequestOverrides,
	normalizeProviderRequestOverrides,
	type ProviderRequestBodyOverrides,
	type ProviderRequestOverrides,
	type ProviderRequestOverridesInput
} from "./provider-request-overrides.js";

const KEYTAR_SERVICE: string = "Godot Daedalus";

export type ProviderConfigInput = {
	provider: ProviderId;
	apiKey?: string | null | undefined;
	model?: string | undefined;
	baseUrl?: string | null | undefined;
	enabled?: boolean | undefined;
	activate?: boolean | undefined;
	modelRouting?: ProviderModelRoutingInput | undefined;
	requestOverrides?: ProviderRequestOverridesInput | null | undefined;
};

export type ProviderTaskModelRef = {
	provider: ProviderId;
	model: string;
};

export type ProviderModelRouting = {
	imageRecognition: ProviderTaskModelRef | null;
	workflowPlanner: ProviderTaskModelRef | null;
	sessionTitle: ProviderTaskModelRef | null;
	nextStepHints: ProviderTaskModelRef | null;
	imageGeneration: ProviderTaskModelRef | null;
	gitCommit: ProviderTaskModelRef | null;
	commandReview: ProviderTaskModelRef | null;
	goalEvaluator: ProviderTaskModelRef | null;
	contextCompression: ProviderTaskModelRef | null;
};

export type ProviderModelRoutingInput = Partial<Record<keyof ProviderModelRouting, ProviderTaskModelRef | null | undefined>>;

export type StoredProviderModelsCache = {
	models: ProviderModelInfo[];
	updatedAt: string;
};

export type StoredProviderEntry = {
	model?: string | undefined;
	baseUrl?: string | undefined;
	/** Omitted remains enabled for compatibility. */
	enabled?: false | undefined;
	keyStorage: "keytar";
	updatedAt: string;
	modelsCache?: StoredProviderModelsCache | undefined;
	requestBodyOverrides?: ProviderRequestBodyOverrides | undefined;
};

export type StoredProviderConfig = {
	schemaVersion: 3;
	activeModel: ModelRef;
	providers: Partial<Record<ProviderId, StoredProviderEntry>>;
	modelRouting: ProviderModelRouting;
};

export type ProviderConfigWithSecret = {
	provider: ProviderId;
	model?: string | undefined;
	baseUrl?: string | undefined;
	apiKey?: string | undefined;
	requestOverrides?: ProviderRequestOverrides | undefined;
};

export type ProviderConfigProviderStatus = {
	provider: ProviderId;
	displayName: string;
	configured: boolean;
	model: string | null;
	baseUrl: string | null;
	defaultModel: string | null;
	defaultBaseUrl: string;
	custom: boolean;
	enabled: boolean;
	providerType: CustomProviderType | null;
	ready: boolean;
	modelsCache: ProviderModelInfo[];
	fallbackModels: readonly ProviderModelInfo[];
	apiKeyMasked: string | null;
	keyStorage: "keytar";
	updatedAt: string | null;
	modelsCacheUpdatedAt: string | null;
	requestOverrides?: ProviderRequestOverrides | undefined;
};

export type CurrentProviderConfigStatus = {
	provider: ProviderId;
	displayName: string;
	configured: boolean;
	model: string;
	modelDisplayName: string;
	baseUrl: string;
	apiKeyMasked: string | null;
	keyStorage: "keytar";
	updatedAt: string | null;
};

export type ProviderModelSelectionProviderStatus = {
	provider: ProviderId;
	displayName: string;
	configured: boolean;
	selected: boolean;
	selectedModel: string | null;
	selectedModelDisplayName: string | null;
	defaultModel: string | null;
	baseUrl: string;
	custom: boolean;
	enabled: boolean;
	providerType: CustomProviderType | null;
	ready: boolean;
	apiKeyMasked: string | null;
	models: ProviderModelInfo[];
	modelsSource: "cache" | "fallback";
	modelsCacheUpdatedAt: string | null;
	requestOverrides?: ProviderRequestOverrides | undefined;
};

export type ProviderModelSelectionStatus = {
	activeModel: ModelRef;
	current: CurrentProviderConfigStatus;
	providers: ProviderModelSelectionProviderStatus[];
	modelRouting: ProviderModelRouting;
};

export type ProviderModelUsage = {
	kind: "activeModel" | "taskRouting";
	model: string;
	task?: keyof ProviderModelRouting | undefined;
};

export type ProviderMutationResult = {
	updated: boolean;
	usages: ProviderModelUsage[];
};

export type ProviderConfigStatus = {
	schemaVersion: 3;
	activeModel: ModelRef;
	activeProvider: ProviderId;
	current: CurrentProviderConfigStatus;
	providers: ProviderConfigProviderStatus[];
	modelRouting: ProviderModelRouting;
	provider: ProviderId;
	configured: boolean;
	model: string | null;
	baseUrl: string | null;
	apiKeyMasked: string | null;
	keyStorage: "keytar";
	configPath: string;
	updatedAt: string | null;
};

type ParsedStoredConfig = {
	config: StoredProviderConfig;
	migrated: boolean;
};

function normalizeOptionalString(value: string | undefined): string | undefined {
	const trimmed: string | undefined = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function getKeytarAccount(provider: ProviderId): string {
	return `provider:${provider}:api_key`;
}

function getRequestHeadersKeytarAccount(provider: ProviderId): string {
	return `provider:${provider}:request_headers`;
}

function maskApiKey(apiKey: string | null): string | null {
	if (apiKey === null || apiKey.length === 0) {
		return null;
	}

	if (apiKey.length <= 8) {
		return "********";
	}

	return `${apiKey.slice(0, 3)}...${apiKey.slice(-4)}`;
}

async function readKeytarPassword(provider: ProviderId): Promise<string | null> {
	return readSecret(KEYTAR_SERVICE, getKeytarAccount(provider));
}

async function readProviderRequestHeaders(provider: ProviderId): Promise<Record<string, string>> {
	const raw: string | null = await readSecret(KEYTAR_SERVICE, getRequestHeadersKeytarAccount(provider));
	if (raw === null) {
		return {};
	}

	try {
		return normalizeProviderRequestOverrides({ headers: JSON.parse(raw) })?.headers ?? {};
	} catch {
		return {};
	}
}

async function writeProviderRequestHeaders(provider: ProviderId, headers: Record<string, string>): Promise<void> {
	if (Object.keys(headers).length === 0) {
		await deleteSecret(KEYTAR_SERVICE, getRequestHeadersKeytarAccount(provider));
		return;
	}
	await writeSecret(KEYTAR_SERVICE, getRequestHeadersKeytarAccount(provider), JSON.stringify(headers));
}

async function resolveProviderRequestOverrides(
	provider: ProviderId,
	entry: StoredProviderEntry | undefined
): Promise<ProviderRequestOverrides | undefined> {
	return normalizeProviderRequestOverrides({
		headers: await readProviderRequestHeaders(provider),
		body: entry?.requestBodyOverrides
	});
}

function getModelDisplayName(models: readonly ProviderModelInfo[], modelId: string): string {
	return models.find((model: ProviderModelInfo): boolean => model.id === modelId)?.displayName ?? modelId;
}

function createModelRef(provider: ProviderId = DEFAULT_PROVIDER_ID, model?: string | undefined): ModelRef {
	return {
		providerId: provider,
		modelId: normalizeOptionalString(model) ?? getProviderDefaultModel(provider)
	};
}

function createEmptyStoredConfig(activeModel: ModelRef = createModelRef()): StoredProviderConfig {
	return {
		schemaVersion: 3,
		activeModel,
		providers: {},
		modelRouting: createEmptyModelRouting()
	};
}

export function createEmptyModelRouting(): ProviderModelRouting {
	return {
		imageRecognition: null,
		workflowPlanner: null,
		sessionTitle: null,
		nextStepHints: null,
		imageGeneration: null,
		gitCommit: null,
		commandReview: null,
		goalEvaluator: null,
		contextCompression: null
	};
}

function parseTaskModelRef(value: unknown): ProviderTaskModelRef | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}

	const record: Record<string, unknown> = value as Record<string, unknown>;
	const provider: unknown = record.provider ?? record.providerId;
	const model: unknown = record.model ?? record.modelId;
	if (!isProviderId(provider) || typeof model !== "string" || model.trim().length === 0) {
		return null;
	}

	return {
		provider,
		model: model.trim()
	};
}

function parseModelRouting(value: unknown): ProviderModelRouting {
	const routing: ProviderModelRouting = createEmptyModelRouting();
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return routing;
	}

	const record: Record<string, unknown> = value as Record<string, unknown>;
	routing.imageRecognition = parseTaskModelRef(record.imageRecognition);
	routing.workflowPlanner = parseTaskModelRef(record.workflowPlanner);
	routing.sessionTitle = parseTaskModelRef(record.sessionTitle);
	routing.nextStepHints = parseTaskModelRef(record.nextStepHints);
	routing.imageGeneration = parseTaskModelRef(record.imageGeneration);
	routing.gitCommit = parseTaskModelRef(record.gitCommit);
	routing.commandReview = parseTaskModelRef(record.commandReview);
	routing.goalEvaluator = parseTaskModelRef(record.goalEvaluator);
	routing.contextCompression = parseTaskModelRef(record.contextCompression);
	return routing;
}

function mergeModelRouting(existing: ProviderModelRouting | undefined, input: ProviderModelRoutingInput | undefined): ProviderModelRouting {
	const routing: ProviderModelRouting = existing ?? createEmptyModelRouting();
	if (input === undefined) {
		return routing;
	}

	const next: ProviderModelRouting = { ...routing };
	for (const key of ["imageRecognition", "workflowPlanner", "sessionTitle", "nextStepHints", "imageGeneration", "gitCommit", "commandReview", "goalEvaluator", "contextCompression"] as const) {
		if (!Object.prototype.hasOwnProperty.call(input, key)) {
			continue;
		}

		const value: ProviderTaskModelRef | null | undefined = input[key];
		if (value === null || value === undefined) {
			next[key] = null;
			continue;
		}

		if (!isProviderId(value.provider)) {
			throw new Error(`Invalid task model provider for ${key}: ${String(value.provider)}`);
		}
		const model: string = value.model.trim();
		if (model.length === 0) {
			throw new Error(`Invalid task model for ${key}: model is required`);
		}
		next[key] = {
			provider: value.provider,
			model
		};
	}
	return next;
}

function validateModelRouting(routing: ProviderModelRouting, stored: StoredProviderConfig): void {
	for (const [key, value] of Object.entries(routing) as [keyof ProviderModelRouting, ProviderTaskModelRef | null][]) {
		if (value === null) {
			continue;
		}
		if (!isProviderEnabled(stored, value.provider)) {
			throw new Error(`provider_disabled: Provider ${value.provider} must be enabled before it can be used for ${key}.`);
		}
		const models: ProviderModelInfo[] = mergeProviderModelsWithCatalog(
			value.provider,
			stored.providers[value.provider]?.modelsCache?.models ?? []
		);
		if (!models.some((model: ProviderModelInfo): boolean => model.id === value.model)) {
			throw new Error(`provider_model_not_found: Model ${value.model} is not enabled for ${key}.`);
		}
	}
}

function isProviderEnabled(stored: StoredProviderConfig, provider: ProviderId): boolean {
	return stored.providers[provider]?.enabled !== false;
}

function collectProviderModelUsages(stored: StoredProviderConfig, provider: ProviderId): ProviderModelUsage[] {
	const usages: ProviderModelUsage[] = [];
	if (stored.activeModel.providerId === provider) {
		usages.push({ kind: "activeModel", model: stored.activeModel.modelId });
	}
	for (const key of Object.keys(stored.modelRouting) as Array<keyof ProviderModelRouting>) {
		const routedModel: ProviderTaskModelRef | null = stored.modelRouting[key];
		if (routedModel?.provider === provider) {
			usages.push({ kind: "taskRouting", task: key, model: routedModel.model });
		}
	}
	return usages;
}

function assertProvider(provider: ProviderId): void {
	if (!isProviderId(provider)) {
		throw new Error(`Unknown provider: ${provider}`);
	}
}

function assertCustomProvider(provider: ProviderId): void {
	assertProvider(provider);
	if (!isCustomProvider(provider)) {
		throw new Error(`provider_not_custom: Provider ${provider} cannot be removed.`);
	}
}

function hasStoredProviderData(entry: StoredProviderEntry): boolean {
	return entry.model !== undefined
		|| entry.baseUrl !== undefined
		|| entry.modelsCache !== undefined
		|| entry.requestBodyOverrides !== undefined
		|| entry.enabled === false;
}

function parseModelInfo(value: unknown): ProviderModelInfo | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}

	const record: Record<string, unknown> = value as Record<string, unknown>;
	const provider: unknown = record.provider;
	const id: unknown = record.id;
	const displayName: unknown = record.displayName;
	const contextWindowTokens: unknown = record.contextWindowTokens;
	const maxOutputTokens: unknown = record.maxOutputTokens;
	if (!isProviderId(provider) || typeof id !== "string" || id.trim().length === 0) {
		return null;
	}
	if (typeof displayName !== "string" || displayName.trim().length === 0) {
		return null;
	}
	if (typeof contextWindowTokens !== "number" || !Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) {
		return null;
	}
	if (typeof maxOutputTokens !== "number" || !Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) {
		return null;
	}

	const fallback = getProviderFallbackModels(provider).find((model: ProviderModelInfo): boolean => model.id === id);
	const model: ProviderModelInfo = {
		id: id.trim(),
		displayName: displayName.trim(),
		provider,
		endpointType: fallback?.endpointType ?? "openai-chat-completions",
		contextWindowTokens: Math.floor(contextWindowTokens),
		maxOutputTokens: Math.floor(maxOutputTokens),
		capabilities: normalizeProviderModelCapabilities(typeof record.capabilities === "object" && record.capabilities !== null && !Array.isArray(record.capabilities)
			? record.capabilities as ProviderModelInfo["capabilities"]
			: {})
	};
	if (
		typeof record.endpointType === "string"
		&& (
			record.endpointType === "openai-chat-completions"
			|| record.endpointType === "openai-responses"
			|| record.endpointType === "anthropic-messages"
		)
	) {
		model.endpointType = record.endpointType;
	}
	if (typeof record.ownedBy === "string") {
		model.ownedBy = record.ownedBy;
	}
	return model;
}

function parseModelsCache(value: unknown): StoredProviderModelsCache | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}

	const record: Record<string, unknown> = value as Record<string, unknown>;
	if (!Array.isArray(record.models) || typeof record.updatedAt !== "string") {
		return undefined;
	}
	const models: ProviderModelInfo[] = record.models
		.map(parseModelInfo)
		.filter((model: ProviderModelInfo | null): model is ProviderModelInfo => model !== null);
	return models.length > 0 ? { models, updatedAt: record.updatedAt } : undefined;
}

function parseStoredEntry(value: unknown): StoredProviderEntry | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}

	const record: Record<string, unknown> = value as Record<string, unknown>;
	const entry: StoredProviderEntry = {
		keyStorage: "keytar",
		updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : ""
	};

	if (typeof record.model === "string" && record.model.trim().length > 0) {
		entry.model = record.model.trim();
	}
	if (typeof record.baseUrl === "string" && record.baseUrl.trim().length > 0) {
		entry.baseUrl = record.baseUrl.trim();
	}
	if (record.enabled === false) {
		entry.enabled = false;
	}
	const modelsCache: StoredProviderModelsCache | undefined = parseModelsCache(record.modelsCache);
	if (modelsCache !== undefined) {
		entry.modelsCache = modelsCache;
	}
	try {
		const requestOverrides: ProviderRequestOverrides | undefined = normalizeProviderRequestOverrides({
			body: record.requestBodyOverrides
		});
		if (requestOverrides?.body !== undefined && Object.keys(requestOverrides.body).length > 0) {
			entry.requestBodyOverrides = requestOverrides.body;
		}
	} catch {
		// Invalid persisted overrides must not prevent the provider configuration from loading
	}

	return entry;
}

function parseActiveModel(value: unknown, fallbackProvider?: ProviderId | undefined, fallbackModel?: string | undefined): ModelRef {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		const record: Record<string, unknown> = value as Record<string, unknown>;
		const provider: unknown = record.providerId ?? record.provider;
		const model: unknown = record.modelId ?? record.model;
		if (isProviderId(provider) && typeof model === "string" && model.trim().length > 0) {
			return createModelRef(provider, model);
		}
	}

	return createModelRef(fallbackProvider ?? DEFAULT_PROVIDER_ID, fallbackModel);
}

function parseStoredProviderConfig(parsed: unknown): ParsedStoredConfig {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { config: createEmptyStoredConfig(), migrated: true };
	}

	const record: Record<string, unknown> = parsed as Record<string, unknown>;
	if (record.schemaVersion === 3) {
		const activeModel: ModelRef = parseActiveModel(record.activeModel);
		const config: StoredProviderConfig = createEmptyStoredConfig(activeModel);
		const providersValue: unknown = record.providers;
		if (typeof providersValue === "object" && providersValue !== null && !Array.isArray(providersValue)) {
			const providersRecord: Record<string, unknown> = providersValue as Record<string, unknown>;
			for (const provider of getProviderIds()) {
				const entry: StoredProviderEntry | undefined = parseStoredEntry(providersRecord[provider]);
				if (entry !== undefined) {
					config.providers[provider] = entry;
				}
			}
		}
		config.modelRouting = parseModelRouting(record.modelRouting);
		return { config, migrated: false };
	}

	// v2 只在这里迁移一次，后续写回 schemaVersion 3。
	const activeProvider: ProviderId = isProviderId(record.activeProvider) ? record.activeProvider : DEFAULT_PROVIDER_ID;
	const providersValue: unknown = record.providers;
	let activeModel: ModelRef = createModelRef(activeProvider);
	const config: StoredProviderConfig = createEmptyStoredConfig(activeModel);
	if (typeof providersValue === "object" && providersValue !== null && !Array.isArray(providersValue)) {
		const providersRecord: Record<string, unknown> = providersValue as Record<string, unknown>;
		for (const provider of getProviderIds()) {
			const entry: StoredProviderEntry | undefined = parseStoredEntry(providersRecord[provider]);
			if (entry !== undefined) {
				config.providers[provider] = entry;
				if (provider === activeProvider) {
					activeModel = createModelRef(provider, entry.model);
				}
			}
		}
	}
	config.activeModel = activeModel;
	config.modelRouting = parseModelRouting(record.modelRouting);
	return { config, migrated: true };
}

async function readStoredProviderConfig(): Promise<StoredProviderConfig> {
	const filePath: string = getProviderConfigPath();

	try {
		const raw: string = await readFile(filePath, "utf8");
		const parsed: unknown = JSON.parse(raw);
		const result: ParsedStoredConfig = parseStoredProviderConfig(parsed);
		if (result.migrated) {
			await writeStoredProviderConfig(result.config);
		}
		return result.config;
	} catch {
		return createEmptyStoredConfig();
	}
}

async function writeStoredProviderConfig(config: StoredProviderConfig): Promise<void> {
	const filePath: string = getProviderConfigPath();
	await writeJsonFileAtomic(filePath, config);
}

export async function saveProviderConfig(input: ProviderConfigInput): Promise<ProviderConfigStatus> {
	if (!isProviderId(input.provider)) {
		throw new Error(`Unknown provider: ${input.provider}`);
	}
	const requestedOverrides: ProviderRequestOverrides | undefined = input.requestOverrides === undefined
		? undefined
		: input.requestOverrides === null
			? undefined
			: normalizeProviderRequestOverrides(input.requestOverrides);

	const stored: StoredProviderConfig = await readStoredProviderConfig();
	const existing: StoredProviderEntry | undefined = stored.providers[input.provider];
	const apiKey: string | undefined = input.apiKey === null ? undefined : normalizeOptionalString(input.apiKey);
	const disablesProvider: boolean = input.apiKey === null || input.enabled === false;
	if (disablesProvider) {
		const usages: ProviderModelUsage[] = collectProviderModelUsages(stored, input.provider);
		if (usages.length > 0) {
			throw new Error(`provider_in_use: Provider ${input.provider} is still assigned to active or task models.`);
		}
	}
	if (input.enabled === true && apiKey === undefined && await readKeytarPassword(input.provider) === null) {
		throw new Error(`provider_api_key_required: Provider ${input.provider} requires an API key before it can be enabled.`);
	}
	if (input.apiKey === null) {
		await deleteSecret(KEYTAR_SERVICE, getKeytarAccount(input.provider));
	}
	if (apiKey !== undefined) {
		await writeSecret(KEYTAR_SERVICE, getKeytarAccount(input.provider), apiKey);
	}
	const entry: StoredProviderEntry = {
		keyStorage: "keytar",
		updatedAt: new Date().toISOString()
	};

	const effectiveModels: ProviderModelInfo[] = mergeProviderModelsWithCatalog(
		input.provider,
		existing?.modelsCache?.models ?? []
	);
	const effectiveModelIds: Set<string> = new Set(
		effectiveModels.map((candidate: ProviderModelInfo): string => candidate.id)
	);
	const requestedModel: string | undefined = normalizeOptionalString(input.model);
	if (requestedModel !== undefined && !effectiveModelIds.has(requestedModel)) {
		throw new Error(`provider_model_not_found: Model ${requestedModel} does not exist for provider ${input.provider}.`);
	}
	const defaultModel: string | null = getProviderDefaultModelOrNull(input.provider);
	const model: string | undefined = requestedModel
		?? (existing?.model !== undefined && effectiveModelIds.has(existing.model) ? existing.model : undefined)
		?? (defaultModel !== null && effectiveModelIds.has(defaultModel) ? defaultModel : undefined)
		?? effectiveModels[0]?.id;
	const baseUrl: string | undefined = input.baseUrl === null
		? undefined
		: (normalizeOptionalString(input.baseUrl) ?? existing?.baseUrl ?? normalizeOptionalString(getProviderDefaultBaseUrl(input.provider)));
	if (model !== undefined) {
		entry.model = model;
	}
	if (baseUrl !== undefined && input.baseUrl !== null) {
		entry.baseUrl = baseUrl;
	}
	if (existing?.modelsCache !== undefined) {
		entry.modelsCache = existing.modelsCache;
	}
	if (disablesProvider) {
		entry.enabled = false;
	} else if (input.enabled !== true && existing?.enabled === false) {
		entry.enabled = false;
	}
	if (input.requestOverrides === undefined) {
		if (existing?.requestBodyOverrides !== undefined) {
			entry.requestBodyOverrides = existing.requestBodyOverrides;
		}
	} else if (requestedOverrides?.body !== undefined && Object.keys(requestedOverrides.body).length > 0) {
		entry.requestBodyOverrides = requestedOverrides.body;
	}
	if (input.requestOverrides !== undefined) {
		await writeProviderRequestHeaders(input.provider, requestedOverrides?.headers ?? {});
	}

	stored.providers[input.provider] = entry;
	stored.modelRouting = mergeModelRouting(stored.modelRouting, input.modelRouting);
	validateModelRouting(stored.modelRouting, stored);
	if (input.activate !== false) {
		if (!isProviderEnabled(stored, input.provider)) {
			throw new Error(`provider_disabled: Provider ${input.provider} must be enabled before it can be activated.`);
		}
		if (model === undefined) {
			throw new Error(`provider_not_ready: Provider ${input.provider} has no models.`);
		}
		if (isCustomProvider(input.provider) && baseUrl === undefined) {
			throw new Error(`provider_base_url_required: Provider ${input.provider} requires a Base URL before activation.`);
		}
		stored.activeModel = createModelRef(input.provider, model);
	}

	await writeStoredProviderConfig(stored);
	return getProviderConfigStatus();
}

export async function loadProviderConfigWithSecret(provider?: ProviderId | undefined): Promise<ProviderConfigWithSecret | null> {
	const stored: StoredProviderConfig = await readStoredProviderConfig();
	const activeProvider: ProviderId = provider ?? stored.activeModel.providerId;
	if (!isProviderId(activeProvider)) {
		return null;
	}
	const entry: StoredProviderEntry | undefined = stored.providers[activeProvider];
	const apiKey: string | null = await readKeytarPassword(activeProvider);

	if (entry === undefined && apiKey === null) {
		return null;
	}

	const result: ProviderConfigWithSecret = {
		provider: activeProvider,
		model: entry?.model ?? (activeProvider === stored.activeModel.providerId ? stored.activeModel.modelId : undefined),
		apiKey: apiKey ?? undefined
	};
	if (entry?.baseUrl !== undefined) {
		result.baseUrl = entry.baseUrl;
	}
	const requestOverrides: ProviderRequestOverrides | undefined = await resolveProviderRequestOverrides(activeProvider, entry);
	if (requestOverrides !== undefined) {
		result.requestOverrides = requestOverrides;
	}
	return result;
}

export async function getProviderConfigStatus(): Promise<ProviderConfigStatus> {
	const stored: StoredProviderConfig = await readStoredProviderConfig();
	const providers: ProviderConfigProviderStatus[] = [];

	for (const provider of getProviderIds()) {
		const entry: StoredProviderEntry | undefined = stored.providers[provider];
		const apiKey: string | null = await readKeytarPassword(provider);
		const requestOverrides: ProviderRequestOverrides | undefined = await resolveProviderRequestOverrides(provider, entry);
		const fallbackModels: ProviderModelInfo[] = mergeProviderModelsWithCatalog(provider, []);
		const models: ProviderModelInfo[] = mergeProviderModelsWithCatalog(provider, entry?.modelsCache?.models ?? []);
		const defaultBaseUrl: string = getProviderDefaultBaseUrl(provider);
		const resolvedBaseUrl: string = entry?.baseUrl ?? defaultBaseUrl;
		const custom: boolean = isCustomProvider(provider);
		const enabled: boolean = apiKey !== null && isProviderEnabled(stored, provider);
		const status: ProviderConfigProviderStatus = {
			provider,
			displayName: getProviderDisplayName(provider),
			configured: apiKey !== null,
			model: entry?.model ?? null,
			baseUrl: entry?.baseUrl ?? null,
			defaultModel: getProviderDefaultModelOrNull(provider),
			defaultBaseUrl,
			custom,
			enabled,
			providerType: getCustomProviderType(provider),
			ready: enabled && models.length > 0 && (!custom || resolvedBaseUrl.trim().length > 0),
			modelsCache: entry?.modelsCache?.models ?? [],
			fallbackModels,
			apiKeyMasked: maskApiKey(apiKey),
			keyStorage: "keytar",
			updatedAt: entry?.updatedAt ?? null,
			modelsCacheUpdatedAt: entry?.modelsCache?.updatedAt ?? null
		};
		if (requestOverrides !== undefined) {
			status.requestOverrides = requestOverrides;
		}
		providers.push(status);
	}

	const activeStatus: ProviderConfigProviderStatus = providers.find((item: ProviderConfigProviderStatus): boolean => item.provider === stored.activeModel.providerId)
		?? providers[0]!;
	const activeModels: ProviderModelInfo[] = mergeProviderModelsWithCatalog(
		activeStatus.provider,
		activeStatus.modelsCache
	);
	const current: CurrentProviderConfigStatus = {
		provider: activeStatus.provider,
		displayName: activeStatus.displayName,
		configured: activeStatus.configured,
		model: stored.activeModel.modelId,
		modelDisplayName: getModelDisplayName(activeModels, stored.activeModel.modelId),
		baseUrl: activeStatus.baseUrl ?? activeStatus.defaultBaseUrl,
		apiKeyMasked: activeStatus.apiKeyMasked,
		keyStorage: "keytar",
		updatedAt: activeStatus.updatedAt
	};

	return {
		schemaVersion: 3,
		activeModel: stored.activeModel,
		activeProvider: stored.activeModel.providerId,
		current,
		providers,
		modelRouting: stored.modelRouting,
		provider: activeStatus.provider,
		configured: activeStatus.configured,
		model: activeStatus.model,
		baseUrl: activeStatus.baseUrl,
		apiKeyMasked: activeStatus.apiKeyMasked,
		keyStorage: "keytar",
		configPath: getProviderConfigPath(),
		updatedAt: activeStatus.updatedAt
	};
}

export async function getProviderModelSelectionStatus(): Promise<ProviderModelSelectionStatus> {
	const status: ProviderConfigStatus = await getProviderConfigStatus();

	return {
		activeModel: status.activeModel,
		current: status.current,
		providers: status.providers.map((providerStatus: ProviderConfigProviderStatus): ProviderModelSelectionProviderStatus => {
			const modelsSource: "cache" | "fallback" = providerStatus.modelsCache.length > 0 ? "cache" : "fallback";
			const models: ProviderModelInfo[] = mergeProviderModelsWithCatalog(
				providerStatus.provider,
				providerStatus.modelsCache
			);
			const selected: boolean = providerStatus.provider === status.activeModel.providerId;
			const selectedModel: string | null = selected
				? status.activeModel.modelId
				: providerStatus.model ?? null;

			const selectionProvider: ProviderModelSelectionProviderStatus = {
				provider: providerStatus.provider,
				displayName: providerStatus.displayName,
				configured: providerStatus.configured,
				selected,
				selectedModel,
				selectedModelDisplayName: selectedModel === null ? null : getModelDisplayName(models, selectedModel),
				defaultModel: providerStatus.defaultModel,
				baseUrl: providerStatus.baseUrl ?? providerStatus.defaultBaseUrl,
				custom: providerStatus.custom,
				enabled: providerStatus.enabled,
				providerType: providerStatus.providerType,
				ready: providerStatus.ready,
				apiKeyMasked: providerStatus.apiKeyMasked,
				models,
				modelsSource,
				modelsCacheUpdatedAt: providerStatus.modelsCacheUpdatedAt
			};
			if (providerStatus.requestOverrides !== undefined) {
				selectionProvider.requestOverrides = cloneProviderRequestOverrides(providerStatus.requestOverrides);
			}
			return selectionProvider;
		}),
		modelRouting: status.modelRouting
	};
}

export async function clearProviderConfig(provider?: ProviderId | undefined): Promise<ProviderConfigStatus> {
	const stored: StoredProviderConfig = await readStoredProviderConfig();
	const providerToClear: ProviderId = provider ?? stored.activeModel.providerId;
	if (!isProviderId(providerToClear)) {
		throw new Error(`Unknown provider: ${providerToClear}`);
	}

	await deleteSecret(KEYTAR_SERVICE, getKeytarAccount(providerToClear));
	await deleteSecret(KEYTAR_SERVICE, getRequestHeadersKeytarAccount(providerToClear));
	if (stored.providers[providerToClear]?.enabled === false) {
		stored.providers[providerToClear] = {
			keyStorage: "keytar",
			updatedAt: new Date().toISOString(),
			enabled: false
		};
	} else {
		delete stored.providers[providerToClear];
	}

	if (Object.keys(stored.providers).length === 0) {
		await rm(getProviderConfigPath(), { force: true });
		return getProviderConfigStatus();
	}

	if (stored.activeModel.providerId === providerToClear) {
		const nextProvider: ProviderId = Object.keys(stored.providers).find((value: string): value is ProviderId => {
			if (!isProviderId(value)) {
				return false;
			}
		const nextEntry: StoredProviderEntry | undefined = stored.providers[value];
			return isProviderEnabled(stored, value)
				&& nextEntry?.model !== undefined
				&& (!isCustomProvider(value) || (nextEntry.baseUrl?.trim().length ?? 0) > 0);
		}) ?? DEFAULT_PROVIDER_ID;
		stored.activeModel = createModelRef(nextProvider, stored.providers[nextProvider]?.model);
	}

	await writeStoredProviderConfig(stored);
	return getProviderConfigStatus();
}

export async function setProviderEnabled(provider: ProviderId, enabled: boolean): Promise<ProviderMutationResult> {
	assertProvider(provider);
	const stored: StoredProviderConfig = await readStoredProviderConfig();
	if (enabled && await readKeytarPassword(provider) === null) {
		throw new Error(`provider_api_key_required: Provider ${provider} requires an API key before it can be enabled.`);
	}
	const usages: ProviderModelUsage[] = enabled ? [] : collectProviderModelUsages(stored, provider);
	if (usages.length > 0) {
		return { updated: false, usages };
	}
	const existing: StoredProviderEntry | undefined = stored.providers[provider];
	const entry: StoredProviderEntry = {
		keyStorage: "keytar",
		updatedAt: new Date().toISOString(),
		...(existing ?? {})
	};
	if (enabled) {
		delete entry.enabled;
	} else {
		entry.enabled = false;
	}
	entry.updatedAt = new Date().toISOString();
	if (hasStoredProviderData(entry)) {
		stored.providers[provider] = entry;
	} else {
		delete stored.providers[provider];
	}
	await writeStoredProviderConfig(stored);
	return { updated: true, usages: [] };
}

export async function getProviderUsage(provider: ProviderId): Promise<ProviderModelUsage[]> {
	assertProvider(provider);
	return collectProviderModelUsages(await readStoredProviderConfig(), provider);
}

export async function removeCustomProviderConfig(provider: ProviderId): Promise<ProviderMutationResult> {
	assertCustomProvider(provider);
	const stored: StoredProviderConfig = await readStoredProviderConfig();
	const usages: ProviderModelUsage[] = collectProviderModelUsages(stored, provider);
	if (usages.length > 0) {
		return { updated: false, usages };
	}

	await deleteSecret(KEYTAR_SERVICE, getKeytarAccount(provider));
	await deleteSecret(KEYTAR_SERVICE, getRequestHeadersKeytarAccount(provider));
	delete stored.providers[provider];
	if (Object.keys(stored.providers).length === 0) {
		await rm(getProviderConfigPath(), { force: true });
	} else {
		await writeStoredProviderConfig(stored);
	}
	return { updated: true, usages: [] };
}

export async function getProviderModelsCache(provider: ProviderId): Promise<StoredProviderModelsCache | undefined> {
	const stored: StoredProviderConfig = await readStoredProviderConfig();
	return stored.providers[provider]?.modelsCache;
}

export async function saveProviderModelsCache(provider: ProviderId, models: ProviderModelInfo[]): Promise<void> {
	const stored: StoredProviderConfig = await readStoredProviderConfig();
	const existing: StoredProviderEntry | undefined = stored.providers[provider];
	const entry: StoredProviderEntry = existing ?? {
		keyStorage: "keytar",
		updatedAt: new Date().toISOString()
	};
	const defaultModel: string | null = getProviderDefaultModelOrNull(provider);
	if (entry.model === undefined && defaultModel !== null) {
		entry.model = defaultModel;
	}
	entry.modelsCache = {
		models,
		updatedAt: new Date().toISOString()
	};
	stored.providers[provider] = entry;
	await writeStoredProviderConfig(stored);
}
