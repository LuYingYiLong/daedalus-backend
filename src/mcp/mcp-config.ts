import type { McpServerConfig } from "./types.js";
import { getDefaultWorkspace } from "../workspace/registry.js";
import type { WorkspaceConfig } from "../workspace/types.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createGlobalSkillWorkspace } from "../skills/runtime.js";
import { createSelfInvocation } from "../runtime/self-invocation.js";

export const TERMINAL_MCP_SERVER_ID: string = "terminal";
export const WORKSPACE_MCP_SERVER_ID: string = "workspace";
export const GODOT_DOCUMENTATION_MCP_SERVER_ID: string = "godot_documentation";

const defaultWs = getDefaultWorkspace();
const DEFAULT_GODOT_PROJECT_PATH: string | undefined = process.env.GODOT_PROJECT_PATH ?? defaultWs?.rootPath;
const DEFAULT_GODOT_EXECUTABLE_PATH: string | undefined = process.env.GODOT_EXECUTABLE_PATH ?? defaultWs?.godotExecutablePath;

export function getSourceScopedServerId(
	baseServerId: string,
	workspace: WorkspaceConfig,
	sourceFolderId?: string | undefined
): string {
	const effectiveSourceId: string = sourceFolderId?.trim() || workspace.primarySourceFolderId;
	return effectiveSourceId === workspace.primarySourceFolderId
		? baseServerId
		: `${baseServerId}:${effectiveSourceId}`;
}

export function buildGlobalMcpServerConfigs(defaultGodotExecutablePath?: string | undefined): McpServerConfig[] {
	const terminalInvocation = createSelfInvocation(["mcp", "terminal"]);
	const documentationInvocation = createSelfInvocation(["mcp", "documentation"]);
	const skillsInvocation = createSelfInvocation(["mcp", "skills"]);
	const terminalEnv: Record<string, string> = {
		BACKEND_DIR: process.cwd()
	};
	const globalSkillWorkspace = createGlobalSkillWorkspace();

	if (DEFAULT_GODOT_PROJECT_PATH !== undefined) {
		terminalEnv.GODOT_PROJECT_PATH = DEFAULT_GODOT_PROJECT_PATH;
	}
	const effectiveExecutablePath: string | undefined = defaultGodotExecutablePath ?? DEFAULT_GODOT_EXECUTABLE_PATH;
	if (effectiveExecutablePath !== undefined) {
		terminalEnv.GODOT_EXECUTABLE_PATH = effectiveExecutablePath;
	}

	return [
		{
			id: TERMINAL_MCP_SERVER_ID,
			name: "Terminal MCP",
			transport: "stdio",
			command: terminalInvocation.command,
			args: terminalInvocation.args,
			env: terminalEnv
		},
		{
			id: GODOT_DOCUMENTATION_MCP_SERVER_ID,
			name: "Godot Documentation MCP",
			transport: "stdio",
			command: documentationInvocation.command,
			args: documentationInvocation.args
		},
		{
			id: "skills",
			name: "Daedalus Skills MCP",
			transport: "stdio",
			command: skillsInvocation.command,
			args: skillsInvocation.args,
			env: {
				DAEDALUS_WORKSPACE_ID: globalSkillWorkspace.id,
				GODOT_PROJECT_PATH: globalSkillWorkspace.rootPath
			}
		}
	];
}

export function buildMcpServerConfigs(workspace?: WorkspaceConfig, defaultGodotExecutablePath?: string | undefined): McpServerConfig[] {
	if (workspace === undefined || workspace.sourceFolders.length === 0) {
		return [];
	}

	const configs: McpServerConfig[] = [];
	const workspaceInvocation = createSelfInvocation(["mcp", "workspace"]);
	const godotInvocation = createSelfInvocation(["mcp", "godot"]);
	const skillsInvocation = createSelfInvocation(["mcp", "skills"]);
	for (const sourceFolder of workspace.sourceFolders) {
		const projectPath: string = sourceFolder.path;
		const workspaceServerId: string = getSourceScopedServerId(WORKSPACE_MCP_SERVER_ID, workspace, sourceFolder.id);
		configs.push({
			id: workspaceServerId,
			name: sourceFolder.id === workspace.primarySourceFolderId
				? "Workspace MCP"
				: `Workspace MCP (${sourceFolder.id})`,
			transport: "stdio",
			command: workspaceInvocation.command,
			args: workspaceInvocation.args,
			env: {
				WORKSPACE_ID: workspace.id,
				WORKSPACE_SOURCE_FOLDER_ID: sourceFolder.id,
				WORKSPACE_ROOT: projectPath
			}
		});

		const isGodotProject: boolean = existsSync(join(projectPath, "project.godot"));
		if (isGodotProject) {
			const godotExecutablePath: string | undefined = workspace.godotExecutablePath ?? defaultGodotExecutablePath;
			configs.push({
				id: getSourceScopedServerId("godot", workspace, sourceFolder.id),
				name: sourceFolder.id === workspace.primarySourceFolderId
					? "Godot Project MCP"
					: `Godot Project MCP (${sourceFolder.id})`,
				transport: "stdio",
				command: godotInvocation.command,
				args: godotInvocation.args,
				env: {
					DAEDALUS_WORKSPACE_ID: workspace.id,
					DAEDALUS_SOURCE_FOLDER_ID: sourceFolder.id,
					GODOT_PROJECT_PATH: projectPath,
					...(godotExecutablePath === undefined ? {} : { GODOT_EXECUTABLE_PATH: godotExecutablePath })
				}
			});
		}

		configs.push({
			id: getSourceScopedServerId("skills", workspace, sourceFolder.id),
			name: sourceFolder.id === workspace.primarySourceFolderId
				? "Daedalus Skills MCP"
				: `Daedalus Skills MCP (${sourceFolder.id})`,
			transport: "stdio",
			command: skillsInvocation.command,
			args: skillsInvocation.args,
			env: {
				DAEDALUS_WORKSPACE_ID: workspace.id,
				DAEDALUS_SOURCE_FOLDER_ID: sourceFolder.id,
				GODOT_PROJECT_PATH: projectPath
			}
		});
	}

	return configs;
}
