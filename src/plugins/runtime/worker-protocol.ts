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

export type PluginRuntimeContext = {
	pluginId: string;
	sessionId: string;
	workspaceId?: string | undefined;
	workspaceRoot?: string | undefined;
	capabilities: PluginCapability[];
};

export type PluginWorkerMessage =
	| { type: "initialize"; protocolVersion: 1; entry: string; context: PluginRuntimeContext }
	| { type: "invoke"; id: string; kind: "tool" | "hook" | "mcp_tool" | "mcp_resource"; name: string; args: Record<string, unknown> }
	| { type: "shutdown" };

export type PluginWorkerEvent =
	| { type: "ready"; protocolVersion: 1 }
	| { type: "register.tool"; registration: PluginToolRegistration }
	| { type: "register.skill"; registration: PluginSkillRegistration }
	| { type: "register.hook"; registration: PluginHookRegistration }
	| { type: "register.mcp"; registration: PluginMcpRegistration }
	| { type: "result"; id: string; ok: boolean; value?: unknown; error?: string }
	| { type: "error"; message: string };

export function encodeWorkerMessage(message: PluginWorkerMessage): string {
	return `${JSON.stringify(message)}\n`;
}

export function parseWorkerEvent(line: string): PluginWorkerEvent {
	const value: unknown = JSON.parse(line);
	if (value === null || typeof value !== "object" || Array.isArray(value) || typeof (value as { type?: unknown }).type !== "string") {
		throw new Error("Invalid plugin worker event.");
	}
	return value as PluginWorkerEvent;
}
