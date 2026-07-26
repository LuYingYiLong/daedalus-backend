import type WebSocket from "ws";
import type { ClientRequest } from "../../protocol/types.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession } from "../client-session.js";
import { clearActiveSession } from "../client-session.js";
import { sendJson } from "../send-json.js";
import { deleteWorkspace, findWorkspace, hydrateWorkspacesFromSessionMetadata, loadWorkspaces } from "../../workspace/registry.js";
import type { WorkspaceConfig } from "../../workspace/types.js";
import { getClientConnection, updateClientConnection } from "../client-connections.js";
import { logger } from "../../logger.js";
import { deleteSessionsByWorkspace, listArchivedSessions, listSessions } from "../../session/session-store.js";
import { checkoutWorkspaceGitBranch, createWorkspaceGitBranch, listWorkspaceGitBranches } from "../workspace-git-branches.js";
import { commitOrPushWorkspaceGit, generateWorkspaceGitCommitMessage } from "../workspace-git-commit.js";
import { readWorkspaceGitDiff, readWorkspaceGitDiffFile, readWorkspaceGitDiffSummary } from "../workspace-git-diff.js";
import { evaluateWorkspaceSelectionForSession, type WorkspaceSelectionDecision } from "../workspace-selection-guard.js";

export async function handleWorkspaceRequest(socket: WebSocket, request: ClientRequest, session: ClientSession, mcpHost: McpHost): Promise<void> {
	switch (request.method) {
	case "workspace.list":
		hydrateWorkspacesFromSessionMetadata([
			...await listSessions(),
			...await listArchivedSessions()
		]);
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: {
				workspaces: loadWorkspaces(),
				active: session.activeWorkspace?.id ?? mcpHost.getActiveWorkspaceId() ?? null,
				connected: mcpHost.getConnectedWorkspaceIds()
			}
		});
		break;

	case "workspace.select": {
		const workspace: WorkspaceConfig | undefined = findWorkspace(request.params.workspaceId);

		if (!workspace) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "workspace_not_found",
					message: `Workspace not found: ${request.params.workspaceId}`
				}
			});
			break;
		}

		const selectionDecision: WorkspaceSelectionDecision = evaluateWorkspaceSelectionForSession({
			clientType: getClientConnection(socket)?.clientType,
			session,
			workspace,
			requestedSessionId: request.params.sessionId
		});
		if (!selectionDecision.allowed) {
			logger.warn("workspace", "session_workspace_switch_blocked", {
				sessionId: session.sessionId,
				currentWorkspaceId: selectionDecision.currentWorkspaceId,
				requestedWorkspaceId: selectionDecision.requestedWorkspaceId
			});
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
		} catch (error: unknown) {
			logger.error("workspace", "switch_failed", error, {
				requestedWorkspaceId: request.params.workspaceId,
				sessionId: session.sessionId
			});
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "workspace_switch_failed",
					message: error instanceof Error ? error.message : "Failed to switch MCP workspace"
				}
			});
			break;
		}

		if (selectionDecision.bindToSession) {
			session.activeWorkspace = workspace;
			session.godotProjectPath = workspace.rootPath;
		}
		logger.info("workspace", "selected", {
			workspaceId: workspace.id,
			rootPath: workspace.rootPath,
			sessionId: selectionDecision.bindToSession ? session.sessionId : null
		});
		updateClientConnection(socket, {
			workspaceId: workspace.id,
			workspaceRoot: workspace.rootPath
		});

		if (selectionDecision.bindToSession && workspace.godotExecutablePath) {
			session.godotExecutablePath = workspace.godotExecutablePath;
		}

		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: {
				selected: true,
				workspace: {
					id: workspace.id,
					name: workspace.name,
					kind: workspace.kind,
					rootPath: workspace.rootPath
				}
			}
		});
		break;
	}

	case "workspace.delete": {
		const workspace: WorkspaceConfig | undefined = findWorkspace(request.params.workspaceId);

		if (!workspace) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "workspace_not_found",
					message: `Workspace not found: ${request.params.workspaceId}`
				}
			});
			break;
		}

		const deletion = await deleteSessionsByWorkspace(workspace.id);
		deleteWorkspace(workspace.id);
		await mcpHost.closeWorkspace(workspace.id);

		if (session.sessionId !== undefined && deletion.deletedSessionIds.includes(session.sessionId)) {
			clearActiveSession(session);
		}
		if (session.activeWorkspace?.id === workspace.id) {
			session.activeWorkspace = undefined;
			session.godotProjectPath = undefined;
			session.godotExecutablePath = undefined;
			updateClientConnection(socket, {
				workspaceId: null,
				workspaceRoot: null
			});
		}

		logger.info("workspace", "deleted", {
			workspaceId: workspace.id,
			rootPath: workspace.rootPath,
			deletedSessions: deletion.deletedSessionIds.length,
			deletedArchivedSessions: deletion.deletedArchivedSessionIds.length
		});

		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: {
				deleted: true,
				workspaceId: workspace.id,
				deletedSessionIds: deletion.deletedSessionIds,
				deletedArchivedSessionIds: deletion.deletedArchivedSessionIds
			}
		});
		break;
	}

	case "workspace.info":
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: session.activeWorkspace ?? null
		});
		break;

	case "workspace.git.diff.get": {
		const workspace: WorkspaceConfig | undefined = findWorkspace(request.params.workspaceId);
		if (!workspace) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "workspace_not_found",
					message: `Workspace not found: ${request.params.workspaceId}`
				}
			});
			break;
		}

		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: await readWorkspaceGitDiff(workspace.id, workspace.rootPath)
		});
		break;
	}
	case "workspace.git.diff.summary.get": {
		const workspace: WorkspaceConfig | undefined = findWorkspace(request.params.workspaceId);
		if (!workspace) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "workspace_not_found",
					message: `Workspace not found: ${request.params.workspaceId}`
				}
			});
			break;
		}

		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: await readWorkspaceGitDiffSummary(workspace.id, workspace.rootPath, request.params.cursor, request.params.limit)
		});
		break;
	}
	case "workspace.git.diff.file.get": {
		const workspace: WorkspaceConfig | undefined = findWorkspace(request.params.workspaceId);
		if (!workspace) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "workspace_not_found",
					message: `Workspace not found: ${request.params.workspaceId}`
				}
			});
			break;
		}

		try {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: await readWorkspaceGitDiffFile(workspace.id, workspace.rootPath, request.params.path)
			});
		} catch (error: unknown) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "workspace_git_diff_file_unavailable",
					message: error instanceof Error ? error.message : "Unable to read Git diff file."
				}
			});
		}
		break;
	}
	case "workspace.git.commit.message.generate": {
		const workspace: WorkspaceConfig | undefined = findWorkspace(request.params.workspaceId);
		if (!workspace) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "workspace_not_found",
					message: `Workspace not found: ${request.params.workspaceId}`
				}
			});
			break;
		}

		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: await generateWorkspaceGitCommitMessage({
				workspaceId: workspace.id,
				workspaceRoot: workspace.rootPath,
				includeUnstagedChanges: request.params.includeUnstagedChanges,
				provider: request.params.provider,
				model: request.params.model,
				session,
				requestId: request.id
			})
		});
		break;
	}
	case "workspace.git.commitOrPush": {
		const workspace: WorkspaceConfig | undefined = findWorkspace(request.params.workspaceId);
		if (!workspace) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "workspace_not_found",
					message: `Workspace not found: ${request.params.workspaceId}`
				}
			});
			break;
		}

		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: await commitOrPushWorkspaceGit({
				workspaceId: workspace.id,
				workspaceRoot: workspace.rootPath,
				action: request.params.action,
				message: request.params.message,
				includeUnstagedChanges: request.params.includeUnstagedChanges
			})
		});
		break;
	}
	case "workspace.git.branches.list": {
		const workspace: WorkspaceConfig | undefined = findWorkspace(request.params.workspaceId);
		if (!workspace) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "workspace_not_found",
					message: `Workspace not found: ${request.params.workspaceId}`
				}
			});
			break;
		}

		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: await listWorkspaceGitBranches(workspace.id, workspace.rootPath)
		});
		break;
	}
	case "workspace.git.branch.checkout": {
		const workspace: WorkspaceConfig | undefined = findWorkspace(request.params.workspaceId);
		if (!workspace) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "workspace_not_found",
					message: `Workspace not found: ${request.params.workspaceId}`
				}
			});
			break;
		}

		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: await checkoutWorkspaceGitBranch({
				workspaceId: workspace.id,
				workspaceRoot: workspace.rootPath,
				branchName: request.params.branchName
			})
		});
		break;
	}
	case "workspace.git.branch.create": {
		const workspace: WorkspaceConfig | undefined = findWorkspace(request.params.workspaceId);
		if (!workspace) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "workspace_not_found",
					message: `Workspace not found: ${request.params.workspaceId}`
				}
			});
			break;
		}

		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: await createWorkspaceGitBranch({
				workspaceId: workspace.id,
				workspaceRoot: workspace.rootPath,
				branchName: request.params.branchName,
				startPoint: request.params.startPoint
			})
		});
		break;
	}
	default:
		throw new Error(`Unsupported workspace method: ${request.method}`);
	}
}
