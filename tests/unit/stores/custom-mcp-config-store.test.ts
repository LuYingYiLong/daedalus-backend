import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installMemorySecretStore, resetSecretStoreDriver } from "../../helpers/secret-store.js";
import { getMcpServersConfigPath } from "../../../src/app-paths.js";
import {
	addCustomMcpServerConfig,
	buildCustomMcpServerConfigs,
	listStoredCustomMcpServerConfigs,
	updateCustomMcpServerConfig
} from "../../../src/mcp/custom-mcp-config-store.js";
import type { McpServerConfig } from "../../../src/mcp/types.js";
import type { WorkspaceConfig } from "../../../src/workspace/types.js";

async function withTempAppData(run: (secrets: Map<string, string>) => Promise<void>): Promise<void> {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const appDataDir: string = await mkdtemp(join(tmpdir(), "daedalus-custom-mcp-"));
	const secrets: Map<string, string> = installMemorySecretStore();
	process.env.USERPROFILE = appDataDir;

	try {
		await run(secrets);
	} finally {
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		resetSecretStoreDriver();
		await rm(appDataDir, { recursive: true, force: true });
	}
}

test("custom MCP config update preserves identity and applies secret update semantics", async (): Promise<void> => {
	await withTempAppData(async (secrets: Map<string, string>): Promise<void> => {
		const added = await addCustomMcpServerConfig({
			name: "Demo Tools",
			description: "Original",
			transport: "stdio",
			planAccess: "read",
			command: "npx",
			args: ["-y", "old-mcp"],
			env: {
				TOKEN: "old-token",
				DROP_ME: "drop-token"
			}
		});
		const serverId: string = added.id;
		const createdAt: string = added.createdAt;

		const updated = await updateCustomMcpServerConfig({
			serverId,
			description: "Updated",
			transport: "stdio",
			enabled: false,
			command: "uvx",
			args: ["new-mcp"],
			env: {
				TOKEN: "",
				NEW_TOKEN: "new-token"
			}
		});

		assert.notEqual(updated, null);
		assert.equal(updated?.id, serverId);
		assert.equal(updated?.name, "Demo Tools");
		assert.equal(updated?.createdAt, createdAt);
		assert.equal(updated?.description, "Updated");
		assert.equal(updated?.enabled, false);
		assert.equal(updated?.planAccess, "disabled");
		assert.equal(updated?.command, "uvx");
		assert.deepEqual(updated?.args, ["new-mcp"]);
		assert.deepEqual(updated?.envNames, ["NEW_TOKEN", "TOKEN"]);
		assert.equal(secrets.get(`mcp:${serverId}:env:TOKEN`), "old-token");
		assert.equal(secrets.get(`mcp:${serverId}:env:NEW_TOKEN`), "new-token");
		assert.equal(secrets.has(`mcp:${serverId}:env:DROP_ME`), false);

		await assert.rejects(
			updateCustomMcpServerConfig({
				serverId,
				transport: "stdio",
				command: "uvx",
				env: {
					NEW_BLANK: ""
				}
			}),
			/Secret value is required for new env: NEW_BLANK/
		);
		assert.equal(secrets.get(`mcp:${serverId}:env:TOKEN`), "old-token");

		const workspace: WorkspaceConfig = {
			id: "workspace-a",
			name: "Workspace A",
			kind: "godot",
			rootPath: "D:/Projects/Game",
			icon: 0,
			color: 0,
			sourceFolders: [{ id: "primary", path: "D:/Projects/Game", capabilities: { git: false, godot: false } }],
			primarySourceFolderId: "primary"
		};
		const configs: McpServerConfig[] = await buildCustomMcpServerConfigs(workspace);
		assert.equal(configs.length, 0, "disabled custom MCP is not launched");

		const rawConfig: string = await readFile(getMcpServersConfigPath(), "utf8");
		assert.equal(rawConfig.endsWith("\n"), true);
		assert.doesNotMatch(rawConfig, /old-token|new-token|drop-token/);
		assert.deepEqual((await readdir(join(process.env.USERPROFILE!, ".daedalus", "config"))).sort(), ["mcp-servers.json"]);

		const stored = await listStoredCustomMcpServerConfigs();
		assert.equal(stored[0]?.id, serverId);
		assert.equal(stored[0]?.name, "Demo Tools");
		assert.equal(stored[0]?.planAccess, "disabled");
	});
});

test("custom MCP config update can switch transports and preserve existing header secrets", async (): Promise<void> => {
	await withTempAppData(async (secrets: Map<string, string>): Promise<void> => {
		const added = await addCustomMcpServerConfig({
			name: "HTTP Tools",
			transport: "stdio",
			command: "npx",
			env: {
				TOKEN: "old-token"
			}
		});
		const serverId: string = added.id;

		const switched = await updateCustomMcpServerConfig({
			serverId,
			transport: "http",
			enabled: true,
			planAccess: "read",
			url: "https://example.com/mcp",
			headers: {
				Authorization: "Bearer first"
			}
		});
		assert.equal(switched?.transport, "http");
		assert.equal(switched?.planAccess, "disabled");
		assert.equal(switched?.url, "https://example.com/mcp");
		assert.deepEqual(switched?.headerNames, ["Authorization"]);
		assert.equal(secrets.has(`mcp:${serverId}:env:TOKEN`), false);
		assert.equal(secrets.get(`mcp:${serverId}:header:Authorization`), "Bearer first");

		const preserved = await updateCustomMcpServerConfig({
			serverId,
			transport: "http",
			url: "https://example.com/next",
			headers: {
				Authorization: ""
			}
		});
		assert.equal(preserved?.url, "https://example.com/next");
		assert.equal(preserved?.planAccess, "disabled");
		assert.deepEqual(preserved?.headerNames, ["Authorization"]);
		assert.equal(secrets.get(`mcp:${serverId}:header:Authorization`), "Bearer first");
	});
});

test("custom MCP plan access is migrated and never exposed to plan mode", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		const configPath: string = getMcpServersConfigPath();
		await mkdir(join(process.env.USERPROFILE!, ".daedalus", "config"), { recursive: true });
		await writeFile(configPath, JSON.stringify([{
			id: "custom-old-plan-server-12345678",
			name: "Old Plan Server",
			description: "Legacy read access",
			transport: "stdio",
			enabled: true,
			planAccess: "read",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			command: "npx"
		}], null, 2), "utf8");

		const stored = await listStoredCustomMcpServerConfigs();
		assert.equal(stored[0]?.planAccess, "disabled");
		assert.doesNotMatch(await readFile(configPath, "utf8"), /"planAccess": "read"/);

		const workspace: WorkspaceConfig = {
			id: "workspace-a",
			name: "Workspace A",
			kind: "godot",
			rootPath: "D:/Projects/Game",
			icon: 0,
			color: 0,
			sourceFolders: [{ id: "primary", path: "D:/Projects/Game", capabilities: { git: false, godot: false } }],
			primarySourceFolderId: "primary"
		};
		const configs: McpServerConfig[] = await buildCustomMcpServerConfigs(workspace);
		assert.equal(configs[0]?.planAccess, "disabled");
	});
});
