import { join } from "node:path";

const DAEDALUS_DIR_NAME: string = ".daedalus";

export type DaedalusPathKey =
	| "config.workspaces"
	| "config.workspaceTreeOrder"
	| "config.provider"
	| "config.providerCustomizations"
	| "config.mcpServers"
	| "config.skillSettings"
	| "config.userPrompt"
	| "config.generalSettings"
	| "config.webSearchSettings"
	| "config.godotDocumentation"
	| "config.approval"
	| "config.hookTrust"
	| "config.environmentTrust"
	| "config.worktreeSettings"
	| "hooks.globalConfig"
	| "hooks.dataRoot"
	| "cache.hookOutputs"
	| "godotDocumentation.root"
	| "goalCheckpoints.root"
	| "skills.root"
	| "worktrees.root"
	| "plugins.root"
	| "plugins.packages"
	| "plugins.development"
	| "plugins.developmentRecords"
	| "plugins.records"
	| "plugins.profiles"
	| "plugins.trust"
	| "plugins.audit"
	| "plugins.quarantine"
	| "plugins.versions"
	| "plugins.runtime"
	| "plugins.dependencies"
	| "plugins.harnessConfig"
	| "plugins.harnessRuntime"
	| "plugins.events"
	| "sessions.activeRoot"
	| "sessions.archivedRoot"
	| "sessions.database"
	| "cache.sessionSearch"
	| "logs.root"
	| "backend.connection"
	| "backend.runtimeRoot"
	| "backend.nativeRoot"
	| "backend.runtimeAssetsRoot"
	| "terminalJobs.root"
	| "toolExecution.ledger"
	| "metrics.usageDb";

type DaedalusPathRegistry = Record<DaedalusPathKey, string>;

export function getDaedalusDir(): string {
	const userProfile: string | undefined = process.env.USERPROFILE;
	if (!userProfile || userProfile.trim().length === 0) {
		throw new Error("USERPROFILE is not configured");
	}

	return join(userProfile, DAEDALUS_DIR_NAME);
}

function buildDaedalusPathRegistry(): DaedalusPathRegistry {
	const root: string = getDaedalusDir();
	const configRoot: string = join(root, "config");
	return {
		"config.workspaces": join(configRoot, "workspaces.json"),
		"config.workspaceTreeOrder": join(configRoot, "workspace-tree-order.json"),
		"config.provider": join(configRoot, "provider.json"),
		"config.providerCustomizations": join(configRoot, "provider-customizations.json"),
		"config.mcpServers": join(configRoot, "mcp-servers.json"),
		"config.skillSettings": join(configRoot, "skill-settings.json"),
		"config.userPrompt": join(configRoot, "user-prompt.json"),
		"config.generalSettings": join(configRoot, "general-settings.json"),
		"config.webSearchSettings": join(configRoot, "web-search-settings.json"),
		"config.godotDocumentation": join(configRoot, "godot-documentation.json"),
		"config.approval": join(configRoot, "approval.json"),
		"config.hookTrust": join(configRoot, "hook-trust.json"),
		"config.environmentTrust": join(configRoot, "environment-trust.json"),
		"config.worktreeSettings": join(configRoot, "worktree-settings.json"),
		"hooks.globalConfig": join(root, "hooks.json"),
		"hooks.dataRoot": join(root, "hook-data"),
		"cache.hookOutputs": join(root, "cache", "hook-outputs"),
		"godotDocumentation.root": join(root, "godot-docs"),
		"goalCheckpoints.root": join(root, "goal-checkpoints"),
		"skills.root": join(root, "skills"),
		"worktrees.root": join(root, "worktrees"),
		"plugins.root": join(root, "plugins"),
		"plugins.packages": join(root, "plugins", "packages"),
		"plugins.development": join(root, "plugin-dev"),
		"plugins.developmentRecords": join(root, "plugins", "development-records.json"),
		"plugins.records": join(root, "plugins", "records.json"),
		"plugins.profiles": join(root, "plugins", "profiles.json"),
		"plugins.trust": join(root, "plugins", "trust.json"),
		"plugins.audit": join(root, "plugins", "audit.jsonl"),
		"plugins.quarantine": join(root, "plugins", "quarantine.json"),
		"plugins.versions": join(root, "plugins", "versions"),
		"plugins.runtime": join(root, "plugins", "runtime"),
		"plugins.dependencies": join(root, "plugins", "dependencies"),
		"plugins.harnessConfig": join(root, "plugins", "harness.json"),
		"plugins.harnessRuntime": join(root, "plugins", "harness-runtime"),
		"plugins.events": join(root, "plugins", "events.json"),
		"sessions.activeRoot": join(root, "sessions"),
		"sessions.archivedRoot": join(root, "archived_sessions"),
		"sessions.database": join(root, "sessions.sqlite"),
		"cache.sessionSearch": join(root, "cache", "session-search.sqlite"),
		"logs.root": join(root, "logs"),
		"backend.connection": join(root, "backend", "connection.json"),
		"backend.runtimeRoot": join(root, "backend", "runtime"),
		"backend.nativeRoot": join(root, "backend", "native"),
		"backend.runtimeAssetsRoot": join(root, "backend", "runtime-assets"),
		"terminalJobs.root": join(root, "terminal-jobs"),
		"toolExecution.ledger": join(root, "tool-executions.jsonl"),
		"metrics.usageDb": join(root, "metrics", "usage.sqlite")
	};
}

export function getDaedalusPath(key: DaedalusPathKey): string {
	return buildDaedalusPathRegistry()[key];
}

export function getDefaultWorkspaceConfigPath(): string {
	return getDaedalusPath("config.workspaces");
}

export function getWorkspaceTreeOrderConfigPath(): string {
	return getDaedalusPath("config.workspaceTreeOrder");
}

export function getProviderConfigPath(): string {
	return getDaedalusPath("config.provider");
}

export function getProviderCustomizationsPath(): string {
	return getDaedalusPath("config.providerCustomizations");
}

export function getMcpServersConfigPath(): string {
	return getDaedalusPath("config.mcpServers");
}

export function getPersonalSkillsDir(): string {
	return getDaedalusPath("skills.root");
}

export function getWorktreesRoot(): string {
	return getDaedalusPath("worktrees.root");
}

export function getEnvironmentTrustConfigPath(): string {
	return getDaedalusPath("config.environmentTrust");
}

export function getWorktreeSettingsConfigPath(): string {
	return getDaedalusPath("config.worktreeSettings");
}

export function getSkillSettingsPath(): string {
	return getDaedalusPath("config.skillSettings");
}

export function getUserPromptConfigPath(): string {
	return getDaedalusPath("config.userPrompt");
}

export function getGeneralSettingsConfigPath(): string {
	return getDaedalusPath("config.generalSettings");
}

export function getWebSearchSettingsConfigPath(): string {
	return getDaedalusPath("config.webSearchSettings");
}

export function getGodotDocumentationConfigPath(): string {
	return getDaedalusPath("config.godotDocumentation");
}

export function getGodotDocumentationRoot(): string {
	return getDaedalusPath("godotDocumentation.root");
}

export function getGoalCheckpointsRoot(): string {
	return getDaedalusPath("goalCheckpoints.root");
}

export function getApprovalConfigPath(): string {
	return getDaedalusPath("config.approval");
}

export function getHookTrustConfigPath(): string {
	return getDaedalusPath("config.hookTrust");
}

export function getGlobalHooksConfigPath(): string {
	return getDaedalusPath("hooks.globalConfig");
}

export function getHookDataRoot(): string {
	return getDaedalusPath("hooks.dataRoot");
}

export function getHookOutputsRoot(): string {
	return getDaedalusPath("cache.hookOutputs");
}

export function getDefaultSessionsDir(): string {
	return getDaedalusPath("sessions.activeRoot");
}

export function getDefaultArchivedSessionsDir(): string {
	return getDaedalusPath("sessions.archivedRoot");
}

export function getSessionsDatabasePath(): string {
	return getDaedalusPath("sessions.database");
}

export function getSessionSearchDatabasePath(): string {
	return getDaedalusPath("cache.sessionSearch");
}

export function getLogsDir(): string {
	return getDaedalusPath("logs.root");
}

export function getBackendNativeRoot(): string {
	return getDaedalusPath("backend.nativeRoot");
}

export function getBackendConnectionPath(): string {
	return getDaedalusPath("backend.connection");
}

export function getBackendRuntimeRoot(): string {
	return getDaedalusPath("backend.runtimeRoot");
}

export function getBackendRuntimeAssetsRoot(): string {
	return getDaedalusPath("backend.runtimeAssetsRoot");
}

export function getTerminalJobsDir(): string {
	return getDaedalusPath("terminalJobs.root");
}

export function getToolExecutionLedgerPath(): string {
	return getDaedalusPath("toolExecution.ledger");
}

export function getUsageMetricsDbPath(): string {
	return getDaedalusPath("metrics.usageDb");
}
