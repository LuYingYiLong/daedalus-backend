const MAX_PROVIDER_WEBSITE_URL_LENGTH = 2048;

export function normalizeProviderWebsiteUrl(value: unknown): string | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error("Provider website URL must be a string.");
	}
	const normalized: string = value.trim();
	if (normalized.length === 0) {
		return undefined;
	}
	if (normalized.length > MAX_PROVIDER_WEBSITE_URL_LENGTH) {
		throw new Error(`Provider website URL must not exceed ${MAX_PROVIDER_WEBSITE_URL_LENGTH} characters.`);
	}
	let parsed: URL;
	try {
		parsed = new URL(normalized);
	} catch {
		throw new Error("Provider website URL must be a valid URL.");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("Provider website URL must use http or https.");
	}
	return normalized;
}
