import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerTerminalTools } from "../../../src/mcp/terminal/registration.js";
import { COMMAND_PRESETS } from "../../../src/mcp/terminal/presets.js";
import { startCommandJob, runCommandWait } from "../../../src/mcp/terminal/process-runner.js";
import { terminalJobStore } from "../../../src/mcp/terminal/job-store.js";
import type { CommandPreset, TerminalJobRecord } from "../../../src/mcp/terminal/types.js";
import { parseToolResultSummary } from "../../../src/tools/tool-result-parser.js";
import { createRuntimeWorkspace, upsertRuntimeWorkspace } from "../../../src/workspace/registry.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

type FakeMcpServer = {
	tools: Map<string, ToolHandler>;
	registerTool(name: string, _config: unknown, handler: ToolHandler): void;
};

function createFakeTerminalServer(): FakeMcpServer {
	return {
		tools: new Map(),
		registerTool(name: string, _config: unknown, handler: ToolHandler): void {
			this.tools.set(name, handler);
		}
	};
}

async function callTerminalTool(server: FakeMcpServer, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
	const handler: ToolHandler | undefined = server.tools.get(name);
	assert.notEqual(handler, undefined);
	const result = await handler!(args);
	return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

function nodePreset(command: string): { preset: CommandPreset; command: string[] } {
	return {
		preset: {
			name: "test.node",
			description: "Node test command",
			command: [process.execPath, "-e", command],
			workingDirectory: process.cwd(),
			risk: "verify"
		},
		command: [process.execPath, "-e", command]
	};
}

async function withAppData<T>(fn: () => Promise<T>): Promise<T> {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const root: string = await mkdtemp(join(tmpdir(), "terminal-job-"));
	process.env.USERPROFILE = root;
	try {
		return await fn();
	} finally {
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		await rm(root, { recursive: true, force: true });
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve): void => {
		setTimeout(resolve, ms);
	});
}

async function waitForTerminalJob(jobId: string, expectedStatus: TerminalJobRecord["status"], timeoutMs: number = 3000): Promise<TerminalJobRecord | null> {
	const deadline: number = Date.now() + timeoutMs;
	let lastRecord: TerminalJobRecord | null = null;
	while (Date.now() < deadline) {
		lastRecord = await terminalJobStore.get(jobId);
		if (lastRecord?.status === expectedStatus) {
			return lastRecord;
		}
		await sleep(50);
	}

	return lastRecord;
}

test("terminal wait mode preserves immediate command result shape", async (): Promise<void> => {
	await withAppData(async (): Promise<void> => {
		const { preset, command } = nodePreset("console.log('wait-ok')");
		const streamedOutput: Array<{ stream: "stdout" | "stderr"; text: string }> = [];
		const result = await runCommandWait({
			preset,
			command,
			cwd: process.cwd(),
			timeoutMs: 5000,
			onOutput: (stream, text): void => {
				streamedOutput.push({ stream, text });
			}
		});

		assert.equal(result.ok, true);
		assert.equal(result.exitCode, 0);
		assert.match(result.stdout, /wait-ok/);
		assert.match(streamedOutput.filter((item): boolean => item.stream === "stdout").map((item): string => item.text).join(""), /wait-ok/);
		assert.equal(result.preset, "test.node");
	});
});

test("terminal wait mode reports cancellation and terminates the process", async (): Promise<void> => {
	await withAppData(async (): Promise<void> => {
		const { preset, command } = nodePreset("setTimeout(() => console.log('late'), 5000)");
		const abortController = new AbortController();
		const resultPromise = runCommandWait({
			preset,
			command,
			cwd: process.cwd(),
			timeoutMs: 5000,
			signal: abortController.signal
		});
		setTimeout((): void => abortController.abort(), 50);

		const result = await resultPromise;
		assert.equal(result.ok, false);
		assert.equal(result.status, "cancelled");
	});
});

test("terminal wait mode reports command timeout", async (): Promise<void> => {
	await withAppData(async (): Promise<void> => {
		const { preset, command } = nodePreset("setTimeout(() => console.log('late'), 5000)");
		const result = await runCommandWait({
			preset,
			command,
			cwd: process.cwd(),
			timeoutMs: 50
		});

		assert.equal(result.ok, false);
		assert.equal(result.status, "timed_out");
	});
});

test("terminal job mode returns job id and later completed status", async (): Promise<void> => {
	await withAppData(async (): Promise<void> => {
		const { preset, command } = nodePreset("setTimeout(() => { console.log('job-ok') }, 50)");
		const started: TerminalJobRecord = startCommandJob({
			preset,
			command,
			cwd: process.cwd(),
			timeoutMs: 5000,
			wakeAfterMs: 100,
			tailLines: 10
		});

		assert.equal(started.status, "running");
		assert.match(started.jobId, /^terminal-job-/);
		const record: TerminalJobRecord | null = await waitForTerminalJob(started.jobId, "completed");
		assert.notEqual(record, null);
		assert.equal(record?.status, "completed");
		assert.equal(record?.exitCode, 0);
		assert.match(record?.stdoutTail ?? "", /job-ok/);
	});
});

test("terminal job can be cancelled", async (): Promise<void> => {
	await withAppData(async (): Promise<void> => {
		const { preset, command } = nodePreset("setTimeout(() => { console.log('late') }, 5000)");
		const started: TerminalJobRecord = startCommandJob({
			preset,
			command,
			cwd: process.cwd(),
			timeoutMs: 10000,
			tailLines: 10
		});

		const cancelled: TerminalJobRecord = await terminalJobStore.cancel(started.jobId);
		assert.equal(cancelled.status, "cancelled");
	});
});

test("terminal job result parser exposes running job wakeup metadata", (): void => {
	const summary = parseToolResultSummary(
		"mcp_terminal_run_safe_preset",
		{ presetName: "backend.typecheck" },
		JSON.stringify({
			preset: "backend.typecheck",
			status: "running",
			jobId: "terminal-job-test",
			wakeAfterMs: 1000
		})
	);

	assert.equal(summary.validationStatus, "unknown");
	assert.equal(summary.terminalJobId, "terminal-job-test");
	assert.equal(summary.terminalJobStatus, "running");
	assert.equal(summary.terminalJobWakeAfterMs, 1000);
});

test("Godot runtime result parser exposes running job wakeup metadata", (): void => {
	const summary = parseToolResultSummary(
		"mcp_godot_run_project",
		{ scenePath: "scenes/main.tscn" },
		JSON.stringify({
			preset: "godot.run_project",
			status: "running",
			jobId: "terminal-job-godot",
			wakeAfterMs: 1000,
			scenePath: "scenes/main.tscn"
		})
	);

	assert.equal(summary.validationStatus, "unknown");
	assert.equal(summary.terminalJobId, "terminal-job-godot");
	assert.equal(summary.terminalJobStatus, "running");
	assert.equal(summary.terminalJobWakeAfterMs, 1000);
	assert.deepEqual(summary.artifactRefs, ["scenes/main.tscn"]);
});

test("terminal preset wrappers accept only their risk boundary", async (): Promise<void> => {
	const server: FakeMcpServer = createFakeTerminalServer();
	registerTerminalTools(server as never);
	const outsideRoot: string = await mkdtemp(join(tmpdir(), "terminal-risk-outside-"));

	try {
		for (const preset of COMMAND_PRESETS) {
			const args: Record<string, unknown> = {
				presetName: preset.name,
				resourcePath: "res://scripts/game.gd",
				workingDirectory: outsideRoot
			};
			const safeResult: Record<string, unknown> = await callTerminalTool(server, "run_safe_preset", args);
			if (preset.risk === "write") {
				assert.equal(safeResult.ok, false);
				assert.equal(safeResult.requiredRisk, "write");
			} else {
				assert.notEqual(safeResult.error, `Preset '${preset.name}' has risk '${preset.risk}', not allowed by this tool.`);
			}

			const writeResult: Record<string, unknown> = await callTerminalTool(server, "run_write_preset", args);
			assert.equal(writeResult.preset, preset.name);
			assert.notEqual(writeResult.error, `Preset '${preset.name}' has risk '${preset.risk}', not allowed by this tool.`);
		}
	} finally {
		await rm(outsideRoot, { recursive: true, force: true });
	}
});

test("terminal capabilities use injected workspace context", async (): Promise<void> => {
	await withAppData(async (): Promise<void> => {
		const server: FakeMcpServer = createFakeTerminalServer();
		registerTerminalTools(server as never);
		const workspaceRoot: string = await mkdtemp(join(tmpdir(), "terminal-workspace-"));
		await writeFile(join(workspaceRoot, "project.godot"), "[application]\n", "utf8");
		const workspace = upsertRuntimeWorkspace(createRuntimeWorkspace(workspaceRoot, "godot-test"));

		try {
			const capabilities: Record<string, unknown> = await callTerminalTool(server, "get_terminal_capabilities", {
				__daedalusWorkspaceId: workspace.id
			});
			const presets = capabilities.presets as Array<Record<string, unknown>>;
			const godotPreset = presets.find((preset: Record<string, unknown>): boolean => preset.name === "godot.check_only");
			const workspaceTypecheckPreset = presets.find((preset: Record<string, unknown>): boolean => preset.name === "workspace.typecheck");

			assert.equal(godotPreset?.godotProjectPath, workspace.rootPath);
			assert.equal(godotPreset?.godotExecutablePath, "godot-test");
			assert.match(String(godotPreset?.command), /godot-test/);
			assert.equal(workspaceTypecheckPreset?.workingDirectory, workspace.rootPath);
		} finally {
			await rm(workspaceRoot, { recursive: true, force: true });
		}
	});
});

test("terminal capabilities do not treat ordinary workspaces as Godot projects", async (): Promise<void> => {
	await withAppData(async (): Promise<void> => {
		const server: FakeMcpServer = createFakeTerminalServer();
		registerTerminalTools(server as never);
		const workspaceRoot: string = await mkdtemp(join(tmpdir(), "terminal-ordinary-workspace-"));
		const workspace = upsertRuntimeWorkspace(createRuntimeWorkspace(workspaceRoot));

		try {
			const capabilities: Record<string, unknown> = await callTerminalTool(server, "get_terminal_capabilities", {
				__daedalusWorkspaceId: workspace.id
			});
			const presets = capabilities.presets as Array<Record<string, unknown>>;
			const godotPreset = presets.find((preset: Record<string, unknown>): boolean => preset.name === "godot.check_only");
			const workspaceTypecheckPreset = presets.find((preset: Record<string, unknown>): boolean => preset.name === "workspace.typecheck");

			assert.equal(godotPreset?.godotProjectPath, null);
			assert.equal(workspaceTypecheckPreset?.workingDirectory, workspace.rootPath);
		} finally {
			await rm(workspaceRoot, { recursive: true, force: true });
		}
	});
});

test("terminal verification presets return not_applicable before running unsupported workspace checks", async (): Promise<void> => {
	await withAppData(async (): Promise<void> => {
		const server: FakeMcpServer = createFakeTerminalServer();
		registerTerminalTools(server as never);
		const workspaceRoot: string = await mkdtemp(join(tmpdir(), "terminal-empty-workspace-"));
		const workspace = upsertRuntimeWorkspace(createRuntimeWorkspace(workspaceRoot));

		try {
			const gitResult: Record<string, unknown> = await callTerminalTool(server, "run_safe_preset", {
				presetName: "git.status",
				__daedalusWorkspaceId: workspace.id
			});
			const typecheckResult: Record<string, unknown> = await callTerminalTool(server, "run_safe_preset", {
				presetName: "workspace.typecheck",
				__daedalusWorkspaceId: workspace.id
			});

			assert.equal(gitResult.validationStatus, "not_applicable");
			assert.equal(typecheckResult.validationStatus, "not_applicable");
			assert.equal(gitResult.applicabilityCode, "git_repository_missing");
			assert.equal(typecheckResult.applicabilityCode, "package_manifest_missing");
			assert.equal(gitResult.status, "not_applicable");
			assert.equal(typecheckResult.status, "not_applicable");
		} finally {
			await rm(workspaceRoot, { recursive: true, force: true });
		}
	});
});
