import { registerPluginTool } from "../runtime/registries.js";
import type { PluginToolRegistration } from "../runtime/worker-protocol.js";
import { MAX_PLUGIN_TOOLS } from "../runtime/runtime-limits.js";

export function registerHarnessTools(pluginId: string, registrations: readonly PluginToolRegistration[]): void {
	if (registrations.length > MAX_PLUGIN_TOOLS) throw new Error("Harness tool registry exceeds the plugin limit.");
	for (const registration of registrations) registerPluginTool(pluginId, registration, "harness");
}
