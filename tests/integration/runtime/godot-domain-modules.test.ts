import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

type FakeMcpServer = {
	tools: Map<string, ToolHandler>;
	resources: Map<string, unknown>;
	registerTool(name: string, _config: unknown, handler: ToolHandler): void;
	registerResource(name: string, ...rest: unknown[]): void;
};

function createFakeServer(): FakeMcpServer {
	return {
		tools: new Map(),
		resources: new Map(),
		registerTool(name: string, _config: unknown, handler: ToolHandler): void {
			this.tools.set(name, handler);
		},
		registerResource(name: string, ...rest: unknown[]): void {
			this.resources.set(name, rest);
		}
	};
}

async function callTool(server: FakeMcpServer, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
	const handler: ToolHandler | undefined = server.tools.get(name);
	assert.notEqual(handler, undefined);
	const result = await handler!(args);
	return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

test("Godot domain modules preserve file, log, and editor config behavior", async (): Promise<void> => {
	const root: string = await fs.mkdtemp(path.join(os.tmpdir(), "daedalus-godot-domain-"));
	const projectRoot: string = path.join(root, "project");
	const appData: string = path.join(root, "appdata");
	const userProfile: string = path.join(root, "profile-user");
	process.env.GODOT_PROJECT_PATH = projectRoot;
	process.env.APPDATA = appData;
	process.env.USERPROFILE = userProfile;

	await fs.mkdir(projectRoot, { recursive: true });
	await fs.mkdir(path.join(projectRoot, "assets"), { recursive: true });
	await fs.mkdir(path.join(projectRoot, "scenes"), { recursive: true });
	await fs.mkdir(path.join(projectRoot, "scripts"), { recursive: true });
	await fs.mkdir(path.join(projectRoot, "tests"), { recursive: true });
	await fs.mkdir(path.join(projectRoot, "addons", "demo"), { recursive: true });
	await fs.mkdir(path.join(projectRoot, "addons", "gut"), { recursive: true });
	await fs.mkdir(path.join(projectRoot, "addons", "gdUnit4"), { recursive: true });
	await fs.mkdir(path.join(projectRoot, "broken-csharp"), { recursive: true });
	await fs.mkdir(path.join(projectRoot, "Shared"), { recursive: true });
	await fs.mkdir(path.join(appData, "Godot", "app_userdata", "Daedalus Test", "logs"), { recursive: true });
	await fs.mkdir(path.join(appData, "Godot"), { recursive: true });
	await fs.writeFile(path.join(projectRoot, "project.godot"), [
		"[application]",
		"config/name=\"Daedalus Test\"",
		"run/main_scene=\"res://scenes/main.tscn\"",
		"",
		"[debug]",
		"file_logging/enable_file_logging.pc=true",
		"",
		"[input]",
		"jump={",
		"\"deadzone\": 0.2,",
		"\"events\": [Object(InputEventKey,\"resource_local_to_scene\":false)]",
		"}",
		"",
		"[autoload]",
		"GameState=\"*res://scripts/game_state.gd\"",
		""
	].join("\n"), "utf8");
	await fs.writeFile(path.join(projectRoot, "scripts", "game_state.gd"), "extends Node\n", "utf8");
	await fs.writeFile(path.join(projectRoot, "scripts", "player.gd"), [
		"extends CharacterBody2D",
		"const Missing = preload(\"res://assets/missing.png\")",
		""
	].join("\n"), "utf8");
	await fs.writeFile(path.join(projectRoot, "scripts", "enemy.gd"), [
		"@tool",
		"class_name Enemy",
		"extends CharacterBody2D",
		""
	].join("\n"), "utf8");
	await fs.writeFile(path.join(projectRoot, "scripts", "duplicate_enemy.gd"), [
		"class_name Enemy",
		"extends Node",
		""
	].join("\n"), "utf8");
	await fs.writeFile(path.join(projectRoot, "scripts", "global_thing.cs"), [
		"using Godot;",
		"",
		"[GlobalClass]",
		"public partial class GlobalThing : Node",
		"{",
		"}",
		""
	].join("\n"), "utf8");
	await fs.writeFile(path.join(projectRoot, "addons", "demo", "addon_class.gd"), [
		"class_name AddonClass",
		"extends Node",
		""
	].join("\n"), "utf8");
	await fs.writeFile(path.join(projectRoot, "addons", "gut", "gut_cmdln.gd"), "extends SceneTree\n", "utf8");
	await fs.writeFile(path.join(projectRoot, "tests", "test_player.gd"), [
		"extends GutTest",
		"",
		"func test_player_moves():",
		"\tpass",
		""
	].join("\n"), "utf8");
	await fs.writeFile(path.join(projectRoot, "tests", "test_math.py"), [
		"def test_addition():",
		"\tassert 1 + 1 == 2",
		""
	].join("\n"), "utf8");
	await fs.writeFile(path.join(projectRoot, "assets", "player.png"), "", "utf8");
	await fs.writeFile(path.join(projectRoot, "assets", "player.png.import"), [
		"[remap]",
		"importer=\"texture\"",
		"type=\"CompressedTexture2D\"",
		"uid=\"uid://player\"",
		"path=\"res://.godot/imported/player.png-abc.ctex\"",
		"",
		"[deps]",
		"source_file=\"res://assets/player.png\"",
		"",
		"[params]",
		"compress/mode=0",
		""
	].join("\n"), "utf8");
	await fs.writeFile(path.join(projectRoot, "assets", "unused.png"), "", "utf8");
	await fs.writeFile(path.join(projectRoot, "Game.csproj"), [
		"<Project Sdk=\"Godot.NET.Sdk/4.4.0\">",
		"  <PropertyGroup>",
		"    <TargetFramework>net8.0</TargetFramework>",
		"  </PropertyGroup>",
		"  <ItemGroup>",
		"    <PackageReference Include=\"Newtonsoft.Json\" Version=\"13.0.3\" />",
		"    <ProjectReference Include=\"Shared/Shared.csproj\" />",
		"  </ItemGroup>",
		"</Project>",
		""
	].join("\n"), "utf8");
	await fs.writeFile(path.join(projectRoot, "Game.sln"), [
		"Microsoft Visual Studio Solution File, Format Version 12.00",
		"Project(\"{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}\") = \"Game\", \"Game.csproj\", \"{11111111-1111-1111-1111-111111111111}\"",
		"EndProject",
		""
	].join("\n"), "utf8");
	await fs.writeFile(path.join(projectRoot, "broken-csharp", "Broken.csproj"), [
		"<Project Sdk=\"Godot.NET.Sdk/4.4.0\">",
		"  <PropertyGroup>",
		"    <TargetFramework>net8.0</TargetFramework>",
		""
	].join("\n"), "utf8");
	await fs.writeFile(path.join(projectRoot, "scenes", "main.tscn"), [
		"[gd_scene load_steps=3 format=3]",
		"",
		"[ext_resource type=\"Script\" path=\"res://scripts/player.gd\" id=\"1_player\"]",
		"[ext_resource type=\"Texture2D\" path=\"res://assets/player.png\" id=\"2_player\"]",
		"",
		"[node name=\"Main\" type=\"Node2D\"]",
		"",
		"[node name=\"Player\" type=\"CharacterBody2D\" parent=\".\"]",
		"groups=[\"actors\", \"players\"]",
		"script=ExtResource(\"1_player\")",
		"",
		"[node name=\"StartButton\" type=\"Button\" parent=\".\"]",
		"",
		"[connection signal=\"pressed\" from=\"StartButton\" to=\"Player\" method=\"_on_start_pressed\"]",
		""
	].join("\n"), "utf8");
	await fs.writeFile(path.join(appData, "Godot", "app_userdata", "Daedalus Test", "logs", "godot.log"), [
		"first",
		"second",
		"third"
	].join("\n"), "utf8");
	await fs.writeFile(path.join(appData, "Godot", "editor_settings-4.7.tres"), [
		"[text_editor]",
		`external/editor_path="${path.join(userProfile, "tools", "editor.exe").replaceAll("\\", "/")}"`,
		""
	].join("\n"), "utf8");

	const { registerGodotToolsAndResources } = await import("../../../src/mcp/godot/registration.js");
	const server: FakeMcpServer = createFakeServer();
	registerGodotToolsAndResources(server as never);

	const blockedCreate = await callTool(server, "propose_create_text_file", {
		relativePath: ".godot/blocked.gd",
		content: "extends Node\n"
	});
	assert.equal(blockedCreate.valid, false);

	const proposedCreate = await callTool(server, "propose_create_text_file", {
		relativePath: "scripts/new_script.gd",
		content: "extends Node\n"
	});
	assert.equal(proposedCreate.valid, true);
	await assert.rejects(fs.access(path.join(projectRoot, "scripts", "new_script.gd")));

	const logTail = await callTool(server, "read_project_log", { lines: 2 });
	assert.deepEqual(logTail.lines, ["second", "third"]);

	const editorFiles = await callTool(server, "list_editor_config_files", {});
	const files = editorFiles.files as Array<Record<string, unknown>>;
	assert.ok(files.some((file: Record<string, unknown>): boolean => file.fileId === "global_config:editor_settings-4.7.tres"));

	const editorFile = await callTool(server, "read_editor_config_file", {
		fileId: "global_config:editor_settings-4.7.tres"
	});
	assert.match(String(editorFile.content), /%USERPROFILE%/);
	assert.doesNotMatch(String(editorFile.content), /profile-user/);

	const inputActions = await callTool(server, "get_input_actions", {});
	assert.equal((inputActions.actions as Array<Record<string, unknown>>)[0]?.action, "jump");

	const proposedInput = await callTool(server, "propose_set_input_action", {
		action: "dash",
		events: ["Object(InputEventKey,\"resource_local_to_scene\":false)"],
		deadzone: 0.25
	});
	assert.equal(proposedInput.valid, true);
	assert.doesNotMatch(await fs.readFile(path.join(projectRoot, "project.godot"), "utf8"), /dash=/);

	const setInput = await callTool(server, "set_input_action", {
		action: "dash",
		events: ["Object(InputEventKey,\"resource_local_to_scene\":false)"],
		deadzone: 0.25
	});
	assert.equal(setInput.modified, true);
	assert.match(await fs.readFile(path.join(projectRoot, "project.godot"), "utf8"), /dash=/);

	const autoloads = await callTool(server, "get_autoloads", {});
	assert.equal((autoloads.autoloads as Array<Record<string, unknown>>)[0]?.name, "GameState");
	assert.equal((autoloads.autoloads as Array<Record<string, unknown>>)[0]?.resourcePath, "res://scripts/game_state.gd");

	const proposedAutoload = await callTool(server, "propose_set_autoload", {
		name: "PlayerState",
		resourcePath: "res://scripts/player.gd"
	});
	assert.equal(proposedAutoload.valid, true);
	assert.doesNotMatch(await fs.readFile(path.join(projectRoot, "project.godot"), "utf8"), /PlayerState=/);

	const dependencies = await callTool(server, "analyze_project_dependencies", {});
	assert.equal((dependencies.missingReferences as Array<Record<string, unknown>>).some((reference: Record<string, unknown>): boolean => reference.targetPath === "assets/missing.png"), true);

	const unusedResources = await callTool(server, "find_unused_resources", {});
	assert.equal((unusedResources.unused as string[]).includes("assets/unused.png"), true);
	assert.equal((unusedResources.unused as string[]).includes("assets/player.png"), false);

	const sceneNodes = await callTool(server, "find_scene_nodes", {
		group: "players"
	});
	assert.equal((sceneNodes.matches as Array<Record<string, unknown>>)[0]?.nodePath, "Player");

	const scriptReferences = await callTool(server, "find_script_references", {
		scriptPath: "res://scripts/player.gd"
	});
	assert.equal((scriptReferences.references as Array<Record<string, unknown>>).some((reference: Record<string, unknown>): boolean => reference.sourcePath === "scenes/main.tscn"), true);

	const globalClasses = await callTool(server, "list_project_global_classes", {});
	const classNames: string[] = (globalClasses.classes as Array<Record<string, unknown>>).map((entry: Record<string, unknown>): string => String(entry.className));
	assert.equal(classNames.includes("Enemy"), true);
	assert.equal(classNames.includes("GlobalThing"), true);
	assert.equal(classNames.includes("AddonClass"), false);
	assert.equal((globalClasses.classes as Array<Record<string, unknown>>).some((entry: Record<string, unknown>): boolean => entry.className === "Enemy" && entry.isTool === true), true);

	const addonGlobalClasses = await callTool(server, "list_project_global_classes", { includeAddons: true });
	assert.equal((addonGlobalClasses.classes as Array<Record<string, unknown>>).some((entry: Record<string, unknown>): boolean => entry.className === "AddonClass"), true);

	const filteredGlobalClasses = await callTool(server, "list_project_global_classes", { filter: "global" });
	assert.deepEqual((filteredGlobalClasses.classes as Array<Record<string, unknown>>).map((entry: Record<string, unknown>): unknown => entry.className), ["GlobalThing"]);

	const projectTests = await callTool(server, "list_project_tests", {});
	const testEntries = projectTests.tests as Array<Record<string, unknown>>;
	assert.equal(testEntries.some((entry: Record<string, unknown>): boolean => entry.framework === "gut" && entry.runnable === true), true);
	assert.equal(testEntries.some((entry: Record<string, unknown>): boolean => entry.framework === "python" && (entry.matchedFunctions as string[]).includes("test_addition")), true);
	const missingTests = await callTool(server, "list_project_tests", { searchPath: "missing-tests" });
	assert.equal(missingTests.count, 0);

	const csharpSupport = await callTool(server, "inspect_csharp_project_support", {});
	assert.equal(csharpSupport.projectCount, 2);
	assert.equal(csharpSupport.solutionCount, 1);
	const csharpProject = (csharpSupport.projects as Array<Record<string, unknown>>)[0]!;
	assert.equal(csharpProject.usesGodotSdk, true);
	assert.deepEqual(csharpProject.targetFrameworks, ["net8.0"]);
	assert.deepEqual(csharpProject.projectReferences, ["Shared/Shared.csproj"]);
	const brokenCsharpSupport = await callTool(server, "inspect_csharp_project_support", { searchPath: "broken-csharp" });
	assert.match(String(((brokenCsharpSupport.projects as Array<Record<string, unknown>>)[0]?.issues as string[])[0]), /Malformed XML/u);

	const importMetadata = await callTool(server, "get_import_metadata", { resourcePath: "res://assets/player.png" });
	assert.equal(importMetadata.exists, true);
	assert.equal(importMetadata.importer, "texture");
	assert.equal(importMetadata.resourceType, "CompressedTexture2D");
	assert.equal(importMetadata.uid, "uid://player");
	assert.equal((importMetadata.params as Record<string, string>)["compress/mode"], "0");

	const missingImportMetadata = await callTool(server, "get_import_metadata", { resourcePath: "assets/unused.png" });
	assert.equal(missingImportMetadata.exists, false);
	await assert.rejects(callTool(server, "get_import_metadata", { resourcePath: "res://.godot/imported/player.ctex" }));

	const projectHealth = await callTool(server, "audit_project_health", {});
	assert.equal(projectHealth.status, "issues_found");
	const healthSummary = projectHealth.summary as Record<string, unknown>;
	assert.equal(healthSummary.duplicateGlobalClasses, 1);
	assert.equal(healthSummary.discoveredTests, 2);
	assert.equal(healthSummary.csharpProjects, 2);
	assert.equal((projectHealth.issues as Array<Record<string, unknown>>).some((issue: Record<string, unknown>): boolean => issue.kind === "duplicate_global_class"), true);
	assert.equal((projectHealth.issues as Array<Record<string, unknown>>).some((issue: Record<string, unknown>): boolean => issue.kind === "import_metadata" && issue.issue === "missing_import_metadata"), true);
});
