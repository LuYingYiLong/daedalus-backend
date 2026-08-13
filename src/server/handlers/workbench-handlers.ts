import type WebSocket from "ws";
import type { ClientRequest } from "../../protocol/types.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession } from "../client-session.js";
import { getClientConnection } from "../client-connections.js";
import { sendJson } from "../send-json.js";
import {
	applyWorkbenchPatch,
	emitWorkbenchUpdated,
	serializeWorkbench,
	type WorkbenchPatch
} from "../workbench.js";
import { updateSessionForkDraft } from "../../session/session-fork.js";

function sendWorkbenchResult(
	socket: WebSocket,
	request: ClientRequest,
	session: ClientSession,
	changed: boolean = false,
	stale: boolean = false
): void {
	sendJson(socket, {
		type: "response",
		id: request.id,
		ok: true,
		result: {
			workbench: serializeWorkbench(session),
			changed,
			...(stale ? { stale: true } : {})
		}
	});
}

function isStaleWorkbenchPatch(socket: WebSocket, session: ClientSession, patch: WorkbenchPatch): boolean {
	if (patch.clientSequence === undefined) {
		return false;
	}

	const connectionId: string = getClientConnection(socket)?.connectionId ?? "legacy";
	const lastSequence: number = session.workbenchClientPatchSequences.get(connectionId) ?? -1;
	if (patch.clientSequence <= lastSequence) {
		return true;
	}

	session.workbenchClientPatchSequences.set(connectionId, patch.clientSequence);
	return false;
}

export async function handleWorkbenchRequest(socket: WebSocket, request: ClientRequest, session: ClientSession, _mcpHost: McpHost): Promise<void> {
	switch (request.method) {
	case "session.workbench.get":
		sendWorkbenchResult(socket, request, session);
		break;

	case "session.workbench.patch": {
		const patch: WorkbenchPatch = request.params as WorkbenchPatch;
		if (isStaleWorkbenchPatch(socket, session, patch)) {
			sendWorkbenchResult(socket, request, session, false, true);
			break;
		}
		const changed: boolean = applyWorkbenchPatch(session, patch);
		if (changed && session.sessionId !== undefined) {
			await updateSessionForkDraft(session.sessionId, {
				text: session.workbenchComposer.text,
				additionalContext: session.workbenchComposer.additionalContext,
			});
		}
		sendWorkbenchResult(socket, request, session, changed);
		if (changed) {
			emitWorkbenchUpdated(socket, request.id, session);
		}
		break;
	}

		default:
			throw new Error(`Unsupported workbench method: ${request.method}`);
	}
}
