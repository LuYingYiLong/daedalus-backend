import type { PluginCommandRegistration, PluginHookRegistration, PluginMcpRegistration, PluginRuntimeContext, PluginSkillRegistration, PluginToolRegistration } from "../runtime/worker-protocol.js";
import { HARNESS_BRIDGE_PROTOCOL_VERSION, MAX_HARNESS_FRAME_BYTES } from "./limits.js";

export type HarnessBridgeRequest =
	| { jsonrpc: "2.0"; id: string; method: "initialize"; params: { protocolVersion: number; bundleFingerprint: string; context: PluginRuntimeContext } }
	| { jsonrpc: "2.0"; id: string; method: "health"; params: Record<string, never> }
	| { jsonrpc: "2.0"; id: string; method: "invoke"; params: { kind: "tool" | "hook" | "mcp_tool" | "mcp_resource" | "command"; name: string; args: Record<string, unknown> } }
	| { jsonrpc: "2.0"; id: string; method: "shutdown"; params: Record<string, never> };

export type HarnessRegistrySnapshot = {
	tools: PluginToolRegistration[];
	skills: PluginSkillRegistration[];
	hooks: Array<PluginHookRegistration & { handlerName: string }>;
	mcpServers: PluginMcpRegistration[];
	commands?: PluginCommandRegistration[];
};

export type HarnessBridgeEvent =
	| { jsonrpc: "2.0"; method: "bridge.loaded"; params: { protocolVersion: number } }
	| { jsonrpc: "2.0"; method: "ready"; params: { protocolVersion: number; harnessVersion?: string; registry: HarnessRegistrySnapshot } }
	| { jsonrpc: "2.0"; method: "registry.snapshot"; params: HarnessRegistrySnapshot }
	| { jsonrpc: "2.0"; method: "log"; params: { level: "debug" | "info" | "warn" | "error"; message: string } }
	| { jsonrpc: "2.0"; id: string; result: unknown }
	| { jsonrpc: "2.0"; id: string; error: { code: number; message: string; data?: unknown } };

export function encodeHarnessRequest(message: HarnessBridgeRequest): string {
	return `${JSON.stringify(message)}\n`;
}

export function parseHarnessEvent(line: string): HarnessBridgeEvent {
	if (Buffer.byteLength(line, "utf8") > MAX_HARNESS_FRAME_BYTES) throw new Error("Harness bridge frame exceeds the size limit.");
	const value: unknown = JSON.parse(line);
	if (value === null || typeof value !== "object" || Array.isArray(value) || (value as { jsonrpc?: unknown }).jsonrpc !== "2.0") throw new Error("Invalid Harness bridge JSON-RPC frame.");
	const frame = value as Record<string, unknown>;
	const allowed = (keys: readonly string[]): void => { for (const key of Object.keys(frame)) if (!keys.includes(key)) throw new Error(`Unknown Harness bridge field: ${key}.`); };
	const record = (candidate: unknown, name: string): Record<string, unknown> => {
		if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error(`Invalid Harness bridge ${name}.`);
		return candidate as Record<string, unknown>;
	};
	const params = (keys: readonly string[]): Record<string, unknown> => {
		const candidate = record(frame.params, "parameters");
		for (const key of Object.keys(candidate)) if (!keys.includes(key)) throw new Error(`Unknown Harness bridge parameter: ${key}.`);
		return candidate;
	};
	const registry = (candidate: unknown): void => {
		const item = record(candidate, "registry snapshot");
		for (const key of Object.keys(item)) if (!["tools", "skills", "hooks", "mcpServers", "commands"].includes(key)) throw new Error(`Unknown Harness registry field: ${key}.`);
		for (const key of ["tools", "skills", "hooks", "mcpServers"] as const) if (!Array.isArray(item[key])) throw new Error(`Harness registry field ${key} must be an array.`);
		if (item.commands !== undefined && !Array.isArray(item.commands)) throw new Error("Harness registry field commands must be an array.");
	};
	if (typeof frame.method === "string") {
		switch (frame.method) {
		case "bridge.loaded":
			allowed(["jsonrpc", "method", "params"]);
			if (typeof params(["protocolVersion"]).protocolVersion !== "number") throw new Error("Invalid Harness bridge protocol version.");
			break;
		case "ready":
			allowed(["jsonrpc", "method", "params"]);
			{
				const value = params(["protocolVersion", "harnessVersion", "registry"]);
				if (typeof value.protocolVersion !== "number") throw new Error("Invalid Harness bridge protocol version.");
				if (value.harnessVersion !== undefined && (typeof value.harnessVersion !== "string" || value.harnessVersion.length > 256)) throw new Error("Invalid Harness bridge version.");
				registry(value.registry);
			}
			break;
		case "registry.snapshot":
			allowed(["jsonrpc", "method", "params"]);
			registry(frame.params);
			break;
		case "log":
			allowed(["jsonrpc", "method", "params"]);
			{
				const value = params(["level", "message"]);
				if (!["debug", "info", "warn", "error"].includes(String(value.level)) || typeof value.message !== "string" || value.message.length > 4000) throw new Error("Invalid Harness bridge log.");
			}
			break;
		default:
			throw new Error(`Unknown Harness bridge event method: ${frame.method}.`);
		}
	} else if (frame.id !== undefined) {
		allowed(["jsonrpc", "id", "result", "error"]);
		if (typeof frame.id !== "string" || frame.id.length === 0 || frame.id.length > 128) throw new Error("Invalid Harness bridge response ID.");
		if (frame.result === undefined && frame.error === undefined || frame.result !== undefined && frame.error !== undefined) throw new Error("Invalid Harness bridge response payload.");
		if (frame.error !== undefined) {
			const error = record(frame.error, "error");
			for (const key of Object.keys(error)) if (!["code", "message", "data"].includes(key)) throw new Error(`Unknown Harness bridge error field: ${key}.`);
			if (typeof error.code !== "number" || typeof error.message !== "string" || error.message.length > 4000) throw new Error("Invalid Harness bridge error payload.");
		}
	} else {
		throw new Error("Harness bridge frame must contain a method or response ID.");
	}
	return value as HarnessBridgeEvent;
}

export function assertHarnessBridgeVersion(version: number): void {
	if (version !== HARNESS_BRIDGE_PROTOCOL_VERSION) throw Object.assign(new Error(`Unsupported Harness bridge protocol version ${String(version)}.`), { code: "plugin_harness_bridge_incompatible" });
}
