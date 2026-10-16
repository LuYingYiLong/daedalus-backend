import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import * as path from "node:path";

export function getWorkspaceRuntimeHome(workspaceRoot: string): string {
	return path.join(workspaceRoot, ".daedalus-terminal");
}

export function createWorkspaceRuntimeEnvironment(
	workspaceRoot: string,
	inputEnv: Record<string, string> | undefined,
	platform: NodeJS.Platform = process.platform
): Record<string, string> {
	const runtimeRoot: string = getWorkspaceRuntimeHome(workspaceRoot);
	const home: string = path.join(runtimeRoot, "home");
	const cache: string = path.join(runtimeRoot, "cache");
	const temporary: string = path.join(runtimeRoot, "tmp");
	const defaults: Record<string, string> = {
		HOME: home,
		XDG_CACHE_HOME: cache,
		TMPDIR: temporary
	};
	if (platform === "win32") {
		defaults.USERPROFILE = home;
		defaults.APPDATA = path.join(home, "AppData", "Roaming");
		defaults.LOCALAPPDATA = path.join(home, "AppData", "Local");
		defaults.TEMP = temporary;
		defaults.TMP = temporary;
		defaults.HOMEDRIVE = path.parse(home).root.replace(/[\\/]$/u, "");
		defaults.HOMEPATH = home.slice(defaults.HOMEDRIVE.length);
	}
	return { ...defaults, ...(inputEnv ?? {}) };
}

export function ensureWorkspaceRuntimeHome(workspaceRoot: string): void {
	const canonicalRoot: string = realpathSync(workspaceRoot);
	const runtimeRoot: string = getWorkspaceRuntimeHome(canonicalRoot);
	const directories: string[] = [
		runtimeRoot,
		path.join(runtimeRoot, "home"),
		path.join(runtimeRoot, "home", "AppData"),
		path.join(runtimeRoot, "home", "AppData", "Roaming"),
		path.join(runtimeRoot, "home", "AppData", "Local"),
		path.join(runtimeRoot, "cache"),
		path.join(runtimeRoot, "tmp")
	];
	for (const directory of directories) {
		if (!existsSync(directory)) mkdirSync(directory);
		const entry = lstatSync(directory);
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			throw new Error(`Terminal runtime directory must be a real workspace directory: ${directory}`);
		}
		const relative: string = path.relative(canonicalRoot, realpathSync(directory));
		if (relative.startsWith("..") || path.isAbsolute(relative)) {
			throw new Error(`Terminal runtime directory escapes the workspace: ${directory}`);
		}
	}
}
