import type WebSocket from "ws";
import type { ClientRequest } from "../../protocol/types.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession } from "../client-session.js";
import { clearActiveSession } from "../client-session.js";
import { sendJson } from "../send-json.js";
import {
	deleteWorkspace,
	findWorkspace,
	getWorkspaceSourceFolder,
	hydrateWorkspacesFromSessionMetadata,
	loadWorkspaces,
	updateWorkspace
} from "../../workspace/registry.js";
import type { WorkspaceColor, WorkspaceConfig, WorkspaceIcon } from "../../workspace/types.js";
import { getClientConnection, updateClientConnection } from "../client-connections.js";
import { logger } from "../../logger.js";
import {
	listArchivedSessions,
	listSessions,
	reassignOrDeleteSessionsForWorkspace,
	updateSessionsForWorkspace
} from "../../session/session-store.js";
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
				workspace
			}
		});
		break;
	}

	case "workspace.update": {
		const existingWorkspace: WorkspaceConfig | undefined = findWorkspace(request.params.workspaceId);
		if (existingWorkspace === undefined) {
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
			const wasConnected: boolean = mcpHost.getConnectedWorkspaceIds().includes(existingWorkspace.id);
			const workspace: WorkspaceConfig = updateWorkspace(existingWorkspace.id, {
				name: request.params.name,
				icon: request.params.icon as WorkspaceIcon,
				color: request.params.color as WorkspaceColor,
				sourceFolders: request.params.sourceFolders,
				primarySourceFolderId: request.params.primarySourceFolderId
			});
			await updateSessionsForWorkspace(workspace);
			await mcpHost.closeWorkspace(workspace.id);
			if (session.activeWorkspace?.id === workspace.id) {
				await mcpHost.switchWorkspace(workspace);
				session.activeWorkspace = workspace;
				session.godotProjectPath = workspace.rootPath;
				session.godotExecutablePath = workspace.godotExecutablePath;
				updateClientConnection(socket, {
					workspaceId: workspace.id,
					workspaceRoot: workspace.rootPath
				});
			} else if (wasConnected) {
				await mcpHost.ensureWorkspace(workspace);
			}
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: { workspace }
			});
		} catch (error: unknown) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "workspace_update_failed",
					message: error instanceof Error ? error.message : "Failed to update workspace"
				}
			});
		}
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

		const remainingWorkspaces: WorkspaceConfig[] = loadWorkspaces().filter(
			(candidate: WorkspaceConfig): boolean => candidate.id !== workspace.id
		);
		const deletion = await reassignOrDeleteSessionsForWorkspace(workspace.id, remainingWorkspaces);
		deleteWorkspace(workspace.id);
		await mcpHost.closeWorkspace(workspace.id);

		const activeSessionMove = session.sessionId === undefined
			? undefined
			: deletion.movedSessions.find((move): boolean => move.sessionId === session.sessionId);
		if (activeSessionMove !== undefined) {
			const destination: WorkspaceConfig | undefined = findWorkspace(activeSessionMove.workspaceId);
			if (destination !== undefined) {
				session.activeWorkspace = destination;
				session.godotProjectPath = destination.rootPath;
				session.godotExecutablePath = destination.godotExecutablePath;
				await mcpHost.ensureWorkspace(destination);
				updateClientConnection(socket, {
					workspaceId: destination.id,
					workspaceRoot: destination.rootPath
				});
			}
		} else if (session.sessionId !== undefined && deletion.deletedSessionIds.includes(session.sessionId)) {
			clearActiveSession(session);
		}
		if (session.activeWorkspace?.id === workspace.id && activeSessionMove === undefined) {
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
				movedSessions: deletion.movedSessions,
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
			result: await readWorkspaceGitDiff(
				workspace.id,
				getWorkspaceSourceFolder(workspace, request.params.sourceFolderId).path
			)
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
			result: await readWorkspaceGitDiffSummary(
				workspace.id,
				getWorkspaceSourceFolder(workspace, request.params.sourceFolderId).path,
				request.params.cursor,
				request.params.limit
			)
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
				result: await readWorkspaceGitDiffFile(
					workspace.id,
					getWorkspaceSourceFolder(workspace, request.params.sourceFolderId).path,
					request.params.path
				)
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
				workspaceRoot: getWorkspaceSourceFolder(workspace, request.params.sourceFolderId).path,
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
				workspaceRoot: getWorkspaceSourceFolder(workspace, request.params.sourceFolderId).path,
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
			result: await listWorkspaceGitBranches(
				workspace.id,
				getWorkspaceSourceFolder(workspace, request.params.sourceFolderId).path
			)
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
				workspaceRoot: getWorkspaceSourceFolder(workspace, request.params.sourceFolderId).path,
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
				workspaceRoot: getWorkspaceSourceFolder(workspace, request.params.sourceFolderId).path,
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
