export type ProviderEmptyResponseDetails = {
	finishReason?: string | undefined;
	responseStatus?: string | undefined;
	incompleteReason?: string | undefined;
	reasoningChars?: number | undefined;
	refused?: boolean | undefined;
};

export class ProviderEmptyResponseError extends Error {
	readonly code = "empty_response";
	readonly details: ProviderEmptyResponseDetails;

	constructor(details: ProviderEmptyResponseDetails = {}) {
		super("LLM returned empty response");
		this.name = "ProviderEmptyResponseError";
		this.details = details;
	}
}

export function isProviderEmptyResponseError(error: unknown): boolean {
	return error instanceof ProviderEmptyResponseError
		|| (error instanceof Error && error.message === "LLM returned empty response");
}
