import { randomUUID } from "node:crypto";
import { resolveProviderBaseUrl } from "./provider-base-url.js";
import {
	registerWebSearchProviderAdapter,
	type WebSearchExecutionConfig,
	type WebSearchProviderAdapter,
	type WebSearchResult,
	type WebSearchResultItem,
	type WebSearchToolArgs
} from "./web-search-adapter.js";

const WEB_SEARCH_TIMEOUT_MS: number = 45_000;
const RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([429, 500, 503]);
const MAX_RETRIES: number = 2;
const MIMO_MAX_KEYWORDS_MIN: number = 1;
const MIMO_MAX_KEYWORDS_MAX: number = 3;
const MIMO_MAX_LIMIT: number = 50;

type AbortSignalHandle = {
	signal: AbortSignal;
	dispose: () => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getObjectArray(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value)
		? value.filter((item: unknown): item is Record<string, unknown> => isRecord(item))
		: [];
}

function getNestedValue(record: Record<string, unknown>, path: readonly string[]): unknown {
	let current: unknown = record;
	for (const key of path) {
		if (!isRecord(current)) {
			return undefined;
		}
		current = current[key];
	}
	return current;
}

function clampInteger(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, Math.floor(value)));
}

function createAbortSignalHandle(parentSignal?: AbortSignal | undefined): AbortSignalHandle {
	const controller = new AbortController();
	const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
		controller.abort(new Error("Web search request timed out."));
	}, WEB_SEARCH_TIMEOUT_MS);
	const abortFromParent = (): void => controller.abort(parentSignal?.reason);

	if (parentSignal?.aborted === true) {
		abortFromParent();
	} else {
		parentSignal?.addEventListener("abort", abortFromParent, { once: true });
	}

	return {
		signal: controller.signal,
		dispose: (): void => {
			clearTimeout(timer);
			parentSignal?.removeEventListener("abort", abortFromParent);
		}
	};
}

async function parseErrorMessage(response: Response): Promise<string> {
	try {
		const body: unknown = await response.json() as unknown;
		if (isRecord(body)) {
			const message: unknown = getNestedValue(body, ["error", "message"]) ?? body.message;
			if (typeof message === "string" && message.trim().length > 0) {
				return message.trim();
			}
		}
	} catch {
		// 响应体不可解析时使用 HTTP 状态。
	}
	return `HTTP ${response.status}`;
}

function parseRetryAfterMs(response: Response): number | undefined {
	const value: string | null = response.headers.get("retry-after");
	if (value === null) {
		return undefined;
	}
	const seconds: number = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return Math.min(30_000, Math.floor(seconds * 1_000));
	}
	const retryAtMs: number = Date.parse(value);
	return Number.isFinite(retryAtMs) ? Math.min(30_000, Math.max(0, retryAtMs - Date.now())) : undefined;
}

async function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) {
		throw signal.reason;
	}
	await new Promise<void>((resolve, reject): void => {
		const finish = (): void => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		};
		const timer: ReturnType<typeof setTimeout> = setTimeout(finish, delayMs);
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

async function fetchWithRetry(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
	for (let attempt: number = 0; ; attempt += 1) {
		const response: Response = await fetch(url, { ...init, signal });
		if (!RETRYABLE_STATUS_CODES.has(response.status) || attempt >= MAX_RETRIES) {
			return response;
		}
		const retryAfterMs: number | undefined = parseRetryAfterMs(response);
		const exponentialMs: number = 500 * (2 ** attempt);
		const jitterMs: number = Math.floor(Math.random() * 150);
		await waitForRetry(retryAfterMs ?? exponentialMs + jitterMs, signal);
	}
}

function parseSearchResultItem(record: Record<string, unknown>): WebSearchResultItem | null {
	const url: string | undefined = getString(record.link) ?? getString(record.url);
	const title: string | undefined = getString(record.title);
	if (url === undefined || title === undefined) {
		return null;
	}

	const item: WebSearchResultItem = { title, url };
	const summary: string | undefined = getString(record.content) ?? getString(record.summary) ?? getString(record.snippet);
	const source: string | undefined = getString(record.media) ?? getString(record.site_name) ?? getString(record.source) ?? getString(record.refer);
	const publishedAt: string | undefined = getString(record.publish_date) ?? getString(record.publish_time) ?? getString(record.publishedAt);
	if (summary !== undefined) item.summary = summary;
	if (source !== undefined) item.source = source;
	if (publishedAt !== undefined) item.publishedAt = publishedAt;
	return item;
}

function dedupeAndLimitResults(records: Record<string, unknown>[], maxResults: number): WebSearchResultItem[] {
	const seenUrls: Set<string> = new Set();
	const results: WebSearchResultItem[] = [];
	for (const record of records) {
		const item: WebSearchResultItem | null = parseSearchResultItem(record);
		if (item === null || seenUrls.has(item.url)) {
			continue;
		}
		seenUrls.add(item.url);
		if (results.length < maxResults) {
			results.push(item);
		}
	}
	return results;
}

function collectZhipuSearchRecords(body: Record<string, unknown>): Record<string, unknown>[] {
	const searchResults: Record<string, unknown>[] = getObjectArray(body.search_result);
	if (searchResults.length > 0) return searchResults;
	const topLevelResults: Record<string, unknown>[] = getObjectArray(body.web_search);
	if (topLevelResults.length > 0) return topLevelResults;

	const choiceResults: Record<string, unknown>[] = [];
	for (const choice of getObjectArray(body.choices)) {
		choiceResults.push(...getObjectArray(getNestedValue(choice, ["message", "web_search"])));
	}
	return choiceResults;
}

function getZhipuAnswer(body: Record<string, unknown>): string {
	const firstChoice: Record<string, unknown> | undefined = getObjectArray(body.choices)[0];
	return firstChoice === undefined ? "" : getString(getNestedValue(firstChoice, ["message", "content"])) ?? "";
}

function createZhipuSearchQuery(input: WebSearchToolArgs): string {
	const query: string = input.query.trim();
	return [...query].length <= 70 ? query : [...query].slice(0, 70).join("");
}

async function executeZhipuWebSearch(
	config: WebSearchExecutionConfig,
	input: WebSearchToolArgs,
	abortSignal?: AbortSignal | undefined
): Promise<WebSearchResult> {
	const signalHandle: AbortSignalHandle = createAbortSignalHandle(abortSignal);
	const maxResults: number = input.maxResults ?? config.maxResults;
	try {
		const response: Response = await fetchWithRetry(`${resolveProviderBaseUrl(config.provider, config.baseUrl)}/web_search`, {
			method: "POST",
			headers: {
				"Authorization": `Bearer ${config.apiKey}`,
				"Content-Type": "application/json"
			},
			body: JSON.stringify({
				search_query: createZhipuSearchQuery(input),
				search_engine: "search_std",
				search_intent: false,
				count: Math.max(1, maxResults),
				search_recency_filter: "noLimit",
				content_size: "medium",
				request_id: randomUUID()
			})
		}, signalHandle.signal);
		if (!response.ok) {
			throw new Error(`Web search request failed: ${await parseErrorMessage(response)}`);
		}
		const body: unknown = await response.json() as unknown;
		if (!isRecord(body)) {
			throw new Error("Web search response is not an object.");
		}
		const results: WebSearchResultItem[] = dedupeAndLimitResults(collectZhipuSearchRecords(body), maxResults);
		return {
			ok: true,
			type: "web_search",
			provider: config.provider,
			model: config.model,
			query: input.query,
			answer: getZhipuAnswer(body) || `Web search returned ${results.length} result${results.length === 1 ? "" : "s"}.`,
			results
		};
	} finally {
		signalHandle.dispose();
	}
}

async function executeMimoWebSearch(
	config: WebSearchExecutionConfig,
	input: WebSearchToolArgs,
	abortSignal?: AbortSignal | undefined
): Promise<WebSearchResult> {
	const signalHandle: AbortSignalHandle = createAbortSignalHandle(abortSignal);
	const maxResults: number = input.maxResults ?? config.maxResults;
	const maxKeywords: number = clampInteger(config.maxKeywords, MIMO_MAX_KEYWORDS_MIN, MIMO_MAX_KEYWORDS_MAX);
	const limit: number = clampInteger(Math.ceil(Math.max(1, maxResults) / maxKeywords), 1, MIMO_MAX_LIMIT);
	try {
		const response: Response = await fetchWithRetry(`${resolveProviderBaseUrl(config.provider, config.baseUrl)}/chat/completions`, {
			method: "POST",
			headers: {
				"Authorization": `Bearer ${config.apiKey}`,
				"Content-Type": "application/json"
			},
			body: JSON.stringify({
				model: config.model,
				messages: [{ role: "user", content: input.query }],
				tools: [{
					type: "web_search",
					max_keyword: maxKeywords,
					force_search: true,
					limit
				}],
				tool_choice: "auto",
				thinking: { type: "disabled" },
				max_completion_tokens: 4096,
				stream: false
			})
		}, signalHandle.signal);
		if (!response.ok) {
			throw new Error(`Web search request failed: ${await parseErrorMessage(response)}`);
		}
		const body: unknown = await response.json() as unknown;
		if (!isRecord(body)) {
			throw new Error("Web search response is not an object.");
		}
		const firstChoice: Record<string, unknown> | undefined = getObjectArray(body.choices)[0];
		const message: unknown = firstChoice === undefined ? undefined : firstChoice.message;
		if (!isRecord(message)) {
			throw new Error("MiMo web search response does not contain a message.");
		}
		const searchError: string | undefined = getString(message.error_message);
		if (searchError !== undefined) {
			throw new Error(`MiMo web search failed: ${searchError}`);
		}
		const results: WebSearchResultItem[] = dedupeAndLimitResults(getObjectArray(message.annotations), maxResults);
		const answer: string = getString(message.content) ?? "";
		return {
			ok: true,
			type: "web_search",
			provider: config.provider,
			model: config.model,
			query: input.query,
			answer: answer || `Web search returned ${results.length} result${results.length === 1 ? "" : "s"}.`,
			results
		};
	} finally {
		signalHandle.dispose();
	}
}

const zhipuAdapter: WebSearchProviderAdapter = {
	provider: "zhipu",
	execute: executeZhipuWebSearch
};

const mimoAdapter: WebSearchProviderAdapter = {
	provider: "mimo",
	options: {
		maxKeywords: {
			min: MIMO_MAX_KEYWORDS_MIN,
			max: MIMO_MAX_KEYWORDS_MAX,
			defaultValue: MIMO_MAX_KEYWORDS_MIN,
			chargedPerUnit: true
		}
	},
	execute: executeMimoWebSearch
};

registerWebSearchProviderAdapter(zhipuAdapter);
registerWebSearchProviderAdapter(mimoAdapter);
