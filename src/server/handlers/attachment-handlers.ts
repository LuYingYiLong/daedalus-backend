import type WebSocket from "ws";
import type { ClientRequest } from "../../protocol/types.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession } from "../client-session.js";
import { sendJson } from "../send-json.js";
import { readGeneratedImageDataUrl, readImageAttachmentDataUrl, readTextAttachmentContent, saveImageAttachment, saveTextAttachment } from "../../session/session-attachments.js";

export async function handleAttachmentRequest(socket: WebSocket, request: ClientRequest, session: ClientSession, _mcpHost: McpHost): Promise<void> {
	switch (request.method) {
		case "attachment.image.save": {
			if (session.sessionId === undefined || session.sessionId !== request.params.sessionId) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "session_mismatch",
						message: "Image attachments can only be saved for the active session."
					}
				});
				return;
			}

			try {
				const context = await saveImageAttachment(request.params);
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: true,
					result: {
						attachment: context
					}
				});
			} catch (error: unknown) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "attachment_image_save_failed",
						message: error instanceof Error ? error.message : "Failed to save image attachment"
					}
				});
			}
			return;
		}

		case "attachment.image.generated.get": {
			if (session.sessionId === undefined || session.sessionId !== request.params.sessionId) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "session_mismatch",
						message: "Generated images can only be read for the active session."
					}
				});
				return;
			}

			try {
				const image = await readGeneratedImageDataUrl(request.params.sessionId, request.params.imageId);
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: true,
					result: image
				});
			} catch (error: unknown) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "generated_image_read_failed",
						message: error instanceof Error ? error.message : "Failed to read generated image"
					}
				});
			}
			return;
		}

		case "attachment.image.get": {
			if (session.sessionId === undefined) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "session_required", message: "Open a session before reading image attachments." }
				});
				return;
			}

			try {
				const dataUrl = await readImageAttachmentDataUrl(session.sessionId, request.params.attachmentId);
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: true,
					result: { attachmentId: request.params.attachmentId, dataUrl }
				});
			} catch (error: unknown) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "attachment_image_read_failed", message: error instanceof Error ? error.message : "Failed to read image attachment" }
				});
			}
			return;
		}

		case "attachment.text.save": {
			if (session.sessionId === undefined || session.sessionId !== request.params.sessionId) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "session_mismatch", message: "Text attachments can only be saved for the active session." }
				});
				return;
			}

			try {
				const attachment = await saveTextAttachment(request.params);
				sendJson(socket, { type: "response", id: request.id, ok: true, result: { attachment } });
			} catch (error: unknown) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "attachment_text_save_failed", message: error instanceof Error ? error.message : "Failed to save text attachment" }
				});
			}
			return;
		}

		case "attachment.text.get": {
			if (session.sessionId === undefined) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "session_required", message: "Open a session before reading text attachments." }
				});
				return;
			}

			try {
				const result = await readTextAttachmentContent(session.sessionId, request.params.attachmentId);
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: true,
					result: { attachmentId: request.params.attachmentId, content: result.content }
				});
			} catch (error: unknown) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "attachment_text_read_failed", message: error instanceof Error ? error.message : "Failed to read text attachment" }
				});
			}
			return;
		}

		default:
			throw new Error(`Unsupported attachment method: ${request.method}`);
	}
}
