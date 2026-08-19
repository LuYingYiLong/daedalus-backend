import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonFileAtomic } from "../json-file-store.js";
import { broadcastGlobalEvent } from "../server/client-connections.js";
import { readWorktreeSettings } from "./worktree-settings.js";

export type WorktreeOperationType = "create" | "setup" | "handoff" | "repair" | "delete" | "permanent-create" | "permanent-delete";
export type WorktreeOperationStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";

export type WorktreeOperationSnapshot = {
	id: string;
	type: WorktreeOperationType;
	sessionId?: string | undefined;
	workspaceId?: string | undefined;
	status: WorktreeOperationStatus;
	stage: string;
	sourceFolderId?: string | undefined;
	progress: number;
	message?: string | undefined;
	error?: { code: string; message: string } | undefined;
	createdAt: string;
	updatedAt: string;
	finishedAt?: string | undefined;
};

type ActiveOperation = {
	snapshot: WorktreeOperationSnapshot;
	abortController: AbortController;
};

export type WorktreeOperationContext = {
	signal: AbortSignal;
	update: (patch: Partial<Pick<WorktreeOperationSnapshot, "stage" | "sourceFolderId" | "progress" | "message">>) => Promise<void>;
};

const activeOperations: Map<string, ActiveOperation> = new Map();
const snapshots: Map<string, WorktreeOperationSnapshot> = new Map();
let initialized: Promise<void> | null = null;

async function operationsRoot(): Promise<string> {
	return join((await readWorktreeSettings()).rootDirectory, ".operations");
}

async function operationPath(id: string): Promise<string> {
	return join(await operationsRoot(), `${id}.json`);
}

function publicSnapshot(snapshot: WorktreeOperationSnapshot): WorktreeOperationSnapshot {
	return structuredClone(snapshot);
}

async function persist(snapshot: WorktreeOperationSnapshot): Promise<void> {
	await writeJsonFileAtomic(await operationPath(snapshot.id), snapshot);
}

async function emit(snapshot: WorktreeOperationSnapshot): Promise<void> {
	await persist(snapshot);
	broadcastGlobalEvent(snapshot.id, "worktree.operation.updated", publicSnapshot(snapshot));
}

export async function initializeWorktreeOperations(): Promise<void> {
	if (initialized !== null) return await initialized;
	initialized = (async (): Promise<void> => {
		const root: string = await operationsRoot();
		await mkdir(root, { recursive: true });
		for (const entry of await readdir(root, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			try {
				const snapshot = JSON.parse(await readFile(join(root, entry.name), "utf8")) as WorktreeOperationSnapshot;
				if (snapshot.status === "running" || snapshot.status === "queued") {
					snapshot.status = "interrupted";
					snapshot.stage = "interrupted";
					snapshot.updatedAt = new Date().toISOString();
					snapshot.finishedAt = snapshot.updatedAt;
					await persist(snapshot);
				}
				snapshots.set(snapshot.id, snapshot);
			} catch {
				continue;
			}
		}
	})();
	await initialized;
}

export async function startWorktreeOperation(params: {
	type: WorktreeOperationType;
	sessionId?: string | undefined;
	workspaceId?: string | undefined;
	task: (context: WorktreeOperationContext) => Promise<void>;
}): Promise<WorktreeOperationSnapshot> {
	await initializeWorktreeOperations();
	const now: string = new Date().toISOString();
	const snapshot: WorktreeOperationSnapshot = {
		id: randomUUID(),
		type: params.type,
		sessionId: params.sessionId,
		workspaceId: params.workspaceId,
		status: "queued",
		stage: "queued",
		progress: 0,
		createdAt: now,
		updatedAt: now
	};
	const abortController = new AbortController();
	const active: ActiveOperation = { snapshot, abortController };
	activeOperations.set(snapshot.id, active);
	snapshots.set(snapshot.id, snapshot);
	await emit(snapshot);
	void (async (): Promise<void> => {
		try {
			snapshot.status = "running";
			snapshot.stage = "starting";
			snapshot.updatedAt = new Date().toISOString();
			await emit(snapshot);
			await params.task({
				signal: abortController.signal,
				update: async (patch): Promise<void> => {
					if (abortController.signal.aborted) throw Object.assign(new Error("Worktree operation cancelled."), { code: "worktree_operation_cancelled" });
					Object.assign(snapshot, patch, { progress: Math.max(0, Math.min(1, patch.progress ?? snapshot.progress)), updatedAt: new Date().toISOString() });
					await emit(snapshot);
				}
			});
			if (abortController.signal.aborted) throw Object.assign(new Error("Worktree operation cancelled."), { code: "worktree_operation_cancelled" });
			snapshot.status = "succeeded";
			snapshot.stage = "completed";
			snapshot.progress = 1;
		} catch (error: unknown) {
			snapshot.status = abortController.signal.aborted ? "cancelled" : "failed";
			snapshot.stage = snapshot.status;
			snapshot.error = {
				code: typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "worktree_operation_failed",
				message: error instanceof Error ? error.message : "Worktree operation failed."
			};
		} finally {
			snapshot.updatedAt = new Date().toISOString();
			snapshot.finishedAt = snapshot.updatedAt;
			activeOperations.delete(snapshot.id);
			await emit(snapshot);
		}
	})();
	return publicSnapshot(snapshot);
}

export async function runTrackedWorktreeOperation<T>(params: {
	type: WorktreeOperationType;
	sessionId?: string | undefined;
	workspaceId?: string | undefined;
	task: (context: WorktreeOperationContext) => Promise<T>;
}): Promise<{ result: T; operation: WorktreeOperationSnapshot }> {
	let result: T | undefined;
	let hasResult: boolean = false;
	let failure: unknown;
	let finish: (() => void) | undefined;
	const finished: Promise<void> = new Promise((resolvePromise): void => { finish = resolvePromise; });
	const operation: WorktreeOperationSnapshot = await startWorktreeOperation({
		type: params.type,
		sessionId: params.sessionId,
		workspaceId: params.workspaceId,
		task: async (context): Promise<void> => {
			try {
				result = await params.task(context);
				hasResult = true;
			} catch (error: unknown) {
				failure = error;
				throw error;
			} finally {
				finish?.();
			}
		}
	});
	await finished;
	if (failure !== undefined) throw failure;
	const finalOperation: WorktreeOperationSnapshot | null = await getWorktreeOperation(operation.id);
	if (!hasResult || finalOperation === null) {
		throw Object.assign(new Error("Worktree operation completed without a result."), { code: "worktree_operation_result_missing" });
	}
	return { result: result as T, operation: finalOperation };
}

export async function getWorktreeOperation(id: string): Promise<WorktreeOperationSnapshot | null> {
	await initializeWorktreeOperations();
	return snapshots.has(id) ? publicSnapshot(snapshots.get(id)!) : null;
}

export async function cancelWorktreeOperation(id: string): Promise<WorktreeOperationSnapshot> {
	await initializeWorktreeOperations();
	const active: ActiveOperation | undefined = activeOperations.get(id);
	if (active === undefined) {
		const snapshot: WorktreeOperationSnapshot | undefined = snapshots.get(id);
		if (snapshot === undefined) throw Object.assign(new Error("Worktree operation not found."), { code: "worktree_operation_not_found" });
		return publicSnapshot(snapshot);
	}
	active.abortController.abort();
	return publicSnapshot(active.snapshot);
}

export async function listWorktreeOperations(): Promise<WorktreeOperationSnapshot[]> {
	await initializeWorktreeOperations();
	return [...snapshots.values()].sort((left, right): number => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 200).map(publicSnapshot);
}

export function hasActiveWorktreeOperation(sessionId: string): boolean {
	return [...activeOperations.values()].some((operation): boolean => operation.snapshot.sessionId === sessionId);
}

export async function removeMissingOperationFiles(): Promise<void> {
	await initializeWorktreeOperations();
	for (const [id] of snapshots) if (!existsSync(await operationPath(id))) snapshots.delete(id);
}
