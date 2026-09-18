import type { McpHost } from "../mcp/mcp-host.js";
import { listArchivedSessions, listSessions, type SessionMetadata } from "../session/session-store.js";
import { hydrateWorkspacesFromSessionMetadata, loadWorkspaces } from "../workspace/registry.js";
import type { WorkspaceConfig } from "../workspace/types.js";
import type { ClientSession } from "./client-session.js";

export type SessionBrowserSnapshot = {
	sessions: SessionMetadata[];
	archivedSessions: SessionMetadata[];
	workspaces: WorkspaceConfig[];
	active: string | null;
	connected: string[];
};

export async function createSessionBrowserSnapshot(session: ClientSession, mcpHost: McpHost): Promise<SessionBrowserSnapshot> {
	const allSessions: SessionMetadata[] = await listSessions();
	const allArchivedSessions: SessionMetadata[] = await listArchivedSessions();
	hydrateWorkspacesFromSessionMetadata([...allSessions, ...allArchivedSessions]);
	const sessions: SessionMetadata[] = allSessions;
	const archivedSessions: SessionMetadata[] = allArchivedSessions;

	return {
		sessions,
		archivedSessions,
		workspaces: loadWorkspaces(),
		active: session.activeWorkspace?.id ?? mcpHost.getActiveWorkspaceId() ?? null,
		connected: mcpHost.getConnectedWorkspaceIds()
	};
}
