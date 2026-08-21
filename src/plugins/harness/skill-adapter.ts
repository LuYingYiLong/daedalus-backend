import { registerPluginSkill } from "../runtime/registries.js";
import type { PluginSkillRegistration } from "../runtime/worker-protocol.js";
import { MAX_PLUGIN_SKILLS } from "../runtime/runtime-limits.js";

export function registerHarnessSkills(pluginId: string, registrations: readonly PluginSkillRegistration[]): void {
	if (registrations.length > MAX_PLUGIN_SKILLS) throw new Error("Harness skill registry exceeds the plugin limit.");
	for (const registration of registrations) registerPluginSkill(pluginId, registration, "harness");
}
