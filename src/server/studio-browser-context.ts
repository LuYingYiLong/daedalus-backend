import type WebSocket from "ws";
import type { BrowserControlContext } from "../tools/browser-tools.js";
import { getClientConnection } from "./client-connections.js";
import { studioBrowserRuntime } from "./studio-browser-runtime.js";
import { externalBrowserControl } from "./external-browser-runtime.js";

export function getStudioBrowserControl(socket: WebSocket, sessionId: string | undefined): BrowserControlContext | undefined {
	const connection = getClientConnection(socket);
	if (connection?.clientType !== "studio" || sessionId === undefined) {
		return undefined;
	}
	const legacy = connection.capabilities.browserTools === true ? studioBrowserRuntime.createControl(socket, sessionId) : undefined;
	return connection.capabilities.externalBrowser === true ? externalBrowserControl(socket, sessionId, legacy) : legacy;
}
