import { invokePlugin } from "./manager.js";
import { getPluginMcp } from "./registries.js";

export function isPluginMcpServer(serverId: string): boolean { return serverId.startsWith("plugin:") || serverId.startsWith("harness:"); }

function requireServer(serverId: string) {
	const server = getPluginMcp(serverId);
	if (server === undefined) throw new Error("Plugin MCP server is not registered.");
	return server;
}

export function listPluginMcpToolsForServer(serverId: string): { tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> } {
	const server = requireServer(serverId);
	return { tools: server.tools.map((tool) => ({ name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }), inputSchema: tool.inputSchema })) };
}

export async function callPluginMcpTool(serverId: string, name: string, args: Record<string, unknown>, sessionId: string): Promise<unknown> {
	const server = requireServer(serverId);
	if (!server.tools.some((tool) => tool.name === name)) throw new Error("Plugin MCP tool is not registered.");
	return invokePlugin(server.pluginId, sessionId, "mcp_tool", `${server.localServerId}:${name}`, args);
}

export function listPluginMcpResourcesForServer(serverId: string) {
	return { resources: requireServer(serverId).resources };
}

export async function readPluginMcpResource(serverId: string, uri: string, sessionId: string): Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }> {
	const server = requireServer(serverId);
	if (!server.resources.some((resource) => resource.uri === uri)) throw new Error("Plugin MCP resource is not registered.");
	const value = await invokePlugin(server.pluginId, sessionId, "mcp_resource", uri, {});
	return { contents: [{ uri, mimeType: server.resources.find((resource) => resource.uri === uri)?.mimeType ?? "text/plain", text: typeof value === "string" ? value : JSON.stringify(value) }] };
}
