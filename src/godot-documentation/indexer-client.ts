import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createSelfInvocation } from "../runtime/self-invocation.js";
import { DocumentationIndexError } from "./health.js";
import type { DocumentationIndexSummary } from "./indexer.js";
import type { GodotDocumentationGenerationManifest } from "./types.js";

type IndexerCommand =
	| { type: "build"; extractedRoot: string; indexPath: string; branch: string; commitSha: string }
	| { type: "check"; generationDir: string; branch: string; commitSha: string };

type IndexerResponse = {
	id: string;
	type: "progress" | "completed" | "error";
	progress?: number;
	summary?: DocumentationIndexSummary;
	manifest?: GodotDocumentationGenerationManifest;
	code?: string | null;
	message?: string;
};

async function runIndexer<T>(
	command: IndexerCommand,
	signal: AbortSignal,
	onProgress?: ((progress: number) => void) | undefined
): Promise<T> {
	const invocation = createSelfInvocation(["internal", "documentation-indexer"]);
	const child = spawn(invocation.command, invocation.args, {
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
		env: { ...process.env, DAEDALUS_LOG_CONSOLE: "0" }
	});
	const id: string = `documentation-indexer-${randomUUID()}`;
	return new Promise<T>((resolvePromise, rejectPromise): void => {
		let settled: boolean = false;
		let stderr: string = "";
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", handleAbort);
			callback();
		};
		const handleAbort = (): void => {
			if (child.exitCode === null) child.kill();
			finish((): void => rejectPromise(new Error("Documentation import cancelled.")));
		};
		const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
		lines.on("line", (line: string): void => {
			let response: IndexerResponse;
			try {
				response = JSON.parse(line) as IndexerResponse;
			} catch {
				return;
			}
			if (response.id !== id) return;
			if (response.type === "progress") {
				onProgress?.(Math.max(0, Math.min(1, response.progress ?? 0)));
				return;
			}
			if (response.type === "error") {
				finish((): void => rejectPromise(new DocumentationIndexError(
					response.code ?? "documentation_index_corrupt",
					response.message ?? "Documentation indexer failed."
				)));
				return;
			}
			const result: unknown = command.type === "build" ? response.summary : response.manifest;
			finish((): void => resolvePromise(result as T));
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string): void => { stderr = `${stderr}${chunk}`.slice(-4_000); });
		child.once("error", (error: Error): void => finish((): void => rejectPromise(error)));
		child.once("exit", (code: number | null, exitSignal: NodeJS.Signals | null): void => {
			if (!settled) finish((): void => rejectPromise(new Error(
				stderr.trim() || `Documentation indexer exited (${code ?? exitSignal ?? "unknown"}).`
			)));
		});
		if (signal.aborted) {
			handleAbort();
			return;
		}
		signal.addEventListener("abort", handleAbort, { once: true });
		child.stdin.end(`${JSON.stringify({ id, ...command })}\n`);
	});
}

export async function buildDocumentationIndexInProcess(params: {
	extractedRoot: string;
	indexPath: string;
	branch: string;
	commitSha: string;
	signal: AbortSignal;
	onProgress?: ((progress: number) => void) | undefined;
}): Promise<DocumentationIndexSummary> {
	return runIndexer<DocumentationIndexSummary>({
		type: "build",
		extractedRoot: params.extractedRoot,
		indexPath: params.indexPath,
		branch: params.branch,
		commitSha: params.commitSha
	}, params.signal, params.onProgress);
}

export async function deepCheckDocumentationInProcess(params: {
	generationDir: string;
	branch: string;
	commitSha: string;
	signal: AbortSignal;
}): Promise<GodotDocumentationGenerationManifest> {
	return runIndexer<GodotDocumentationGenerationManifest>({
		type: "check",
		generationDir: params.generationDir,
		branch: params.branch,
		commitSha: params.commitSha
	}, params.signal);
}
