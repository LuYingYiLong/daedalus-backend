import {
	buildGlobalMcpServerConfigs,
	buildMcpServerConfigs,
	GODOT_DOCUMENTATION_MCP_SERVER_ID,
	getSourceScopedServerId,
	TERMINAL_MCP_SERVER_ID
} from "./mcp-config.js";
import * as path from "node:path";
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
	describeWorkspaceSource,
	formatWorkspaceFileRef,
	isWorkspaceSourceAvailable,
	resolveWorkspaceReadSource,
	resolveWorkspaceSources,
	resolveWorkspaceTerminalSource,
	WorkspaceSourceResolutionError,
	type WorkspaceScope,
	type WorkspaceSourceOperation
} from "../workspace/source-context.js";
import { WorkspaceSourceIndex } from "../workspace/source-index.js";
import { readWorkspaceGitHistory } from "../workspace/git-history.js";
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
import type { McpProgressNotification } from "./terminal/progress.js";
import { resolveEffectiveGodotExecutable } from "../godot-executable-resolver.js";
import { readGodotProjectFeatureVersion } from "../godot-documentation/project-version.js";
import { logger } from "../logger.js";
import {
	COMMAND_TIMEOUT_MS,
	findPreset,
	MAX_JOB_TIMEOUT_MS,
	MIN_JOB_TIMEOUT_MS,
	normalizeTimeoutMs,
	resolveDefaultCommandTimeoutMs,
	presetRequiresWorkspaceSource
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

type McpTextResult = {
	content?: Array<{ type?: unknown; text?: unknown }>;
	[key: string]: unknown;
};

function createTextToolResult(value: unknown, isError: boolean = false): McpTextResult {
	return {
		...(isError ? { isError: true } : {}),
		content: [{ type: "text", text: JSON.stringify(value) }]
	};
}

function createSourceErrorResult(error: WorkspaceSourceResolutionError): McpTextResult {
	return createTextToolResult({
		ok: false,
		code: error.code,
		workspaceId: error.workspaceId,
		message: error.message,
		candidates: error.candidates
	}, true);
}

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
	private readonly sourceIndex: WorkspaceSourceIndex = new WorkspaceSourceIndex();

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

	private async restartGlobalInternalServer(serverId: string): Promise<void> {
		const current: McpSession | undefined = this.globalInternalSessions.get(serverId);
		this.globalInternalSessions.delete(serverId);
		await current?.close().catch((): void => undefined);
		const effectiveGodot = await resolveEffectiveGodotExecutable();
		const config = buildGlobalMcpServerConfigs(effectiveGodot.path).find((candidate): boolean => candidate.id === serverId);
		if (config === undefined) throw new Error(`Unknown global internal MCP server: ${serverId}`);
		const session = new McpSession(config);
		await this.connectSession(config, session);
		this.globalInternalSessions.set(serverId, session);
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

	private async callWorkspaceIndexedTool(
		name: "list_files" | "search_text",
		args: Record<string, unknown>,
		workspace: WorkspaceConfig
	): Promise<McpTextResult> {
		const sourceFolderId: string | undefined = typeof args.sourceFolderId === "string" ? args.sourceFolderId : undefined;
		const scope: WorkspaceScope | undefined = typeof args.scope === "string" ? args.scope as WorkspaceScope : undefined;
		const selection = resolveWorkspaceSources(workspace, {
			sourceFolderId,
			scope,
			operation: name === "list_files" ? "list" : "search"
		});
		const forwardedArgs: Record<string, unknown> = { ...args };
		delete forwardedArgs.sourceFolderId;
		delete forwardedArgs.scope;
		delete forwardedArgs.continuationToken;
		const sources = selection.kind === "source" ? [selection.source] : selection.sources;
		const requestedLimit: number = typeof args.limit === "number" && Number.isFinite(args.limit)
			? Math.max(1, Math.floor(args.limit))
			: name === "list_files" ? 200 : 50;
		const globalLimit: number = name === "list_files"
			? Math.min(requestedLimit, 500)
			: Math.min(requestedLimit, 500);
		const continuationToken: string | undefined = typeof args.continuationToken === "string" ? args.continuationToken : undefined;
		const offset: number = continuationToken?.startsWith("offset:")
			? Math.max(0, Number.parseInt(continuationToken.slice("offset:".length), 10) || 0)
			: 0;
		const perSourceLimit: number = globalLimit + offset + 1;
		const sourceResults = await Promise.all(sources.map(async (source) => {
			if (!isWorkspaceSourceAvailable(source)) {
				return {
					source,
					warning: `source_unavailable: Source folder is unavailable: ${source.id}`
				};
			}
			try {
				if (name === "list_files") {
					const listed = await this.sourceIndex.listSourceFiles(workspace, source, {
						subdir: typeof forwardedArgs.subdir === "string" ? forwardedArgs.subdir : undefined,
						extensions: Array.isArray(forwardedArgs.extensions) ? forwardedArgs.extensions.filter((value): value is string => typeof value === "string") : undefined,
						includeIgnored: forwardedArgs.includeIgnored === true,
						limit: perSourceLimit
					});
					return { source, listed, warning: undefined };
				}
				const searched = await this.sourceIndex.searchSource(workspace, source, {
					query: typeof forwardedArgs.query === "string" ? forwardedArgs.query : "",
					extensions: Array.isArray(forwardedArgs.extensions) ? forwardedArgs.extensions.filter((value): value is string => typeof value === "string") : undefined,
					limit: perSourceLimit,
					subdir: typeof forwardedArgs.subdir === "string" ? forwardedArgs.subdir : undefined
				});
				return { source, searched, warning: undefined };
			} catch (error: unknown) {
				return {
					source,
					warning: error instanceof Error ? error.message : "Source folder could not be accessed."
				};
			}
		}));
		const warnings = sourceResults
			.filter((result): result is typeof result & { warning: string } => typeof result.warning === "string")
			.map((result) => ({
				sourceFolderId: result.source.id,
				sourceName: describeWorkspaceSource(result.source).sourceName,
				warning: result.warning
			}));
		if (name === "list_files") {
			const files = sourceResults.flatMap((result) => "listed" in result && result.listed !== undefined
				? result.listed.files
				: []);
			files.sort((left, right) => left.sourceFolderId.localeCompare(right.sourceFolderId) || left.file.localeCompare(right.file));
			const limited = files.slice(offset, offset + globalLimit);
			return createTextToolResult({
				files: limited.map((file) => file.file),
				fileRefs: limited.map((file) => formatWorkspaceFileRef(file.fileRef)),
				scope: selection.kind === "all" ? "all" : "source",
				directoryExists: sourceResults.some((result) => "listed" in result && result.listed?.directoryExists === true),
				sources: sources.map((source) => ({ sourceFolderId: source.id, sourceName: describeWorkspaceSource(source).sourceName })),
				warnings,
				...(files.length > offset + globalLimit ? { continuationToken: `offset:${offset + globalLimit}` } : {})
			});
		}
		const matches = sourceResults.flatMap((result) => "searched" in result && result.searched !== undefined ? result.searched : []);
		matches.sort((left, right) => left.sourceFolderId.localeCompare(right.sourceFolderId) || left.file.localeCompare(right.file) || left.line - right.line);
		const limitedMatches = matches.slice(offset, offset + globalLimit);
		return createTextToolResult({
			matches: limitedMatches.map((match) => ({
				file: match.file,
				line: match.line,
				text: match.text,
				sourceFolderId: match.sourceFolderId,
				sourceName: match.sourceName,
				fileRef: formatWorkspaceFileRef(match.fileRef)
			})),
			scope: selection.kind === "all" ? "all" : "source",
			warnings,
			...(matches.length > offset + globalLimit ? { continuationToken: `offset:${offset + globalLimit}` } : {})
		});
	}

	private async callWorkspaceGitHistoryTool(
		args: Record<string, unknown>,
		workspace: WorkspaceConfig,
		abortSignal?: AbortSignal | undefined
	): Promise<McpTextResult> {
		const sourceFolderId: string | undefined = typeof args.sourceFolderId === "string" ? args.sourceFolderId : undefined;
		const selection = resolveWorkspaceSources(workspace, {
			sourceFolderId,
			operation: "read"
		});
		if (selection.kind !== "source") {
			throw new Error("source_required: Git history requires one source folder.");
		}
		if (typeof args.fromRef !== "string" || args.fromRef.trim().length === 0) {
			throw new Error("fromRef is required for Git history.");
		}
		const result = await readWorkspaceGitHistory({
			cwd: selection.source.path,
			fromRef: args.fromRef,
			toRef: typeof args.toRef === "string" ? args.toRef : undefined,
			limit: typeof args.limit === "number" && Number.isFinite(args.limit) ? args.limit : undefined,
			signal: abortSignal
		});
		return createTextToolResult({
			...result,
			sourceFolderId: selection.source.id,
			sourceName: describeWorkspaceSource(selection.source).sourceName
		}, !result.ok);
	}

	private callWorkspaceSourceContextTool(name: "list_source_folders" | "get_source_context", workspace: WorkspaceConfig): McpTextResult {
		const sources = workspace.sourceFolders.map((source) => describeWorkspaceSource(source));
		return createTextToolResult({
			workspaceId: workspace.id,
			workspaceName: workspace.name,
			primarySourceFolderId: workspace.primarySourceFolderId,
			sources,
			...(name === "list_source_folders" ? {} : { kind: workspace.kind })
		});
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
		commandAuthorization?: TerminalCommandAuthorization | undefined,
		toolName?: string | undefined
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
			const requestedWorkingDirectory: string | undefined = typeof args.workingDirectory === "string"
				? args.workingDirectory.trim()
				: undefined;
			const presetName: string | undefined = typeof args.presetName === "string" ? args.presetName.trim() : undefined;
			const isPresetCall: boolean = toolName === "run_safe_preset" || toolName === "run_write_preset";
			const requiresWorkspaceSource: boolean = toolName === "run_command"
				|| (isPresetCall && presetName !== undefined && presetRequiresWorkspaceSource(presetName));
			const sourceSelection = requiresWorkspaceSource || sourceFolderId !== undefined
				? resolveWorkspaceTerminalSource(workspace, {
					sourceFolderId,
					pathHint: requestedCwd ?? requestedWorkingDirectory,
					presetName: isPresetCall ? presetName : undefined
				})
				: undefined;
			sourceFolderId = sourceSelection?.kind === "source" ? sourceSelection.source.id : sourceFolderId;
			const source = sourceSelection?.kind === "source"
				? sourceSelection.source
				: sourceFolderId === undefined ? undefined : getWorkspaceSourceFolder(workspace, sourceFolderId);
			if (requestedCwd !== undefined && requestedCwd.length > 0) {
				const candidateCwd: string = path.isAbsolute(requestedCwd)
					? path.resolve(requestedCwd)
					: source === undefined ? requestedCwd : path.resolve(source.path, requestedCwd);
				const cwdSource = findContainingWorkspaceSourceFolder(workspace, candidateCwd);
				if (source !== undefined && (cwdSource === undefined || cwdSource.id !== source.id)) {
					throw new WorkspaceSourceResolutionError(
						"source_boundary",
						workspace,
						"The terminal cwd must remain inside the selected source folder.",
						[describeWorkspaceSource(source)]
					);
				}
			}
		}

		return {
			...args,
			__daedalusWorkspaceId: resolvedWorkspaceId,
			__daedalusSourceFolderId: sourceFolderId,
			__daedalusApprovalMode: approvalMode,
			__daedalusCommandAuthorization: commandAuthorization
		};
	}

	private async createDocumentationArgs(
		args: Record<string, unknown>,
		workspaceId?: string | undefined
	): Promise<Record<string, unknown>> {
		const forwardedArgs: Record<string, unknown> = { ...args };
		const sourceFolderId: string | undefined = typeof forwardedArgs.sourceFolderId === "string"
			? forwardedArgs.sourceFolderId
			: undefined;
		delete forwardedArgs.sourceFolderId;

		const resolvedWorkspaceId: string | undefined = workspaceId ?? getCurrentMcpWorkspaceId() ?? this.activeWorkspaceId;
		const workspace: WorkspaceConfig | undefined = resolvedWorkspaceId === undefined
			? undefined
			: findWorkspace(resolvedWorkspaceId);
		if (workspace === undefined) {
			return forwardedArgs;
		}

		const sourceSelection = resolveWorkspaceSources(workspace, {
			sourceFolderId,
			operation: "read"
		});
		if (sourceSelection.kind !== "source") {
			throw new Error("source_required: documentation queries require one source folder.");
		}
		const sourceFolder = sourceSelection.source;
		const projectVersion: string | undefined = await readGodotProjectFeatureVersion(sourceFolder.path);
		return projectVersion === undefined
			? forwardedArgs
			: { ...forwardedArgs, __daedalusProjectVersion: projectVersion };
	}

	async listTools(serverId: string, workspaceId?: string | undefined) {
		if (serverId === TERMINAL_MCP_SERVER_ID || serverId === GODOT_DOCUMENTATION_MCP_SERVER_ID) {
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
		abortSignal?: AbortSignal | undefined,
		onProgress?: ((progress: McpProgressNotification) => void) | undefined
	) {
		const sourceFolderId: string | undefined = typeof args.sourceFolderId === "string"
			? args.sourceFolderId
			: undefined;
		if (serverId === TERMINAL_MCP_SERVER_ID || serverId === GODOT_DOCUMENTATION_MCP_SERVER_ID) {
			await this.ensureGlobalInternalServers();
		}
		if (serverId === GODOT_DOCUMENTATION_MCP_SERVER_ID) {
			const forwardedArgs = await this.createDocumentationArgs(args, workspaceId);
			try {
				return await this.getSession(serverId, workspaceId).callTool(
					name,
					forwardedArgs,
					{ signal: abortSignal, timeoutMs: 5_000 }
				);
			} catch (error: unknown) {
				const message: string = error instanceof Error ? error.message : String(error);
				if (/timed out|timeout/iu.test(message)) {
					throw new Error("documentation_query_timeout: Documentation query exceeded the 5 second limit.", { cause: error });
				}
				if (!/closed|not connected|transport|MCP session not found|connection/iu.test(message)) throw error;
				logger.warn("mcp", "documentation_transport_retry", { error: message });
				await this.restartGlobalInternalServer(serverId);
				return this.getSession(serverId, workspaceId).callTool(
					name,
					forwardedArgs,
					{ signal: abortSignal, timeoutMs: 5_000 }
				);
			}
		}
		if (serverId === TERMINAL_MCP_SERVER_ID) {
			try {
				const terminalArgs: Record<string, unknown> = await this.createTerminalArgs(args, workspaceId, commandAuthorization, name);
				return this.getSession(serverId, workspaceId).callTool(
					name,
					terminalArgs,
					{
						signal: abortSignal,
						timeoutMs: resolveTerminalMcpRequestTimeoutMs(name, args),
						onProgress
					}
				);
			} catch (error: unknown) {
				if (error instanceof WorkspaceSourceResolutionError) {
					return createSourceErrorResult(error);
				}
				throw error;
			}
		}

		if (serverId === GODOT_EDITOR_SERVER_ID) {
			const workspace: WorkspaceConfig | undefined = workspaceId === undefined ? undefined : findWorkspace(workspaceId);
			let routedWorkspaceId: string | undefined = workspaceId;
			if (workspace !== undefined) {
				const selection = resolveWorkspaceSources(workspace, { sourceFolderId, operation: "godot" });
				if (selection.kind !== "source") throw new Error("source_required: editor operations require one source folder.");
				routedWorkspaceId = createSourceScopedWorkspace(workspace, selection.source.id).id;
			}
			const forwardedArgs: Record<string, unknown> = { ...args };
			delete forwardedArgs.sourceFolderId;
			delete forwardedArgs.scope;
			return this.editorBridge.callTool(name, forwardedArgs, routedWorkspaceId, editorInstanceId);
		}

		if (serverId === GODOT_DIAGNOSTICS_SERVER_ID) {
			const workspace: WorkspaceConfig = this.selectDiagnosticsWorkspace(workspaceId);
			const selection = resolveWorkspaceSources(workspace, { sourceFolderId, operation: "godot" });
			if (selection.kind !== "source") throw new Error("source_required: diagnostics require one source folder.");
			this.diagnosticsBridge.setWorkspace(createSourceScopedWorkspace(workspace, selection.source.id));
			const forwardedArgs: Record<string, unknown> = { ...args };
			delete forwardedArgs.sourceFolderId;
			delete forwardedArgs.scope;
			return this.diagnosticsBridge.callTool(name, forwardedArgs);
		}

		const resolvedWorkspaceId: string | undefined = workspaceId ?? getCurrentMcpWorkspaceId() ?? this.activeWorkspaceId;
		const workspace: WorkspaceConfig | undefined = resolvedWorkspaceId === undefined
			? undefined
			: findWorkspace(resolvedWorkspaceId);
		if (serverId === "workspace" && workspace !== undefined) {
			try {
				if (name === "list_source_folders" || name === "get_source_context") {
					return this.callWorkspaceSourceContextTool(name, workspace);
				}
				if (name === "list_files" || name === "search_text") {
					return await this.callWorkspaceIndexedTool(name, args, workspace);
				}
				if (name === "get_git_history") {
					return await this.callWorkspaceGitHistoryTool(args, workspace, abortSignal);
				}
				if (name === "read_text_file") {
					const selection = resolveWorkspaceReadSource(workspace, String(args.relativePath ?? ""), {
						sourceFolderId,
						scope: typeof args.scope === "string" ? args.scope as WorkspaceScope : undefined
					});
					// 将唯一匹配结果回填到本次执行上下文，保证 evidence、ToolPart 和恢复日志使用同一文件身份。
					args.sourceFolderId = selection.source.id;
					const forwardedReadArgs: Record<string, unknown> = { ...args };
					delete forwardedReadArgs.sourceFolderId;
					delete forwardedReadArgs.scope;
					const routedServerId: string = getSourceScopedServerId("workspace", workspace, selection.source.id);
					return this.getSession(routedServerId, workspaceId).callTool(name, forwardedReadArgs, { signal: abortSignal });
				}
			} catch (error: unknown) {
				if (error instanceof WorkspaceSourceResolutionError) return createSourceErrorResult(error);
				throw error;
			}
		}
		const forwardedArgs: Record<string, unknown> = { ...args };
		delete forwardedArgs.sourceFolderId;
		delete forwardedArgs.scope;
		const sourceScoped: boolean = serverId === "workspace" || serverId === "godot" || serverId === "skills";
		let routedServerId: string = serverId;
		if (workspace !== undefined && sourceScoped) {
			const operation: WorkspaceSourceOperation = serverId === "godot"
				? "godot"
				: serverId === "skills" && name === "load" ? "read" : "write";
			const selection = resolveWorkspaceSources(workspace, { sourceFolderId, operation });
			if (selection.kind !== "source") {
				throw new Error("source_required: this operation requires one source folder.");
			}
			routedServerId = getSourceScopedServerId(serverId, workspace, selection.source.id);
		}
		const result = await this.getSession(routedServerId, workspaceId).callTool(name, forwardedArgs, { signal: abortSignal });
		if (workspace !== undefined && sourceScoped) {
			const routedSourceId: string | undefined = routedServerId.includes(":")
				? routedServerId.slice(routedServerId.lastIndexOf(":") + 1)
				: undefined;
			if (routedSourceId !== undefined) this.sourceIndex.invalidateSource(workspace.id, routedSourceId);
		}
		return result;
	}

	async listResources(serverId: string, workspaceId?: string | undefined) {
		if (serverId === TERMINAL_MCP_SERVER_ID || serverId === GODOT_DOCUMENTATION_MCP_SERVER_ID) {
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
		if (serverId === TERMINAL_MCP_SERVER_ID || serverId === GODOT_DOCUMENTATION_MCP_SERVER_ID) {
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
		this.sourceIndex.clear();
		clearGlobalDynamicMcpTools();
		this.activeWorkspaceId = undefined;
		this.globalInternalInitialized = false;
		this.globalCustomInitialized = false;
		this.diagnosticsBridge.clearWorkspace();
	}
}
