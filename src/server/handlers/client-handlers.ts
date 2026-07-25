import type WebSocket from "ws";
import type { ClientRequest } from "../../protocol/types.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession } from "../client-session.js";
import { sendJson } from "../send-json.js";
import {
	getClientConnection,
	updateClientConnection,
	type ClientCapabilities,
	type ClientType
} from "../client-connections.js";
import { logger } from "../../logger.js";
import { createRuntimeWorkspace, upsertRuntimeWorkspace } from "../../workspace/registry.js";
import type { WorkspaceConfig } from "../../workspace/types.js";

function readClientType(value: unknown): ClientType {
	return value === "godot_plugin" || value === "studio" || value === "cli" || value === "smoke" || value === "external_mcp"
		? value
		: "legacy";
}

function readCapabilities(value: unknown): ClientCapabilities {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}

	const result: ClientCapabilities = {};
	const record: Record<string, unknown> = value as Record<string, unknown>;
	for (const [key, item] of Object.entries(record)) {
		if (typeof item === "boolean") {
			result[key as keyof ClientCapabilities] = item;
		}
	}
	return result;
}

export async function handleClientRequest(socket: WebSocket, request: ClientRequest, session: ClientSession, mcpHost: McpHost): Promise<void> {
	switch (request.method) {
		case "client.hello": {
			const params = request.params!;
			const clientType: ClientType = readClientType(params.clientType);
			let workspace: WorkspaceConfig | undefined;
			if (clientType === "godot_plugin" && params.workspaceRoot !== undefined) {
				workspace = upsertRuntimeWorkspace(createRuntimeWorkspace(
					params.workspaceRoot,
					params.godotExecutablePath ?? session.godotExecutablePath
				));

				// 在异步初始化 MCP 前先绑定会话，避免后续并发请求继续使用持久化默认工作区。
				session.activeWorkspace = workspace;
				session.godotProjectPath = workspace.rootPath;
				session.godotExecutablePath = workspace.godotExecutablePath ?? session.godotExecutablePath;
				try {
					await mcpHost.ensureWorkspace(workspace);
				} catch (error: unknown) {
					sendJson(socket, {
						type: "response",
						id: request.id,
						ok: false,
						error: {
							code: "workspace_switch_failed",
							message: error instanceof Error ? error.message : "Failed to configure Godot workspace"
						}
					});
					break;
				}
			}

			const info = updateClientConnection(socket, {
				clientType,
				clientName: params.clientName ?? (params.clientType === "studio" ? "Daedalus Studio" : "Godot Daedalus"),
				workspaceId: workspace?.id ?? params.workspaceId,
				workspaceRoot: workspace?.rootPath ?? params.workspaceRoot,
				editorInstanceId: params.editorInstanceId,
				capabilities: readCapabilities(params.capabilities)
			});
			// Studio 正常重连时握手频繁，仅在传输排障时保留这类元数据。
			logger.debug("client", "hello", {
				connectionId: info.connectionId,
				clientType: info.clientType,
				clientName: info.clientName,
				workspaceId: info.workspaceId,
				workspaceRoot: info.workspaceRoot,
				editorInstanceId: info.editorInstanceId,
				capabilities: info.capabilities,
				sessionId: session.sessionId
			});
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					connection: info,
					workspace: workspace ?? null,
					multiClient: {
						enabled: true,
						protocolVersion: 2
					}
				}
			});
			break;
		}

		case "client.info":
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					connection: getClientConnection(socket),
					session: {
						sessionId: session.sessionId ?? null,
						workspaceId: session.activeWorkspace?.id ?? null,
						editorInstanceId: session.editorInstanceId ?? null
					}
				}
			});
			break;

		default:
			throw new Error(`Unsupported client method: ${request.method}`);
	}
}
