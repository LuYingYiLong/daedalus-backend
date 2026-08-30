import type { GodotEditorInstanceSummary } from "../mcp/godot/bridges/editor-bridge.js";
import { GODOT_DIAGNOSTICS_SERVER_ID } from "../mcp/godot/bridges/diagnostics-bridge.js";
import { GODOT_EDITOR_SERVER_ID } from "../mcp/godot/bridges/editor-bridge.js";
import type { McpHost } from "../mcp/mcp-host.js";
import type { ClientSession } from "./client-session.js";

type DiagnosticsStatus = {
	serverId?: unknown;
	workspaceId?: unknown;
	workspaceRoot?: unknown;
	lsp?: unknown;
	dap?: unknown;
};

type RuntimeWarning = {
	code: string;
	message: string;
};

function asString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function getEndpointAvailability(endpointStatus: unknown): boolean | null {
	if (endpointStatus !== null && typeof endpointStatus === "object") {
		const available: unknown = (endpointStatus as Record<string, unknown>).available;
		return typeof available === "boolean" ? available : null;
	}
	return null;
}

function getEndpointLastError(endpointStatus: unknown): string | null {
	if (endpointStatus !== null && typeof endpointStatus === "object") {
		return asString((endpointStatus as Record<string, unknown>).lastError);
	}
	return null;
}

export function createGodotRuntimeStatus(session: ClientSession, mcpHost: McpHost): Record<string, unknown> {
	const sessionWorkspaceId: string | null = session.activeWorkspace?.id ?? null;
	const sessionWorkspaceRoot: string | null = session.activeWorkspace?.rootPath ?? session.workspaceRoot ?? null;
	const boundEditorInstanceId: string | null = session.editorInstanceId ?? null;
	const mcpActiveWorkspaceId: string | null = mcpHost.getActiveWorkspaceId() ?? null;
	const connectedWorkspaceIds: string[] = mcpHost.getConnectedWorkspaceIds();
	const diagnosticsStatus: DiagnosticsStatus = mcpHost.getDiagnosticsBridge().getCachedStatus() as DiagnosticsStatus;
	const diagnosticsWorkspaceId: string | null = asString(diagnosticsStatus.workspaceId);
	const editorInstancesForSession: GodotEditorInstanceSummary[] = mcpHost.getEditorBridge().listInstances(sessionWorkspaceId ?? undefined);
	const allEditorInstances: GodotEditorInstanceSummary[] = mcpHost.getEditorBridge().listInstances();
	const boundEditor: GodotEditorInstanceSummary | null = boundEditorInstanceId === null
		? null
		: allEditorInstances.find((instance: GodotEditorInstanceSummary): boolean => instance.editorInstanceId === boundEditorInstanceId) ?? null;
	const editorOnlineForSession: boolean = sessionWorkspaceId === null
		? mcpHost.getEditorBridge().isOnline(undefined, boundEditorInstanceId ?? undefined)
		: mcpHost.getEditorBridge().isOnline(sessionWorkspaceId, boundEditorInstanceId ?? undefined);
	const warnings: RuntimeWarning[] = [];

	if (sessionWorkspaceId === null) {
		warnings.push({
			code: "session_workspace_missing",
			message: "The current session is not bound to a workspace, so Godot/LSP tools may not be able to select a project."
		});
	}

	if (sessionWorkspaceId !== null && !connectedWorkspaceIds.includes(sessionWorkspaceId)) {
		warnings.push({
			code: "workspace_not_connected",
			message: "The current session workspace is not connected to an MCP session. Run environment.configure or workspace.select before calling tools."
		});
	}

	if (sessionWorkspaceId !== null && editorInstancesForSession.length === 0) {
		warnings.push({
			code: "editor_instance_missing",
			message: "The current workspace has no online Godot editor instance, so editor bridge tools are unavailable."
		});
	}

	if (sessionWorkspaceId !== null && editorInstancesForSession.length > 1 && boundEditorInstanceId === null) {
		warnings.push({
			code: "editor_binding_required",
			message: "Multiple Godot editor instances are online for the current workspace. Bind an editorInstanceId before using editor write tools."
		});
	}

	if (boundEditorInstanceId !== null && boundEditor === null) {
		warnings.push({
			code: "bound_editor_offline",
			message: "The Godot editor instance bound to this session is currently offline."
		});
	}

	if (sessionWorkspaceId !== null && diagnosticsWorkspaceId !== null && diagnosticsWorkspaceId !== sessionWorkspaceId) {
		warnings.push({
			code: "diagnostics_workspace_mismatch",
			message: "The workspace cached by the Godot diagnostics bridge does not match the session workspace."
		});
	}

	if (sessionWorkspaceId !== null && diagnosticsWorkspaceId === null) {
		warnings.push({
			code: "diagnostics_workspace_missing",
			message: "The Godot diagnostics bridge has not selected a workspace. The backend will select the session workspace on the first diagnostics call."
		});
	}

	const lspAvailable: boolean | null = getEndpointAvailability(diagnosticsStatus.lsp);
	const lspLastError: string | null = getEndpointLastError(diagnosticsStatus.lsp);
	if (lspAvailable === false && lspLastError !== null) {
		warnings.push({
			code: "lsp_unavailable",
			message: `The most recent Godot LSP probe failed: ${lspLastError}`
		});
	}

	return {
		sessionWorkspaceId,
		sessionWorkspaceRoot,
		mcpActiveWorkspaceId,
		connectedWorkspaceIds,
		mcpServers: mcpHost.getConnectedServerIds(sessionWorkspaceId ?? undefined),
		editor: {
			serverId: GODOT_EDITOR_SERVER_ID,
			boundEditorInstanceId,
			onlineForSession: editorOnlineForSession,
			instancesForSessionWorkspace: editorInstancesForSession,
			allInstances: allEditorInstances
		},
		diagnostics: {
			serverId: GODOT_DIAGNOSTICS_SERVER_ID,
			workspaceMatchesSession: sessionWorkspaceId !== null && diagnosticsWorkspaceId === sessionWorkspaceId,
			status: diagnosticsStatus
		},
		warnings
	};
}

