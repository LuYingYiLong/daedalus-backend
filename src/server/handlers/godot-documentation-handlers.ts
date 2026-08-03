import type WebSocket from "ws";
import type { ClientRequest } from "../../protocol/types.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession } from "../client-session.js";
import { getClientConnection } from "../client-connections.js";
import { sendJson } from "../send-json.js";
import {
	cancelGodotDocumentationJob,
	getGodotDocumentationJob,
	getGodotDocumentationState,
	importLocalGodotDocumentation,
	installGodotDocumentation,
	listGodotDocumentationBranches,
	removeGodotDocumentation,
	setGodotDocumentationEnabled,
	updateGodotDocumentation
} from "../../godot-documentation/manager.js";

function sendError(socket: WebSocket, request: ClientRequest, code: string, message: string): void {
	sendJson(socket, {
		type: "response",
		id: request.id,
		ok: false,
		error: { code, message }
	});
}

export async function handleGodotDocumentationRequest(
	socket: WebSocket,
	request: ClientRequest,
	_session: ClientSession,
	_mcpHost: McpHost
): Promise<void> {
	if (getClientConnection(socket)?.clientType !== "studio") {
		sendError(socket, request, "studio_only", `${request.method} is only available to Daedalus Studio.`);
		return;
	}
	try {
		switch (request.method) {
		case "godotDocumentation.get":
			sendJson(socket, { type: "response", id: request.id, ok: true, result: getGodotDocumentationState() });
			return;
		case "godotDocumentation.branches.list":
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: await listGodotDocumentationBranches(request.params?.refresh === true)
			});
			return;
		case "godotDocumentation.install":
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: installGodotDocumentation(request.params.branch)
			});
			return;
		case "godotDocumentation.importLocal":
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: importLocalGodotDocumentation(request.params.branch, request.params.sourcePath)
			});
			return;
		case "godotDocumentation.update":
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: updateGodotDocumentation(request.params.documentId)
			});
			return;
		case "godotDocumentation.remove":
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: await removeGodotDocumentation(request.params.documentId)
			});
			return;
		case "godotDocumentation.setEnabled":
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: await setGodotDocumentationEnabled(request.params.enabled)
			});
			return;
		case "godotDocumentation.job.get": {
			const job = getGodotDocumentationJob(request.params.jobId);
			if (job === null) {
				sendError(socket, request, "documentation_job_not_found", "The documentation job no longer exists.");
				return;
			}
			sendJson(socket, { type: "response", id: request.id, ok: true, result: job });
			return;
		}
		case "godotDocumentation.job.cancel": {
			const job = cancelGodotDocumentationJob(request.params.jobId);
			if (job === null) {
				sendError(socket, request, "documentation_job_not_found", "The documentation job no longer exists.");
				return;
			}
			sendJson(socket, { type: "response", id: request.id, ok: true, result: job });
			return;
		}
		default:
			return;
		}
	} catch (error: unknown) {
		sendError(
			socket,
			request,
			"godot_documentation_error",
			error instanceof Error ? error.message : "Godot documentation operation failed."
		);
	}
}
