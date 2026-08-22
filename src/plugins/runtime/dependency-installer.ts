import { lstat, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { runCommandInvocationWait } from "../../mcp/terminal/process-runner.js";
import { createSandboxInvocation } from "../../mcp/terminal/sandbox-runner.js";
import type { TerminalCommandResult } from "../../mcp/terminal/types.js";
import type { PluginRecord, PluginDependencyStatus } from "../types.js";

function npmCommand(): string { return process.platform === "win32" ? "npm.cmd" : "npm"; }

async function rejectDependencyLinks(current: string): Promise<void> {
	for (const entry of await readdir(current, { withFileTypes: true })) {
		const path = `${current}/${entry.name}`;
		if (entry.isSymbolicLink()) throw Object.assign(new Error(`Plugin dependency contains a symbolic link: ${entry.name}`), { code: "plugin_dependency_symlink" });
		if (entry.isDirectory()) await rejectDependencyLinks(path);
	}
}

async function readLockfile(record: PluginRecord): Promise<Buffer> {
	for (const name of ["package-lock.json", "npm-shrinkwrap.json"]) {
		try { return await readFile(`${record.packageRoot}/${name}`); } catch { /* try the next supported lockfile */ }
	}
	throw new Error("Plugin requires a package-lock.json or npm-shrinkwrap.json lockfile.");
}

export async function resolveDependencyStatus(record: PluginRecord): Promise<PluginDependencyStatus> {
	try {
		const manifest = JSON.parse(await readFile(`${record.packageRoot}/package.json`, "utf8")) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
		const hasDependencies = Object.keys({ ...(manifest.dependencies ?? {}), ...(manifest.optionalDependencies ?? {}) }).length > 0;
		if (!hasDependencies) return "not_required";
		await readLockfile(record);
		await lstat(`${record.packageRoot}/node_modules`);
		return "ready";
	} catch {
		return "pending";
	}
}

export async function installPluginDependencies(record: PluginRecord, allowNetwork: boolean): Promise<{ status: PluginDependencyStatus; result?: TerminalCommandResult; lockHash?: string }> {
	const dependencyStatus = await resolveDependencyStatus(record);
	if (dependencyStatus === "not_required" || dependencyStatus === "ready") return { status: dependencyStatus };
	if (!allowNetwork) return { status: "needs_network" };
	try {
		const lockBytes = await readLockfile(record);
		const lockHash = createHash("sha256").update(lockBytes).digest("hex");
		const sandbox = createSandboxInvocation({
			command: { kind: "argv", command: npmCommand(), args: ["ci", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"] },
			cwd: record.packageRoot,
			workspaceRoot: record.packageRoot,
			env: { NPM_CONFIG_IGNORE_SCRIPTS: "true", NPM_CONFIG_USERCONFIG: process.platform === "win32" ? "NUL" : "/dev/null" },
			network: allowNetwork
		});
		if (!sandbox.available) return { status: "failed", result: { preset: "plugin-dependencies", ok: false, status: "spawn_error", exitCode: null, command: [sandbox.error], commandLine: sandbox.error, cwd: record.packageRoot, stdout: "", stderr: sandbox.error, durationMs: 0, truncated: false } };
		const result = await runCommandInvocationWait({
			presetName: "plugin-dependencies",
			invocation: { command: sandbox.command, args: sandbox.args, commandLine: "npm ci --ignore-scripts --omit=dev --no-audit --no-fund", env: sandbox.env, sandboxMode: sandbox.sandboxMode, workspaceRoot: record.packageRoot },
			cwd: record.packageRoot,
			timeoutMs: 10 * 60 * 1000,
			killProcessTree: true
		});
		if (result.ok) await rejectDependencyLinks(record.packageRoot);
		return { status: result.ok ? "ready" : "failed", result, lockHash };
	} catch (error: unknown) {
		return { status: "failed", result: { preset: "plugin-dependencies", ok: false, status: "spawn_error", exitCode: null, command: [], commandLine: "npm ci", cwd: record.packageRoot, stdout: "", stderr: error instanceof Error ? error.message : String(error), durationMs: 0, truncated: false } };
	}
}
