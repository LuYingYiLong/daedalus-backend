import type WebSocket from "ws";
import { randomUUID } from "node:crypto";
import type { ClientRequest } from "../../protocol/types.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession } from "../client-session.js";
import { clearActiveSession } from "../client-session.js";
import { sendJson } from "../send-json.js";
import { deleteWorkspace, findWorkspace, getWorkspaceSourceFolder, hydrateWorkspacesFromSessionMetadata, loadWorkspaces, unregisterSessionRuntimeWorkspace, updateWorkspace, upsertRuntimeWorkspace } from "../../workspace/registry.js";
import type { WorkspaceColor, WorkspaceConfig, WorkspaceIcon } from "../../workspace/types.js";
import { getClientConnection, updateClientConnection } from "../client-connections.js";
import { logger } from "../../logger.js";
import { getStoredSessionMetadata, listArchivedSessions, listSessions, listTemporarySessions, reassignOrDeleteSessionsForWorkspace, updateSessionsForWorkspace } from "../../session/session-store.js";
import { checkoutWorkspaceGitBranch, createWorkspaceGitBranch, listWorkspaceGitBranches } from "../workspace-git-branches.js";
import { commitOrPushWorkspaceGit, generateWorkspaceGitCommitMessage, GitCommitMessageGenerationTimeoutError } from "../workspace-git-commit.js";
import { readWorkspaceGitDiff, readWorkspaceGitDiffFile, readWorkspaceGitDiffSummary } from "../workspace-git-diff.js";
import { evaluateWorkspaceSelectionForSession, type WorkspaceSelectionDecision } from "../workspace-selection-guard.js";
import { getWorkspaceTreeOrder, updateWorkspaceTreeOrder, type WorkspaceTreeOrderInventory } from "../../workspace/tree-order-store.js";
import { createManagedWorktree, deleteManagedWorktree, inspectWorkspaceWorktreeEligibility } from "../../workspace/worktree-manager.js";
import { inspectWorktreeHealth, repairManagedWorktree, findOrphanedManagedWorktreeDirectories } from "../../workspace/worktree-health.js";
import { listWorktreeOperations, runTrackedWorktreeOperation } from "../../workspace/worktree-operations.js";
import { runWorktreeSetup } from "../../workspace/local-environment-runtime.js";

async function loadWorkspaceTreeOrderInventory(): Promise<WorkspaceTreeOrderInventory> {
	const [sessions, archivedSessions] = await Promise.all([listSessions(), listArchivedSessions()]);
	hydrateWorkspacesFromSessionMetadata([...sessions, ...archivedSessions]);
	return {
		workspaces: loadWorkspaces(),
		sessions
	};
}

export async function handleWorkspaceRequest(socket: WebSocket, request: ClientRequest, session: ClientSession, mcpHost: McpHost): Promise<void> {
	switch (request.method) {
		case "workspace.tree.order.get":
		case "workspace.tree.order.update": {
			if (getClientConnection(socket)?.clientType !== "studio") {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "studio_only",
						message: `${request.method} is only available to Daedalus Studio.`
					}
				});
				break;
			}
			try {
				const inventory: WorkspaceTreeOrderInventory = await loadWorkspaceTreeOrderInventory();
				const result = request.method === "workspace.tree.order.get" ? await getWorkspaceTreeOrder(inventory) : await updateWorkspaceTreeOrder(request.params, inventory);
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: true,
					result
				});
			} catch (error: unknown) {
				const message: string = error instanceof Error ? error.message : "Failed to save workspace tree order.";
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: message.startsWith("workspace_tree_order_") ? message : "workspace_tree_order_failed",
						message
					}
				});
			}
			break;
		}

		case "workspace.list":
			hydrateWorkspacesFromSessionMetadata([...(await listSessions()), ...(await listArchivedSessions())]);
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
			const worktreeSession = [...(await listSessions()), ...(await listTemporarySessions()), ...(await listArchivedSessions())].find(
				(candidate): boolean => candidate.worktree?.sourceWorkspaceId === workspace.id
			);
			if (worktreeSession !== undefined) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "workspace_has_managed_worktree",
						message: `Delete the managed worktree for session ${worktreeSession.id} first.`
					}
				});
				break;
			}
			const permanentWorktree: WorkspaceConfig | undefined = loadWorkspaces().find((candidate): boolean => candidate.permanentWorktree?.sourceWorkspaceId === workspace.id);
			if (permanentWorktree !== undefined) {
				sendJson(socket, { type: "response", id: request.id, ok: false, error: { code: "workspace_has_permanent_worktree", message: `Delete permanent worktree ${permanentWorktree.name} first.` } });
				break;
			}

			const remainingWorkspaces: WorkspaceConfig[] = loadWorkspaces().filter((candidate: WorkspaceConfig): boolean => candidate.id !== workspace.id);
			const deletion = await reassignOrDeleteSessionsForWorkspace(workspace.id, remainingWorkspaces);
			deleteWorkspace(workspace.id);
			await mcpHost.closeWorkspace(workspace.id);

			const activeSessionMove = session.sessionId === undefined ? undefined : deletion.movedSessions.find((move): boolean => move.sessionId === session.sessionId);
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

		case "workspace.worktree.eligibility.get": {
			const workspace: WorkspaceConfig | undefined = findWorkspace(request.params.workspaceId);
			if (workspace === undefined) {
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
				result: await inspectWorkspaceWorktreeEligibility(workspace)
			});
			break;
		}

		case "workspace.worktree.status.list": {
			const allSessions = [...(await listSessions()), ...(await listTemporarySessions()), ...(await listArchivedSessions())];
			const worktreeSessions = allSessions.filter((candidate): boolean => candidate.worktree !== undefined);
			const permanentWorkspaces = loadWorkspaces().filter((workspace): boolean => workspace.permanentWorktree !== undefined);
			const knownDirectoryKeys = new Set<string>([
				...worktreeSessions.map((candidate): string => candidate.id),
				...permanentWorkspaces.map((workspace): string => workspace.permanentWorktree!.id.replace(/^(?:managed|permanent)-/u, ""))
			]);
			const sessions = await Promise.all(worktreeSessions.map(async (candidate) => ({
				session: candidate,
				health: await inspectWorktreeHealth(candidate.worktree!)
			})));
			const permanent = await Promise.all(permanentWorkspaces.map(async (workspace) => ({ workspace, health: await inspectWorktreeHealth(workspace.permanentWorktree!) })));
			sendJson(socket, { type: "response", id: request.id, ok: true, result: { sessions, permanent, orphans: await findOrphanedManagedWorktreeDirectories(knownDirectoryKeys), operations: await listWorktreeOperations() } });
			break;
		}

		case "workspace.worktree.repair": {
			try {
				const metadata = await getStoredSessionMetadata(request.params.sessionId);
				if (metadata.worktree === undefined) throw Object.assign(new Error("Session does not have a managed worktree."), { code: "worktree_not_found" });
				sendJson(socket, { type: "response", id: request.id, ok: true, result: await repairManagedWorktree(metadata.worktree) });
			} catch (error: unknown) {
				sendJson(socket, { type: "response", id: request.id, ok: false, error: { code: typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "worktree_repair_failed", message: error instanceof Error ? error.message : "Failed to repair worktree." } });
			}
			break;
		}

		case "workspace.worktree.permanent.create": {
			try {
				const sourceWorkspace: WorkspaceConfig | undefined = findWorkspace(request.params.workspaceId);
				if (sourceWorkspace === undefined) throw Object.assign(new Error(`Workspace not found: ${request.params.workspaceId}`), { code: "workspace_not_found" });
				const directoryKey: string = `permanent-${randomUUID()}`;
				const trackedCreate = await runTrackedWorktreeOperation({
					type: "permanent-create",
					workspaceId: sourceWorkspace.id,
					task: async ({ signal, update }) => {
						await update({ stage: "creating", progress: 0.05 });
						const created = await createManagedWorktree({ sessionId: directoryKey, workspace: sourceWorkspace, sources: request.params.sources, permanentName: request.params.name });
						try {
							if (signal.aborted) throw Object.assign(new Error("Permanent worktree creation cancelled."), { code: "worktree_operation_cancelled" });
							await update({ stage: "setup", progress: 0.55 });
							const setupResult = await runWorktreeSetup({ metadata: created.metadata, sourceWorkspace, signal });
							return { created, setupResult };
						} catch (error: unknown) {
							await deleteManagedWorktree(created.metadata).catch((): void => undefined);
							throw error;
						}
					}
				});
				const { created, setupResult } = trackedCreate.result;
				unregisterSessionRuntimeWorkspace(created.workspace.id);
				const workspaceId: string = `permanent-worktree-${randomUUID()}`;
				const metadata = { ...setupResult.metadata, runtimeWorkspaceId: workspaceId };
				const workspace: WorkspaceConfig = upsertRuntimeWorkspace({ ...created.workspace, id: workspaceId, name: request.params.name, permanentWorktree: metadata });
				sendJson(socket, { type: "response", id: request.id, ok: true, result: { workspace, metadata, operation: trackedCreate.operation } });
			} catch (error: unknown) {
				sendJson(socket, { type: "response", id: request.id, ok: false, error: { code: typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "permanent_worktree_create_failed", message: error instanceof Error ? error.message : "Failed to create permanent worktree." } });
			}
			break;
		}

		case "workspace.worktree.permanent.delete": {
			try {
				const workspace: WorkspaceConfig | undefined = findWorkspace(request.params.workspaceId);
				if (workspace?.permanentWorktree === undefined) throw Object.assign(new Error("Permanent worktree not found."), { code: "permanent_worktree_not_found" });
				const boundSession = [...(await listSessions()), ...(await listTemporarySessions()), ...(await listArchivedSessions())].find((candidate): boolean => candidate.workspaceId === workspace.id);
				if (boundSession !== undefined) throw Object.assign(new Error(`Delete or move session ${boundSession.id} first.`), { code: "permanent_worktree_in_use" });
				const trackedDelete = await runTrackedWorktreeOperation({
					type: "permanent-delete",
					workspaceId: workspace.id,
					task: async ({ signal, update }): Promise<void> => {
						if (signal.aborted) throw Object.assign(new Error("Permanent worktree deletion cancelled."), { code: "worktree_operation_cancelled" });
						await update({ stage: "deleting", progress: 0.1 });
						await deleteManagedWorktree(workspace.permanentWorktree!);
					}
				});
				deleteWorkspace(workspace.id);
				sendJson(socket, { type: "response", id: request.id, ok: true, result: { deleted: true, workspaceId: workspace.id, operation: trackedDelete.operation } });
			} catch (error: unknown) {
				sendJson(socket, { type: "response", id: request.id, ok: false, error: { code: typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "permanent_worktree_delete_failed", message: error instanceof Error ? error.message : "Failed to delete permanent worktree." } });
			}
			break;
		}

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
				result: await readWorkspaceGitDiff(workspace.id, getWorkspaceSourceFolder(workspace, request.params.sourceFolderId).path)
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
				result: await readWorkspaceGitDiffSummary(workspace.id, getWorkspaceSourceFolder(workspace, request.params.sourceFolderId).path, request.params.cursor, request.params.limit)
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
					result: await readWorkspaceGitDiffFile(workspace.id, getWorkspaceSourceFolder(workspace, request.params.sourceFolderId).path, request.params.path)
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

			try {
				const result = await generateWorkspaceGitCommitMessage({
					workspaceId: workspace.id,
					workspaceRoot: getWorkspaceSourceFolder(workspace, request.params.sourceFolderId).path,
					includeUnstagedChanges: request.params.includeUnstagedChanges,
					provider: request.params.provider,
					model: request.params.model,
					session,
					requestId: request.id
				});
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
						code: error instanceof GitCommitMessageGenerationTimeoutError ? error.code : "workspace_git_commit_message_generation_failed",
						message: error instanceof Error ? error.message : "Failed to generate an AI commit message."
					}
				});
			}
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
				result: await listWorkspaceGitBranches(workspace.id, getWorkspaceSourceFolder(workspace, request.params.sourceFolderId).path)
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
