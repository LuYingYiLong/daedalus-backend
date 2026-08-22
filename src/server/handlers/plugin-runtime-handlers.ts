import type WebSocket from "ws";
import type { ClientRequest } from "../../protocol/types.js";
import type { ClientSession } from "../client-session.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import { getClientConnection } from "../client-connections.js";
import { sendJson } from "../send-json.js";
import {
	getPluginRuntimeSnapshot,
	clearPluginRuntimeQuarantine,
	installPluginRuntimeDependencies,
	listPluginRuntimeSnapshots,
	restartPlugin,
	stopPlugin
} from "../../plugins/runtime/manager.js";
import { listPluginRuntimeLogs } from "../../plugins/runtime/runtime-logs.js";

type RuntimeRequest = Extract<ClientRequest, { method: `plugin.runtime.${string}` }>;

function ensureStudio(socket: WebSocket): void {
	if (getClientConnection(socket)?.clientType !== "studio") throw Object.assign(new Error("Plugin runtime is only available to Daedalus Studio."), { code: "studio_only" });
}

export async function handlePluginRuntimeRequest(socket: WebSocket, request: ClientRequest, _session: ClientSession, _mcpHost: McpHost): Promise<void> {
	ensureStudio(socket);
	const runtimeRequest = request as RuntimeRequest;
	let result: unknown;
	switch (runtimeRequest.method) {
	case "plugin.runtime.list":
		result = { runtimes: listPluginRuntimeSnapshots() };
		break;
	case "plugin.runtime.restart":
		await restartPlugin((runtimeRequest.params as { pluginId: string }).pluginId);
		result = getPluginRuntimeSnapshot((runtimeRequest.params as { pluginId: string }).pluginId) ?? null;
		break;
	case "plugin.runtime.disable":
		await stopPlugin((runtimeRequest.params as { pluginId: string }).pluginId);
		result = getPluginRuntimeSnapshot((runtimeRequest.params as { pluginId: string }).pluginId) ?? null;
		break;
	case "plugin.runtime.clear_quarantine": {
		const params = runtimeRequest.params as { pluginId: string; sessionId?: string };
		await clearPluginRuntimeQuarantine(params.pluginId, params.sessionId);
		result = getPluginRuntimeSnapshot(params.pluginId) ?? null;
		break;
	}
	case "plugin.runtime.logs.list":
		{
			const params = (runtimeRequest.params ?? {}) as { pluginId?: string; limit?: number };
			result = listPluginRuntimeLogs(params.pluginId, params.limit);
		}
		break;
	case "plugin.runtime.dependencies.install":
		{
			const params = runtimeRequest.params as { pluginId: string; allowNetwork: boolean };
			result = await installPluginRuntimeDependencies(params.pluginId, params.allowNetwork);
		}
		break;
	}
	sendJson(socket, { type: "response", id: request.id, ok: true, result });
}
