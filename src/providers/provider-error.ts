export type ProviderErrorInfo = {
	code: "provider_error" | "provider_quota_exhausted" | "provider_connection_interrupted" | "provider_response_stalled";
	message: string;
};

const PROVIDER_CONTEXT_LENGTH_ERROR_CODES: ReadonlySet<string> = new Set([
	"context_length_exceeded",
	"context_window_exceeded",
	"max_context_length_exceeded",
	"prompt_too_long",
	"input_too_long",
	"too_many_tokens",
	"request_too_large"
]);

function collectStructuredErrorCodes(error: unknown, codes: string[], seen: Set<object>, depth: number = 0): void {
	if (depth > 5 || typeof error !== "object" || error === null || seen.has(error)) {
		return;
	}

	seen.add(error);
	const source: Record<string, unknown> = error as Record<string, unknown>;
	for (const key of ["code", "type", "errorCode", "reason"] as const) {
		const value: unknown = source[key];
		if (typeof value === "string" && value.length > 0) {
			codes.push(value.toLowerCase());
		}
	}
	for (const nested of [source.error, source.cause, source.body, source.response, source.data]) {
		collectStructuredErrorCodes(nested, codes, seen, depth + 1);
	}
}

/**
 * Context recovery is intentionally gated by provider-owned structured fields.
 * Arbitrary error text must not trigger a destructive retry or replay a model step.
 */
export function isProviderContextLengthError(error: unknown): boolean {
	const codes: string[] = [];
	collectStructuredErrorCodes(error, codes, new Set<object>());
	return codes.some((code: string): boolean => PROVIDER_CONTEXT_LENGTH_ERROR_CODES.has(code));
}

const QUOTA_ERROR_PATTERN: RegExp = /\b(insufficient[_ -]?(quota|balance|credits?)|quota[_ -]?exceeded|billing|payment required|balance not enough|not enough balance)\b|余额不足|额度不足|欠费/i;

const RETRYABLE_TRANSPORT_ERROR_CODES: ReadonlySet<string> = new Set([
	"ECONNRESET",
	"EPIPE",
	"ETIMEDOUT",
	"UND_ERR_BODY_TIMEOUT",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_SOCKET"
]);
const RETRYABLE_TRANSPORT_MESSAGE_PATTERN: RegExp = /\bterminated\b|socket hang up|premature(?:ly)? closed|other side closed|network connection was lost/iu;
const PROVIDER_CONNECTION_INTERRUPTED_MESSAGE: string = "The connection to the model provider ended unexpectedly. Daedalus could not complete the response. Check your network or the provider service, then try again.";
const PROVIDER_RESPONSE_STALLED_MESSAGE: string = "The model provider stopped producing data before the response completed. Daedalus saved the unfinished run so it can be retried from a safe checkpoint.";

function collectErrorSignals(error: unknown, signals: string[], seen: Set<object>, depth: number = 0): void {
	if (depth > 5 || error === null || error === undefined) {
		return;
	}
	if (typeof error === "string") {
		signals.push(error);
		return;
	}
	if (typeof error !== "object" || seen.has(error)) {
		return;
	}

	seen.add(error);
	const source: Record<string, unknown> = error as Record<string, unknown>;
	for (const value of [source.name, source.code, source.message]) {
		if (typeof value === "string" && value.length > 0) {
			signals.push(value);
		}
	}
	collectErrorSignals(source.cause, signals, seen, depth + 1);
}

export function isRetryableProviderTransportError(error: unknown): boolean {
	const signals: string[] = [];
	collectErrorSignals(error, signals, new Set<object>());
	if (signals.some((signal: string): boolean => signal === "AbortError" || /cancel(?:led)?|aborted/iu.test(signal))) {
		return false;
	}

	return signals.some((signal: string): boolean => (
		RETRYABLE_TRANSPORT_ERROR_CODES.has(signal.toUpperCase())
		|| RETRYABLE_TRANSPORT_MESSAGE_PATTERN.test(signal)
	));
}

function getErrorStatus(error: unknown): number | undefined {
	if (typeof error !== "object" || error === null) {
		return undefined;
	}

	const source: Record<string, unknown> = error as Record<string, unknown>;
	const status: unknown = source.status ?? source.statusCode ?? source.code;
	return typeof status === "number" ? status : undefined;
}

export function getProviderErrorMessage(error: unknown, fallback: string = "Provider API call failed"): string {
	if (error instanceof Error && error.message.length > 0) {
		return error.message;
	}

	if (typeof error === "object" && error !== null) {
		const source: Record<string, unknown> = error as Record<string, unknown>;
		const message: unknown = source.message ?? source.error;
		if (typeof message === "string" && message.length > 0) {
			return message;
		}
	}

	return fallback;
}

export function classifyProviderError(error: unknown): ProviderErrorInfo {
	const message: string = getProviderErrorMessage(error);
	const status: number | undefined = getErrorStatus(error);
	const errorCode: unknown = typeof error === "object" && error !== null
		? (error as Record<string, unknown>).code
		: undefined;
	if (status === 402 || QUOTA_ERROR_PATTERN.test(message)) {
		return {
			code: "provider_quota_exhausted",
			message
		};
	}
	if (isRetryableProviderTransportError(error)) {
		return {
			code: "provider_connection_interrupted",
			message: PROVIDER_CONNECTION_INTERRUPTED_MESSAGE
		};
	}
	if (errorCode === "provider_connection_interrupted") {
		return {
			code: "provider_connection_interrupted",
			message: PROVIDER_CONNECTION_INTERRUPTED_MESSAGE
		};
	}
	if (errorCode === "provider_response_stalled") {
		return {
			code: "provider_response_stalled",
			message: PROVIDER_RESPONSE_STALLED_MESSAGE
		};
	}

	return {
		code: "provider_error",
		message
	};
}

export function createProviderStatusEvent(error: unknown): Record<string, string> {
	const info: ProviderErrorInfo = classifyProviderError(error);
	if (info.code === "provider_quota_exhausted") {
		return {
			status: "error",
			title: "Quota Exhausted",
			details: "The model provider returned insufficient quota or balance. The current response has been stopped. Please check your account balance, plan quota, or switch to another API key and try again.",
			actionLabel: "Open settings",
			actionId: "provider-settings",
			code: info.code
		};
	}
	if (info.code === "provider_connection_interrupted") {
		return {
			status: "error",
			title: "Model Connection Interrupted",
			details: info.message,
			code: info.code
		};
	}
	if (info.code === "provider_response_stalled") {
		return {
			status: "warning",
			title: "Model Response Paused",
			details: info.message,
			code: info.code
		};
	}

	return {
		status: "error",
		title: "Model Request Failed",
		details: info.message,
		code: info.code
	};
}
