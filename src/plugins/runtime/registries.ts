import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { ToolMapping } from "../../tools/tool-mapping.js";
import type { PluginHookRegistration, PluginMcpRegistration, PluginSkillRegistration, PluginToolRegistration, PluginToolRisk } from "./worker-protocol.js";

export type RegisteredPluginTool = PluginToolRegistration & { llmToolName: string; pluginId: string; mapping: ToolMapping };
export type RegisteredPluginSkill = PluginSkillRegistration & { pluginId: string; ref: string };
export type RegisteredPluginHook = PluginHookRegistration & { pluginId: string; handlerName: string };
export type RegisteredPluginMcp = PluginMcpRegistration & { pluginId: string; serverId: string; localServerId: string };
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

function toolName(pluginId: string, name: string): string {
	return `mcp_plugin_${pluginId.replace(/[^a-z0-9]+/giu, "_").slice(0, 24)}_${name.replace(/[^a-z0-9]+/giu, "_").slice(0, 32)}`;
}

function mcpToolName(pluginId: string, serverId: string, name: string): string {
	return toolName(pluginId, `${serverId}_${name}`);
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

export function registerPluginTool(pluginId: string, registration: PluginToolRegistration): RegisteredPluginTool {
	const llmToolName = toolName(pluginId, registration.name);
	const entry: RegisteredPluginTool = { ...registration, pluginId, llmToolName, mapping: { serverId: `plugin:${pluginId}`, toolName: registration.name } };
	tools.set(llmToolName, entry);
	definitions.set(llmToolName, { type: "function", function: { name: llmToolName, description: registration.description.slice(0, 1024), parameters: registration.inputSchema } });
	return entry;
}

export function registerPluginSkill(pluginId: string, registration: PluginSkillRegistration): RegisteredPluginSkill {
	const ref = `plugin:${pluginId}:${registration.slug}`;
	const entry: RegisteredPluginSkill = { ...registration, pluginId, ref };
	skills.set(ref, entry);
	return entry;
}

export function registerPluginHook(pluginId: string, registration: PluginHookRegistration, handlerName: string): RegisteredPluginHook {
	const entry: RegisteredPluginHook = { ...registration, pluginId, handlerName };
	hooks.set(registration.event, [...(hooks.get(registration.event) ?? []), entry]);
	return entry;
}

export function registerPluginMcp(pluginId: string, registration: PluginMcpRegistration): RegisteredPluginMcp {
	const serverId = `plugin:${pluginId}:${registration.serverId}`;
	const entry: RegisteredPluginMcp = { ...registration, pluginId, serverId, localServerId: registration.serverId };
	mcps.set(serverId, entry);
	return entry;
}

export function listPluginMcpTools(): RegisteredPluginMcpTool[] {
	return [...mcps.values()].flatMap((server): RegisteredPluginMcpTool[] => server.tools.map((tool): RegisteredPluginMcpTool => ({
		pluginId: server.pluginId,
		serverId: server.serverId,
		llmToolName: mcpToolName(server.pluginId, server.serverId, tool.name),
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
