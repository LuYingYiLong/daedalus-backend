import type WebSocket from "ws";
import type { ClientRequest } from "../../protocol/types.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession } from "../client-session.js";
import { sendJson } from "../send-json.js";
import { getClientConnection, updateClientConnection } from "../client-connections.js";
import {
	createRuntimeWorkspace,
	createSourceScopedWorkspace,
	findWorkspace,
	findWorkspaceSourceByPath,
	upsertRuntimeWorkspace
} from "../../workspace/registry.js";
import type { WorkspaceConfig } from "../../workspace/types.js";

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function resolveEditorWorkspaceFromParams(params: Record<string, unknown>): WorkspaceConfig | undefined {
	const explicitWorkspaceId: string | undefined = readString(params.workspaceId);
	if (explicitWorkspaceId !== undefined) {
		const configuredWorkspace: WorkspaceConfig | undefined = findWorkspace(explicitWorkspaceId);
		if (configuredWorkspace !== undefined) {
			return configuredWorkspace;
		}

		return upsertRuntimeWorkspace(createRuntimeWorkspace(explicitWorkspaceId));
	}

	const workspaceRoot: string | undefined = readString(params.workspaceRoot) ?? readString(params.godotProjectPath);
	if (workspaceRoot !== undefined) {
		const configuredSource = findWorkspaceSourceByPath(workspaceRoot);
		if (configuredSource !== undefined) {
			return createSourceScopedWorkspace(configuredSource.workspace, configuredSource.sourceFolder.id);
		}
		return upsertRuntimeWorkspace(createRuntimeWorkspace(workspaceRoot));
	}

	return undefined;
}

export async function handleEditorRequest(socket: WebSocket, request: ClientRequest, session: ClientSession, mcpHost: McpHost): Promise<void> {
	switch (request.method) {
		case "editor.context.update": {
			const connection = getClientConnection(socket);
			const editorInstanceId: string = typeof request.params.editorInstanceId === "string" && request.params.editorInstanceId.length > 0
				? request.params.editorInstanceId
				: session.editorInstanceId ?? connection?.editorInstanceId ?? `editor-${connection?.connectionId ?? "legacy"}`;
			const requestWorkspace: WorkspaceConfig | undefined = resolveEditorWorkspaceFromParams(request.params);
			const workspace: WorkspaceConfig | undefined = session.activeWorkspace ?? requestWorkspace ?? (connection?.workspaceId === undefined ? undefined : findWorkspace(connection.workspaceId));
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

			const workspaceId: string | undefined = workspace?.id ?? connection?.workspaceId;
			session.editorInstanceId = editorInstanceId;
			const instance = mcpHost.getEditorBridge().updateInstanceContext(
				socket,
				workspaceId,
				editorInstanceId,
				request.params,
				connection?.clientName
			);
			updateClientConnection(socket, {
				clientType: connection?.clientType === "legacy" ? "godot_plugin" : connection?.clientType,
				editorInstanceId,
				workspaceId,
				workspaceRoot: workspace?.rootPath ?? connection?.workspaceRoot,
				capabilities: {
					...connection?.capabilities,
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
			const accepted: boolean = mcpHost.getEditorBridge().handleToolResult(
				request.params.callId,
				request.params.ok,
				request.params.result,
				request.params.error
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
