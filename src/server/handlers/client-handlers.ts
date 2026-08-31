import type WebSocket from "ws";
import type { ClientRequest } from "../../protocol/types.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import { applyWorkspaceToSession, type ClientSession } from "../client-session.js";
import { sendJson } from "../send-json.js";
import {
	getClientConnection,
	updateClientConnection,
	type ClientCapabilities,
	type ClientType
} from "../client-connections.js";
import { logger } from "../../logger.js";
import {
	createRuntimeWorkspace,
	createSourceScopedWorkspace,
	findWorkspaceSourceByPath,
	upsertRuntimeWorkspace
} from "../../workspace/registry.js";
import type { WorkspaceConfig } from "../../workspace/types.js";
import {
	isBridgeProtocolSupported,
	MAX_BRIDGE_PROTOCOL_VERSION,
	MIN_BRIDGE_PROTOCOL_VERSION
} from "../bridge-compatibility.js";
import { studioBrowserRuntime } from "../studio-browser-runtime.js";
import { studioComputerRuntime } from "../studio-computer-runtime.js";
import { getComputerObservation } from "../../session/computer-observation-store.js";
import { getGeneralSettings } from "../../general-settings-store.js";
import { studioScheduledTaskRuntime } from "../studio-scheduled-task-runtime.js";

function readClientType(value: unknown): ClientType {
	return value === "godot_editor_bridge" || value === "studio" || value === "studio_remote" || value === "studio_scheduler" || value === "cli" || value === "smoke" || value === "external_mcp"
		? value
		: "legacy";
}

function getDefaultClientName(clientType: ClientType): string {
	if (clientType === "studio") return "Daedalus Studio";
	if (clientType === "studio_remote") return "Daedalus Remote";
	return "Daedalus Editor Bridge";
}

function rejectBridgeHandshake(socket: WebSocket, requestId: string, receivedVersion: number | undefined): void {
	sendJson(socket, {
		type: "response",
		id: requestId,
		ok: false,
		error: {
			code: "bridge_protocol_unsupported",
			message: `Daedalus Editor Bridge Protocol v${MIN_BRIDGE_PROTOCOL_VERSION} is required. Received ${receivedVersion ?? "an unidentified legacy client"}.`
		}
	});
	setTimeout((): void => {
		if (socket.readyState < 2) {
			socket.close(1008, "bridge_protocol_unsupported");
		}
	}, 0);
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
			const isEditorBridge: boolean = clientType === "godot_editor_bridge";
			if (isEditorBridge && !isBridgeProtocolSupported(params.bridgeProtocolVersion)) {
				rejectBridgeHandshake(
					socket,
					request.id,
					params.bridgeProtocolVersion
				);
				break;
			}
			if (isEditorBridge && (
				params.bridgeVersion === undefined
				|| params.godotVersion === undefined
				|| params.workspaceRoot === undefined
				|| params.editorInstanceId === undefined
			)) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "bridge_hello_invalid",
						message: "Editor Bridge hello requires bridgeVersion, godotVersion, workspaceRoot, and editorInstanceId."
					}
				});
				break;
			}
			let workspace: WorkspaceConfig | undefined;
			if (isEditorBridge && params.workspaceRoot !== undefined) {
				const configuredSource = findWorkspaceSourceByPath(params.workspaceRoot);
				workspace = configuredSource === undefined
					? upsertRuntimeWorkspace(createRuntimeWorkspace(
						params.workspaceRoot,
						params.godotExecutablePath ?? session.godotExecutablePath
					))
					: createSourceScopedWorkspace(configuredSource.workspace, configuredSource.sourceFolder.id);

				// 在异步初始化 MCP 前先绑定会话，避免后续并发请求继续使用持久化默认工作区。
				applyWorkspaceToSession(session, workspace);
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
				clientName: params.clientName ?? getDefaultClientName(clientType),
				workspaceId: workspace?.id ?? params.workspaceId,
				workspaceRoot: workspace?.rootPath ?? params.workspaceRoot,
				editorInstanceId: params.editorInstanceId,
				bridgeProtocolVersion: isEditorBridge ? params.bridgeProtocolVersion : undefined,
				bridgeHandshakeAccepted: isEditorBridge,
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
				bridgeVersion: params.bridgeVersion,
				bridgeProtocolVersion: params.bridgeProtocolVersion,
				godotVersion: params.godotVersion,
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
						protocolVersion: 3
					},
					bridgeCompatibility: {
						minProtocolVersion: MIN_BRIDGE_PROTOCOL_VERSION,
						maxProtocolVersion: MAX_BRIDGE_PROTOCOL_VERSION,
						accepted: !isEditorBridge || isBridgeProtocolSupported(params.bridgeProtocolVersion)
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
					features: { computerControl: 3, computerGrounding: 1 },
					session: {
						sessionId: session.sessionId ?? null,
						workspaceId: session.activeWorkspace?.id ?? null,
						editorInstanceId: session.editorInstanceId ?? null
					}
				}
			});
			break;

		case "client.capabilities.update": {
			const current = getClientConnection(socket);
			if (current?.clientType !== "studio") {
				throw new Error("Only Daedalus Studio can update runtime capabilities.");
			}
			const capabilities: ClientCapabilities = { ...current.capabilities };
			for (const [key, value] of Object.entries(request.params!.capabilities)) {
				if (typeof value === "boolean") capabilities[key as keyof ClientCapabilities] = value;
			}
			const info = updateClientConnection(socket, { capabilities });
			if (capabilities.computerGrounding !== true || capabilities.computerObservation !== true) studioComputerRuntime.disableGrounding(socket);
			sendJson(socket, { type: "response", id: request.id, ok: true, result: { connection: info } });
			break;
		}

		case "browser.tool.result":
		case "computer.tool.result":
			if (request.method === "computer.tool.result") {
				if (getClientConnection(socket)?.clientType !== "studio") throw new Error("computer_client_not_allowed");
				studioComputerRuntime.handleResult(socket, request.params!);
				sendJson(socket, { type: "response", id: request.id, ok: true, result: { accepted: true } });
				break;
			}
			studioBrowserRuntime.handleResult(socket, request.params!);
			sendJson(socket, { type: "response", id: request.id, ok: true, result: { accepted: true } });
			break;

		case "session.computerObservation.get": {
			if (getClientConnection(socket)?.clientType !== "studio") throw new Error("computer_client_not_allowed");
			const result = await getComputerObservation(request.params!.sessionId, request.params!.observationId, (await getGeneralSettings()).developerMode);
			sendJson(socket, { type: "response", id: request.id, ok: true, result });
			break;
		}
		case "computer.access.revoked": {
			if (getClientConnection(socket)?.clientType !== "studio") throw new Error("computer_client_not_allowed");
			studioComputerRuntime.revoke(socket, request.params!);
			sendJson(socket, { type: "response", id: request.id, ok: true, result: { accepted: true } });
			break;
		}
		case "computer.control.update": {
			if (getClientConnection(socket)?.clientType !== "studio") throw new Error("computer_client_not_allowed");
			studioComputerRuntime.updateControl(socket, request.params!);
			sendJson(socket, { type: "response", id: request.id, ok: true, result: { accepted: true } });
			break;
		}
		case "scheduled-task.tool.result":
			studioScheduledTaskRuntime.handleResult(socket, request.params!);
			sendJson(socket, { type: "response", id: request.id, ok: true, result: { accepted: true } });
			break;

		default:
			throw new Error(`Unsupported client method: ${request.method}`);
	}
}
