import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { getTerminalJobsDir } from "../../app-paths.js";
import { writeJsonFileAtomic } from "../../json-file-store.js";
import { MAX_STDERR_CHARS, MAX_STDOUT_CHARS, tailText, truncateOutput } from "./output-tail.js";
import type { RunningTerminalJob, TerminalJobRecord, TerminalJobStatus } from "./types.js";

function createJobId(): string {
	return `terminal-job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso(): string {
	return new Date().toISOString();
}

function getJobPath(jobId: string): string {
	if (!/^terminal-job-[a-z0-9_-]+$/i.test(jobId)) {
		throw new Error(`Invalid terminal job id: ${jobId}`);
	}

	return join(getTerminalJobsDir(), `${jobId}.json`);
}

function toPersistedRecord(record: TerminalJobRecord): TerminalJobRecord {
	const stdoutResult = truncateOutput(record.stdout, MAX_STDOUT_CHARS);
	const stderrResult = truncateOutput(record.stderr, MAX_STDERR_CHARS);
	return {
		...record,
		stdout: stdoutResult.text,
		stderr: stderrResult.text,
		truncated: record.truncated || stdoutResult.truncated || stderrResult.truncated
	};
}

export class TerminalJobStore {
	private readonly runningJobs: Map<string, RunningTerminalJob> = new Map();
	private persistQueue: Promise<void> = Promise.resolve();

	createRecord(params: {
		preset: string;
		command: string[];
		commandLine: string;
		cwd: string;
		timeoutMs: number;
		wakeAfterMs?: number | undefined;
		resourcePath?: string | null | undefined;
		godotProjectPath?: string | null | undefined;
		godotExecutablePath?: string | undefined;
		sandboxMode?: TerminalJobRecord["sandboxMode"] | undefined;
		workspaceId?: string | undefined;
		workspaceRoot?: string | undefined;
		trusted?: boolean | undefined;
		consentText?: string | undefined;
		authorizationSource?: "model" | "policy" | "user" | undefined;
	}): TerminalJobRecord {
		const startedAt: string = nowIso();
		const nextWakeAt: string | undefined = params.wakeAfterMs !== undefined
			? new Date(Date.now() + params.wakeAfterMs).toISOString()
			: undefined;
		return {
			jobId: createJobId(),
			preset: params.preset,
			status: "running",
			command: params.command,
			commandLine: params.commandLine,
			cwd: params.cwd,
			startedAt,
			updatedAt: startedAt,
			timeoutAt: new Date(Date.now() + params.timeoutMs).toISOString(),
			wakeAfterMs: params.wakeAfterMs,
			nextWakeAt,
			durationMs: 0,
			stdout: "",
			stderr: "",
			stdoutTail: "",
			stderrTail: "",
			truncated: false,
			resourcePath: params.resourcePath,
			godotProjectPath: params.godotProjectPath,
			godotExecutablePath: params.godotExecutablePath,
			sandboxMode: params.sandboxMode,
			workspaceId: params.workspaceId,
			workspaceRoot: params.workspaceRoot,
			trusted: params.trusted,
			consentText: params.consentText,
			authorizationSource: params.authorizationSource
		};
	}

	addRunning(job: RunningTerminalJob): void {
		this.runningJobs.set(job.record.jobId, job);
		void this.persist(job.record);
	}

	appendStdout(jobId: string, chunk: string, tailLines: number | undefined): void {
		const job: RunningTerminalJob | undefined = this.runningJobs.get(jobId);
		if (job === undefined) {
			return;
		}

		job.record.stdout += chunk;
		job.record.stdoutTail = tailText(job.record.stdout, tailLines);
		job.record.updatedAt = nowIso();
	}

	appendStderr(jobId: string, chunk: string, tailLines: number | undefined): void {
		const job: RunningTerminalJob | undefined = this.runningJobs.get(jobId);
		if (job === undefined) {
			return;
		}

		job.record.stderr += chunk;
		job.record.stderrTail = tailText(job.record.stderr, tailLines);
		job.record.updatedAt = nowIso();
	}

	async finish(jobId: string, status: TerminalJobStatus, exitCode: number | null, error?: string | undefined): Promise<TerminalJobRecord | undefined> {
		const job: RunningTerminalJob | undefined = this.runningJobs.get(jobId);
		if (job === undefined) {
			return undefined;
		}

		if (job.timeout !== undefined) {
			clearTimeout(job.timeout);
		}
		const finishedAt: string = nowIso();
		job.record.status = status;
		job.record.exitCode = exitCode;
		job.record.finishedAt = finishedAt;
		job.record.updatedAt = finishedAt;
		job.record.durationMs = new Date(finishedAt).getTime() - new Date(job.record.startedAt).getTime();
		if (error !== undefined) {
			job.record.error = error;
			job.record.stderr += `\n${error}`;
			job.record.stderrTail = tailText(job.record.stderr, undefined);
		}
		this.runningJobs.delete(jobId);
		await this.persist(job.record);
		return job.record;
	}

	async cancel(jobId: string): Promise<TerminalJobRecord> {
		const job: RunningTerminalJob | undefined = this.runningJobs.get(jobId);
		if (job === undefined) {
			const stored: TerminalJobRecord | null = await this.read(jobId);
			if (stored === null) {
				throw new Error(`Terminal job not found: ${jobId}`);
			}
			return stored;
		}

		job.child.kill();
		const record: TerminalJobRecord | undefined = await this.finish(jobId, "cancelled", null);
		if (record === undefined) {
			throw new Error(`Terminal job not found: ${jobId}`);
		}
		return record;
	}

	async persistSnapshot(record: TerminalJobRecord): Promise<void> {
		await this.persist(record);
	}

	async get(jobId: string): Promise<TerminalJobRecord | null> {
		const running: RunningTerminalJob | undefined = this.runningJobs.get(jobId);
		if (running !== undefined) {
			running.record.durationMs = Date.now() - new Date(running.record.startedAt).getTime();
			return toPersistedRecord(running.record);
		}

		return this.read(jobId);
	}

	async listRecent(limit: number = 20): Promise<TerminalJobRecord[]> {
		await mkdir(getTerminalJobsDir(), { recursive: true });
		const files: string[] = await readdir(getTerminalJobsDir());
		const records: TerminalJobRecord[] = [];
		for (const fileName of files.filter((file: string): boolean => file.endsWith(".json")).slice(-limit)) {
			try {
				const text: string = await readFile(join(getTerminalJobsDir(), fileName), "utf8");
				records.push(JSON.parse(text) as TerminalJobRecord);
			} catch {
				continue;
			}
		}
		return records.sort((left: TerminalJobRecord, right: TerminalJobRecord): number => right.updatedAt.localeCompare(left.updatedAt)).slice(0, limit);
	}

	private async persist(record: TerminalJobRecord): Promise<void> {
		const operation: Promise<void> = this.persistQueue.then(async (): Promise<void> => {
			await mkdir(getTerminalJobsDir(), { recursive: true });
			await writeJsonFileAtomic(getJobPath(record.jobId), toPersistedRecord(record));
		});
		this.persistQueue = operation.catch((): void => undefined);
		await operation;
	}

	private async read(jobId: string): Promise<TerminalJobRecord | null> {
		try {
			const text: string = await readFile(getJobPath(jobId), "utf8");
			return JSON.parse(text) as TerminalJobRecord;
		} catch {
			return null;
		}
	}
}

export const terminalJobStore: TerminalJobStore = new TerminalJobStore();
