import type { ContextBudgetSnapshot } from "./context-types.js";

export const CONTEXT_NUDGE_PERCENT = 45;
export const CONTEXT_TARGET_PERCENT = 50;
export const CONTEXT_AUTO_COMPACT_PERCENT = 70;
export const CONTEXT_EMERGENCY_PERCENT = 90;

function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function toPercent(tokens: number, contextWindowTokens: number): number {
	return contextWindowTokens <= 0 ? 0 : clampPercent((Math.max(0, tokens) / contextWindowTokens) * 100);
}

export function createContextBudgetSnapshot(params: {
	inputTokens: number;
	outputReserveTokens: number;
	safetyMarginTokens: number;
	contextWindowTokens: number;
}): ContextBudgetSnapshot {
	const contextWindowTokens: number = Math.max(0, params.contextWindowTokens);
	const inputTokens: number = Math.max(0, params.inputTokens);
	const outputReserveTokens: number = Math.max(0, params.outputReserveTokens);
	const safetyMarginTokens: number = Math.max(0, params.safetyMarginTokens);
	const committedTokens: number = inputTokens + outputReserveTokens + safetyMarginTokens;
	const committedPercent: number = toPercent(committedTokens, contextWindowTokens);
	return {
		inputTokens,
		outputReserveTokens,
		safetyMarginTokens,
		contextWindowTokens,
		committedTokens,
		availableTokens: Math.max(0, contextWindowTokens - committedTokens),
		inputPercent: toPercent(inputTokens, contextWindowTokens),
		outputReservePercent: toPercent(outputReserveTokens, contextWindowTokens),
		safetyMarginPercent: toPercent(safetyMarginTokens, contextWindowTokens),
		committedPercent,
		availablePercent: toPercent(Math.max(0, contextWindowTokens - committedTokens), contextWindowTokens),
		pressure: committedPercent >= CONTEXT_EMERGENCY_PERCENT
			? "critical"
			: committedPercent >= CONTEXT_AUTO_COMPACT_PERCENT
				? "high"
				: committedPercent >= CONTEXT_NUDGE_PERCENT ? "moderate" : "low",
		shouldNudge: committedPercent >= CONTEXT_NUDGE_PERCENT,
		shouldAutoCompress: committedPercent >= CONTEXT_AUTO_COMPACT_PERCENT,
		shouldEmergencyCompress: committedPercent >= CONTEXT_EMERGENCY_PERCENT
	};
}

export function getContextTargetTokens(contextWindowTokens: number): number {
	return Math.max(0, Math.floor(contextWindowTokens * (CONTEXT_TARGET_PERCENT / 100)));
}
