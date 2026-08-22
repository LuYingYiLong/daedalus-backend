import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { ToolMapping } from "../../tools/tool-mapping.js";
import type { PluginHookRegistration, PluginMcpRegistration, PluginSkillRegistration, PluginToolRegistration, PluginToolRisk } from "./worker-protocol.js";

export type PluginRegistryNamespace = "plugin" | "harness";
export type RegisteredPluginTool = PluginToolRegistration & { llmToolName: string; pluginId: string; namespace: PluginRegistryNamespace; mapping: ToolMapping };
export type RegisteredPluginSkill = PluginSkillRegistration & { pluginId: string; namespace: PluginRegistryNamespace; ref: string };
export type RegisteredPluginHook = PluginHookRegistration & { pluginId: string; namespace: PluginRegistryNamespace; handlerName: string };
export type RegisteredPluginMcp = PluginMcpRegistration & { pluginId: string; namespace: PluginRegistryNamespace; serverId: string; localServerId: string };
export type RegisteredPluginMcpTool = {
	pluginId: string;
	serverId: string;
	llmToolName: string;
	name: string;
	description?: string | undefined;
	inputSchema: Record<string, unknown>;
	risk: PluginToolRisk;
};

const tools = new Map<string, RegisteredPluginTool>();
const definitions = new Map<string, ChatCompletionTool>();
const skills = new Map<string, RegisteredPluginSkill>();
const hooks = new Map<string, RegisteredPluginHook[]>();
const mcps = new Map<string, RegisteredPluginMcp>();

function toolName(pluginId: string, name: string, namespace: PluginRegistryNamespace = "plugin"): string {
	return `mcp_${namespace}_${pluginId.replace(/[^a-z0-9]+/giu, "_").slice(0, 24)}_${name.replace(/[^a-z0-9]+/giu, "_").slice(0, 32)}`;
}

export function clearPluginRegistrations(pluginId: string): void {
	for (const [name, entry] of tools) if (entry.pluginId === pluginId) { tools.delete(name); definitions.delete(name); }
	for (const [ref, entry] of skills) if (entry.pluginId === pluginId) skills.delete(ref);
	for (const [event, entries] of hooks) {
		const filtered = entries.filter((entry): boolean => entry.pluginId !== pluginId);
		if (filtered.length === 0) hooks.delete(event); else hooks.set(event, filtered);
	}
	for (const [serverId, entry] of mcps) if (entry.pluginId === pluginId) mcps.delete(serverId);
}

export function registerPluginTool(pluginId: string, registration: PluginToolRegistration, namespace: PluginRegistryNamespace = "plugin"): RegisteredPluginTool {
	const llmToolName = toolName(pluginId, registration.name, namespace);
	const existing = tools.get(llmToolName);
	if (existing !== undefined) throw Object.assign(new Error(`Plugin tool name conflicts with ${existing.pluginId}.`), { code: "plugin_registry_conflict" });
	const entry: RegisteredPluginTool = { ...registration, pluginId, namespace, llmToolName, mapping: { serverId: `${namespace}:${pluginId}`, toolName: registration.name } };
	tools.set(llmToolName, entry);
	definitions.set(llmToolName, { type: "function", function: { name: llmToolName, description: registration.description.slice(0, 1024), parameters: registration.inputSchema } });
	return entry;
}

export function registerPluginSkill(pluginId: string, registration: PluginSkillRegistration, namespace: PluginRegistryNamespace = "plugin"): RegisteredPluginSkill {
	const ref = `${namespace}:${pluginId}:${registration.slug}`;
	if (skills.has(ref)) throw Object.assign(new Error(`Plugin Skill ref is already registered: ${ref}.`), { code: "plugin_registry_conflict" });
	const entry: RegisteredPluginSkill = { ...registration, pluginId, namespace, ref };
	skills.set(ref, entry);
	return entry;
}

export function registerPluginHook(pluginId: string, registration: PluginHookRegistration, handlerName: string, namespace: PluginRegistryNamespace = "plugin"): RegisteredPluginHook {
	const entry: RegisteredPluginHook = { ...registration, pluginId, namespace, handlerName };
	if ((hooks.get(registration.event) ?? []).some((candidate): boolean => candidate.pluginId === pluginId && candidate.handlerName === handlerName)) throw Object.assign(new Error(`Plugin Hook is already registered: ${registration.event}.`), { code: "plugin_registry_conflict" });
	hooks.set(registration.event, [...(hooks.get(registration.event) ?? []), entry]);
	return entry;
}

export function registerPluginMcp(pluginId: string, registration: PluginMcpRegistration, namespace: PluginRegistryNamespace = "plugin"): RegisteredPluginMcp {
	const serverId = `${namespace}:${pluginId}:${registration.serverId}`;
	if (mcps.has(serverId)) throw Object.assign(new Error(`Plugin MCP server is already registered: ${serverId}.`), { code: "plugin_registry_conflict" });
	const entry: RegisteredPluginMcp = { ...registration, pluginId, namespace, serverId, localServerId: registration.serverId };
	mcps.set(serverId, entry);
	return entry;
}

export function listPluginMcpTools(): RegisteredPluginMcpTool[] {
	return [...mcps.values()].flatMap((server): RegisteredPluginMcpTool[] => server.tools.map((tool): RegisteredPluginMcpTool => ({
		pluginId: server.pluginId,
		serverId: server.serverId,
		llmToolName: toolName(server.pluginId, `${server.serverId}_${tool.name}`, server.namespace),
		...tool
	})));
}

export function getPluginMcpToolByLlmName(name: string): RegisteredPluginMcpTool | undefined {
	return listPluginMcpTools().find((entry): boolean => entry.llmToolName === name);
}

export function listPluginToolDefinitions(workspaceId?: string): ChatCompletionTool[] {
	return [...tools.values()].filter((entry): boolean => entry.global || workspaceId !== undefined).map((entry): ChatCompletionTool => definitions.get(entry.llmToolName)!).filter(Boolean);
}

export function getPluginTool(name: string): RegisteredPluginTool | undefined { return tools.get(name); }
export function getPluginToolNames(workspaceId?: string): string[] { return [...tools.values()].filter((entry): boolean => entry.global || workspaceId !== undefined).map((entry): string => entry.llmToolName); }
export function getPluginToolEntries(workspaceId?: string): RegisteredPluginTool[] { return [...tools.values()].filter((entry): boolean => entry.global || workspaceId !== undefined); }
export function getPluginSkill(ref: string): RegisteredPluginSkill | undefined { return skills.get(ref); }
export function listPluginSkills(): RegisteredPluginSkill[] { return [...skills.values()]; }
export function listPluginHooks(event: string): RegisteredPluginHook[] { return [...(hooks.get(event) ?? [])]; }
export function getPluginMcp(serverId: string): RegisteredPluginMcp | undefined { return mcps.get(serverId); }
export function listPluginMcps(): RegisteredPluginMcp[] { return [...mcps.values()]; }
