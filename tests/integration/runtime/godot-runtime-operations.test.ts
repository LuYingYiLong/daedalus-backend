import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

type FakeMcpServer = {
	tools: Map<string, ToolHandler>;
	registerTool(name: string, _config: unknown, handler: ToolHandler): void;
};

function createFakeServer(): FakeMcpServer {
	return {
		tools: new Map(),
		registerTool(name: string, _config: unknown, handler: ToolHandler): void {
			this.tools.set(name, handler);
		}
	};
}

async function callTool(server: FakeMcpServer, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
	const handler: ToolHandler | undefined = server.tools.get(name);
	assert.notEqual(handler, undefined);
	const result = await handler!(args);
	return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

test("Godot runtime and headless operation tools keep commands scoped and shell-free", async (): Promise<void> => {
	const previousProjectPath: string | undefined = process.env.GODOT_PROJECT_PATH;
	const previousExecutablePath: string | undefined = process.env.GODOT_EXECUTABLE_PATH;
	const previousAppData: string | undefined = process.env.APPDATA;
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const previousSandboxHelper: string | undefined = process.env.DAEDALUS_WINDOWS_SANDBOX_HELPER;
	const root: string = await mkdtemp(path.join(tmpdir(), "godot-runtime-"));
	const projectRoot: string = path.join(root, "project");
	const appDataRoot: string = path.join(root, "appdata");

	await mkdir(path.join(projectRoot, "scenes"), { recursive: true });
	await mkdir(appDataRoot, { recursive: true });
	await writeFile(path.join(projectRoot, "project.godot"), "[application]\nconfig/name=\"Runtime Test\"\n", "utf8");

	process.env.GODOT_PROJECT_PATH = projectRoot;
	process.env.GODOT_EXECUTABLE_PATH = "fake-godot";
	process.env.APPDATA = appDataRoot;
	process.env.USERPROFILE = appDataRoot;
	// 此测试验证沙箱不可用分支，不应被开发机已有的 helper 构建产物改变
	process.env.DAEDALUS_WINDOWS_SANDBOX_HELPER = path.join(root, "unavailable-helper.exe");

	try {
		const runtimeTools = await import("../../../src/mcp/godot/tools/runtime-tools.js");
		const headlessTools = await import("../../../src/mcp/godot/tools/headless-operations.js");

		assert.deepEqual(runtimeTools.buildLaunchEditorCommand(), ["fake-godot", "--path", projectRoot, "--editor"]);
		assert.deepEqual(runtimeTools.buildRunProjectCommand("scenes/main.tscn", true), ["fake-godot", "--path", projectRoot, "--debug", "res://scenes/main.tscn"]);
		assert.throws((): void => {
			runtimeTools.toRuntimeResPath("../outside.tscn");
		}, /outside Godot project|traversal/u);

		const invocation = await headlessTools.buildGodotHeadlessOperationInvocation({
			operation: "get_uid",
			resource_path: "res://scenes/main.tscn"
		});
		assert.equal(invocation.executable, "fake-godot");
		assert.deepEqual(invocation.args.slice(0, 4), ["--headless", "--disable-crash-handler", "--path", projectRoot]);
		assert.ok(invocation.args.includes("--script"));
		assert.equal(invocation.args.at(-2), "--");
		assert.deepEqual(JSON.parse(invocation.args.at(-1)!), {
			operation: "get_uid",
			resource_path: "res://scenes/main.tscn"
		});
		assert.equal(invocation.cwd, projectRoot);

		const runtimeServer: FakeMcpServer = createFakeServer();
		runtimeTools.registerRuntimeTools(runtimeServer as never);
		const statusResult: Record<string, unknown> = await callTool(runtimeServer, "get_runtime_status", {});
		assert.equal(statusResult.ok, false);
		assert.equal(statusResult.godotExecutablePath, "fake-godot");
		assert.equal(statusResult.godotExecutableStatus, "unavailable");
		assert.equal(statusResult.environmentIssue, true);
		assert.deepEqual(statusResult.activeJob, null);
		assert.deepEqual(statusResult.capabilities, {
			runtimeLifecycle: false,
			debugOutputTail: true,
			headlessOperations: false,
			projectDiscovery: true
		});
		const launchResult: Record<string, unknown> = await callTool(runtimeServer, "launch_editor", {});
		assert.equal(launchResult.ok, false);
		assert.equal(launchResult.code, "sandbox_unavailable");
		assert.equal(launchResult.jobId, undefined);

		const projectsResult: Record<string, unknown> = await callTool(runtimeServer, "list_projects", {
			directory: projectRoot
		});
		assert.equal(projectsResult.ok, true);
		assert.deepEqual(projectsResult.projects, [{ path: projectRoot, current: true }]);

		const outsideRoot: string = path.join(root, "outside");
		await mkdir(outsideRoot, { recursive: true });
		await assert.rejects(
			callTool(runtimeServer, "list_projects", { directory: outsideRoot }),
			/outside allowed roots/u
		);

		const headlessServer: FakeMcpServer = createFakeServer();
		headlessTools.registerHeadlessOperationTools(headlessServer as never);
		await assert.rejects(
			callTool(headlessServer, "resave_resource", { resourcePath: "addons/plugin/data.tres" }),
			/Writing to addons/u
		);
		await assert.rejects(
			callTool(headlessServer, "resave_resource", { resourcePath: "icon.png" }),
			/Unsupported headless operation extension/u
		);
	} finally {
		if (previousSandboxHelper === undefined) delete process.env.DAEDALUS_WINDOWS_SANDBOX_HELPER;
		else process.env.DAEDALUS_WINDOWS_SANDBOX_HELPER = previousSandboxHelper;
		if (previousProjectPath === undefined) {
			delete process.env.GODOT_PROJECT_PATH;
		} else {
			process.env.GODOT_PROJECT_PATH = previousProjectPath;
		}
		if (previousExecutablePath === undefined) {
			delete process.env.GODOT_EXECUTABLE_PATH;
		} else {
			process.env.GODOT_EXECUTABLE_PATH = previousExecutablePath;
		}
		if (previousAppData === undefined) {
			delete process.env.APPDATA;
		} else {
			process.env.APPDATA = previousAppData;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
