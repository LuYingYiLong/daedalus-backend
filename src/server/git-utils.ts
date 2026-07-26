import { spawn } from "node:child_process";

export type GitResult = {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	stdoutTruncated: boolean;
};

export type RunGitOptions = {
	allowedExitCodes?: readonly number[] | undefined;
	timeoutMs?: number | undefined;
	maxStdoutBytes?: number | undefined;
};

const DEFAULT_GIT_COMMAND_TIMEOUT_MS: number = 5000;

export function runGit(workspaceRoot: string, args: string[], options: RunGitOptions = {}): Promise<GitResult> {
	const allowedExitCodes: readonly number[] = options.allowedExitCodes ?? [0];
	const timeoutMs: number = options.timeoutMs ?? DEFAULT_GIT_COMMAND_TIMEOUT_MS;
	const maxStdoutBytes: number | undefined = options.maxStdoutBytes;

	return new Promise((resolve: (result: GitResult) => void, reject: (error: Error) => void): void => {
		const child = spawn("git", args, {
			cwd: workspaceRoot,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"]
		});
		let stdout: string = "";
		let stderr: string = "";
		let stdoutBytes: number = 0;
		let stdoutTruncated: boolean = false;
		let settled: boolean = false;
		const settle = (callback: () => void): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeout);
			callback();
		};
		const timeout = setTimeout((): void => {
			child.kill();
			settle((): void => reject(new Error("Git command timed out.")));
		}, timeoutMs);

		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: Buffer): void => {
			stdoutBytes += chunk.length;
			if (maxStdoutBytes !== undefined && stdoutBytes > maxStdoutBytes) {
				stdoutTruncated = true;
				child.kill();
				return;
			}
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: string): void => {
			stderr += chunk;
		});
		child.on("error", (error: Error): void => {
			settle((): void => reject(error));
		});
		child.on("close", (code: number | null): void => {
			if (stdoutTruncated) {
				settle((): void => resolve({ stdout: "", stderr, exitCode: code, stdoutTruncated: true }));
				return;
			}
			if (code !== null && allowedExitCodes.includes(code)) {
				settle((): void => resolve({ stdout, stderr, exitCode: code, stdoutTruncated: false }));
				return;
			}
			settle((): void => reject(new Error(stderr.trim() || `Git exited with code ${code ?? "unknown"}.`)));
		});
	});
}

export async function isInsideGitWorkTree(workspaceRoot: string): Promise<boolean> {
	try {
		const repoCheck: GitResult = await runGit(workspaceRoot, ["rev-parse", "--is-inside-work-tree"]);
		return repoCheck.stdout.trim() === "true";
	} catch {
		return false;
	}
}

export async function readGitBranch(workspaceRoot: string): Promise<string | null> {
	try {
		const branch: string = (await runGit(workspaceRoot, ["branch", "--show-current"])).stdout.trim();
		if (branch.length > 0) {
			return branch;
		}
		const revision: string = (await runGit(workspaceRoot, ["rev-parse", "--short", "HEAD"])).stdout.trim();
		return revision.length > 0 ? revision : null;
	} catch {
		return null;
	}
}
