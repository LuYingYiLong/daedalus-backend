import type { PluginHookRegistration, PluginMcpRegistration, PluginRuntimeContext, PluginSkillRegistration, PluginToolRegistration } from "../runtime/worker-protocol.js";
import { HARNESS_BRIDGE_PROTOCOL_VERSION, MAX_HARNESS_FRAME_BYTES } from "./limits.js";

export type HarnessBridgeRequest =
	| { jsonrpc: "2.0"; id: string; method: "initialize"; params: { protocolVersion: number; bundleFingerprint: string; context: PluginRuntimeContext } }
	| { jsonrpc: "2.0"; id: string; method: "health"; params: Record<string, never> }
	| { jsonrpc: "2.0"; id: string; method: "invoke"; params: { kind: "tool" | "hook" | "mcp_tool" | "mcp_resource"; name: string; args: Record<string, unknown> } }
	| { jsonrpc: "2.0"; id: string; method: "shutdown"; params: Record<string, never> };

export type HarnessRegistrySnapshot = {
	tools: PluginToolRegistration[];
	skills: PluginSkillRegistration[];
	hooks: Array<PluginHookRegistration & { handlerName: string }>;
	mcpServers: PluginMcpRegistration[];
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
	return value as HarnessBridgeEvent;
}

export function assertHarnessBridgeVersion(version: number): void {
	if (version !== HARNESS_BRIDGE_PROTOCOL_VERSION) throw Object.assign(new Error(`Unsupported Harness bridge protocol version ${String(version)}.`), { code: "plugin_harness_bridge_incompatible" });
}
