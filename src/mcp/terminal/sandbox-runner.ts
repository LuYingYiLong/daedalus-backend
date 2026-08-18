import { accessSync, constants, existsSync, lstatSync, realpathSync } from "node:fs";
import * as path from "node:path";

export const UNSANDBOXED_CONSENT_TEXT: string = "RUN WITHOUT SANDBOX";
export const CROSS_WORKSPACE_UNSANDBOXED_CONSENT_PREFIX: string = "ALLOW CROSS-WORKSPACE AND RUN WITHOUT SANDBOX: ";

export type SandboxCommand =
	| { kind: "shell"; commandLine: string }
	| { kind: "argv"; command: string; args: readonly string[] };

export type SandboxAvailability =
	| { available: true; helperPath?: string | undefined }
	| { available: false; error: string };

export type SandboxInvocation =
	| {
		available: true;
		command: string;
		args: string[];
		env: Record<string, string>;
		sandboxMode: "os-sandbox";
	}
	| {
		available: false;
		error: string;
		sandboxMode: "os-sandbox";
	};

export type SandboxRuntimeOptions = {
	platform?: NodeJS.Platform | undefined;
	env?: NodeJS.ProcessEnv | undefined;
};

function splitPathEnv(value: string | undefined): string[] {
	return (value ?? "").split(path.delimiter).filter((entry: string): boolean => entry.length > 0);
}

function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
	for (const directory of splitPathEnv(env.PATH ?? env.Path)) {
		const candidate: string = path.join(directory, name);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			continue;
		}
	}
	return null;
}

function resolveWindowsSandboxHelper(env: NodeJS.ProcessEnv): SandboxAvailability {
	const configuredPath: string | undefined = env.DAEDALUS_WINDOWS_SANDBOX_HELPER?.trim();
	if (configuredPath === undefined || configuredPath.length === 0) {
		return {
			available: false,
			error: "sandbox_unavailable: DAEDALUS_WINDOWS_SANDBOX_HELPER is not configured."
		};
	}
	if (!path.isAbsolute(configuredPath)) {
		return {
			available: false,
			error: "sandbox_unavailable: the Windows sandbox helper path must be absolute."
		};
	}
	const resolvedPath: string = path.resolve(configuredPath);
	try {
		if (!existsSync(resolvedPath) || !lstatSync(resolvedPath).isFile()) {
			throw new Error("the configured helper is not a regular file");
		}
		const realPath: string = realpathSync(resolvedPath);
		if (path.resolve(realPath).toLowerCase() !== resolvedPath.toLowerCase()) {
			throw new Error("symbolic links and junctions are not allowed for the helper");
		}
		return { available: true, helperPath: realPath };
	} catch (error: unknown) {
		return {
			available: false,
			error: `sandbox_unavailable: invalid Windows sandbox helper: ${error instanceof Error ? error.message : "unknown error"}.`
		};
	}
}

export function getSandboxAvailability(options: SandboxRuntimeOptions = {}): SandboxAvailability {
	const platform: NodeJS.Platform = options.platform ?? process.platform;
	const env: NodeJS.ProcessEnv = options.env ?? process.env;
	if (platform === "win32") {
		return resolveWindowsSandboxHelper(env);
	}
	if (platform === "linux") {
		const executablePath: string | null = findExecutable("bwrap", env);
		return executablePath === null
			? { available: false, error: "sandbox_unavailable: bwrap is not installed or not in PATH." }
			: { available: true, helperPath: executablePath };
	}
	if (platform === "darwin") {
		const executablePath: string | null = findExecutable("sandbox-exec", env);
		return executablePath === null
			? { available: false, error: "sandbox_unavailable: sandbox-exec is not available." }
			: { available: true, helperPath: executablePath };
	}
	return {
		available: false,
		error: `sandbox_unavailable: unsupported platform ${platform}.`
	};
}

export function createSandboxEnvironment(
	extraEnv: Record<string, string> | undefined,
	options: SandboxRuntimeOptions = {}
): Record<string, string> {
	const platform: NodeJS.Platform = options.platform ?? process.platform;
	const sourceEnv: NodeJS.ProcessEnv = options.env ?? process.env;
	const allowedKeys: string[] = platform === "win32"
		? ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE"]
		: ["PATH", "LANG", "LC_ALL"];
	const env: Record<string, string> = {};
	for (const key of allowedKeys) {
		const value: string | undefined = sourceEnv[key];
		if (value !== undefined) {
			env[key] = value;
		}
	}
	if (platform !== "win32") {
		env.HOME = "/tmp/daedalus-home";
		env.TMPDIR = "/tmp";
		env.SHELL = "/bin/sh";
	}
	for (const [key, value] of Object.entries(extraEnv ?? {})) {
		env[key] = value;
	}
	return env;
}

function createBubblewrapEnvironmentArgs(env: Record<string, string>): string[] {
	return Object.entries(env).flatMap(([key, value]: [string, string]): string[] => ["--setenv", key, value]);
}

function escapeSandboxProfileLiteral(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

function createMacSandboxProfile(workspaceRoot: string, readOnlyPaths: readonly string[]): string {
	const readableSystemPaths: string[] = [
		"/System",
		"/Library",
		"/bin",
		"/sbin",
		"/usr",
		"/opt/homebrew",
		"/usr/local",
		"/private/etc"
	];
	const readRules: string = readableSystemPaths
		.map((value: string): string => `(subpath "${escapeSandboxProfileLiteral(value)}")`)
		.join(" ");
	const additionalReadRules: string = readOnlyPaths
		.map((value: string): string => `(subpath "${escapeSandboxProfileLiteral(value)}")`)
		.join(" ");
	const escapedWorkspaceRoot: string = escapeSandboxProfileLiteral(workspaceRoot);
	return [
		"(version 1)",
		"(deny default)",
		"(allow process*)",
		"(allow sysctl-read)",
		`(allow file-read* ${readRules} ${additionalReadRules} (subpath "${escapedWorkspaceRoot}") (subpath "/private/tmp") (subpath "/tmp"))`,
		`(allow file-write* (subpath "${escapedWorkspaceRoot}") (subpath "/private/tmp") (subpath "/tmp"))`
	].join("\n");
}

function createWindowsHelperArgs(command: SandboxCommand, workspaceRoot: string, cwd: string, readOnlyPaths: readonly string[]): string[] {
	const commonArgs: string[] = [
		"--workspace", workspaceRoot,
		"--cwd", cwd,
		...readOnlyPaths.flatMap((value: string): string[] => ["--read-only", value])
	];
	return command.kind === "shell"
		? [...commonArgs, "--shell", "--", command.commandLine]
		: [...commonArgs, "--argv", "--", command.command, ...command.args];
}

function resolveReadOnlyPaths(
	readOnlyPaths: readonly string[] | undefined,
	env: Record<string, string>,
	platform: NodeJS.Platform,
	workspaceRoot: string
): string[] {
	const candidates: string[] = [
		...(readOnlyPaths ?? []),
		...(platform === "win32" ? [] : splitPathEnv(env.PATH))
	];
	const resolvedPaths: Set<string> = new Set();
	const systemRoots: readonly string[] = ["/bin", "/sbin", "/usr", "/lib", "/lib64", "/opt", "/System", "/Library"];
	for (const candidate of candidates) {
		if (!path.isAbsolute(candidate) || !existsSync(candidate)) continue;
		let resolvedPath: string;
		try {
			resolvedPath = realpathSync(candidate);
		} catch {
			continue;
		}
		if (resolvedPath === workspaceRoot || resolvedPath.startsWith(`${workspaceRoot}${path.sep}`)) continue;
		if (platform !== "win32" && systemRoots.some((root: string): boolean =>
			resolvedPath === root || resolvedPath.startsWith(`${root}/`)
		)) continue;
		resolvedPaths.add(resolvedPath);
	}
	return [...resolvedPaths];
}

function createBubblewrapParentDirectoryArgs(paths: readonly string[]): string[] {
	const directories: Set<string> = new Set();
	for (const value of paths) {
		let currentPath: string = path.posix.dirname(value.replaceAll("\\", "/"));
		while (currentPath !== "/" && currentPath !== ".") {
			directories.add(currentPath);
			currentPath = path.posix.dirname(currentPath);
		}
	}
	return [...directories]
		.sort((left: string, right: string): number => left.length - right.length)
		.flatMap((value: string): string[] => ["--dir", value]);
}

export function isUnsandboxedConsentText(value: string | undefined): boolean {
	return value === UNSANDBOXED_CONSENT_TEXT
		|| value?.startsWith(CROSS_WORKSPACE_UNSANDBOXED_CONSENT_PREFIX) === true;
}

export function createSandboxInvocation(params: {
	command: SandboxCommand;
	cwd: string;
	workspaceRoot: string;
	env?: Record<string, string> | undefined;
	readOnlyPaths?: readonly string[] | undefined;
	runtime?: SandboxRuntimeOptions | undefined;
}): SandboxInvocation {
	const runtime: SandboxRuntimeOptions = params.runtime ?? {};
	const platform: NodeJS.Platform = runtime.platform ?? process.platform;
	const env: Record<string, string> = createSandboxEnvironment(params.env, runtime);
	const readOnlyPaths: string[] = resolveReadOnlyPaths(params.readOnlyPaths, env, platform, params.workspaceRoot);
	const availability: SandboxAvailability = getSandboxAvailability(runtime);
	if (!availability.available) {
		return {
			available: false,
			error: availability.error,
			sandboxMode: "os-sandbox"
		};
	}
	if (platform === "win32") {
		return {
			available: true,
			command: availability.helperPath!,
			args: createWindowsHelperArgs(params.command, params.workspaceRoot, params.cwd, readOnlyPaths),
			env,
			sandboxMode: "os-sandbox"
		};
	}

	if (platform === "linux") {
		const commandArgs: string[] = params.command.kind === "shell"
			? ["/bin/sh", "-lc", params.command.commandLine]
			: [params.command.command, ...params.command.args];
		return {
			available: true,
			command: availability.helperPath!,
			args: [
				"--unshare-all",
				"--die-with-parent",
				"--new-session",
				"--clearenv",
				...createBubblewrapEnvironmentArgs(env),
				"--proc", "/proc",
				"--dev", "/dev",
				"--tmpfs", "/tmp",
				"--dir", "/tmp/daedalus-home",
				...createBubblewrapParentDirectoryArgs([params.workspaceRoot, ...readOnlyPaths]),
				"--ro-bind", "/bin", "/bin",
				"--ro-bind", "/usr", "/usr",
				"--ro-bind-try", "/lib", "/lib",
				"--ro-bind-try", "/lib64", "/lib64",
				"--ro-bind-try", "/opt", "/opt",
				...readOnlyPaths.flatMap((value: string): string[] => ["--ro-bind", value, value]),
				"--bind", params.workspaceRoot, params.workspaceRoot,
				"--chdir", params.cwd,
				"--",
				...commandArgs
			],
			env,
			sandboxMode: "os-sandbox"
		};
	}

	if (platform === "darwin") {
		const profile: string = createMacSandboxProfile(params.workspaceRoot, readOnlyPaths);
		const commandArgs: string[] = params.command.kind === "shell"
			? ["/bin/sh", "-lc", params.command.commandLine]
			: [params.command.command, ...params.command.args];
		return {
			available: true,
			command: availability.helperPath!,
			args: ["-p", profile, ...commandArgs],
			env,
			sandboxMode: "os-sandbox"
		};
	}

	return {
		available: false,
		error: `sandbox_unavailable: unsupported platform ${platform}.`,
		sandboxMode: "os-sandbox"
	};
}
