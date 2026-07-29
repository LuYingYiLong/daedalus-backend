import type WebSocket from "ws";
import type { ClientRequest } from "../../protocol/types.js";
import type { McpHost, CustomMcpServerRuntimeStatus } from "../../mcp/mcp-host.js";
import type { ClientSession } from "../client-session.js";
import { sendJson } from "../send-json.js";
import { sendGlobalEvent } from "../session-events.js";
import {
	addCustomMcpServerConfig,
	listCustomMcpServerSummaries,
	removeCustomMcpServerConfig,
	setCustomMcpServerEnabled,
	updateCustomMcpServerConfig,
	type CustomMcpServerSummary
} from "../../mcp/custom-mcp-config-store.js";
import { createProviderStatusEvent } from "../../providers/provider-error.js";
import { SecretStoreUnavailableError } from "../../secrets/secret-store.js";
import { logger } from "../../logger.js";

function canCallMcpToolDirectly(toolName: string): boolean {
	const allowedTools: Set<string> = new Set([
		"get_project_summary",
		"list_project_files",
		"list_scenes",
		"list_scripts",
		"read_text_file",
		"search_text",
		"propose_create_text_file",
		"get_context",
		"get_selected_nodes",
		"inspect_node"
	]);

	return allowedTools.has(toolName);
}

async function createMcpConfigListResult(mcpHost: McpHost, workspaceId?: string | undefined): Promise<Record<string, unknown>> {
	await mcpHost.ensureGlobalCustomServers();
	const summaries: CustomMcpServerSummary[] = await listCustomMcpServerSummaries();
	const statusesById: Map<string, CustomMcpServerRuntimeStatus> = new Map(
		mcpHost.getCustomServerStatusesForWorkspace(workspaceId).map((status: CustomMcpServerRuntimeStatus): [string, CustomMcpServerRuntimeStatus] => [status.id, status])
	);
	const servers: Record<string, unknown>[] = summaries.map((summary: CustomMcpServerSummary): Record<string, unknown> => {
		const runtimeStatus: CustomMcpServerRuntimeStatus | undefined = statusesById.get(summary.id);
		const status: string = summary.enabled ? runtimeStatus?.status ?? "connecting" : "disabled";
		return {
			...summary,
			status,
			toolCount: summary.enabled ? runtimeStatus?.toolCount ?? 0 : 0,
			error: summary.enabled ? runtimeStatus?.error ?? null : null
		};
	});

	return {
		customMcpServers: servers,
		mcpServers: servers,
		connectedServerIds: mcpHost.getConnectedServerIds(workspaceId)
	};
}

function refreshCustomMcpServersAndNotify(socket: WebSocket, mcpHost: McpHost, workspaceId?: string | undefined): void {
	void (async (): Promise<void> => {
		try {
			if (workspaceId !== undefined) {
				await mcpHost.refreshCustomServersForWorkspace(workspaceId);
			} else {
				await mcpHost.refreshCustomServersForActiveWorkspace();
			}
			sendGlobalEvent(socket, "mcp-config", "mcp.config.updated", await createMcpConfigListResult(mcpHost, workspaceId));
		} catch (error: unknown) {
			logger.error("mcp_config", "refresh_failed", error, {
				workspaceId
			});
			sendGlobalEvent(socket, "mcp-config", "mcp.config.updated", {
					...await createMcpConfigListResult(mcpHost, workspaceId),
					error: error instanceof Error ? error.message : "Failed to refresh custom MCP servers"
			});
		}
	})();
}


export async function handleMcpRequest(socket: WebSocket, request: ClientRequest, session: ClientSession, mcpHost: McpHost): Promise<void> {
	const workspaceId: string | undefined = session.activeWorkspace?.id;
	switch (request.method) {
	case "mcp.listTools": {
		const serverId: string = request.params?.serverId ?? "godot";

		try {
			const result = await mcpHost.listTools(serverId, workspaceId);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result
			});
		} catch (error: unknown) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "mcp_error",
					message: error instanceof Error ? error.message : "MCP call failed"
				}
			});
		}
		break;
	}

	case "mcp.callTool": {
		const serverId: string = request.params.serverId ?? "godot";

		try {
			if (!canCallMcpToolDirectly(request.params.name)) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "approval_required",
						message: `Direct MCP call is not allowed for tool: ${request.params.name}`
					}
				});
				break;
			}

			const result = await mcpHost.callTool(serverId, request.params.name, request.params.args ?? {}, workspaceId);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result
			});
		} catch (error: unknown) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "mcp_error",
					message: error instanceof Error ? error.message : "MCP call failed"
				}
			});
		}
		break;
	}

	case "mcp.listResources": {
		const serverId: string = request.params?.serverId ?? "godot";

		try {
			const result = await mcpHost.listResources(serverId, workspaceId);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result
			});
		} catch (error: unknown) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "mcp_error",
					message: error instanceof Error ? error.message : "MCP call failed"
				}
			});
		}
		break;
	}

	case "mcp.readResource": {
		const serverId: string = request.params.serverId ?? "godot";

		try {
			const result = await mcpHost.readResource(serverId, request.params.uri, workspaceId);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result
			});
		} catch (error: unknown) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "mcp_error",
					message: error instanceof Error ? error.message : "MCP call failed"
				}
			});
		}
		break;
	}

	case "mcp.config.list": {
		try {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: await createMcpConfigListResult(mcpHost, workspaceId)
			});
		} catch (error: unknown) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "mcp_config_error",
					message: error instanceof Error ? error.message : "Failed to list custom MCP servers"
				}
			});
		}
		break;
	}

	case "mcp.config.add": {
		try {
			await addCustomMcpServerConfig(request.params);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					added: true,
					...await createMcpConfigListResult(mcpHost, workspaceId)
				}
			});
			refreshCustomMcpServersAndNotify(socket, mcpHost, workspaceId);
		} catch (error: unknown) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: error instanceof SecretStoreUnavailableError ? error.code : "mcp_config_error",
					message: error instanceof Error ? error.message : "Failed to add custom MCP server"
				}
			});
		}
		break;
	}

	case "mcp.config.update": {
		try {
			const updated: CustomMcpServerSummary | null = await updateCustomMcpServerConfig(request.params);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					updated: updated !== null,
					serverId: request.params.serverId,
					server: updated,
					...await createMcpConfigListResult(mcpHost, workspaceId)
				}
			});
			refreshCustomMcpServersAndNotify(socket, mcpHost, workspaceId);
		} catch (error: unknown) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: error instanceof SecretStoreUnavailableError ? error.code : "mcp_config_error",
					message: error instanceof Error ? error.message : "Failed to update custom MCP server"
				}
			});
		}
		break;
	}

	case "mcp.config.remove": {
		try {
			const removed: boolean = await removeCustomMcpServerConfig(request.params.serverId);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					removed,
					serverId: request.params.serverId,
					...await createMcpConfigListResult(mcpHost, workspaceId)
				}
			});
			refreshCustomMcpServersAndNotify(socket, mcpHost, workspaceId);
		} catch (error: unknown) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "mcp_config_error",
					message: error instanceof Error ? error.message : "Failed to remove custom MCP server"
				}
			});
		}
		break;
	}

	case "mcp.config.setEnabled": {
		try {
			const updated: boolean = await setCustomMcpServerEnabled(request.params.serverId, request.params.enabled);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					updated,
					serverId: request.params.serverId,
					enabled: request.params.enabled,
					...await createMcpConfigListResult(mcpHost, workspaceId)
				}
			});
			refreshCustomMcpServersAndNotify(socket, mcpHost, workspaceId);
		} catch (error: unknown) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "mcp_config_error",
					message: error instanceof Error ? error.message : "Failed to update custom MCP server"
				}
			});
		}
		break;
	}

		default:
			throw new Error(`Unsupported mcp method: ${request.method}`);
	}
}
