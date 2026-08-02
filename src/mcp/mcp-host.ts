import {
	buildGlobalMcpServerConfigs,
	buildMcpServerConfigs,
	getSourceScopedServerId,
	TERMINAL_MCP_SERVER_ID
} from "./mcp-config.js";
import { buildCustomMcpServerConfigs } from "./custom-mcp-config-store.js";
import { GODOT_DIAGNOSTICS_SERVER_ID, GodotDiagnosticsBridge } from "./godot/bridges/diagnostics-bridge.js";
import { GODOT_EDITOR_SERVER_ID, GodotEditorBridge } from "./godot/bridges/editor-bridge.js";
import { McpSession } from "./mcp-session.js";
import type { McpServerConfig } from "./types.js";
import {
	createSourceScopedWorkspace,
	findContainingWorkspaceSourceFolder,
	findWorkspace,
	getDefaultWorkspace,
	getWorkspaceSourceFolder
} from "../workspace/registry.js";
import type { WorkspaceConfig } from "../workspace/types.js";
import {
	clearDynamicMcpToolsForWorkspace,
	clearGlobalDynamicMcpTools,
	replaceDynamicMcpToolsForWorkspace,
	replaceGlobalDynamicMcpTools,
	type DynamicMcpToolSource
} from "../tools/dynamic-mcp-tools.js";
import { getCurrentMcpWorkspaceId } from "./request-context.js";
import { getApprovalMode } from "../approval-settings-store.js";
import type { TerminalCommandAuthorization } from "./terminal/authorization.js";
import { resolveEffectiveGodotExecutable } from "../godot-executable-resolver.js";
import { logger } from "../logger.js";
import {
	COMMAND_TIMEOUT_MS,
	findPreset,
	MAX_JOB_TIMEOUT_MS,
	MIN_JOB_TIMEOUT_MS,
	normalizeTimeoutMs,
	resolveDefaultCommandTimeoutMs
} from "./terminal/presets.js";

const CUSTOM_MCP_CONNECT_TIMEOUT_MS: number = 30_000;
const CUSTOM_MCP_LIST_TOOLS_TIMEOUT_MS: number = 10_000;
const CUSTOM_MCP_CLOSE_TIMEOUT_MS: number = 2_000;
const GLOBAL_CUSTOM_SCOPE_ID: string = "__global_custom_mcp__";
const TERMINAL_MCP_TIMEOUT_GRACE_MS: number = 30_000;

type McpToolListResult = {
	tools: Array<{
		name: string;
		description?: string | undefined;
		inputSchema?: unknown;
	}>;
};

export type CustomMcpServerRuntimeStatus = {
	id: string;
	status: "connected" | "error";
	toolCount: number;
	error?: string | undefined;
};

function customStatusKey(workspaceId: string, serverId: string): string {
	return `${workspaceId}\u0000${serverId}`;
}

function customStatusServerId(key: string): string {
	const separatorIndex: number = key.indexOf("\u0000");
	return separatorIndex === -1 ? key : key.slice(separatorIndex + 1);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timeout: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject): void => {
				timeout = setTimeout((): void => {
					reject(new Error(`${label} timed out after ${timeoutMs}ms`));
				}, timeoutMs);
			})
		]);
	} finally {
		if (timeout !== undefined) {
			clearTimeout(timeout);
		}
	}
}

export function resolveTerminalMcpRequestTimeoutMs(name: string, args: Record<string, unknown>): number | undefined {
	if (name !== "run_command" && name !== "run_safe_preset" && name !== "run_write_preset") return undefined;
	if (args.executionMode === "job") return undefined;
	const requestedTimeout = typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)
		? Math.floor(args.timeoutMs)
		: undefined;
	let commandTimeout: number;
	if (
		(name === "run_safe_preset" || name === "run_write_preset")
		&& typeof args.presetName === "string"
	) {
		try {
			commandTimeout = normalizeTimeoutMs(requestedTimeout, findPreset(args.presetName), COMMAND_TIMEOUT_MS);
		} catch {
			commandTimeout = requestedTimeout ?? COMMAND_TIMEOUT_MS;
		}
	} else {
		commandTimeout = requestedTimeout ?? resolveDefaultCommandTimeoutMs(typeof args.commandLine === "string" ? args.commandLine : undefined);
	}
	commandTimeout = Math.max(MIN_JOB_TIMEOUT_MS, Math.min(MAX_JOB_TIMEOUT_MS, commandTimeout));
	return commandTimeout + TERMINAL_MCP_TIMEOUT_GRACE_MS;
}

export class McpHost {
	private workspaceSessions: Map<string, Map<string, McpSession>> = new Map();
	private workspaceCustomTools: Map<string, Map<string, DynamicMcpToolSource[]>> = new Map();
	private globalInternalSessions: Map<string, McpSession> = new Map();
	private globalCustomSessions: Map<string, McpSession> = new Map();
	private globalCustomTools: Map<string, DynamicMcpToolSource[]> = new Map();
	private customServerStatuses: Map<string, CustomMcpServerRuntimeStatus> = new Map();
	private workspaceInitializations: Map<string, Promise<void>> = new Map();
	private globalInternalInitialization?: Promise<void> | undefined;
	private globalInternalInitialized: boolean = false;
	private globalCustomInitialization?: Promise<void> | undefined;
	private globalCustomInitialized: boolean = false;
	private activeWorkspaceId?: string | undefined;
	private readonly editorBridge: GodotEditorBridge = new GodotEditorBridge();
	private readonly diagnosticsBridge: GodotDiagnosticsBridge = new GodotDiagnosticsBridge();

	async connectAll(): Promise<void> {
		await this.ensureGlobalInternalServers();
		await this.ensureGlobalCustomServers();

		if (process.env.MCP_AUTO_CONNECT !== "1") {
			logger.info("mcp", "lazy_workspace_startup");
			return;
		}

		const workspace: WorkspaceConfig | undefined = getDefaultWorkspace();
		if (!workspace) {
			logger.warn("mcp", "default_workspace_missing");
			return;
		}

		await this.switchWorkspace(workspace);
	}

	async switchWorkspace(workspace: WorkspaceConfig): Promise<void> {
		await this.ensureWorkspace(workspace);
		this.activeWorkspaceId = workspace.id;
		this.diagnosticsBridge.setWorkspace(workspace);
		logger.info("mcp", "active_workspace_selected", {
			workspaceId: workspace.id,
			rootPath: workspace.rootPath
		});
	}

	async ensureWorkspace(workspace: WorkspaceConfig): Promise<void> {
		if (this.workspaceSessions.has(workspace.id)) {
			return;
		}
		const pendingInitialization: Promise<void> | undefined = this.workspaceInitializations.get(workspace.id);
		if (pendingInitialization !== undefined) {
			await pendingInitialization;
			return;
		}

		const initialization: Promise<void> = this.initializeWorkspace(workspace);
		this.workspaceInitializations.set(workspace.id, initialization);
		try {
			await initialization;
		} finally {
			if (this.workspaceInitializations.get(workspace.id) === initialization) {
				this.workspaceInitializations.delete(workspace.id);
			}
		}
	}

	private async initializeWorkspace(workspace: WorkspaceConfig): Promise<void> {
		const effectiveGodot = await resolveEffectiveGodotExecutable(workspace.godotExecutablePath);
		const configs: McpServerConfig[] = [
			...buildMcpServerConfigs(workspace, effectiveGodot.path)
		];
		if (configs.length === 0) {
			throw new Error(`MCP workspace has no project path: ${workspace.id}`);
		}

		const sessions: Map<string, McpSession> = new Map();

		try {
			for (const config of configs) {
				const session: McpSession = new McpSession(config);
				try {
					await this.connectSession(config, session);
					if (config.custom === true) {
						await this.cacheCustomServerTools(workspace.id, config, session);
					}
					sessions.set(config.id, session);
					logger.info("mcp", "session_connected", {
						workspaceId: workspace.id,
						serverId: config.id,
						serverName: config.name,
						custom: config.custom === true
					});
				} catch (error: unknown) {
					if (config.custom === true) {
						await this.closeCustomSessionQuietly(session);
						this.setCustomServerError(workspace.id, config.id, error);
						logger.warn("mcp", "custom_session_failed", {
							workspaceId: workspace.id,
							serverId: config.id,
							serverName: config.name,
							error: error instanceof Error ? error.message : error
						});
						continue;
					}

					await session.close().catch((): void => undefined);
					throw error;
				}
			}
		} catch (error: unknown) {
			for (const session of sessions.values()) {
				await session.close().catch((): void => undefined);
			}

			throw error;
		}

		this.workspaceSessions.set(workspace.id, sessions);
		this.syncDynamicToolsForWorkspace(workspace.id);
	}

	private async connectSession(config: McpServerConfig, session: McpSession): Promise<void> {
		if (config.custom === true) {
			await withTimeout(
				session.connect(),
				CUSTOM_MCP_CONNECT_TIMEOUT_MS,
				`Custom MCP "${config.name}" connect`
			);
			return;
		}

		await session.connect();
	}

	private async closeCustomSessionQuietly(session: McpSession): Promise<void> {
		await withTimeout(
			session.close(),
			CUSTOM_MCP_CLOSE_TIMEOUT_MS,
			`Custom MCP "${session.name}" close`
		).catch((): void => undefined);
	}

	private async cacheCustomServerTools(workspaceId: string, config: McpServerConfig, session: McpSession): Promise<void> {
		const toolsResult: McpToolListResult = await withTimeout(
			session.listTools(),
			CUSTOM_MCP_LIST_TOOLS_TIMEOUT_MS,
			`Custom MCP "${config.name}" listTools`
		) as McpToolListResult;
		const toolSources: DynamicMcpToolSource[] = toolsResult.tools.map((tool): DynamicMcpToolSource => ({
			serverId: config.id,
			serverName: config.name,
			toolName: tool.name,
			description: tool.description,
			inputSchema: tool.inputSchema,
			planAccess: config.planAccess ?? "disabled"
		}));

		let workspaceTools: Map<string, DynamicMcpToolSource[]> | undefined = this.workspaceCustomTools.get(workspaceId);
		if (workspaceTools === undefined) {
			workspaceTools = new Map();
			this.workspaceCustomTools.set(workspaceId, workspaceTools);
		}
		workspaceTools.set(config.id, toolSources);
		this.customServerStatuses.set(customStatusKey(workspaceId, config.id), {
			id: config.id,
			status: "connected",
			toolCount: toolSources.length
		});
		logger.info("mcp", "custom_tools_cached", {
			workspaceId,
			serverId: config.id,
			serverName: config.name,
			toolCount: toolSources.length
		});
	}

	private setCustomServerError(workspaceId: string, serverId: string, error: unknown): void {
		this.customServerStatuses.set(customStatusKey(workspaceId, serverId), {
			id: serverId,
			status: "error",
			toolCount: 0,
			error: error instanceof Error ? error.message : "Custom MCP server failed"
		});
	}

	private syncDynamicToolsForWorkspace(workspaceId: string): void {
		const workspaceTools: Map<string, DynamicMcpToolSource[]> | undefined = this.workspaceCustomTools.get(workspaceId);
		replaceDynamicMcpToolsForWorkspace(workspaceId, workspaceTools === undefined ? [] : Array.from(workspaceTools.values()).flat());
	}

	private syncGlobalDynamicTools(): void {
		replaceGlobalDynamicMcpTools(Array.from(this.globalCustomTools.values()).flat());
	}

	async ensureGlobalInternalServers(): Promise<void> {
		if (this.globalInternalInitialized) {
			return;
		}
		if (this.globalInternalInitialization !== undefined) {
			await this.globalInternalInitialization;
			return;
		}

		this.globalInternalInitialization = this.initializeGlobalInternalServers();
		try {
			await this.globalInternalInitialization;
		} finally {
			this.globalInternalInitialization = undefined;
		}
	}

	private async initializeGlobalInternalServers(): Promise<void> {
		const sessions: Map<string, McpSession> = new Map();

		try {
			const effectiveGodot = await resolveEffectiveGodotExecutable();
			for (const config of buildGlobalMcpServerConfigs(effectiveGodot.path)) {
				const session: McpSession = new McpSession(config);
				await this.connectSession(config, session);
				sessions.set(config.id, session);
				logger.info("mcp", "global_internal_session_connected", {
					serverId: config.id,
					serverName: config.name
				});
			}
		} catch (error: unknown) {
			for (const session of sessions.values()) {
				await session.close().catch((): void => undefined);
			}

			throw error;
		}

		this.globalInternalSessions = sessions;
		this.globalInternalInitialized = true;
	}

	async refreshGodotExecutableConfiguration(): Promise<void> {
		const activeWorkspaceId: string | undefined = this.activeWorkspaceId;
		const workspaceIds: string[] = Array.from(this.workspaceSessions.keys());
		for (const session of this.globalInternalSessions.values()) {
			await session.close();
		}
		this.globalInternalSessions.clear();
		this.globalInternalInitialized = false;

		for (const workspaceId of workspaceIds) {
			const sessions: Map<string, McpSession> | undefined = this.workspaceSessions.get(workspaceId);
			if (sessions !== undefined) {
				for (const session of sessions.values()) {
					await session.close();
				}
			}
			this.workspaceSessions.delete(workspaceId);
			const workspace: WorkspaceConfig | undefined = findWorkspace(workspaceId);
			if (workspace !== undefined) {
				await this.ensureWorkspace(workspace);
			}
		}
		await this.ensureGlobalInternalServers();
		if (activeWorkspaceId !== undefined) {
			const activeWorkspace: WorkspaceConfig | undefined = findWorkspace(activeWorkspaceId);
			if (activeWorkspace !== undefined) {
				this.activeWorkspaceId = activeWorkspaceId;
				this.diagnosticsBridge.setWorkspace(activeWorkspace);
			}
		}
	}

	async ensureGlobalCustomServers(): Promise<void> {
		if (this.globalCustomInitialized) {
			return;
		}
		if (this.globalCustomInitialization !== undefined) {
			await this.globalCustomInitialization;
			return;
		}

		this.globalCustomInitialization = this.refreshGlobalCustomServers();
		try {
			await this.globalCustomInitialization;
		} finally {
			this.globalCustomInitialization = undefined;
		}
	}

	async refreshGlobalCustomServers(): Promise<void> {
		for (const session of this.globalCustomSessions.values()) {
			await this.closeCustomSessionQuietly(session);
		}

		this.globalCustomSessions.clear();
		this.globalCustomTools.clear();
		for (const statusKey of Array.from(this.customServerStatuses.keys())) {
			if (statusKey.startsWith(`${GLOBAL_CUSTOM_SCOPE_ID}\u0000`)) {
				this.customServerStatuses.delete(statusKey);
			}
		}

		const customConfigs: McpServerConfig[] = await buildCustomMcpServerConfigs();
		for (const config of customConfigs) {
			const session: McpSession = new McpSession(config);
			try {
				await this.connectSession(config, session);
				await this.cacheGlobalCustomServerTools(config, session);
				this.globalCustomSessions.set(config.id, session);
				logger.info("mcp", "global_custom_session_connected", {
					serverId: config.id,
					serverName: config.name
				});
			} catch (error: unknown) {
				await this.closeCustomSessionQuietly(session);
				this.setCustomServerError(GLOBAL_CUSTOM_SCOPE_ID, config.id, error);
				logger.warn("mcp", "global_custom_session_failed", {
					serverId: config.id,
					serverName: config.name,
					error: error instanceof Error ? error.message : error
				});
			}
		}

		this.syncGlobalDynamicTools();
		this.globalCustomInitialized = true;
	}

	private async cacheGlobalCustomServerTools(config: McpServerConfig, session: McpSession): Promise<void> {
		const toolsResult: McpToolListResult = await withTimeout(
			session.listTools(),
			CUSTOM_MCP_LIST_TOOLS_TIMEOUT_MS,
			`Custom MCP "${config.name}" listTools`
		) as McpToolListResult;
		const toolSources: DynamicMcpToolSource[] = toolsResult.tools.map((tool): DynamicMcpToolSource => ({
			serverId: config.id,
			serverName: config.name,
			toolName: tool.name,
			description: tool.description,
			inputSchema: tool.inputSchema,
			planAccess: config.planAccess ?? "disabled"
		}));

		this.globalCustomTools.set(config.id, toolSources);
		this.customServerStatuses.set(customStatusKey(GLOBAL_CUSTOM_SCOPE_ID, config.id), {
			id: config.id,
			status: "connected",
			toolCount: toolSources.length
		});
		logger.info("mcp", "global_custom_tools_cached", {
			serverId: config.id,
			serverName: config.name,
			toolCount: toolSources.length
		});
	}

	async refreshCustomServersForActiveWorkspace(): Promise<void> {
		await this.refreshGlobalCustomServers();
	}

	async refreshCustomServersForWorkspace(_workspaceId: string): Promise<void> {
		await this.refreshGlobalCustomServers();
	}

	private getWorkspaceId(workspaceId?: string | undefined): string {
		const resolvedWorkspaceId: string | undefined = workspaceId ?? getCurrentMcpWorkspaceId() ?? this.activeWorkspaceId;
		if (resolvedWorkspaceId === undefined) {
			throw new Error("MCP workspace is not selected");
		}

		return resolvedWorkspaceId;
	}

	private selectDiagnosticsWorkspace(workspaceId?: string | undefined): WorkspaceConfig {
		const resolvedWorkspaceId: string = this.getWorkspaceId(workspaceId);
		const workspace: WorkspaceConfig | undefined = findWorkspace(resolvedWorkspaceId);
		if (workspace === undefined) {
			throw new Error(`MCP workspace is not registered: ${resolvedWorkspaceId}`);
		}

		this.diagnosticsBridge.setWorkspace(workspace);
		return workspace;
	}

	private getActiveSessions(workspaceId?: string | undefined): Map<string, McpSession> {
		const resolvedWorkspaceId: string = this.getWorkspaceId(workspaceId);
		const sessions: Map<string, McpSession> | undefined = this.workspaceSessions.get(resolvedWorkspaceId);
		if (!sessions) {
			throw new Error(`MCP workspace is not connected: ${resolvedWorkspaceId}`);
		}

		return sessions;
	}

	async closeWorkspace(workspaceId: string): Promise<void> {
		const sessions: Map<string, McpSession> | undefined = this.workspaceSessions.get(workspaceId);
		if (!sessions) {
			return;
		}

		for (const session of sessions.values()) {
			await session.close();
		}

		this.workspaceSessions.delete(workspaceId);
		this.workspaceCustomTools.delete(workspaceId);
		clearDynamicMcpToolsForWorkspace(workspaceId);

		if (this.activeWorkspaceId === workspaceId) {
			this.activeWorkspaceId = undefined;
			this.diagnosticsBridge.clearWorkspace(workspaceId);
		}
	}

	getActiveWorkspaceId(): string | undefined {
		return getCurrentMcpWorkspaceId() ?? this.activeWorkspaceId;
	}

	getEditorBridge(): GodotEditorBridge {
		return this.editorBridge;
	}

	getDiagnosticsBridge(): GodotDiagnosticsBridge {
		return this.diagnosticsBridge;
	}

	getSession(id: string, workspaceId?: string | undefined): McpSession {
		const resolvedWorkspaceId: string | undefined = workspaceId ?? getCurrentMcpWorkspaceId() ?? this.activeWorkspaceId;
		if (resolvedWorkspaceId !== undefined) {
			const workspaceSession: McpSession | undefined = this.workspaceSessions.get(resolvedWorkspaceId)?.get(id);
			if (workspaceSession !== undefined) {
				return workspaceSession;
			}
		}

		const globalInternalSession: McpSession | undefined = this.globalInternalSessions.get(id);
		if (globalInternalSession !== undefined) {
			return globalInternalSession;
		}

		const globalCustomSession: McpSession | undefined = this.globalCustomSessions.get(id);
		if (globalCustomSession !== undefined) {
			return globalCustomSession;
		}

		if (resolvedWorkspaceId === undefined) {
			throw new Error("MCP workspace is not selected");
		}

		const session: McpSession | undefined = this.getActiveSessions(resolvedWorkspaceId).get(id);

		if (!session) {
			throw new Error(`MCP session not found in workspace ${resolvedWorkspaceId}: ${id}`);
		}

		return session;
	}

	getConnectedServerIds(workspaceId?: string | undefined): string[] {
		const globalInternalServerIds: string[] = Array.from(this.globalInternalSessions.keys());
		const globalCustomServerIds: string[] = Array.from(this.globalCustomSessions.keys());
		const resolvedWorkspaceId: string | undefined = workspaceId ?? getCurrentMcpWorkspaceId() ?? this.activeWorkspaceId;
		if (!resolvedWorkspaceId) {
			const serverIds: string[] = [...globalInternalServerIds, ...globalCustomServerIds];
			if (this.editorBridge.isOnline()) {
				serverIds.push(GODOT_EDITOR_SERVER_ID);
			}
			return serverIds.sort();
		}

		const sessions: Map<string, McpSession> | undefined = this.workspaceSessions.get(resolvedWorkspaceId);
		if (!sessions) {
			const serverIds: string[] = [...globalInternalServerIds, ...globalCustomServerIds];
			if (this.editorBridge.isOnline(resolvedWorkspaceId)) {
				serverIds.push(GODOT_EDITOR_SERVER_ID);
			}
			return serverIds.sort();
		}

		const serverIds: string[] = [...globalInternalServerIds, ...globalCustomServerIds, ...Array.from(sessions.keys())];
		serverIds.push(GODOT_DIAGNOSTICS_SERVER_ID);
		if (this.editorBridge.isOnline(resolvedWorkspaceId)) {
			serverIds.push(GODOT_EDITOR_SERVER_ID);
		}
		return serverIds.sort();
	}

	getConnectedWorkspaceIds(): string[] {
		return Array.from(this.workspaceSessions.keys()).sort();
	}

	getCustomServerStatuses(): CustomMcpServerRuntimeStatus[] {
		return this.getCustomServerStatusesForWorkspace(undefined);
	}

	getCustomServerStatusesForWorkspace(workspaceId?: string | undefined): CustomMcpServerRuntimeStatus[] {
		const resolvedWorkspaceId: string | undefined = workspaceId ?? getCurrentMcpWorkspaceId() ?? this.activeWorkspaceId;
		if (resolvedWorkspaceId === undefined) {
			const globalStatusPrefix: string = `${GLOBAL_CUSTOM_SCOPE_ID}\u0000`;
			return Array.from(this.customServerStatuses.entries())
				.filter(([key]: [string, CustomMcpServerRuntimeStatus]): boolean => key.startsWith(globalStatusPrefix))
				.map(([_key, status]: [string, CustomMcpServerRuntimeStatus]): CustomMcpServerRuntimeStatus => status);
		}

		const workspaceStatusPrefix: string = `${resolvedWorkspaceId}\u0000`;
		return Array.from(this.customServerStatuses.entries())
			.filter(([key]: [string, CustomMcpServerRuntimeStatus]): boolean => key.startsWith(workspaceStatusPrefix) || key.startsWith(`${GLOBAL_CUSTOM_SCOPE_ID}\u0000`))
			.map(([_key, status]: [string, CustomMcpServerRuntimeStatus]): CustomMcpServerRuntimeStatus => status);
	}

	private async createTerminalArgs(
		args: Record<string, unknown>,
		workspaceId?: string | undefined,
		commandAuthorization?: TerminalCommandAuthorization | undefined
	): Promise<Record<string, unknown>> {
		const resolvedWorkspaceId: string | undefined = workspaceId ?? getCurrentMcpWorkspaceId() ?? this.activeWorkspaceId;
		const approvalMode = await getApprovalMode();
		if (resolvedWorkspaceId === undefined) {
			return {
				...args,
				__daedalusApprovalMode: approvalMode,
				__daedalusCommandAuthorization: commandAuthorization
			};
		}
		const workspace: WorkspaceConfig | undefined = findWorkspace(resolvedWorkspaceId);
		let sourceFolderId: string | undefined = typeof args.sourceFolderId === "string"
			? args.sourceFolderId
			: undefined;
		if (workspace !== undefined) {
			const requestedCwd: string | undefined = typeof args.cwd === "string" ? args.cwd.trim() : undefined;
			if (sourceFolderId === undefined && requestedCwd !== undefined && requestedCwd.length > 0) {
				sourceFolderId = findContainingWorkspaceSourceFolder(workspace, requestedCwd)?.id;
			}
			getWorkspaceSourceFolder(workspace, sourceFolderId);
		}

		return {
			...args,
			__daedalusWorkspaceId: resolvedWorkspaceId,
			__daedalusSourceFolderId: sourceFolderId,
			__daedalusApprovalMode: approvalMode,
			__daedalusCommandAuthorization: commandAuthorization
		};
	}

	async listTools(serverId: string, workspaceId?: string | undefined) {
		if (serverId === TERMINAL_MCP_SERVER_ID) {
			await this.ensureGlobalInternalServers();
		}

		if (serverId === GODOT_EDITOR_SERVER_ID) {
			return this.editorBridge.listTools();
		}

		if (serverId === GODOT_DIAGNOSTICS_SERVER_ID) {
			return this.diagnosticsBridge.listTools();
		}

		return this.getSession(serverId, workspaceId).listTools();
	}

	async callTool(
		serverId: string,
		name: string,
		args: Record<string, unknown>,
		workspaceId?: string | undefined,
		editorInstanceId?: string | undefined,
		commandAuthorization?: TerminalCommandAuthorization | undefined,
		abortSignal?: AbortSignal | undefined
	) {
		const sourceFolderId: string | undefined = typeof args.sourceFolderId === "string"
			? args.sourceFolderId
			: undefined;
		if (serverId === TERMINAL_MCP_SERVER_ID) {
			await this.ensureGlobalInternalServers();
			return this.getSession(serverId, workspaceId).callTool(
				name,
				await this.createTerminalArgs(args, workspaceId, commandAuthorization),
				{
					signal: abortSignal,
					timeoutMs: resolveTerminalMcpRequestTimeoutMs(name, args)
				}
			);
		}

		if (serverId === GODOT_EDITOR_SERVER_ID) {
			const workspace: WorkspaceConfig | undefined = workspaceId === undefined ? undefined : findWorkspace(workspaceId);
			const routedWorkspaceId: string | undefined = workspace === undefined
				? workspaceId
				: createSourceScopedWorkspace(workspace, sourceFolderId).id;
			const forwardedArgs: Record<string, unknown> = { ...args };
			delete forwardedArgs.sourceFolderId;
			return this.editorBridge.callTool(name, forwardedArgs, routedWorkspaceId, editorInstanceId);
		}

		if (serverId === GODOT_DIAGNOSTICS_SERVER_ID) {
			const workspace: WorkspaceConfig = this.selectDiagnosticsWorkspace(workspaceId);
			this.diagnosticsBridge.setWorkspace(createSourceScopedWorkspace(workspace, sourceFolderId));
			const forwardedArgs: Record<string, unknown> = { ...args };
			delete forwardedArgs.sourceFolderId;
			return this.diagnosticsBridge.callTool(name, forwardedArgs);
		}

		const resolvedWorkspaceId: string | undefined = workspaceId ?? getCurrentMcpWorkspaceId() ?? this.activeWorkspaceId;
		const workspace: WorkspaceConfig | undefined = resolvedWorkspaceId === undefined
			? undefined
			: findWorkspace(resolvedWorkspaceId);
		const forwardedArgs: Record<string, unknown> = { ...args };
		delete forwardedArgs.sourceFolderId;
		const sourceScoped: boolean = serverId === "workspace" || serverId === "godot" || serverId === "skills";
		const routedServerId: string = workspace === undefined || !sourceScoped
			? serverId
			: getSourceScopedServerId(serverId, workspace, getWorkspaceSourceFolder(workspace, sourceFolderId).id);
		return this.getSession(routedServerId, workspaceId).callTool(name, forwardedArgs, { signal: abortSignal });
	}

	async listResources(serverId: string, workspaceId?: string | undefined) {
		if (serverId === TERMINAL_MCP_SERVER_ID) {
			await this.ensureGlobalInternalServers();
		}

		if (serverId === GODOT_EDITOR_SERVER_ID) {
			return this.editorBridge.listResources();
		}

		if (serverId === GODOT_DIAGNOSTICS_SERVER_ID) {
			this.selectDiagnosticsWorkspace(workspaceId);
			return this.diagnosticsBridge.listResources();
		}

		return this.getSession(serverId, workspaceId).listResources();
	}

	async readResource(serverId: string, uri: string, workspaceId?: string | undefined) {
		if (serverId === TERMINAL_MCP_SERVER_ID) {
			await this.ensureGlobalInternalServers();
		}

		if (serverId === GODOT_EDITOR_SERVER_ID) {
			return this.editorBridge.readResource(uri);
		}

		if (serverId === GODOT_DIAGNOSTICS_SERVER_ID) {
			this.selectDiagnosticsWorkspace(workspaceId);
			return this.diagnosticsBridge.readResource(uri);
		}

		return this.getSession(serverId, workspaceId).readResource(uri);
	}

	async closeAll(): Promise<void> {
		for (const session of this.globalInternalSessions.values()) {
			await session.close();
		}

		for (const session of this.globalCustomSessions.values()) {
			await session.close();
		}

		for (const sessions of this.workspaceSessions.values()) {
			for (const session of sessions.values()) {
				await session.close();
			}
		}

		this.globalInternalSessions.clear();
		this.globalCustomSessions.clear();
		this.globalCustomTools.clear();
		this.workspaceSessions.clear();
		this.workspaceCustomTools.clear();
		this.customServerStatuses.clear();
		clearGlobalDynamicMcpTools();
		this.activeWorkspaceId = undefined;
		this.globalInternalInitialized = false;
		this.globalCustomInitialized = false;
		this.diagnosticsBridge.clearWorkspace();
	}
}
