export type ProviderRequestJsonValue =
	| null
	| boolean
	| number
	| string
	| ProviderRequestJsonValue[]
	| { [key: string]: ProviderRequestJsonValue };

export type ProviderRequestBodyOverrides = Record<string, ProviderRequestJsonValue>;

/**
 * Per-provider additions to an inference request.
 *
 * The request owner still controls model selection, conversation input,
 * streaming, tools, and all other protocol-critical fields. Overrides can
 * only add a provider extension that is not already present in the request.
 */
export type ProviderRequestOverrides = {
	headers: Record<string, string>;
	body: ProviderRequestBodyOverrides;
};

export type ProviderRequestOverridesInput = {
	headers?: Record<string, string> | undefined;
	body?: Record<string, unknown> | undefined;
};

const MAX_HEADER_COUNT: number = 40;
const MAX_HEADER_NAME_LENGTH: number = 160;
const MAX_HEADER_VALUE_LENGTH: number = 8_000;
const MAX_BODY_PROPERTY_COUNT: number = 64;
const MAX_BODY_DEPTH: number = 8;
const MAX_BODY_SERIALIZED_LENGTH: number = 32_000;

const RESERVED_HEADER_NAMES: ReadonlySet<string> = new Set([
	"authorization",
	"content-type",
	"content-length",
	"host",
	"connection",
	"transfer-encoding"
]);

const RESERVED_BODY_FIELDS: ReadonlySet<string> = new Set([
	"model",
	"messages",
	"input",
	"instructions",
	"stream",
	"tools",
	"tool_choice",
	"parallel_tool_calls",
	"store"
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJsonValue(value: unknown, depth: number = 0): ProviderRequestJsonValue {
	if (depth > MAX_BODY_DEPTH) {
		throw new Error("provider_request_overrides_invalid: Request body nesting is too deep.");
	}
	if (value === null || typeof value === "string" || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new Error("provider_request_overrides_invalid: Request body numbers must be finite.");
		}
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((item: unknown): ProviderRequestJsonValue => cloneJsonValue(item, depth + 1));
	}
	if (!isPlainRecord(value)) {
		throw new Error("provider_request_overrides_invalid: Request body must contain JSON values only.");
	}

	const result: Record<string, ProviderRequestJsonValue> = {};
	for (const [key, nestedValue] of Object.entries(value)) {
		if (key === "__proto__" || key === "constructor" || key === "prototype") {
			throw new Error("provider_request_overrides_invalid: Request body contains an unsafe property name.");
		}
		result[key] = cloneJsonValue(nestedValue, depth + 1);
	}
	return result;
}

function normalizeHeaders(value: unknown): Record<string, string> {
	if (value === undefined) {
		return {};
	}
	if (!isPlainRecord(value)) {
		throw new Error("provider_request_overrides_invalid: headers must be a JSON object.");
	}

	const headers: Record<string, string> = {};
	const normalizedNames: Set<string> = new Set();
	for (const [rawName, rawValue] of Object.entries(value)) {
		const name: string = rawName.trim();
		if (name.length === 0 || name.length > MAX_HEADER_NAME_LENGTH || /[\r\n]/u.test(name)) {
			throw new Error("provider_request_overrides_invalid: A header name is invalid.");
		}
		if (typeof rawValue !== "string" || rawValue.length > MAX_HEADER_VALUE_LENGTH || /[\r\n]/u.test(rawValue)) {
			throw new Error(`provider_request_overrides_invalid: Header ${name} has an invalid value.`);
		}
		const normalizedName: string = name.toLowerCase();
		if (RESERVED_HEADER_NAMES.has(normalizedName)) {
			throw new Error(`provider_request_overrides_invalid: Header ${name} is managed by Daedalus.`);
		}
		if (normalizedNames.has(normalizedName)) {
			throw new Error(`provider_request_overrides_invalid: Header ${name} is duplicated.`);
		}
		normalizedNames.add(normalizedName);
		headers[name] = rawValue;
	}
	if (Object.keys(headers).length > MAX_HEADER_COUNT) {
		throw new Error(`provider_request_overrides_invalid: A maximum of ${MAX_HEADER_COUNT} headers is allowed.`);
	}
	return headers;
}

function normalizeBody(value: unknown): ProviderRequestBodyOverrides {
	if (value === undefined) {
		return {};
	}
	if (!isPlainRecord(value)) {
		throw new Error("provider_request_overrides_invalid: body must be a JSON object.");
	}

	const body: ProviderRequestBodyOverrides = {};
	for (const [rawKey, rawValue] of Object.entries(value)) {
		const key: string = rawKey.trim();
		if (key.length === 0 || key.length > 160 || key === "__proto__" || key === "constructor" || key === "prototype") {
			throw new Error("provider_request_overrides_invalid: A body property name is invalid.");
		}
		if (RESERVED_BODY_FIELDS.has(key)) {
			throw new Error(`provider_request_overrides_invalid: Body property ${key} is managed by Daedalus.`);
		}
		body[key] = cloneJsonValue(rawValue);
	}
	if (Object.keys(body).length > MAX_BODY_PROPERTY_COUNT) {
		throw new Error(`provider_request_overrides_invalid: A maximum of ${MAX_BODY_PROPERTY_COUNT} body properties is allowed.`);
	}
	if (JSON.stringify(body).length > MAX_BODY_SERIALIZED_LENGTH) {
		throw new Error("provider_request_overrides_invalid: Request body overrides are too large.");
	}
	return body;
}

export function normalizeProviderRequestOverrides(value: unknown): ProviderRequestOverrides | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!isPlainRecord(value)) {
		throw new Error("provider_request_overrides_invalid: Request configuration must be a JSON object.");
	}

	const headers: Record<string, string> = normalizeHeaders(value.headers);
	const body: ProviderRequestBodyOverrides = normalizeBody(value.body);
	return Object.keys(headers).length === 0 && Object.keys(body).length === 0 ? undefined : { headers, body };
}

export function cloneProviderRequestOverrides(value: ProviderRequestOverrides | undefined): ProviderRequestOverrides | undefined {
	if (value === undefined) {
		return undefined;
	}
	return normalizeProviderRequestOverrides(value);
}

export function applyProviderRequestBodyOverrides(
	requestBody: Record<string, unknown>,
	overrides: ProviderRequestOverrides | undefined
): void {
	for (const [key, value] of Object.entries(overrides?.body ?? {})) {
		if (!Object.prototype.hasOwnProperty.call(requestBody, key)) {
			requestBody[key] = cloneJsonValue(value);
		}
	}
}

export function applyProviderRequestOverridesToFetchInit(
	init: RequestInit,
	overrides: ProviderRequestOverrides | undefined
): RequestInit {
	if (overrides === undefined) {
		return init;
	}

	const headers: Headers = new Headers(init.headers);
	for (const [name, value] of Object.entries(overrides.headers)) {
		if (!headers.has(name)) {
			headers.set(name, value);
		}
	}

	let body: BodyInit | null | undefined = init.body;
	if (typeof init.body === "string" && Object.keys(overrides.body).length > 0) {
		try {
			const parsed: unknown = JSON.parse(init.body);
			if (isPlainRecord(parsed)) {
				applyProviderRequestBodyOverrides(parsed, overrides);
				body = JSON.stringify(parsed);
			}
		} catch {
			// Non-JSON request payloads are not inference request bodies and stay untouched
		}
	}

	const result: RequestInit = {
		...init,
		headers
	};
	if (body !== undefined) {
		result.body = body;
	}
	return result;
}

export function createProviderRequestOverrideFetch(
	fetchImpl: typeof fetch,
	overrides: ProviderRequestOverrides | undefined
): typeof fetch {
	if (overrides === undefined) {
		return fetchImpl;
	}
	return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		return fetchImpl(input, applyProviderRequestOverridesToFetchInit(init ?? {}, overrides));
	};
}
