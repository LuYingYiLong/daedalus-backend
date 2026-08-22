import type { PluginCapability } from "../types.js";

export const PLUGIN_RUNTIME_PROTOCOL_VERSION = 1 as const;

export type PluginToolRisk = "read" | "verify" | "propose" | "write" | "destructive";

export type PluginToolRegistration = {
	name: string;
	title: string;
	description: string;
	inputSchema: Record<string, unknown>;
	risk: PluginToolRisk;
	workflow: boolean;
	global: boolean;
};

export type PluginSkillRegistration = {
	slug: string;
	name: string;
	description: string;
	body: string;
	allowedTools: string[];
};

export type PluginHookRegistration = {
	event: string;
	matcher?: string | undefined;
	async: boolean;
	failurePolicy: "continue" | "block";
	handlerName?: string | undefined;
};

export type PluginMcpRegistration = {
	serverId: string;
	serverName: string;
	tools: Array<{
		name: string;
		description?: string | undefined;
		inputSchema: Record<string, unknown>;
		risk: PluginToolRisk;
	}>;
	resources: Array<{
		uri: string;
		name: string;
		description?: string | undefined;
		mimeType?: string | undefined;
	}>;
};

export type PluginCommandRegistration = {
	id: string;
	command: string;
	description: string;
	usage?: string | undefined;
	handlerName: string;
	arguments?: Array<{ name: string; required: boolean; description?: string | undefined }> | undefined;
};

export type PluginContextProviderRegistration = {
	id: string;
	title: string;
	description: string;
	scopes: Array<"workspace" | "browser" | "plugin">;
	handlerName: string;
};

export type PluginRuntimeContext = {
	pluginId: string;
	sessionId: string;
	workspaceId?: string | undefined;
	workspaceRoot?: string | undefined;
	capabilities: PluginCapability[];
	p2Capabilities?: string[] | undefined;
};

export type PluginWorkerMessage =
	| { type: "initialize"; protocolVersion: 1; entry: string; context: PluginRuntimeContext }
	| { type: "invoke"; id: string; kind: "tool" | "hook" | "mcp_tool" | "mcp_resource" | "command" | "context_provider"; name: string; args: Record<string, unknown> }
	| { type: "shutdown" };

export type PluginWorkerEvent =
	| { type: "ready"; protocolVersion: 1 }
	| { type: "register.tool"; registration: PluginToolRegistration }
	| { type: "register.skill"; registration: PluginSkillRegistration }
	| { type: "register.hook"; registration: PluginHookRegistration }
	| { type: "register.mcp"; registration: PluginMcpRegistration }
	| { type: "register.command"; registration: PluginCommandRegistration }
	| { type: "register.context-provider"; registration: PluginContextProviderRegistration }
	| { type: "result"; id: string; ok: boolean; value?: unknown; error?: string }
	| { type: "error"; message: string };

export function encodeWorkerMessage(message: PluginWorkerMessage): string {
	return `${JSON.stringify(message)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
	for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown plugin worker event field: ${key}.`);
}

function assertString(value: unknown, name: string, maxLength: number): asserts value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > maxLength) throw new Error(`Invalid plugin worker ${name}.`);
}

function assertRuntimeContext(value: unknown): asserts value is PluginRuntimeContext {
	if (!isRecord(value)) throw new Error("Invalid plugin worker runtime context.");
	assertKeys(value, ["pluginId", "sessionId", "workspaceId", "workspaceRoot", "capabilities", "p2Capabilities"]);
	assertString(value.pluginId, "plugin ID", 256);
	assertString(value.sessionId, "session ID", 256);
	if (value.workspaceId !== undefined && (typeof value.workspaceId !== "string" || value.workspaceId.length > 256)) throw new Error("Invalid plugin worker workspace ID.");
	if (value.workspaceRoot !== undefined && (typeof value.workspaceRoot !== "string" || value.workspaceRoot.length > 4096)) throw new Error("Invalid plugin worker workspace root.");
	if (!Array.isArray(value.capabilities) || !value.capabilities.every((capability): boolean => ["tools", "skills", "hooks", "mcp"].includes(String(capability)))) throw new Error("Invalid plugin worker capabilities.");
	if (value.p2Capabilities !== undefined && (!Array.isArray(value.p2Capabilities) || value.p2Capabilities.length > 16 || !value.p2Capabilities.every((capability): boolean => typeof capability === "string" && capability.length <= 64))) throw new Error("Invalid plugin worker P2 capabilities.");
}

export function parseWorkerMessage(line: string): PluginWorkerMessage {
	const value: unknown = JSON.parse(line);
	if (!isRecord(value) || typeof value.type !== "string") throw new Error("Invalid plugin worker message.");
	switch (value.type) {
	case "initialize":
		assertKeys(value, ["type", "protocolVersion", "entry", "context"]);
		if (value.protocolVersion !== PLUGIN_RUNTIME_PROTOCOL_VERSION) throw new Error("Unsupported plugin worker protocol version.");
		assertString(value.entry, "entry", 4096);
		assertRuntimeContext(value.context);
		return value as PluginWorkerMessage;
	case "invoke":
		assertKeys(value, ["type", "id", "kind", "name", "args"]);
		assertString(value.id, "call ID", 128);
		assertString(value.name, "handler name", 256);
		if (!["tool", "hook", "mcp_tool", "mcp_resource", "command", "context_provider"].includes(String(value.kind)) || !isRecord(value.args)) throw new Error("Invalid plugin worker invocation.");
		if (Buffer.byteLength(JSON.stringify(value.args), "utf8") > 200_000) throw new Error("Plugin worker invocation arguments exceed the size limit.");
		return value as PluginWorkerMessage;
	case "shutdown":
		assertKeys(value, ["type"]);
		return value as PluginWorkerMessage;
	default:
		throw new Error(`Unknown plugin worker message type: ${value.type}.`);
	}
}

function assertRegistration(value: Record<string, unknown>, kind: "tool" | "skill" | "hook" | "mcp" | "command" | "context-provider"): void {
	if (kind === "command") {
		assertKeys(value, ["id", "command", "description", "usage", "handlerName", "arguments"]);
		assertString(value.id, "command ID", 128);
		assertString(value.command, "command", 128);
		assertString(value.description, "command description", 4096);
		assertString(value.handlerName, "command handler", 160);
		if (value.usage !== undefined && (typeof value.usage !== "string" || value.usage.length > 300)) throw new Error("Invalid plugin command usage.");
		if (value.arguments !== undefined && (!Array.isArray(value.arguments) || value.arguments.length > 16)) throw new Error("Invalid plugin command arguments.");
		return;
	}
	if (kind === "context-provider") {
		assertKeys(value, ["id", "title", "description", "scopes", "handlerName"]);
		assertString(value.id, "context provider ID", 128);
		assertString(value.title, "context provider title", 256);
		assertString(value.description, "context provider description", 4096);
		assertString(value.handlerName, "context provider handler", 160);
		if (!Array.isArray(value.scopes) || value.scopes.length === 0 || value.scopes.length > 3 || !value.scopes.every((scope): boolean => ["workspace", "browser", "plugin"].includes(String(scope)))) throw new Error("Invalid plugin context provider scopes.");
		return;
	}
	if (kind === "tool") {
		assertKeys(value, ["name", "title", "description", "inputSchema", "risk", "workflow", "global"]);
		assertString(value.name, "tool name", 128);
		assertString(value.title, "tool title", 256);
		assertString(value.description, "tool description", 4096);
		if (!isRecord(value.inputSchema) || typeof value.workflow !== "boolean" || typeof value.global !== "boolean" || !["read", "verify", "propose", "write", "destructive"].includes(String(value.risk))) throw new Error("Invalid plugin worker tool registration.");
		return;
	}
	if (kind === "skill") {
		assertKeys(value, ["slug", "name", "description", "body", "allowedTools"]);
		assertString(value.slug, "Skill slug", 128);
		assertString(value.name, "Skill name", 256);
		assertString(value.description, "Skill description", 4096);
		assertString(value.body, "Skill body", 200_000);
		if (!Array.isArray(value.allowedTools) || value.allowedTools.length > 64 || !value.allowedTools.every((item): item is string => typeof item === "string" && item.length <= 128)) throw new Error("Invalid plugin worker Skill registration.");
		return;
	}
	if (kind === "hook") {
		assertKeys(value, ["event", "matcher", "async", "failurePolicy", "handlerName"]);
		assertString(value.event, "Hook event", 64);
		if (value.matcher !== undefined && (typeof value.matcher !== "string" || value.matcher.length > 512)) throw new Error("Invalid plugin worker Hook matcher.");
		if (typeof value.async !== "boolean" || !["continue", "block"].includes(String(value.failurePolicy)) || value.handlerName !== undefined && (typeof value.handlerName !== "string" || value.handlerName.length > 160)) throw new Error("Invalid plugin worker Hook registration.");
		return;
	}
	assertKeys(value, ["serverId", "serverName", "tools", "resources"]);
	assertString(value.serverId, "MCP server ID", 128);
	assertString(value.serverName, "MCP server name", 256);
	if (!Array.isArray(value.tools) || !Array.isArray(value.resources) || value.tools.length > 64 || value.resources.length > 64) throw new Error("Invalid plugin worker MCP registration.");
	for (const tool of value.tools) {
		if (!isRecord(tool)) throw new Error("Invalid plugin worker MCP tool registration.");
		assertKeys(tool, ["name", "description", "inputSchema", "risk"]);
		assertString(tool.name, "MCP tool name", 128);
		if (tool.description !== undefined && (typeof tool.description !== "string" || tool.description.length > 4096)) throw new Error("Invalid plugin worker MCP tool description.");
		if (!isRecord(tool.inputSchema) || !["read", "verify", "propose", "write", "destructive"].includes(String(tool.risk))) throw new Error("Invalid plugin worker MCP tool registration.");
	}
	for (const resource of value.resources) {
		if (!isRecord(resource)) throw new Error("Invalid plugin worker MCP resource registration.");
		assertKeys(resource, ["uri", "name", "description", "mimeType"]);
		assertString(resource.uri, "MCP resource URI", 2048);
		assertString(resource.name, "MCP resource name", 256);
		if (resource.description !== undefined && (typeof resource.description !== "string" || resource.description.length > 4096)) throw new Error("Invalid plugin worker MCP resource description.");
		if (resource.mimeType !== undefined && (typeof resource.mimeType !== "string" || resource.mimeType.length > 256)) throw new Error("Invalid plugin worker MCP resource MIME type.");
	}
}

export function parseWorkerEvent(line: string): PluginWorkerEvent {
	const value: unknown = JSON.parse(line);
	if (!isRecord(value) || typeof value.type !== "string") {
		throw new Error("Invalid plugin worker event.");
	}
	switch (value.type) {
	case "ready":
		assertKeys(value, ["type", "protocolVersion"]);
		if (value.protocolVersion !== PLUGIN_RUNTIME_PROTOCOL_VERSION) throw new Error("Unsupported plugin worker protocol version.");
		break;
	case "error":
		assertKeys(value, ["type", "message"]);
		assertString(value.message, "error message", 4000);
		break;
	case "result":
		assertKeys(value, ["type", "id", "ok", "value", "error"]);
		assertString(value.id, "result ID", 128);
		if (typeof value.ok !== "boolean") throw new Error("Invalid plugin worker result status.");
		if (value.ok && value.error !== undefined || !value.ok && value.value !== undefined) throw new Error("Invalid plugin worker result payload.");
		if (!value.ok && (typeof value.error !== "string" || value.error.length > 4000)) throw new Error("Invalid plugin worker result error.");
		break;
	case "register.tool":
	case "register.skill":
	case "register.hook":
	case "register.mcp":
	case "register.command":
	case "register.context-provider":
		assertKeys(value, ["type", "registration"]);
		if (!isRecord(value.registration)) throw new Error("Invalid plugin worker registration payload.");
		assertRegistration(value.registration, value.type === "register.context-provider" ? "context-provider" : value.type.slice("register.".length) as "tool" | "skill" | "hook" | "mcp" | "command");
		break;
	default:
		throw new Error(`Unknown plugin worker event type: ${value.type}.`);
	}
	return value as PluginWorkerEvent;
}
