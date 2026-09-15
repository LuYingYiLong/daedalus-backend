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
import { resolveSandboxedProcessInvocation } from "../../../src/mcp/terminal/sandbox-execution.js";

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
