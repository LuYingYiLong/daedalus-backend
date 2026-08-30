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
			message: "当前会话没有绑定 workspace；Godot/LSP 工具可能无法选择项目。"
		});
	}

	if (sessionWorkspaceId !== null && !connectedWorkspaceIds.includes(sessionWorkspaceId)) {
		warnings.push({
			code: "workspace_not_connected",
			message: "当前会话 workspace 尚未连接 MCP 会话；工具调用前需要先完成 environment.configure 或 workspace.select。"
		});
	}

	if (sessionWorkspaceId !== null && editorInstancesForSession.length === 0) {
		warnings.push({
			code: "editor_instance_missing",
			message: "当前 workspace 没有在线 Godot editor instance；editor bridge 工具不可用。"
		});
	}

	if (sessionWorkspaceId !== null && editorInstancesForSession.length > 1 && boundEditorInstanceId === null) {
		warnings.push({
			code: "editor_binding_required",
			message: "当前 workspace 有多个 Godot editor instance 在线；写入 editor 工具前需要绑定 editorInstanceId。"
		});
	}

	if (boundEditorInstanceId !== null && boundEditor === null) {
		warnings.push({
			code: "bound_editor_offline",
			message: "会话绑定的 Godot editor instance 当前不在线。"
		});
	}

	if (sessionWorkspaceId !== null && diagnosticsWorkspaceId !== null && diagnosticsWorkspaceId !== sessionWorkspaceId) {
		warnings.push({
			code: "diagnostics_workspace_mismatch",
			message: "Godot diagnostics bridge 当前缓存的 workspace 与会话 workspace 不一致。"
		});
	}

	if (sessionWorkspaceId !== null && diagnosticsWorkspaceId === null) {
		warnings.push({
			code: "diagnostics_workspace_missing",
			message: "Godot diagnostics bridge 尚未选择 workspace；首次调用 diagnostics 工具时后端会按会话 workspace 选择。"
		});
	}

	const lspAvailable: boolean | null = getEndpointAvailability(diagnosticsStatus.lsp);
	const lspLastError: string | null = getEndpointLastError(diagnosticsStatus.lsp);
	if (lspAvailable === false && lspLastError !== null) {
		warnings.push({
			code: "lsp_unavailable",
			message: `Godot LSP 最近探测失败：${lspLastError}`
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

