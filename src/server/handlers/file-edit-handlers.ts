import type WebSocket from "ws";
import type { ClientRequest } from "../../protocol/types.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession } from "../client-session.js";
import { sendJson } from "../send-json.js";
import { createFileEditBatchResponse, readFileEditBatch } from "../file-edit-batches.js";

export async function handleFileEditRequest(socket: WebSocket, request: ClientRequest, session: ClientSession, _mcpHost: McpHost): Promise<void> {
	switch (request.method) {
		case "fileEdit.batch.get": {
			if (session.sessionId === undefined || session.sessionId !== request.params.sessionId) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "session_mismatch",
						message: "File edit batches can only be read for the active session."
					}
				});
				return;
			}

			const batch = await readFileEditBatch(request.params.sessionId, request.params.batchId);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: createFileEditBatchResponse(batch, request.params.sessionId)
			});
			return;
		}

		default:
			throw new Error(`Unsupported file edit method: ${request.method}`);
	}
}
