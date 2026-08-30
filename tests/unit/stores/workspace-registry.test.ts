import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { WorkspaceConfig } from "../../../src/workspace/types.js";

async function withTempAppData<T>(fn: (registry: typeof import("../../../src/workspace/registry.js"), appDataDir: string) => Promise<T>): Promise<T> {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const previousGodotProjectPath: string | undefined = process.env.GODOT_PROJECT_PATH;
	const previousGodotExecutablePath: string | undefined = process.env.GODOT_EXECUTABLE_PATH;
	const appDataDir: string = await fs.mkdtemp(path.join(os.tmpdir(), "godot-daedalus-workspace-appdata-"));
	process.env.USERPROFILE = appDataDir;
	delete process.env.GODOT_PROJECT_PATH;
	delete process.env.GODOT_EXECUTABLE_PATH;

	try {
		const registry = await import(`../../../src/workspace/registry.js?case=${Date.now()}-${Math.random()}`);
		return await fn(registry, appDataDir);
	} finally {
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		if (previousGodotProjectPath === undefined) {
			delete process.env.GODOT_PROJECT_PATH;
		} else {
			process.env.GODOT_PROJECT_PATH = previousGodotProjectPath;
		}
		if (previousGodotExecutablePath === undefined) {
			delete process.env.GODOT_EXECUTABLE_PATH;
		} else {
			process.env.GODOT_EXECUTABLE_PATH = previousGodotExecutablePath;
		}
		await fs.rm(appDataDir, { recursive: true, force: true });
	}
}

test("workspace registry persists runtime workspaces", async (): Promise<void> => {
	await withTempAppData(async (registry, appDataDir): Promise<void> => {
		const projectDir: string = await fs.mkdtemp(path.join(os.tmpdir(), "godot-daedalus-project-"));
		const workspace = registry.upsertRuntimeWorkspace(registry.createRuntimeWorkspace(projectDir, "D:/Godot/Godot.exe"));
		const configPath: string = path.join(appDataDir, ".daedalus", "config", "workspaces.json");
		const rawConfig: string = await fs.readFile(configPath, "utf8");
		const persisted = JSON.parse(rawConfig) as Array<Record<string, unknown>>;

		assert.equal(rawConfig.endsWith("\n"), true);
		assert.deepEqual((await fs.readdir(path.dirname(configPath))).sort(), ["workspaces.json"]);
		assert.equal(persisted.length, 1);
		assert.equal(persisted[0]?.id, workspace.id);
		assert.equal(persisted[0]?.name, workspace.name);
		assert.equal(persisted[0]?.kind, "godot");
		assert.equal(persisted[0]?.rootPath, workspace.rootPath);
		assert.equal(persisted[0]?.icon, 0);
		assert.equal(persisted[0]?.color, 0);
		assert.deepEqual(persisted[0]?.sourceFolders, workspace.sourceFolders);
		assert.equal(persisted[0]?.primarySourceFolderId, workspace.primarySourceFolderId);
		assert.equal(persisted[0]?.godotExecutablePath, "D:/Godot/Godot.exe");

		const reloadedRegistry = await import(`../../../src/workspace/registry.js?case=reload-${Date.now()}-${Math.random()}`);
		const loaded: WorkspaceConfig[] = reloadedRegistry.loadWorkspaces();
		assert.equal(loaded.some((item: WorkspaceConfig): boolean => item.id === workspace.id && item.rootPath === workspace.rootPath), true);

		await fs.rm(projectDir, { recursive: true, force: true });
	});
});

test("workspace registry distinguishes generic directories from Godot projects", async (): Promise<void> => {
	await withTempAppData(async (registry): Promise<void> => {
		const workspaceRoot: string = await fs.mkdtemp(path.join(os.tmpdir(), "daedalus-generic-workspace-"));
		const godotRoot: string = await fs.mkdtemp(path.join(os.tmpdir(), "daedalus-godot-workspace-"));
		await fs.writeFile(path.join(godotRoot, "project.godot"), "[application]\n", "utf8");

		const genericWorkspace: WorkspaceConfig = registry.createRuntimeWorkspace(workspaceRoot);
		const godotWorkspace: WorkspaceConfig = registry.createRuntimeWorkspace(godotRoot);
		const explicitlyGeneric: WorkspaceConfig = registry.normalizeWorkspaceConfig({
			id: "explicit-generic",
			name: "Generic",
			kind: "workspace",
			rootPath: godotRoot
		});

		assert.equal(genericWorkspace.kind, "workspace");
		assert.equal(godotWorkspace.kind, "godot");
		assert.equal(explicitlyGeneric.kind, "workspace");

		await fs.rm(workspaceRoot, { recursive: true, force: true });
		await fs.rm(godotRoot, { recursive: true, force: true });
	});
});

test("workspace registry normalizes legacy single-root projects", async (): Promise<void> => {
	await withTempAppData(async (registry): Promise<void> => {
		const rootPath: string = await fs.mkdtemp(path.join(os.tmpdir(), "godot-daedalus-legacy-root-"));
		const normalized: WorkspaceConfig = registry.normalizeWorkspaceConfig({
			id: "legacy-workspace",
			name: "",
			kind: "godot",
			rootPath
		});

		assert.equal(normalized.id, "legacy-workspace");
		assert.equal(normalized.name, path.basename(rootPath));
		assert.equal(normalized.icon, 0);
		assert.equal(normalized.color, 0);
		assert.equal(normalized.sourceFolders.length, 1);
		assert.equal(normalized.sourceFolders[0]?.path, path.resolve(rootPath));
		assert.equal(normalized.primarySourceFolderId, normalized.sourceFolders[0]?.id);
		await fs.rm(rootPath, { recursive: true, force: true });
	});
});

test("workspace registry updates project appearance, primary root, and capabilities", async (): Promise<void> => {
	await withTempAppData(async (registry): Promise<void> => {
		const primaryPath: string = await fs.mkdtemp(path.join(os.tmpdir(), "godot-daedalus-primary-"));
		const toolsPath: string = await fs.mkdtemp(path.join(os.tmpdir(), "godot-daedalus-tools-"));
		await fs.writeFile(path.join(primaryPath, "project.godot"), "[application]\n", "utf8");
		await fs.mkdir(path.join(toolsPath, ".git"));
		const original: WorkspaceConfig = registry.upsertRuntimeWorkspace(registry.createRuntimeWorkspace(primaryPath));
		const originalId: string = original.id;

		const updated: WorkspaceConfig = registry.updateWorkspace(original.id, {
			name: "Daedalus Project",
			icon: 5,
			color: 4,
			sourceFolders: [
				{ id: original.primarySourceFolderId, path: primaryPath },
				{ id: "tools", path: toolsPath }
			],
			primarySourceFolderId: "tools"
		});

		assert.equal(updated.id, originalId);
		assert.equal(updated.name, "Daedalus Project");
		assert.equal(updated.icon, 5);
		assert.equal(updated.color, 4);
		assert.equal(path.basename(updated.rootPath), path.basename(toolsPath));
		assert.equal((await fs.stat(updated.rootPath)).isDirectory(), true);
		assert.equal(updated.primarySourceFolderId, "tools");
		assert.equal(updated.sourceFolders.find((source) => source.id === original.primarySourceFolderId)?.capabilities.godot, true);
		assert.equal(updated.sourceFolders.find((source) => source.id === "tools")?.capabilities.git, true);
		assert.equal(registry.getWorkspaceSourceFolder(updated).id, "tools");
		assert.equal(
			path.basename(registry.getWorkspaceSourceFolder(updated, original.primarySourceFolderId).path),
			path.basename(primaryPath)
		);
		assert.equal(
			registry.findContainingWorkspaceSourceFolder(updated, path.join(primaryPath, "scenes", "Main.tscn"))?.id,
			original.primarySourceFolderId
		);
		assert.equal(
			registry.findContainingWorkspaceSourceFolder(updated, path.join(toolsPath, "scripts", "build.ts"))?.id,
			"tools"
		);
		assert.equal(registry.isPathInsideWorkspaceSources(updated, path.join(toolsPath, "scripts")), true);
		assert.equal(registry.isPathInsideWorkspaceSources(updated, path.join(os.tmpdir(), "outside-project")), false);
		const scoped: WorkspaceConfig | undefined = registry.findWorkspace(`${updated.id}::${original.primarySourceFolderId}`);
		assert.equal(scoped?.rootPath.endsWith(path.basename(primaryPath)), true);
		assert.equal(registry.loadWorkspaces().some((workspace) => workspace.id.includes("::")), false);

		await fs.rm(primaryPath, { recursive: true, force: true });
		await fs.rm(toolsPath, { recursive: true, force: true });
	});
});

test("workspace registry rejects duplicate real paths inside one project", async (): Promise<void> => {
	await withTempAppData(async (registry, appDataDir): Promise<void> => {
		const rootPath: string = await fs.mkdtemp(path.join(os.tmpdir(), "godot-daedalus-duplicate-"));
		const workspace: WorkspaceConfig = registry.upsertRuntimeWorkspace(registry.createRuntimeWorkspace(rootPath));

		assert.throws((): void => {
			registry.updateWorkspace(workspace.id, {
				name: workspace.name,
				icon: 0,
				color: 0,
				sourceFolders: [
					{ id: "first", path: rootPath },
					{ id: "second", path: path.join(rootPath, ".") }
				],
				primarySourceFolderId: "first"
			});
		}, /Duplicate source folder/);
		assert.throws((): void => {
			registry.updateWorkspace(workspace.id, {
				name: workspace.name,
				icon: 0,
				color: 0,
				sourceFolders: [
					{ id: "same", path: rootPath },
					{ id: "same", path: appDataDir }
				],
				primarySourceFolderId: "same"
			});
		}, /Duplicate source folder id/);

		await fs.rm(rootPath, { recursive: true, force: true });
	});
});

test("workspace registry deletes persisted runtime workspaces", async (): Promise<void> => {
	await withTempAppData(async (registry, appDataDir): Promise<void> => {
		const projectDir: string = await fs.mkdtemp(path.join(os.tmpdir(), "godot-daedalus-project-"));
		const workspace = registry.upsertRuntimeWorkspace(registry.createRuntimeWorkspace(projectDir));
		const deleted: WorkspaceConfig | undefined = registry.deleteWorkspace(workspace.id);
		const configPath: string = path.join(appDataDir, ".daedalus", "config", "workspaces.json");
		const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as Array<Record<string, unknown>>;

		assert.equal(deleted?.id, workspace.id);
		assert.equal(registry.findWorkspace(workspace.id), undefined);
		assert.equal(registry.loadWorkspaces().some((item: WorkspaceConfig): boolean => item.id === workspace.id), false);
		assert.deepEqual(persisted, []);
		assert.equal(await fs.stat(projectDir).then((stats): boolean => stats.isDirectory()), true);

		await fs.rm(projectDir, { recursive: true, force: true });
	});
});

test("workspace registry hydrates missing runtime workspaces from session metadata", async (): Promise<void> => {
	await withTempAppData(async (registry): Promise<void> => {
		const hydrated: WorkspaceConfig[] = registry.hydrateWorkspacesFromSessionMetadata([
			{
				workspaceId: "runtime-680ece18e3",
				workspaceName: "example",
				workspaceKind: "godot",
				workspaceRoot: "D:/GodotProjects/example",
				godotExecutablePath: "D:/Godot/Godot.exe"
			}
		]);
		const loaded: WorkspaceConfig[] = registry.loadWorkspaces();

		assert.equal(hydrated.length, 1);
		assert.equal(hydrated[0]?.id, "runtime-680ece18e3");
		assert.equal(hydrated[0]?.name, "example");
		assert.equal(loaded.some((item: WorkspaceConfig): boolean => item.id === "runtime-680ece18e3" && item.name === "example"), true);

		const duplicateHydrated: WorkspaceConfig[] = registry.hydrateWorkspacesFromSessionMetadata([
			{
				workspaceId: "runtime-680ece18e3",
				workspaceName: "example",
				workspaceRoot: "D:/GodotProjects/example"
			}
		]);
		assert.equal(duplicateHydrated.length, 0);

		const genericHydrated: WorkspaceConfig[] = registry.hydrateWorkspacesFromSessionMetadata([
			{
				workspaceId: "runtime-generic-680ece18e3",
				workspaceName: "generic",
				workspaceRoot: "D:/Workspaces/generic"
			}
		]);
		assert.equal(genericHydrated[0]?.kind, "workspace");
	});
});
