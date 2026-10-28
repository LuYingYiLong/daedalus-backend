import { randomUUID } from "node:crypto";
import { getBackendBuildMetadata } from "../runtime/build-metadata.js";
import type { ProviderChatOptions } from "./provider-types.js";
import { applyProviderRequestOverridesToFetchInit } from "./provider-request-overrides.js";

const OPENCODE_GO_USER_AGENT: string = `daedalus-backend/${getBackendBuildMetadata().version}`;

function resolveOpenCodeGoSession(options: ProviderChatOptions): string {
	for (const value of [options.usageContext?.sessionId, options.usageContext?.runId, options.usageContext?.requestId]) {
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}
	// One-off requests without a conversation still need a distinct routing key.
	return `daedalus-${randomUUID()}`;
}

export function createProviderRequestFetch(fetchImpl: typeof fetch, options: ProviderChatOptions): typeof fetch {
	if (options.provider !== "opencode_go" && options.requestOverrides === undefined) {
		return fetchImpl;
	}

	const goSession: string | undefined = options.provider === "opencode_go" ? resolveOpenCodeGoSession(options) : undefined;
	return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const requestInit: RequestInit = applyProviderRequestOverridesToFetchInit(init ?? {}, options.requestOverrides);
		if (goSession !== undefined) {
			const headers: Headers = new Headers(requestInit.headers);
			headers.set("x-opencode-session", goSession);
			headers.set("User-Agent", OPENCODE_GO_USER_AGENT);
			requestInit.headers = headers;
		}
		return fetchImpl(input, requestInit);
	};
}
