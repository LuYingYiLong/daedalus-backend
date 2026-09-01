import type WebSocket from "ws";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientRequest } from "../../protocol/types.js";
import {
	createSourceScopedWorkspace,
	findWorkspace
} from "../../workspace/registry.js";
import { resolveWorkspaceSources } from "../../workspace/source-context.js";
import type { WorkspaceConfig } from "../../workspace/types.js";
import type { ClientSession } from "../client-session.js";
import { getClientConnection } from "../client-connections.js";
import { sendJson } from "../send-json.js";

function requireStudio(socket: WebSocket): void {
	if (getClientConnection(socket)?.clientType !== "studio") throw new Error("runtime_test_studio_required");
}

function requireRuntime(socket: WebSocket): void {
	const connection = getClientConnection(socket);
	if (connection?.clientType !== "godot_runtime_test_bridge" || !connection.bridgeHandshakeAccepted) {
		throw new Error("runtime_bridge_handshake_required");
	}
}

function resolveTestWorkspace(request: Extract<ClientRequest, { method: "godot.runtimeTest.create" }>, session: ClientSession): WorkspaceConfig {
	const workspaceId: string | undefined = request.params?.workspaceId ?? session.activeWorkspace?.id;
	const workspace: WorkspaceConfig | undefined = workspaceId === undefined ? session.activeWorkspace : findWorkspace(workspaceId);
	if (workspace === undefined) throw new Error("runtime_test_workspace_required");
	const selection = resolveWorkspaceSources(workspace, {
		sourceFolderId: request.params?.sourceFolderId,
		operation: "godot"
	});
	if (selection.kind !== "source") throw new Error("source_required: runtime tests require one Godot source folder");
	return createSourceScopedWorkspace(workspace, selection.source.id);
}

export async function handleGodotRuntimeRequest(
	socket: WebSocket,
	request: ClientRequest,
	session: ClientSession,
	mcpHost: McpHost
): Promise<void> {
	switch (request.method) {
		case "godot.runtimeTest.create": {
			requireStudio(socket);
			const ownerWorkspaceId: string | undefined = request.params?.workspaceId ?? session.activeWorkspace?.id;
			if (ownerWorkspaceId === undefined) throw new Error("runtime_test_workspace_required");
			const workspace: WorkspaceConfig = resolveTestWorkspace(request, session);
			await mcpHost.ensureWorkspace(workspace);
			const runtimeSession = mcpHost.getRuntimeTestBridge().createSession(socket, workspace.id, workspace.rootPath, ownerWorkspaceId);
			sendJson(socket, { type: "response", id: request.id, ok: true, result: runtimeSession });
			break;
		}
		case "godot.runtimeTest.status": {
			requireStudio(socket);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: { sessions: mcpHost.getRuntimeTestBridge().listOwnerSessions(socket) }
			});
			break;
		}
		case "godot.runtimeTest.stop": {
			requireStudio(socket);
			const stopped: boolean = mcpHost.getRuntimeTestBridge().stopSession(socket, request.params.testSessionId);
			sendJson(socket, { type: "response", id: request.id, ok: true, result: { stopped } });
			break;
		}
		case "godot.runtime.heartbeat": {
			requireRuntime(socket);
			const runtimeSession = mcpHost.getRuntimeTestBridge().heartbeat(socket, request.params);
			sendJson(socket, { type: "response", id: request.id, ok: true, result: { accepted: true, session: runtimeSession } });
			break;
		}
		case "godot.runtime.tool.result": {
			requireRuntime(socket);
			const accepted: boolean = mcpHost.getRuntimeTestBridge().handleToolResult(socket, request.params);
			sendJson(socket, { type: "response", id: request.id, ok: true, result: { accepted, callId: request.params.callId } });
			break;
		}
		default:
			throw new Error(`Unsupported Godot runtime method: ${request.method}`);
	}
}
