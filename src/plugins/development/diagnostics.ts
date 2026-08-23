import type { PluginDevelopmentDiagnostic } from "./types.js";

const MAX_DIAGNOSTICS: number = 100;
const MAX_MESSAGE_LENGTH: number = 2_000;
const SENSITIVE_PATTERN: RegExp = /(api[_-]?key|authorization|cookie|password|secret|token|mcp[_-]?header)/giu;

export function redactPluginDiagnosticText(value: string): string {
	return value
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [redacted]")
		.replace(/(api[_-]?key|authorization|cookie|password|secret|token)(\s*[:=]\s*)([^\s,;]+)/giu, "$1$2[redacted]")
		// Keep machine-specific paths out of persisted status and RPC results.
		.replace(/\b[A-Za-z]:\\[^\r\n\s"']+/gu, "[path]")
		.replace(/\/(?:Users|home|private|var)\/[^\r\n\s"']+/gu, "[path]")
		.slice(0, MAX_MESSAGE_LENGTH);
}

export function createPluginDiagnostic(input: Partial<PluginDevelopmentDiagnostic> & Pick<PluginDevelopmentDiagnostic, "code" | "message">): PluginDevelopmentDiagnostic {
	return {
		code: input.code,
		message: redactPluginDiagnosticText(input.message),
		severity: input.severity ?? "error",
		stage: input.stage ?? "test",
		retryable: input.retryable ?? true,
		...(input.path === undefined ? {} : { path: redactPluginDiagnosticText(input.path).slice(0, 240) }),
		...(input.caseId === undefined ? {} : { caseId: input.caseId.slice(0, 64) }),
		...(input.capability === undefined ? {} : { capability: input.capability.slice(0, 80) }),
		...(input.hint === undefined ? {} : { hint: redactPluginDiagnosticText(input.hint) }),
		...(input.details === undefined ? {} : { details: Object.fromEntries(Object.entries(input.details).filter(([key]) => !SENSITIVE_PATTERN.test(key)).slice(0, 12).map(([key, value]) => [key.slice(0, 64), redactPluginDiagnosticText(value)])) })
	};
}

export function boundPluginDiagnostics(values: readonly PluginDevelopmentDiagnostic[]): PluginDevelopmentDiagnostic[] {
	return values.slice(-MAX_DIAGNOSTICS).map((value) => createPluginDiagnostic(value));
}
