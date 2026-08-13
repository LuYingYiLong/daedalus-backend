import type { ProviderId } from "../protocol/types.js";
import { getModelCustomizationRecords } from "./provider-customizations-store.js";
import { getProviderFallbackModels } from "./provider-registry.js";
import type { BaseReasoningEffort, ProviderModelInfo, ProviderReasoningEffortOption } from "./provider-types.js";

export const DEFAULT_REASONING_EFFORT: BaseReasoningEffort = "medium";

function getReasoningEffortOptions(provider: ProviderId, model: string): readonly ProviderReasoningEffortOption[] {
	const customizedOptions: ProviderReasoningEffortOption[] | undefined = getModelCustomizationRecords(provider)[model]?.reasoningEfforts;
	if (customizedOptions !== undefined) {
		return customizedOptions;
	}
	const modelInfo: ProviderModelInfo | undefined = getProviderFallbackModels(provider)
		.find((candidate: ProviderModelInfo): boolean => candidate.id === model);
	return modelInfo?.capabilities.reasoningEfforts ?? [];
}

function findOptionByFallback(
	options: readonly ProviderReasoningEffortOption[],
	fallback: BaseReasoningEffort
): ProviderReasoningEffortOption | undefined {
	return options.find((option: ProviderReasoningEffortOption): boolean => option.id === fallback)
		?? options.find((option: ProviderReasoningEffortOption): boolean => option.fallback === fallback);
}

/** Returns a supported effort for the selected model, or undefined for fixed/non-reasoning models. */
export function resolveReasoningEffort(
	provider: ProviderId,
	model: string,
	requested: string | undefined
): string | undefined {
	const options: readonly ProviderReasoningEffortOption[] = getReasoningEffortOptions(provider, model);
	if (options.length === 0) {
		return undefined;
	}
	if (requested !== undefined) {
		const exact: ProviderReasoningEffortOption | undefined = options.find((option: ProviderReasoningEffortOption): boolean => option.id === requested);
		if (exact !== undefined) {
			return exact.id;
		}
	}
	return options.find((option: ProviderReasoningEffortOption): boolean => option.default === true)?.id
		?? findOptionByFallback(options, DEFAULT_REASONING_EFFORT)?.id
		?? options[0]?.id;
}

/** Maps a model-specific level such as xhigh to the closest supported level on the next model. */
export function resolveReasoningEffortForModelChange(
	previousProvider: ProviderId,
	previousModel: string,
	previousEffort: string | undefined,
	nextProvider: ProviderId,
	nextModel: string
): string | undefined {
	const previousOptions: readonly ProviderReasoningEffortOption[] = getReasoningEffortOptions(previousProvider, previousModel);
	const previousOption: ProviderReasoningEffortOption | undefined = previousOptions
		.find((option: ProviderReasoningEffortOption): boolean => option.id === previousEffort);
	const normalized: BaseReasoningEffort = previousOption?.fallback
		?? (previousEffort === "low" || previousEffort === "medium" || previousEffort === "high" || previousEffort === "max"
			? previousEffort
			: DEFAULT_REASONING_EFFORT);
	return resolveReasoningEffort(nextProvider, nextModel, normalized);
}
