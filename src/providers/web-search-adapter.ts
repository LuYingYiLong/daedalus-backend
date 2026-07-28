import type { ProviderId } from "../protocol/types.js";

export type WebSearchToolArgs = {
	query: string;
	reason?: string | undefined;
	maxResults?: number | undefined;
};

export type WebSearchResultItem = {
	title: string;
	url: string;
	summary?: string | undefined;
	source?: string | undefined;
	publishedAt?: string | undefined;
};

export type WebSearchResult = {
	ok: true;
	type: "web_search";
	provider: ProviderId;
	model: string;
	query: string;
	answer: string;
	results: WebSearchResultItem[];
};

export type WebSearchProviderOptions = {
	maxKeywords?: {
		min: number;
		max: number;
		defaultValue: number;
		chargedPerUnit: boolean;
	} | undefined;
};

export type WebSearchExecutionConfig = {
	provider: ProviderId;
	model: string;
	maxResults: number;
	maxKeywords: number;
	apiKey: string;
	baseUrl?: string | undefined;
};

export type WebSearchProviderAdapter = {
	provider: ProviderId;
	options?: WebSearchProviderOptions | undefined;
	execute: (
		config: WebSearchExecutionConfig,
		input: WebSearchToolArgs,
		abortSignal?: AbortSignal | undefined
	) => Promise<WebSearchResult>;
};

const ADAPTERS: Map<ProviderId, WebSearchProviderAdapter> = new Map();

export function registerWebSearchProviderAdapter(adapter: WebSearchProviderAdapter): void {
	if (ADAPTERS.has(adapter.provider)) {
		throw new Error(`Web search adapter already registered: ${adapter.provider}`);
	}
	ADAPTERS.set(adapter.provider, adapter);
}

export function getWebSearchProviderAdapter(provider: ProviderId): WebSearchProviderAdapter | undefined {
	return ADAPTERS.get(provider);
}

export function getRegisteredWebSearchProviders(): ProviderId[] {
	return [...ADAPTERS.keys()];
}
