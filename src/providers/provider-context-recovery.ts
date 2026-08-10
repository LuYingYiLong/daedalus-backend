import type { ContextControlContext } from "../tools/context-control.js";
import { compressContextForProviderRetry } from "../tools/context-control.js";
import { isProviderContextLengthError } from "./provider-error.js";

export async function prepareProviderContextLengthRetry(params: {
	error: unknown;
	retryUsed: boolean;
	contextControl?: ContextControlContext | undefined;
	compactProviderToolResults: () => void;
}): Promise<boolean> {
	if (params.retryUsed || !isProviderContextLengthError(params.error)) return false;

	try {
		await compressContextForProviderRetry(params.contextControl);
	} catch {
		// Provider-native tool-result compaction below remains a safe recovery path.
	}
	params.compactProviderToolResults();
	return true;
}
