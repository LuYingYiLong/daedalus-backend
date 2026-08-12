import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerSkillTools } from "./registration.js";
import type { SkillWorkspace } from "../../skills/types.js";

export async function main(): Promise<void> {
	const workspaceId: string = process.env.DAEDALUS_WORKSPACE_ID?.trim() ?? "";
	const sourceFolderId: string = process.env.DAEDALUS_SOURCE_FOLDER_ID?.trim() ?? "";
	const rootPath: string = process.env.GODOT_PROJECT_PATH?.trim() ?? "";
	if (workspaceId.length === 0 || rootPath.length === 0) {
		throw new Error("DAEDALUS_WORKSPACE_ID and GODOT_PROJECT_PATH are required.");
	}
	const workspace: SkillWorkspace = sourceFolderId.length === 0
		? { id: workspaceId, rootPath }
		: {
			id: workspaceId,
			rootPath,
			sourceFolders: [{ id: sourceFolderId, rootPath }],
			primarySourceFolderId: sourceFolderId
		};
	const server: McpServer = new McpServer({ name: "daedalus-skills", version: "1.0.0" });
	registerSkillTools(server, workspace);
	await server.connect(new StdioServerTransport());
}
