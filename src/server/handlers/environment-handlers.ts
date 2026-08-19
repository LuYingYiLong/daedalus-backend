import type WebSocket from "ws";
import type { ClientRequest } from "../../protocol/types.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession } from "../client-session.js";
import { sendJson } from "../send-json.js";
import { createRuntimeWorkspace, upsertRuntimeWorkspace } from "../../workspace/registry.js";
import type { WorkspaceConfig } from "../../workspace/types.js";
import { getClientConnection, updateClientConnection } from "../client-connections.js";
import { evaluateWorkspaceSelectionForSession, type WorkspaceSelectionDecision } from "../workspace-selection-guard.js";
import { findWorkspace } from "../../workspace/registry.js";
import { listEnvironmentActions, readLocalEnvironmentConfig, updateEnvironmentTrust, writeLocalEnvironmentConfig } from "../../workspace/local-environment.js";

export async function handleEnvironmentRequest(socket: WebSocket, request: ClientRequest, session: ClientSession, mcpHost: McpHost): Promise<void> {
	switch (request.method) {
	case "environment.config.get":
	case "environment.config.update":
	case "environment.trust.update":
	case "environment.actions.list": {
		if (getClientConnection(socket)?.clientType !== "studio") {
			sendJson(socket, { type: "response", id: request.id, ok: false, error: { code: "studio_only", message: "Local environments are only available to Daedalus Studio." } });
			break;
		}
		try {
			const workspace: WorkspaceConfig | undefined = findWorkspace(request.params.workspaceId);
			if (workspace === undefined) throw Object.assign(new Error(`Workspace not found: ${request.params.workspaceId}`), { code: "workspace_not_found" });
			let result: unknown;
			if (request.method === "environment.config.get") {
				result = await readLocalEnvironmentConfig(workspace, request.params.sourceFolderId);
			} else if (request.method === "environment.config.update") {
				result = await writeLocalEnvironmentConfig({ workspace, sourceFolderId: request.params.sourceFolderId, content: request.params.content, expectedRevision: request.params.expectedRevision });
			} else if (request.method === "environment.actions.list") {
				result = await listEnvironmentActions({ workspace, sourceFolderId: request.params.sourceFolderId, environmentId: request.params.environmentId });
			} else {
				const document = await readLocalEnvironmentConfig(workspace, request.params.sourceFolderId);
				if (!document.profiles.some((profile): boolean => profile.fingerprint === request.params.fingerprint)) {
					throw Object.assign(new Error("Environment fingerprint is stale. Reload the configuration before reviewing trust."), { code: "environment_fingerprint_stale" });
				}
				await updateEnvironmentTrust(request.params.fingerprint, request.params.status);
				result = await readLocalEnvironmentConfig(workspace, request.params.sourceFolderId);
			}
			sendJson(socket, { type: "response", id: request.id, ok: true, result });
		} catch (error: unknown) {
			sendJson(socket, { type: "response", id: request.id, ok: false, error: { code: typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "environment_request_failed", message: error instanceof Error ? error.message : "Environment request failed." } });
		}
		break;
	}
	case "environment.configure":
		const draftSelection: boolean = request.params.sessionId === null;
		const nextGodotExecutablePath: string | undefined = request.params.godotExecutablePath ?? session.godotExecutablePath;
		const nextGodotProjectPath: string | undefined = request.params.godotProjectPath ?? session.godotProjectPath;
		let configuredWorkspace: WorkspaceConfig | undefined;

		if (!draftSelection && request.params.godotExecutablePath !== undefined) {
			session.godotExecutablePath = request.params.godotExecutablePath;
		}

		if (!draftSelection && request.params.godotProjectPath !== undefined) {
			session.godotProjectPath = request.params.godotProjectPath;
		}

		if (nextGodotProjectPath) {
			const workspace: WorkspaceConfig = upsertRuntimeWorkspace(createRuntimeWorkspace(
				nextGodotProjectPath,
				nextGodotExecutablePath
			));
			const selectionDecision: WorkspaceSelectionDecision = evaluateWorkspaceSelectionForSession({
				clientType: getClientConnection(socket)?.clientType,
				session,
				workspace,
				requestedSessionId: request.params.sessionId
			});
			if (!selectionDecision.allowed) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: selectionDecision.code,
						message: selectionDecision.message
					}
				});
				break;
			}

			try {
				await mcpHost.ensureWorkspace(workspace);
				configuredWorkspace = workspace;
				if (selectionDecision.bindToSession) {
					session.activeWorkspace = workspace;
					session.godotProjectPath = workspace.rootPath;
					session.godotExecutablePath = workspace.godotExecutablePath ?? nextGodotExecutablePath;
				}
				updateClientConnection(socket, {
					workspaceId: workspace.id,
					workspaceRoot: workspace.rootPath
				});
			} catch (error: unknown) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "workspace_switch_failed",
						message: error instanceof Error ? error.message : "Failed to configure runtime workspace"
					}
				});
				break;
			}
		}

		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: {
				configured: true,
				godotExecutablePath: configuredWorkspace?.godotExecutablePath ?? nextGodotExecutablePath ?? null,
				godotProjectPath: configuredWorkspace?.rootPath ?? nextGodotProjectPath ?? null,
				workspaceId: configuredWorkspace?.id ?? session.activeWorkspace?.id ?? null,
				workspace: configuredWorkspace ?? session.activeWorkspace ?? null
			}
		});
		break;

		default:
			throw new Error(`Unsupported environment method: ${request.method}`);
	}
}
