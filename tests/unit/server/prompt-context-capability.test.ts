import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpHost } from "../../../src/mcp/mcp-host.js";
import { createMcpSystemContext } from "../../../src/server/prompt-context.js";
import { createClientSession } from "../../../src/server/client-session.js";
import type { WorkspaceConfig } from "../../../src/workspace/types.js";

function createWorkspace(rootPath: string, godot: boolean): WorkspaceConfig {
	return {
		id: godot ? "workspace-godot" : "workspace-web",
		name: godot ? "Godot" : "Web",
		kind: "godot",
		rootPath,
		icon: 0,
		color: 0,
		primarySourceFolderId: "main",
		sourceFolders: [{
			id: "main",
			path: rootPath,
			capabilities: {
				git: false,
				godot,
				workflowProfile: godot ? "godot" : "workspace"
			}
		}]
	};
}

function createEmptyMcpHost(): McpHost {
	return {
		ensureGlobalCustomServers: async (): Promise<void> => undefined,
		getConnectedServerIds: (): string[] => []
	} as unknown as McpHost;
}

test("non-Godot workspaces do not inject Godot MCP availability context", async (): Promise<void> => {
	const rootPath: string = await mkdtemp(join(tmpdir(), "daedalus-web-workspace-"));
	try {
		const session = createClientSession(createWorkspace(rootPath, false));
		const context: string = await createMcpSystemContext(createEmptyMcpHost(), session);

		assert.doesNotMatch(context, /Godot/u);
		assert.match(context, /mcp_workspace_\*/u);
	} finally {
		await rm(rootPath, { recursive: true, force: true });
	}
});
