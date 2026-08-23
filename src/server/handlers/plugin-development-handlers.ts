import type WebSocket from "ws";
import type { ClientRequest } from "../../protocol/types.js";
import type { ClientSession } from "../client-session.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import { getClientConnection } from "../client-connections.js";
import { sendJson } from "../send-json.js";
import { getPluginDevelopmentStatus, listPluginDevelopmentStatuses } from "../../plugins/development/status-store.js";

type DevelopmentRequest = Extract<ClientRequest, { method: "plugin.development.status.get" }>;

function ensureStudio(socket: WebSocket): void {
	if (getClientConnection(socket)?.clientType !== "studio") throw Object.assign(new Error("Plugin development status is only available to Daedalus Studio."), { code: "studio_only" });
}

export async function handlePluginDevelopmentRequest(socket: WebSocket, request: ClientRequest, _session: ClientSession, _mcpHost: McpHost): Promise<void> {
	ensureStudio(socket);
	const developmentRequest = request as DevelopmentRequest;
	const result = developmentRequest.params?.slug === undefined
		? { statuses: await listPluginDevelopmentStatuses() }
		: await getPluginDevelopmentStatus(developmentRequest.params.slug);
	sendJson(socket, { type: "response", id: request.id, ok: true, result });
}
