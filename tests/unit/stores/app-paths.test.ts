import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
	getDaedalusPath,
	getDaedalusDir,
	getApprovalConfigPath,
	getBackendConnectionPath,
	getDefaultArchivedSessionsDir,
	getDefaultWorkspaceConfigPath,
	getDefaultSessionsDir,
	getGeneralSettingsConfigPath,
	getGodotDocumentationConfigPath,
	getGodotDocumentationRoot,
	getLogsDir,
	getMcpServersConfigPath,
	getPersonalSkillsDir,
	getProviderConfigPath,
	getProviderCustomizationsPath,
	getSkillSettingsPath,
	getTerminalJobsDir,
	getToolExecutionLedgerPath,
	getUsageMetricsDbPath,
	getUserPromptConfigPath,
	getWebSearchSettingsConfigPath
} from "../../../src/app-paths.js";

test("Daedalus state uses USERPROFILE without legacy appdata or v2 paths", (): void => {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const previousAppData: string | undefined = process.env.APPDATA;
	process.env.USERPROFILE = "D:/Users/TestUser";
	process.env.APPDATA = "D:/Legacy/AppData";

	try {
		const root: string = join("D:/Users/TestUser", ".daedalus");
		const configRoot: string = join(root, "config");

		assert.equal(getDaedalusDir(), root);
		assert.equal(getDefaultWorkspaceConfigPath(), join(configRoot, "workspaces.json"));
		assert.equal(getProviderConfigPath(), join(configRoot, "provider.json"));
		assert.equal(getProviderCustomizationsPath(), join(configRoot, "provider-customizations.json"));
		assert.equal(getMcpServersConfigPath(), join(configRoot, "mcp-servers.json"));
		assert.equal(getSkillSettingsPath(), join(configRoot, "skill-settings.json"));
		assert.equal(getUserPromptConfigPath(), join(configRoot, "user-prompt.json"));
		assert.equal(getGeneralSettingsConfigPath(), join(configRoot, "general-settings.json"));
		assert.equal(getGodotDocumentationConfigPath(), join(configRoot, "godot-documentation.json"));
		assert.equal(getWebSearchSettingsConfigPath(), join(configRoot, "web-search-settings.json"));
		assert.equal(getApprovalConfigPath(), join(configRoot, "approval.json"));
		assert.equal(getPersonalSkillsDir(), join(root, "skills"));
		assert.equal(getDefaultSessionsDir(), join(root, "sessions"));
		assert.equal(getDefaultArchivedSessionsDir(), join(root, "archived_sessions"));
		assert.equal(getLogsDir(), join(root, "logs"));
		assert.equal(getBackendConnectionPath(), join(root, "backend", "connection.json"));
		assert.equal(getTerminalJobsDir(), join(root, "terminal-jobs"));
		assert.equal(getToolExecutionLedgerPath(), join(root, "tool-executions.jsonl"));
		assert.equal(getUsageMetricsDbPath(), join(root, "metrics", "usage.sqlite"));
		assert.equal(getGodotDocumentationRoot(), join(root, "godot-docs"));

		assert.equal(getDaedalusPath("config.workspaces"), getDefaultWorkspaceConfigPath());
		assert.equal(getDaedalusPath("config.provider"), getProviderConfigPath());
		assert.equal(getDaedalusPath("config.providerCustomizations"), getProviderCustomizationsPath());
		assert.equal(getDaedalusPath("config.mcpServers"), getMcpServersConfigPath());
		assert.equal(getDaedalusPath("config.skillSettings"), getSkillSettingsPath());
		assert.equal(getDaedalusPath("config.userPrompt"), getUserPromptConfigPath());
		assert.equal(getDaedalusPath("config.generalSettings"), getGeneralSettingsConfigPath());
		assert.equal(getDaedalusPath("config.godotDocumentation"), getGodotDocumentationConfigPath());
		assert.equal(getDaedalusPath("config.webSearchSettings"), getWebSearchSettingsConfigPath());
		assert.equal(getDaedalusPath("config.approval"), getApprovalConfigPath());
		assert.equal(getDaedalusPath("skills.root"), getPersonalSkillsDir());
		assert.equal(getDaedalusPath("sessions.activeRoot"), getDefaultSessionsDir());
		assert.equal(getDaedalusPath("sessions.archivedRoot"), getDefaultArchivedSessionsDir());
		assert.equal(getDaedalusPath("logs.root"), getLogsDir());
		assert.equal(getDaedalusPath("backend.connection"), getBackendConnectionPath());
		assert.equal(getDaedalusPath("backend.runtimeRoot"), join(root, "backend", "runtime"));
		assert.equal(getDaedalusPath("terminalJobs.root"), getTerminalJobsDir());
		assert.equal(getDaedalusPath("toolExecution.ledger"), getToolExecutionLedgerPath());
		assert.equal(getDaedalusPath("metrics.usageDb"), getUsageMetricsDbPath());
		assert.equal(getDaedalusPath("godotDocumentation.root"), getGodotDocumentationRoot());
	} finally {
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		if (previousAppData === undefined) {
			delete process.env.APPDATA;
		} else {
			process.env.APPDATA = previousAppData;
		}
	}
});
