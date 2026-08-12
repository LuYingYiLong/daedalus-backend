import type WebSocket from "ws";
import type { ClientRequest } from "../../protocol/types.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession } from "../client-session.js";
import { sendJson } from "../send-json.js";
import { getClientConnection, updateClientConnection } from "../client-connections.js";
import { findWorkspace } from "../../workspace/registry.js";
import type { WorkspaceConfig } from "../../workspace/types.js";

function requireAcceptedEditorBridge(socket: WebSocket, requestId: string): ReturnType<typeof getClientConnection> {
	const connection = getClientConnection(socket);
	if (connection?.clientType === "godot_editor_bridge" && connection.bridgeHandshakeAccepted) {
		return connection;
	}

	sendJson(socket, {
		type: "response",
		id: requestId,
		ok: false,
		error: {
			code: "bridge_handshake_required",
			message: "A successful Editor Bridge Protocol v4 handshake is required before editor RPC calls."
		}
	});
	return null;
}

export async function handleEditorRequest(socket: WebSocket, request: ClientRequest, session: ClientSession, mcpHost: McpHost): Promise<void> {
	switch (request.method) {
		case "editor.context.update": {
			const connection = requireAcceptedEditorBridge(socket, request.id);
			if (connection === null) break;
			if (
				typeof request.params.editorInstanceId === "string"
				&& connection.editorInstanceId !== undefined
				&& request.params.editorInstanceId !== connection.editorInstanceId
			) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "editor_instance_mismatch",
						message: "Editor context cannot change the instance identity established by the Bridge handshake."
					}
				});
				break;
			}
			const editorInstanceId: string = typeof request.params.editorInstanceId === "string" && request.params.editorInstanceId.length > 0
				? request.params.editorInstanceId
				: session.editorInstanceId ?? connection.editorInstanceId ?? `editor-${connection.connectionId}`;
			const workspace: WorkspaceConfig | undefined = session.activeWorkspace
				?? (connection.workspaceId === undefined ? undefined : findWorkspace(connection.workspaceId));
			if (workspace !== undefined) {
				try {
					await mcpHost.ensureWorkspace(workspace);
					session.activeWorkspace = workspace;
					session.godotProjectPath = workspace.rootPath;
					session.godotExecutablePath = workspace.godotExecutablePath ?? session.godotExecutablePath;
				} catch (error: unknown) {
					sendJson(socket, {
						type: "response",
						id: request.id,
						ok: false,
						error: {
							code: "workspace_switch_failed",
							message: error instanceof Error ? error.message : "Failed to configure editor workspace"
						}
					});
					break;
				}
			}

			const workspaceId: string | undefined = workspace?.id ?? connection.workspaceId;
			session.editorInstanceId = editorInstanceId;
			const instance = mcpHost.getEditorBridge().updateInstanceContext(
				socket,
				workspaceId,
				editorInstanceId,
				request.params,
				connection.clientName
			);
			updateClientConnection(socket, {
				clientType: "godot_editor_bridge",
				editorInstanceId,
				workspaceId,
				workspaceRoot: workspace?.rootPath ?? connection.workspaceRoot,
				capabilities: {
					...connection.capabilities,
					editorTools: true
				}
			});
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					updated: true,
					serverId: "godot_editor",
					editorInstance: instance
				}
			});
			break;
		}

		case "editor.heartbeat": {
			const connection = requireAcceptedEditorBridge(socket, request.id);
			if (connection === null) break;
			const accepted: boolean = mcpHost.getEditorBridge().heartbeat(
				socket,
				request.params.editorInstanceId,
				request.params.contextRevision
			);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: { accepted, contextRevision: request.params.contextRevision }
			});
			break;
		}

		case "editor.instances.list":
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					instances: mcpHost.getEditorBridge().listInstances(request.params?.workspaceId ?? session.activeWorkspace?.id)
				}
			});
			break;

		case "editor.tool.result": {
			const connection = requireAcceptedEditorBridge(socket, request.id);
			if (connection === null) break;
			const accepted: boolean = mcpHost.getEditorBridge().handleToolResult(
				request.params.callId,
				request.params.ok,
				request.params.result,
				request.params.error,
				socket
			);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					accepted,
					callId: request.params.callId
				}
			});
			break;
		}

		default:
			throw new Error(`Unsupported editor method: ${request.method}`);
	}
}
