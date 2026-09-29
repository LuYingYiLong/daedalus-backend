import { createHash } from "node:crypto";

export type PromptVariant = "legacy" | "optimized";
export type PromptCachePolicy = PromptVariant | "canary";

export function getPromptCachePolicy(): PromptCachePolicy {
	const value: string | undefined = process.env.DAEDALUS_PROMPT_CACHE_POLICY;
	return value === "optimized" || value === "canary" ? value : "legacy";
}

export function resolvePromptVariant(sessionId?: string): PromptVariant {
	const policy: PromptCachePolicy = getPromptCachePolicy();
	if (policy !== "canary") return policy;
	if (sessionId === undefined || sessionId.length === 0) return "legacy";
	const bucket: number = createHash("sha256").update(sessionId).digest().readUInt32BE(0) % 10;
	return bucket === 0 ? "optimized" : "legacy";
}
