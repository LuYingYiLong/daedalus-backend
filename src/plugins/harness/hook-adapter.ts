import { registerPluginHook } from "../runtime/registries.js";
import type { PluginHookRegistration } from "../runtime/worker-protocol.js";
import { MAX_PLUGIN_HOOKS } from "../runtime/runtime-limits.js";

export function registerHarnessHooks(pluginId: string, registrations: readonly PluginHookRegistration[]): void {
	if (registrations.length > MAX_PLUGIN_HOOKS) throw new Error("Harness Hook registry exceeds the plugin limit.");
	for (const registration of registrations) registerPluginHook(pluginId, registration, registration.handlerName ?? registration.event, "harness");
}
