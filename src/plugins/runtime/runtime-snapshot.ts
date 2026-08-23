import type { PluginRuntimeSnapshot } from "../types.js";

export function getRuntimeRecoveryFields(
	status: PluginRuntimeSnapshot["status"] | undefined
): Partial<Pick<PluginRuntimeSnapshot, "lastError" | "lastExitCode">> {
	return status === "starting" || status === "ready"
		? { lastError: undefined, lastExitCode: null }
		: {};
}
