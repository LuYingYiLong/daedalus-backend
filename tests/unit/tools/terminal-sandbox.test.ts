import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	createSandboxEnvironment,
	createSandboxInvocation,
	getSandboxAvailability
} from "../../../src/mcp/terminal/sandbox-runner.js";
import { createTerminalCommandAuthorization } from "../../../src/mcp/terminal/authorization.js";
import { createReviewedRuntimeEnvironment, resolveSandboxedProcessInvocation } from "../../../src/mcp/terminal/sandbox-execution.js";
import { annotateTerminalEnvironmentFailure } from "../../../src/mcp/terminal/environment-diagnostics.js";
import { preflightTerminalEnvironment } from "../../../src/mcp/terminal/environment-preflight.js";
import { createWorkspaceRuntimeEnvironment, ensureWorkspaceRuntimeHome, getWorkspaceRuntimeHome } from "../../../src/mcp/terminal/runtime-home.js";

test("sandbox environments inherit only process essentials and explicit values", (): void => {
	const env = createSandboxEnvironment({ EXPLICIT_TOKEN: "configured" }, {
		platform: "win32",
		env: {
			Path: "C:\\Windows\\System32",
			SystemRoot: "C:\\Windows",
			SECRET_API_KEY: "must-not-leak"
		}
	});
	assert.equal(env.Path, "C:\\Windows\\System32");
	assert.equal(env.SystemRoot, "C:\\Windows");
	assert.equal(env.EXPLICIT_TOKEN, "configured");
	assert.equal(env.SECRET_API_KEY, undefined);
});

test("reviewed execute targets enter PATH while read-only targets do not", async (): Promise<void> => {
	const root: string = await mkdtemp(path.join(tmpdir(), "daedalus-runtime-profile-"));
	try {
		const executeRoot: string = path.join(root, "runtime");
		const readRoot: string = path.join(root, "data");
		await mkdir(executeRoot);
		await mkdir(readRoot);
		const env = createReviewedRuntimeEnvironment({ RUNTIME_HOME: executeRoot }, [
			{ path: executeRoot, mode: "execute" },
			{ path: readRoot, mode: "read" }
		], { platform: "win32", hostEnv: { Path: "C:\\Windows\\System32" } });
		assert.equal(env?.Path, `${executeRoot};C:\\Windows\\System32`);
		assert.equal(env?.RUNTIME_HOME, executeRoot);
		assert.equal(env?.PATH, undefined);
		assert.equal(env?.Path?.includes(readRoot), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("workspace terminal home is writable, stable and isolated from the host profile", async (): Promise<void> => {
	const workspace: string = await mkdtemp(path.join(tmpdir(), "daedalus-terminal-home-"));
	try {
		const env = createWorkspaceRuntimeEnvironment(workspace, { TOOL_SETTING: "safe" }, "win32");
		assert.equal(env.USERPROFILE, path.join(workspace, ".daedalus-terminal", "home"));
		assert.equal(env.TOOL_SETTING, "safe");
		ensureWorkspaceRuntimeHome(workspace);
		ensureWorkspaceRuntimeHome(workspace);
		assert.equal(realpathSync(getWorkspaceRuntimeHome(workspace)), getWorkspaceRuntimeHome(workspace));
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});

test("terminal preflight distinguishes sandbox-ready, reviewed external and absent runtimes", async (): Promise<void> => {
	const root: string = await mkdtemp(path.join(tmpdir(), "daedalus-runtime-preflight-"));
	try {
		const workspace: string = path.join(root, "workspace");
		const external: string = path.join(root, "external");
		await mkdir(workspace);
		await mkdir(external);
		await writeFile(path.join(workspace, "local-tool"), "tool");
		await writeFile(path.join(workspace, "local-tool.cmd"), "@echo off");
		await writeFile(path.join(external, "external-tool"), "tool");
		const result = preflightTerminalEnvironment({
			workspaceRoot: workspace,
			commands: ["local-tool", "external-tool", "missing-tool"],
			environmentVariables: ["LANG", "RUNTIME_HOME", "MISSING_HOME"],
			platform: "linux",
			env: { PATH: `${workspace}:${external}`, LANG: "en_US.UTF-8", RUNTIME_HOME: external }
		});
		assert.deepEqual(result.commands.map((item) => item.status), ["sandbox_ready", "external_access_required", "not_found"]);
		assert.deepEqual(result.environmentVariables.map((item) => item.status), ["sandbox_ready", "explicit_value_required", "not_set"]);
		const windowsResult = preflightTerminalEnvironment({
			workspaceRoot: workspace,
			commands: ["local-tool.cmd"],
			platform: "win32",
			env: { Path: external }
		});
		assert.equal(windowsResult.commands[0]?.status, "sandbox_ready");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("terminal launch errors are environment failures, not code validation failures", (): void => {
	const base = {
		preset: "terminal.command",
		ok: false,
		status: "failed" as const,
		exitCode: 2,
		command: ["helper"],
		commandLine: "echo hello",
		cwd: "C:\\workspace",
		stdout: "",
		stderr: "daedalus sandbox helper: sandbox command was not found in the restricted PATH",
		durationMs: 1,
		truncated: false
	};
	const environmentFailure = annotateTerminalEnvironmentFailure(base);
	assert.equal(environmentFailure.validationStatus, "not_applicable");
	assert.equal(environmentFailure.applicabilityCode, "terminal_runtime_unavailable");
	assert.equal(environmentFailure.environmentIssue, true);
	assert.equal(annotateTerminalEnvironmentFailure({ ...base, stderr: "src/main.ts: error TS1234" }).environmentIssue, undefined);
});

test("sandbox profiles deny network sharing and default macOS access", async (): Promise<void> => {
	const helperDirectory: string = await mkdtemp(path.join(tmpdir(), "daedalus-sandbox-"));
	try {
		for (const helperName of ["bwrap", "sandbox-exec"]) {
			const helperPath: string = path.join(helperDirectory, helperName);
			await writeFile(helperPath, "helper", "utf8");
			await chmod(helperPath, 0o755);
		}
		const linux = createSandboxInvocation({
			command: { kind: "argv", command: "npm", args: ["test"] },
			cwd: helperDirectory,
			workspaceRoot: helperDirectory,
			runtime: { platform: "linux", env: { PATH: helperDirectory } }
		});
		assert.equal(linux.available, true);
		if (linux.available) {
			assert.ok(linux.args.includes("--unshare-all"));
			assert.equal(linux.args.includes("--share-net"), false);
		}

		const mac = createSandboxInvocation({
			command: { kind: "shell", commandLine: "npm test" },
			cwd: helperDirectory,
			workspaceRoot: helperDirectory,
			runtime: { platform: "darwin", env: { PATH: helperDirectory } }
		});
		assert.equal(mac.available, true);
		if (mac.available) {
			const profile: string = mac.args[1] ?? "";
			assert.match(profile, /\(deny default\)/u);
			assert.doesNotMatch(profile, /\(allow default\)/u);
		}
	} finally {
		await rm(helperDirectory, { recursive: true, force: true });
	}
});

test("Windows sandbox helper must be an absolute regular file", (): void => {
	assert.deepEqual(getSandboxAvailability({
		platform: "win32",
		env: { DAEDALUS_WINDOWS_SANDBOX_HELPER: "relative-helper.exe" }
	}), {
		available: false,
		error: "sandbox_unavailable: the Windows sandbox helper path must be absolute."
	});
});

test("unsandboxed fallback consumes an exact, argument-bound one-shot authorization", (): void => {
	const args: Record<string, unknown> = { presetName: "workspace.typecheck" };
	const authorization = createTerminalCommandAuthorization({
		source: "user",
		requestId: "request-a",
		toolCallId: "call-a",
		workspaceId: "workspace-a",
		args,
		crossSandbox: {
			fingerprint: "host-fingerprint",
			boundary: "approved_unsandboxed",
			targets: [],
			networkAccess: false,
			sensitiveTarget: false
		}
	});
	const result = resolveSandboxedProcessInvocation({
		input: {
			...args,
			__daedalusApprovalMode: "manual",
			__daedalusConsentText: "RUN WITHOUT SANDBOX",
			__daedalusCommandAuthorization: authorization
		},
		command: { kind: "argv", command: "npm", args: ["run", "typecheck"] },
		commandLine: "npm run typecheck",
		cwd: "/workspace",
		workspaceRoot: "/workspace",
		workspaceId: "workspace-a",
		runtime: { platform: "aix", env: { PATH: "/usr/bin" } }
	});
	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.invocation.sandboxMode, "approved-unsandboxed");

	const replay = resolveSandboxedProcessInvocation({
		input: {
			...args,
			__daedalusApprovalMode: "manual",
			__daedalusConsentText: "RUN WITHOUT SANDBOX",
			__daedalusCommandAuthorization: authorization
		},
		command: { kind: "argv", command: "npm", args: ["run", "typecheck"] },
		commandLine: "npm run typecheck",
		cwd: "/workspace",
		workspaceRoot: "/workspace",
		workspaceId: "workspace-a",
		runtime: { platform: "aix", env: { PATH: "/usr/bin" } }
	});
	assert.equal(replay.ok, false);
	if (!replay.ok) assert.match(String(replay.result.error), /already consumed/u);
});

test("a model authorization permits one reviewed host invocation without user consent text", (): void => {
	const args: Record<string, unknown> = { presetName: "workspace.typecheck" };
	const authorization = createTerminalCommandAuthorization({
		source: "model",
		requestId: "request-model",
		toolCallId: "call-model",
		toolName: "mcp_terminal_run_safe_preset",
		workspaceId: "workspace-a",
		args,
		crossSandbox: {
			fingerprint: "model-host-fingerprint",
			boundary: "approved_unsandboxed",
			targets: [],
			networkAccess: false,
			sensitiveTarget: false
		}
	});
	const result = resolveSandboxedProcessInvocation({
		input: {
			...args,
			__daedalusApprovalMode: "auto-safe",
			__daedalusCommandAuthorization: authorization
		},
		command: { kind: "argv", command: "npm", args: ["run", "typecheck"] },
		commandLine: "npm run typecheck",
		cwd: "/workspace",
		workspaceRoot: "/workspace",
		workspaceId: "workspace-a",
		runtime: { platform: "aix", env: { PATH: "/usr/bin" } }
	});
	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.invocation.authorizationSource, "model");
});

test("reviewed external paths are mounted read-only in the Windows sandbox", async (): Promise<void> => {
	const root: string = await mkdtemp(path.join(tmpdir(), "daedalus-external-access-"));
	try {
		const helperPath: string = path.join(root, "sandbox-helper.exe");
		const workspaceRoot: string = path.join(root, "workspace");
		const externalRoot: string = path.join(root, "external");
		await writeFile(helperPath, "helper");
		await mkdir(workspaceRoot);
		await mkdir(externalRoot);
		const args: Record<string, unknown> = {
			commandLine: "tool.exe --version",
			externalAccess: {
				targets: [{ path: externalRoot, mode: "execute" }],
				reason: "Run the installed verifier."
			}
		};
		const targets = [{ path: realpathSync(externalRoot), mode: "execute" as const }];
		const authorization = createTerminalCommandAuthorization({
			source: "model",
			requestId: "request-external",
			toolCallId: "call-external",
			toolName: "mcp_terminal_run_command",
			workspaceId: "workspace-a",
			args,
			crossSandbox: {
				fingerprint: "external-fingerprint",
				boundary: "sandbox_external_read",
				targets,
				networkAccess: false,
				sensitiveTarget: false
			}
		});
		const result = resolveSandboxedProcessInvocation({
			input: {
				...args,
				__daedalusApprovalMode: "auto-safe",
				__daedalusCommandAuthorization: authorization
			},
			command: { kind: "shell", commandLine: "tool.exe --version" },
			commandLine: "tool.exe --version",
			cwd: workspaceRoot,
			workspaceRoot,
			externalReadOnlyPaths: [externalRoot],
			workspaceId: "workspace-a",
			runtime: {
				platform: "win32",
				env: { DAEDALUS_WINDOWS_SANDBOX_HELPER: helperPath }
			}
		});
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.invocation.sandboxMode, "os-sandbox");
			assert.equal(result.invocation.args.includes("--read-only"), true);
			assert.equal(result.invocation.args.includes(realpathSync(externalRoot)), true);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
