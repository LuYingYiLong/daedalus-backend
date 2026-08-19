import type WebSocket from "ws";
import type { BrowserControlContext } from "../tools/browser-tools.js";
import { getClientConnection } from "./client-connections.js";
import { studioBrowserRuntime } from "./studio-browser-runtime.js";

export function getStudioBrowserControl(socket: WebSocket, sessionId: string | undefined): BrowserControlContext | undefined {
	const connection = getClientConnection(socket);
	if (connection?.clientType !== "studio" || connection.capabilities.browserTools !== true || sessionId === undefined) {
		return undefined;
	}
	return studioBrowserRuntime.createControl(socket, sessionId);
}
