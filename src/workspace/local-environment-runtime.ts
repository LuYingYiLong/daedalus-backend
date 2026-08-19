import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runCommandInvocationWait } from "../mcp/terminal/process-runner.js";
import { createSandboxInvocation } from "../mcp/terminal/sandbox-runner.js";
import type { TerminalCommandResult } from "../mcp/terminal/types.js";
import type { SessionWorktreeMetadata, SessionWorktreeSource, WorkspaceConfig, WorkspaceSourceFolder } from "./types.js";
import { readLocalEnvironmentConfig } from "./local-environment.js";
import { readWorktreeSettings } from "./worktree-settings.js";

const MAX_LOG_CHARS: number = 200_000;
const SECRET_PATTERN: RegExp = /((?:api[_-]?key|authorization|auth[_-]?token|access[_-]?token|refresh[_-]?token|secret|password|passwd|bearer|cookie)\s*[:=]\s*)([^\s,;]+)/giu;

export type WorktreeSetupResult = {
	metadata: SessionWorktreeMetadata;
	ready: boolean;
	pendingTrust: Array<{ sourceFolderId: string; environmentId: string; fingerprint: string; network: boolean }>;
};

function redact(value: string): string {
	return value.replace(SECRET_PATTERN, "$1[redacted]");
}

function sourceWorkspaceFolder(workspace: WorkspaceConfig, sourceId: string): WorkspaceSourceFolder {
	const source = workspace.sourceFolders.find((candidate): boolean => candidate.id === sourceId);
	if (source === undefined) throw Object.assign(new Error(`Source folder not found: ${sourceId}`), { code: "environment_source_not_found" });
	return source;
}

function cloneMetadata(metadata: SessionWorktreeMetadata): SessionWorktreeMetadata {
	return structuredClone(metadata);
}

export async function runWorktreeSetup(params: {
	metadata: SessionWorktreeMetadata;
	sourceWorkspace: WorkspaceConfig;
	signal?: AbortSignal | undefined;
	onProgress?: ((source: SessionWorktreeSource, index: number, total: number) => Promise<void> | void) | undefined;
}): Promise<WorktreeSetupResult> {
	const metadata: SessionWorktreeMetadata = cloneMetadata(params.metadata);
	const pendingTrust: WorktreeSetupResult["pendingTrust"] = [];
	metadata.status = "setting-up";
	for (const [index, worktreeSource] of metadata.sources.entries()) {
		await params.onProgress?.(worktreeSource, index, metadata.sources.length);
		if (worktreeSource.environmentId == null) {
			worktreeSource.setupState = "not-required";
			continue;
		}
		const source: WorkspaceSourceFolder = sourceWorkspaceFolder(params.sourceWorkspace, worktreeSource.sourceFolderId);
		const document = await readLocalEnvironmentConfig(params.sourceWorkspace, source.id);
		const profile = document.profiles.find((candidate): boolean => candidate.id === worktreeSource.environmentId);
		if (profile === undefined) {
			worktreeSource.setupState = "failed";
			worktreeSource.setupSummary = { finishedAt: new Date().toISOString(), message: `Environment not found: ${worktreeSource.environmentId}` };
			metadata.status = "setup-failed";
			return { metadata, ready: false, pendingTrust };
		}
		worktreeSource.environmentFingerprint = profile.fingerprint;
		if (profile.setup === undefined || profile.resolvedSetupScript === null) {
			worktreeSource.setupState = "not-required";
			continue;
		}
		const needsNetwork: boolean = profile.setup.network === true;
		if (profile.trust === "review-required" || profile.trust === "disabled" || (needsNetwork && profile.trust !== "network-approved")) {
			worktreeSource.setupState = "pending-trust";
			pendingTrust.push({ sourceFolderId: source.id, environmentId: profile.id, fingerprint: profile.fingerprint, network: needsNetwork });
			continue;
		}
		const startedAtMs: number = Date.now();
		const startedAt: string = new Date(startedAtMs).toISOString();
		worktreeSource.setupState = "running";
		const readOnlyPaths: string[] = metadata.sources.filter((candidate): boolean => candidate.sourceFolderId !== source.id).map((candidate): string => candidate.worktreePath);
		const cacheRoot: string = join(worktreeSource.worktreePath, ".daedalus-cache");
		await mkdir(cacheRoot, { recursive: true });
		const sandbox = createSandboxInvocation({
			command: { kind: "shell", commandLine: profile.resolvedSetupScript },
			cwd: worktreeSource.worktreePath,
			workspaceRoot: worktreeSource.worktreePath,
			readOnlyPaths,
			env: {
				DAEDALUS_ENVIRONMENT_ID: profile.id,
				DAEDALUS_ENVIRONMENT_CACHE: cacheRoot,
				DAEDALUS_ENVIRONMENT_NETWORK: needsNetwork ? "enabled" : "disabled"
			}
		});
		let result: TerminalCommandResult;
		if (!sandbox.available) {
			result = {
				preset: "environment-setup", ok: false, status: "spawn_error", exitCode: null,
				command: [profile.resolvedSetupScript], commandLine: profile.resolvedSetupScript, cwd: worktreeSource.worktreePath,
				stdout: "", stderr: sandbox.error, durationMs: 0, truncated: false
			};
		} else {
			result = await runCommandInvocationWait({
				presetName: "environment-setup",
				invocation: {
					command: sandbox.command,
					args: sandbox.args,
					commandLine: profile.resolvedSetupScript,
					env: sandbox.env,
					sandboxMode: sandbox.sandboxMode,
					workspaceId: metadata.runtimeWorkspaceId,
					workspaceRoot: worktreeSource.worktreePath
				},
				cwd: worktreeSource.worktreePath,
				timeoutMs: (profile.setup.timeoutSeconds ?? 600) * 1000,
				killProcessTree: true,
				signal: params.signal
			});
		}
		const logDirectory: string = join((await readWorktreeSettings()).rootDirectory, ".logs", metadata.id);
		await mkdir(logDirectory, { recursive: true });
		const logPath: string = join(logDirectory, `${source.id}-setup.log`);
		await writeFile(logPath, redact(`${result.stdout}\n${result.stderr}`).slice(0, MAX_LOG_CHARS), "utf8");
		worktreeSource.setupState = result.status === "cancelled" ? "interrupted" : result.ok ? "ready" : "failed";
		worktreeSource.setupSummary = {
			startedAt,
			finishedAt: new Date().toISOString(),
			exitCode: result.exitCode,
			durationMs: result.durationMs,
			message: result.ok ? "Setup completed." : redact(result.stderr || "Setup failed.").slice(0, 2000),
			logPath: resolve(logPath)
		};
		if (!result.ok) {
			metadata.status = "setup-failed";
			return { metadata, ready: false, pendingTrust };
		}
	}
	if (pendingTrust.length > 0) {
		metadata.status = "setting-up";
		return { metadata, ready: false, pendingTrust };
	}
	metadata.status = "ready";
	return { metadata, ready: true, pendingTrust };
}

export function skipPendingWorktreeSetup(metadata: SessionWorktreeMetadata): SessionWorktreeMetadata {
	const next: SessionWorktreeMetadata = cloneMetadata(metadata);
	for (const source of next.sources) {
		if (source.setupState === "pending-trust" || source.setupState === "failed" || source.setupState === "interrupted") source.setupState = "skipped";
	}
	next.status = "ready";
	return next;
}
