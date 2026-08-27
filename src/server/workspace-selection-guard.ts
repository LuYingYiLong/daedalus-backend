import type { WorkspaceConfig } from "../workspace/types.js";
import type { ClientSession } from "./client-session.js";
import { isStudioSessionClientType, type ClientType } from "./client-connections.js";

export type WorkspaceSelectionDecision = {
	allowed: true;
	bindToSession: boolean;
} | {
	allowed: false;
	code: "session_workspace_locked";
	message: string;
	currentWorkspaceId?: string | undefined;
	requestedWorkspaceId: string;
};

export function evaluateWorkspaceSelectionForSession(params: {
	clientType: ClientType | undefined;
	session: Pick<ClientSession, "sessionId" | "activeWorkspace">;
	workspace: Pick<WorkspaceConfig, "id" | "name" | "rootPath">;
	requestedSessionId?: string | null | undefined;
}): WorkspaceSelectionDecision {
	if (!isStudioSessionClientType(params.clientType) || params.session.sessionId === undefined) {
		return { allowed: true, bindToSession: true };
	}

	if (params.requestedSessionId === null) {
		return { allowed: true, bindToSession: false };
	}

	if (params.requestedSessionId !== undefined && params.requestedSessionId !== params.session.sessionId) {
		return {
			allowed: false,
			code: "session_workspace_locked",
			message: `The workspace selection targets session ${params.requestedSessionId}, but this connection is bound to ${params.session.sessionId}.`,
			currentWorkspaceId: params.session.activeWorkspace?.id,
			requestedWorkspaceId: params.workspace.id
		};
	}

	const currentWorkspace: WorkspaceConfig | undefined = params.session.activeWorkspace;
	if (currentWorkspace?.id === params.workspace.id) {
		return { allowed: true, bindToSession: true };
	}

	const currentLabel: string = currentWorkspace === undefined
		? "no workspace"
		: `${currentWorkspace.name} (${currentWorkspace.rootPath})`;

	return {
		allowed: false,
		code: "session_workspace_locked",
		message: `This session is bound to ${currentLabel}. Create or open a session for ${params.workspace.name} instead of switching the active workspace in-place.`,
		currentWorkspaceId: currentWorkspace?.id,
		requestedWorkspaceId: params.workspace.id
	};
}
