import { createHash } from "node:crypto";

const REDACTED_VALUE: string = "[redacted]";
const MAX_TRACE_STRING_CHARS: number = 1_000_000;
const SENSITIVE_KEY: RegExp = /^(?:authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|x-api-key|password|passwd|secret|client[-_]?secret|accessId|access[-_]?token|refresh[-_]?token|id[-_]?token)$/i;
const SENSITIVE_ENV_KEY: RegExp = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|COOKIE)$/i;

export type RedactedTraceValue = {
	value: unknown;
	redactedFields: string[];
	truncated: boolean;
};

export function hashTraceContent(value: unknown): string {
	const serialized: string = typeof value === "string" ? value : JSON.stringify(value);
	return createHash("sha256").update(serialized).digest("hex");
}

function redactString(value: string): { value: string; redacted: boolean; truncated: boolean } {
	let result: string = value;
	let redacted: boolean = false;
	const replacements: Array<[RegExp, string]> = [
		// 图片只保留在其专属存储中，provider 实际请求不能再把像素复制进轨迹
		[/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, "[image payload omitted]"],
		[/((?:"|\\")accessId(?:"|\\")\s*:\s*(?:"|\\"))[a-zA-Z0-9_-]+/g, `$1${REDACTED_VALUE}`],
		[/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED_VALUE}`],
		[/\bsk-[A-Za-z0-9_-]{12,}\b/g, REDACTED_VALUE],
		[/\b(https?:\/\/)[^\s:@/]+:[^\s@/]+@/gi, `$1${REDACTED_VALUE}@`],
		[/([?&](?:api[-_]?key|access[-_]?token|token|secret|password)=)[^&#\s]+/gi, `$1${REDACTED_VALUE}`],
		[/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|COOKIE))\s*=\s*([^\s,;]+)/g, `$1=${REDACTED_VALUE}`]
	];
	for (const [pattern, replacement] of replacements) {
		const next: string = result.replace(pattern, replacement);
		redacted ||= next !== result;
		result = next;
	}
	if (result.length > MAX_TRACE_STRING_CHARS) {
		return { value: result.slice(0, MAX_TRACE_STRING_CHARS), redacted, truncated: true };
	}
	return { value: result, redacted, truncated: false };
}

export function redactTraceValue(input: unknown): RedactedTraceValue {
	const redactedFields: string[] = [];
	let truncated: boolean = false;
	const visit = (value: unknown, path: string): unknown => {
		if (typeof value === "string") {
			const redacted = redactString(value);
			if (redacted.redacted) redactedFields.push(path || "$text");
			truncated ||= redacted.truncated;
			return redacted.value;
		}
		if (Array.isArray(value)) {
			return value.map((entry: unknown, index: number): unknown => visit(entry, `${path}[${index}]`));
		}
		if (typeof value !== "object" || value === null) return value;
		const result: Record<string, unknown> = {};
		const imageSource = value as Record<string, unknown>;
		const base64Image: boolean = typeof imageSource.media_type === "string" && imageSource.media_type.startsWith("image/") && imageSource.type === "base64"
			|| typeof imageSource.mimeType === "string" && imageSource.mimeType.startsWith("image/");
		for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
			const nextPath: string = path.length === 0 ? key : `${path}.${key}`;
			if (base64Image && key === "data") {
				result[key] = "[image payload omitted]";
				redactedFields.push(nextPath);
				continue;
			}
			if (SENSITIVE_KEY.test(key) || SENSITIVE_ENV_KEY.test(key)) {
				result[key] = REDACTED_VALUE;
				redactedFields.push(nextPath);
				continue;
			}
			result[key] = visit(entry, nextPath);
		}
		return result;
	};
	return { value: visit(input, ""), redactedFields, truncated };
}
