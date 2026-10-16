import { existsSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";
import { createSandboxEnvironment } from "./sandbox-runner.js";

export type TerminalEnvironmentCheck = {
	name: string;
	status: "sandbox_ready" | "external_access_required" | "not_found";
	resolvedPath?: string | undefined;
};

function isInside(root: string, candidate: string, platform: NodeJS.Platform): boolean {
	const relative: string = path.relative(root, candidate);
	const normalized: string = platform === "win32" ? relative.toLowerCase() : relative;
	return normalized.length === 0 || (!normalized.startsWith("..") && !path.isAbsolute(normalized));
}

function isSandboxReadable(candidate: string, workspaceRoot: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
	if (workspaceRoot.length > 0 && isInside(workspaceRoot, candidate, platform)) return true;
	if (platform === "win32") {
		const systemRoot: string | undefined = env.SystemRoot ?? env.WINDIR;
		return systemRoot !== undefined && isInside(systemRoot, candidate, platform);
	}
	if (platform === "darwin") {
		return ["/System", "/Library", "/bin", "/sbin", "/usr", "/opt/homebrew", "/usr/local"]
			.some((root: string): boolean => isInside(root, candidate, platform));
	}
	return ["/bin", "/sbin", "/usr", "/lib", "/lib64", "/opt"]
		.some((root: string): boolean => isInside(root, candidate, platform));
}

function findHostExecutable(name: string, workspaceRoot: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | undefined {
	const pathValue: string = env.Path ?? env.PATH ?? "";
	const pathSeparator: string = platform === "win32" ? ";" : ":";
	const extensions: string[] = platform === "win32"
		? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
		: [""];
	const roots: string[] = path.isAbsolute(name)
		? [""]
		: /[\\/]/u.test(name)
			? [workspaceRoot]
			: [...(platform === "win32" && workspaceRoot.length > 0 ? [workspaceRoot] : []), ...pathValue.split(pathSeparator).filter(Boolean)];
	for (const root of roots) {
		const base: string = root.length === 0 ? name : path.join(root, name);
		const candidates: string[] = platform === "win32" && path.extname(base).length > 0
			? [base]
			: extensions.map((extension: string): string => `${base}${extension}`);
		for (const candidate of candidates) {
			try {
				if (existsSync(candidate) && statSync(candidate).isFile()) return realpathSync(candidate);
			} catch {
				continue;
			}
		}
	}
	return undefined;
}

export function preflightTerminalEnvironment(params: {
	workspaceRoot: string;
	commands?: readonly string[] | undefined;
	environmentVariables?: readonly string[] | undefined;
	platform?: NodeJS.Platform | undefined;
	env?: NodeJS.ProcessEnv | undefined;
}): {
	commands: TerminalEnvironmentCheck[];
	environmentVariables: Array<{ name: string; status: "sandbox_ready" | "explicit_value_required" | "not_set" }>;
} {
	const platform: NodeJS.Platform = params.platform ?? process.platform;
	const sourceEnv: NodeJS.ProcessEnv = params.env ?? process.env;
	const sandboxEnv: Record<string, string> = createSandboxEnvironment(undefined, { platform, env: sourceEnv });
	return {
		commands: (params.commands ?? []).map((name: string): TerminalEnvironmentCheck => {
			const resolvedPath: string | undefined = findHostExecutable(name, params.workspaceRoot, platform, sourceEnv);
			if (resolvedPath === undefined) return { name, status: "not_found" };
			return {
				name,
				status: isSandboxReadable(resolvedPath, params.workspaceRoot, platform, sourceEnv)
					? "sandbox_ready" : "external_access_required",
				resolvedPath
			};
		}),
		environmentVariables: (params.environmentVariables ?? []).map((name: string) => ({
			name,
			status: sandboxEnv[name] !== undefined
				? "sandbox_ready" as const
				: sourceEnv[name] !== undefined ? "explicit_value_required" as const : "not_set" as const
		}))
	};
}
