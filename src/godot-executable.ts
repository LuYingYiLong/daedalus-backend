import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { spawn } from "node:child_process";

export const GODOT_VERSION_TIMEOUT_MS: number = 15_000;

export type GodotExecutableAvailability = {
	status: "ready" | "unavailable";
	path: string;
	version: string | null;
	error: string | null;
};

function runGodotVersion(executablePath: string, timeoutMs: number): Promise<{ version: string; stderr: string }> {
	return new Promise((resolve, reject): void => {
		const child = spawn(executablePath, ["--headless", "--version"], {
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"]
		});
		let stdout: string = "";
		let stderr: string = "";
		let settled: boolean = false;
		const finish = (callback: () => void): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeout);
			callback();
		};
		const timeout = setTimeout((): void => {
			child.kill();
			finish((): void => reject(new Error(`Godot version check timed out after ${timeoutMs} ms.`)));
		}, timeoutMs);

		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string): void => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk: string): void => {
			stderr += chunk;
		});
		child.once("error", (error: Error): void => {
			finish((): void => reject(error));
		});
		child.once("close", (code: number | null): void => {
			finish((): void => {
				if (code !== 0) {
					reject(new Error(stderr.trim() || `Godot exited with code ${code ?? "unknown"}.`));
					return;
				}
				const version: string = stdout.trim().split(/\r?\n/u)[0]?.trim() ?? "";
				if (version.length === 0) {
					reject(new Error("Godot returned an empty version."));
					return;
				}
				resolve({ version, stderr: stderr.trim() });
			});
		});
	});
}

export async function inspectGodotExecutable(
	executablePath: string,
	options: { requireAbsoluteFile?: boolean | undefined; timeoutMs?: number | undefined } = {}
): Promise<GodotExecutableAvailability> {
	const trimmedPath: string = executablePath.trim();
	if (trimmedPath.length === 0) {
		return {
			status: "unavailable",
			path: trimmedPath,
			version: null,
			error: "Godot executable path is empty."
		};
	}

	try {
		if (options.requireAbsoluteFile === true) {
			if (!isAbsolute(trimmedPath)) {
				throw new Error("Godot executable path must be absolute.");
			}
			const fileStat = await stat(trimmedPath);
			if (!fileStat.isFile()) {
				throw new Error("Godot executable path must point to a file.");
			}
		}

		const result = await runGodotVersion(trimmedPath, options.timeoutMs ?? GODOT_VERSION_TIMEOUT_MS);
		return {
			status: "ready",
			path: trimmedPath,
			version: result.version,
			error: null
		};
	} catch (error: unknown) {
		const detail: string = error instanceof Error ? error.message : "Unknown executable error.";
		return {
			status: "unavailable",
			path: trimmedPath,
			version: null,
			error: `Godot executable is unavailable: ${detail}`
		};
	}
}
