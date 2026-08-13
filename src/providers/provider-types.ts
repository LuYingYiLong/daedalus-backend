import type { ModelProfile, ProviderId } from "../protocol/types.js";
import type { ProviderUsageContext } from "../usage/metrics-types.js";
import type { ProviderRequestOverrides } from "./provider-request-overrides.js";

export type EndpointType = "openai-chat-completions" | "openai-responses" | "anthropic-messages";

export type AdapterFamily = "openai-compatible" | "openai-responses" | "anthropic-compatible";

export type ProviderModelListMode = "api-plus-catalog" | "catalog-recommended" | "catalog-only";

export type ModelRef = {
	providerId: ProviderId;
	modelId: string;
};

export type ProviderModelCapabilities = {
	imageInput?: boolean | undefined;
	videoInput?: boolean | undefined;
	reasoning?: boolean | undefined;
	reasoningEfforts?: ProviderReasoningEffortOption[] | undefined;
	tools?: boolean | undefined;
	webSearch?: boolean | undefined;
	vision?: boolean | undefined;
	imageGeneration?: boolean | undefined;
	imageEdit?: boolean | undefined;
};

export type ProviderModelCapabilityOverrides = Partial<Pick<
	ProviderModelCapabilities,
	"imageInput" | "videoInput" | "reasoning" | "tools" | "webSearch" | "imageGeneration" | "imageEdit"
>>;

export type ProviderModelCustomizationInfo = {
	source: "custom" | "override";
	displayName?: string | undefined;
	contextWindowTokens?: number | undefined;
	maxOutputTokens?: number | undefined;
	capabilities: ProviderModelCapabilityOverrides;
	reasoningEfforts?: ProviderReasoningEffortOption[] | undefined;
	updatedAt: string;
};

export type BaseReasoningEffort = "low" | "medium" | "high" | "max";

/** A provider/model-specific reasoning option exposed to the client. */
export type ProviderReasoningEffortOption = {
	id: string;
	/** Normalized strength used when the user switches to another model. */
	fallback: BaseReasoningEffort;
	/** Whether the provider's documented default should be used when no effort is selected. */
	default?: boolean | undefined;
};

export type ProviderModelInfo = {
	id: string;
	displayName: string;
	provider: ProviderId;
	endpointType: EndpointType;
	contextWindowTokens: number;
	maxOutputTokens: number;
	capabilities: ProviderModelCapabilities;
	ownedBy?: string | undefined;
	customization?: ProviderModelCustomizationInfo | undefined;
};

export type ProviderEndpointConfig = {
	baseUrl: string;
	adapterFamily: AdapterFamily;
	modelsPath: string;
	maxTokensField?: "max_tokens" | "max_completion_tokens" | undefined;
	tokenEstimatePath?: string | undefined;
	requiredToolChoice?: "auto" | "omit" | undefined;
	toolCallsSwitch?: boolean | undefined;
	temperature?: {
		min: number;
		max: number;
	} | undefined;
};

export type ProviderDefinition = {
	id: ProviderId;
	displayName: string;
	authType: "api-key";
	defaultEndpointType: EndpointType;
	defaultBaseUrl: string;
	defaultModel: string | null;
	modelListMode: ProviderModelListMode;
	modelsPath: string;
	tokenEstimatePath?: string | undefined;
	envBaseUrl?: string | undefined;
	envModel?: string | undefined;
	endpointConfigs: Partial<Record<EndpointType, ProviderEndpointConfig>>;
	fallbackModels: readonly ProviderModelInfo[];
};

export type ProviderChatOptions = {
	provider: ProviderId;
	apiKey: string;
	baseUrl?: string | undefined;
	model?: string | undefined;
	endpointType?: EndpointType | undefined;
	adapterFamily?: AdapterFamily | undefined;
	modelProfile?: ModelProfile | undefined;
	/**
	 * Internal task-level override. Auxiliary structured-generation tasks can
	 * disable reasoning without changing the user's composer preference.
	 */
	reasoningMode?: "auto" | "disabled" | undefined;
	usageContext?: ProviderUsageContext | undefined;
	requestOverrides?: ProviderRequestOverrides | undefined;
};

export type ProviderReconnectReason =
	| "transport"
	| "idle_timeout"
	| "gateway"
	| "rate_limit"
	| "server";

export type ProviderReconnectEvent = {
	schemaVersion: 1;
	reconnectId: string;
	revision: number;
	runId: string;
	stepRunId: string;
	provider: string;
	model: string;
	status: "waiting" | "reconnecting" | "recovered" | "failed";
	reason: ProviderReconnectReason;
	attempt: number;
	maxAttempts: 2 | 5 | 15;
	timeoutMs: number;
	retryAt?: string | undefined;
	autoExtended: boolean;
	discardedMessageCodePoints: number;
	discardedThinkingCodePoints: number;
};

export type ProviderRuntimeConfig = {
	providerId: ProviderId;
	modelId: string;
	endpointType: EndpointType;
	adapterFamily: AdapterFamily;
	baseUrl: string;
	apiKey: string;
	modelProfile: ModelProfile;
};

function copyBooleanCapability(target: ProviderModelCapabilities, source: ProviderModelCapabilities, key: Exclude<keyof ProviderModelCapabilities, "reasoningEfforts">): void {
	const value: boolean | undefined = source[key];
	if (value !== undefined) {
		target[key] = value;
	}
}

function normalizeReasoningEfforts(value: unknown): ProviderReasoningEffortOption[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const options: ProviderReasoningEffortOption[] = [];
	const seen: Set<string> = new Set();
	let defaultSeen: boolean = false;
	for (const item of value) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			continue;
		}
		const record: Record<string, unknown> = item as Record<string, unknown>;
		const id: string | undefined = typeof record.id === "string" ? record.id.trim() : undefined;
		const fallback: unknown = record.fallback;
		const isDefault: unknown = record.default;
		if (
			id === undefined
			|| id.length === 0
			|| id.length > 32
			|| seen.has(id)
			|| (fallback !== "low" && fallback !== "medium" && fallback !== "high" && fallback !== "max")
		) {
			continue;
		}
		seen.add(id);
		const useAsDefault: boolean = isDefault === true && !defaultSeen;
		defaultSeen ||= useAsDefault;
		options.push({ id, fallback, ...(useAsDefault ? { default: true } : {}) });
	}
	return options.length > 0 ? options : undefined;
}

export function normalizeProviderModelCapabilities(capabilities: ProviderModelCapabilities | undefined): ProviderModelCapabilities {
	const source: ProviderModelCapabilities = capabilities ?? {};
	const normalized: ProviderModelCapabilities = {};

	copyBooleanCapability(normalized, source, "imageInput");
	copyBooleanCapability(normalized, source, "videoInput");
	copyBooleanCapability(normalized, source, "reasoning");
	copyBooleanCapability(normalized, source, "tools");
	copyBooleanCapability(normalized, source, "webSearch");
	copyBooleanCapability(normalized, source, "imageGeneration");
	copyBooleanCapability(normalized, source, "imageEdit");
	const reasoningEfforts = normalizeReasoningEfforts(source.reasoningEfforts);
	if (reasoningEfforts !== undefined) {
		normalized.reasoningEfforts = reasoningEfforts;
	}
	normalized.vision = source.vision ?? (source.imageInput === true || source.videoInput === true);

	return normalized;
}
