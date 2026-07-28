import { resolveWebSearchRuntimeConfig } from "../web-search-settings-store.js";
import {
	getWebSearchProviderAdapter,
	type WebSearchProviderAdapter,
	type WebSearchResult,
	type WebSearchResultItem,
	type WebSearchToolArgs
} from "./web-search-adapter.js";
import "./web-search-adapters.js";

export type { WebSearchResult, WebSearchResultItem, WebSearchToolArgs } from "./web-search-adapter.js";

const MIN_RESULTS: number = 0;
const MAX_RESULTS: number = 100;

function getString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampInteger(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, Math.floor(value)));
}

export function parseWebSearchToolArgs(args: Record<string, unknown>): WebSearchToolArgs {
	const query: string | undefined = getString(args.query);
	if (query === undefined) {
		throw new Error("Web search requires a non-empty query.");
	}

	const rawMaxResults: number | undefined = getNumber(args.maxResults);
	return {
		query,
		reason: getString(args.reason),
		maxResults: rawMaxResults === undefined ? undefined : clampInteger(rawMaxResults, MIN_RESULTS, MAX_RESULTS)
	};
}

export async function executeWebSearch(input: WebSearchToolArgs, abortSignal?: AbortSignal | undefined): Promise<WebSearchResult> {
	const config = await resolveWebSearchRuntimeConfig();
	if (config === null) {
		throw new Error("Web search is not enabled or the configured search provider is missing an API key.");
	}

	const adapter: WebSearchProviderAdapter | undefined = getWebSearchProviderAdapter(config.provider);
	if (adapter === undefined) {
		throw new Error(`Provider does not support Daedalus web search: ${config.provider}`);
	}
	return adapter.execute(config, input, abortSignal);
}
