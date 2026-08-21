import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { HarnessInstallation, HarnessRuntimeConfig } from "../types.js";
import { HARNESS_BRIDGE_PROTOCOL_VERSION } from "./limits.js";

const DETECTION_TIMEOUT_MS = 5_000;
const MAX_VERSION_OUTPUT_CHARS = 4_096;

function safeDetectionEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "HOME", "LANG", "LC_ALL"]) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	return env;
}

async function regularFile(path: string): Promise<string | undefined> {
	try {
		const resolved: string = await realpath(path);
		const info = await lstat(resolved);
		if (!info.isFile() || info.isSymbolicLink()) return undefined;
		await access(resolved, constants.R_OK);
		return resolved;
	} catch {
		return undefined;
	}
}

async function runVersion(command: string, args: string[], cwd: string): Promise<{ version?: string; error?: string }> {
	return await new Promise((resolveResult): void => {
		const child = spawn(command, args, { cwd, env: safeDetectionEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false });
		let output: string = "";
		const timer = setTimeout((): void => {
			child.kill();
			resolveResult({ error: "Harness version detection timed out." });
		}, DETECTION_TIMEOUT_MS);
		const append = (chunk: Buffer): void => { output = `${output}${chunk.toString("utf8")}`.slice(-MAX_VERSION_OUTPUT_CHARS); };
		child.stdout.on("data", append);
		child.stderr.on("data", append);
		child.once("error", (error: Error): void => { clearTimeout(timer); resolveResult({ error: error.message }); });
		child.once("close", (code: number | null): void => {
			clearTimeout(timer);
			if (code !== 0) { resolveResult({ error: output.trim() || `Harness exited with code ${String(code)}.` }); return; }
			const match = output.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/u);
			resolveResult(match === null ? { error: "Harness did not report a recognizable version." } : { version: match[0] });
		});
	});
}

async function detectInstalled(config: HarnessRuntimeConfig): Promise<HarnessInstallation> {
	if (config.executablePath === null || !isAbsolute(config.executablePath)) return { status: "unconfigured", launchMode: "installed", args: [], readOnlyPaths: [], bridgeProtocolVersion: HARNESS_BRIDGE_PROTOCOL_VERSION, bridgeCompatible: true, dependenciesReady: false, error: "Configure an absolute Harness executable path." };
	const executable: string | undefined = await regularFile(config.executablePath);
	if (executable === undefined) return { status: "failed", launchMode: "installed", args: [], readOnlyPaths: [], bridgeProtocolVersion: HARNESS_BRIDGE_PROTOCOL_VERSION, bridgeCompatible: true, dependenciesReady: false, error: "The configured Harness executable is not a regular readable file." };
	const isCmd: boolean = process.platform === "win32" && [".cmd", ".bat"].some((suffix): boolean => executable.toLowerCase().endsWith(suffix));
	const command: string = isCmd ? (process.env.ComSpec ?? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe")) : executable;
	const prefix: string[] = isCmd ? ["/d", "/s", "/c", "call", executable] : [];
	const result = await runVersion(command, [...prefix, "--version"], dirname(executable));
	return {
		status: result.version === undefined ? "failed" : "detected",
		launchMode: "installed",
		...(result.version === undefined ? {} : { version: result.version }),
		command,
		args: prefix,
		readOnlyPaths: [dirname(executable)],
		bridgeProtocolVersion: HARNESS_BRIDGE_PROTOCOL_VERSION,
		bridgeCompatible: true,
		dependenciesReady: result.version !== undefined,
		...(result.error === undefined ? {} : { error: result.error })
	};
}

async function detectSource(config: HarnessRuntimeConfig): Promise<HarnessInstallation> {
	if (config.sourceRoot === null || !isAbsolute(config.sourceRoot)) return { status: "unconfigured", launchMode: "source", args: [], readOnlyPaths: [], bridgeProtocolVersion: HARNESS_BRIDGE_PROTOCOL_VERSION, bridgeCompatible: true, dependenciesReady: false, error: "Configure an absolute Harness source root." };
	let root: string;
	try { root = await realpath(config.sourceRoot); }
	catch { return { status: "failed", launchMode: "source", args: [], readOnlyPaths: [], bridgeProtocolVersion: HARNESS_BRIDGE_PROTOCOL_VERSION, bridgeCompatible: true, dependenciesReady: false, error: "The configured Harness source root does not exist." }; }
	const builtCliEntry: string | undefined = await regularFile(join(root, "apps", "cli", "lib", "bin.js"));
	const sourceCliEntry: string | undefined = await regularFile(join(root, "apps", "cli", "src", "bin.ts"));
	const tsxPackage: string | undefined = await regularFile(join(root, "node_modules", "tsx", "package.json"));
	let version: string | undefined;
	try {
		const pkg = JSON.parse(await readFile(join(root, "apps", "cli", "package.json"), "utf8")) as { version?: unknown };
		if (typeof pkg.version === "string") version = pkg.version;
	} catch { /* Reported through the status below. */ }
	const sourceReady: boolean = sourceCliEntry !== undefined && tsxPackage !== undefined;
	const dependenciesReady: boolean = builtCliEntry !== undefined || sourceReady;
	const args: string[] = builtCliEntry !== undefined
		? [builtCliEntry]
		: sourceReady
			? ["--import", "tsx/esm", sourceCliEntry!]
			: [];
	return {
		status: dependenciesReady ? "detected" : "needs_setup",
		launchMode: "source",
		...(version === undefined ? {} : { version }),
		command: process.execPath,
		args,
		readOnlyPaths: [root],
		bridgeProtocolVersion: HARNESS_BRIDGE_PROTOCOL_VERSION,
		bridgeCompatible: true,
		dependenciesReady,
		...(dependenciesReady ? {} : { error: `Build the Harness CLI or install its workspace dependencies; ${basename(join(root, "apps", "cli", "lib", "bin.js"))} and the tsx source launcher are unavailable.` })
	};
}

export async function detectHarnessInstallation(config: HarnessRuntimeConfig): Promise<HarnessInstallation> {
	if (!config.enabled) return { status: "unconfigured", launchMode: config.launchMode, args: [], readOnlyPaths: [], bridgeProtocolVersion: HARNESS_BRIDGE_PROTOCOL_VERSION, bridgeCompatible: true, dependenciesReady: false, error: "Harness runtime is disabled." };
	return config.launchMode === "source" ? await detectSource(config) : await detectInstalled(config);
}
