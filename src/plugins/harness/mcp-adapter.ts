import { registerPluginMcp } from "../runtime/registries.js";
import type { PluginMcpRegistration } from "../runtime/worker-protocol.js";
import { MAX_PLUGIN_MCP_SERVERS } from "../runtime/runtime-limits.js";

export function registerHarnessMcpServers(pluginId: string, registrations: readonly PluginMcpRegistration[]): void {
	if (registrations.length > MAX_PLUGIN_MCP_SERVERS) throw new Error("Harness MCP registry exceeds the plugin limit.");
	for (const registration of registrations) registerPluginMcp(pluginId, registration, "harness");
}
