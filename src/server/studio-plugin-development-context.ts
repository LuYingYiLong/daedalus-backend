import type WebSocket from "ws";
import type { PluginDevelopmentControlContext } from "../plugins/development/types.js";
import { createPluginDevelopmentControl } from "../plugins/development/service.js";
import type { WorkspaceConfig } from "../workspace/types.js";
import { getClientConnection } from "./client-connections.js";

export function getStudioPluginDevelopmentControl(
	socket: WebSocket,
	sessionId: string | undefined,
	workspace?: WorkspaceConfig | undefined
): PluginDevelopmentControlContext | undefined {
	if (sessionId === undefined || getClientConnection(socket)?.clientType !== "studio") return undefined;
	return createPluginDevelopmentControl(socket, sessionId, workspace);
}
