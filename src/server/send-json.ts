import WebSocket from "ws";
import type { ServerEvent, ServerResponse } from "../protocol/types.js";
import { BACKEND_PROTOCOL_VERSION } from "../runtime/build-metadata.js";

export function sendJson(socket: WebSocket, message: ServerResponse | ServerEvent): void {
	if (socket.readyState === WebSocket.OPEN) {
		socket.send(JSON.stringify({ protocolVersion: BACKEND_PROTOCOL_VERSION, ...message }));
	}
}
