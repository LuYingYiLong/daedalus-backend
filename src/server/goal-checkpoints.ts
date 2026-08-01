import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getGoalCheckpointsRoot } from "../app-paths.js";
import { getSessionDatabase, parseSqlJson, runSessionTransaction, sqlJson } from "../session/session-database.js";
import type { FileEditBatchDraft, FileEditSnapshot } from "../tools/file-edit-snapshots.js";
import { findWorkspace } from "../workspace/registry.js";
import { readAgentGoalState, saveAgentGoalState } from "../session/agent-goal-store.js";
import { isAgentGoalTerminal, transitionAgentGoalState } from "../workflow/agent-goal-state.js";
import { getGoalRunBinding } from "./goal-run-observer.js";

const MAX_GOAL_CHECKPOINT_BYTES = 200 * 1024 * 1024;
const MAX_GLOBAL_CHECKPOINT_BYTES = 2 * 1024 * 1024 * 1024;
const CHECKPOINT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const pendingCheckpointWrites = new Map<string, Promise<void>>();

type GoalCheckpointMetadata = {
	workspaceRoot: string;
	absolutePath: string;
	existedBefore: boolean;
	existsAfter: boolean;
	available: boolean;
	unavailableReason?: string | undefined;
};

type GoalCheckpointRow = {
	goal_id: string;
	workspace_id: string | null;
	relative_path: string;
	before_sha256: string | null;
	after_sha256: string | null;
	content_sha256: string | null;
	size_bytes: number;
	metadata_json: string;
};

export type GoalRollbackPreview = {
	goalId: string;
	available: boolean;
	fingerprint: string | null;
	files: Array<{ path: string; existedBefore: boolean; existsAfter: boolean; sizeBytes: number }>;
	reasons: string[];
};

function sha256(value: Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function objectPath(goalId: string, hash: string): string {
	return path.join(getGoalCheckpointsRoot(), goalId, "objects", hash);
}

function isInside(target: string, root: string): boolean {
	const relative = path.relative(root, target);
	return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function readBeforeBytes(edit: FileEditSnapshot): Buffer | null {
	if (!edit.existedBefore) return Buffer.alloc(0);
	if (edit.beforeBase64 !== undefined) return Buffer.from(edit.beforeBase64, "base64");
	if (edit.beforeText !== undefined) return Buffer.from(edit.beforeText, "utf8");
	return null;
}

async function writeObject(goalId: string, hash: string, bytes: Buffer): Promise<void> {
	const target = objectPath(goalId, hash);
	try {
		await stat(target);
		return;
	} catch {
		await mkdir(path.dirname(target), { recursive: true });
		const temporary = `${target}.${randomUUID()}.tmp`;
		await writeFile(temporary, bytes);
		try {
			await stat(target);
			await rm(temporary, { force: true });
		} catch {
			await import("node:fs/promises").then(({ rename }) => rename(temporary, target));
		}
	}
}

async function summarize(goalId: string): Promise<{ status: "available" | "partial" | "unavailable"; fileCount: number; totalBytes: number; unavailableReasons: string[] }> {
	const db = await getSessionDatabase();
	const rows = db.prepare(`SELECT size_bytes, metadata_json FROM agent_goal_file_checkpoints WHERE goal_id = ?`).all(goalId) as Array<{ size_bytes: number; metadata_json: string }>;
	const reasons = new Set<string>();
	for (const row of rows) {
		const metadata = parseSqlJson<GoalCheckpointMetadata>(row.metadata_json);
		if (!metadata.available) reasons.add(metadata.unavailableReason ?? "checkpoint_unavailable");
	}
	return {
		status: rows.length === 0 ? "unavailable" : reasons.size > 0 ? "partial" : "available",
		fileCount: rows.length,
		totalBytes: rows.reduce((sum: number, row): number => sum + row.size_bytes, 0),
		unavailableReasons: [...reasons]
	};
}

async function notifySummary(goalId: string): Promise<void> {
	const summary = await summarize(goalId);
	const { refreshAgentGoalCheckpoint } = await import("./goal-controller.js");
	await refreshAgentGoalCheckpoint(goalId, summary);
}

function enqueueCheckpointWrite(requestId: string, operation: () => Promise<void>): void {
	const previous = pendingCheckpointWrites.get(requestId) ?? Promise.resolve();
	const next = previous.then(operation, operation);
	pendingCheckpointWrites.set(requestId, next);
}

export function enqueueGoalFileEditDraft(requestId: string, draft: FileEditBatchDraft): void {
	if (getGoalRunBinding(requestId) === undefined) return;
	enqueueCheckpointWrite(requestId, (): Promise<void> => captureGoalFileEditDraft(requestId, draft));
}

export function enqueueGoalWriteCheckpointUnavailable(requestId: string, reason: string): void {
	enqueueCheckpointWrite(requestId, (): Promise<void> => markGoalWriteCheckpointUnavailable(requestId, reason));
}

export async function waitForGoalCheckpointWrites(requestId: string): Promise<void> {
	const pending = pendingCheckpointWrites.get(requestId);
	if (pending === undefined) return;
	try {
		await pending;
	} finally {
		if (pendingCheckpointWrites.get(requestId) === pending) pendingCheckpointWrites.delete(requestId);
	}
}

export async function captureGoalFileEditDraft(requestId: string, draft: FileEditBatchDraft): Promise<void> {
	const binding = getGoalRunBinding(requestId);
	if (binding === undefined) return;
	const db: DatabaseSync = await getSessionDatabase();
	const existingSizeRow = db.prepare(`SELECT COALESCE(SUM(size_bytes), 0) AS total FROM agent_goal_file_checkpoints WHERE goal_id = ?`).get(binding.goalId) as { total: number };
	let projectedSize = Number(existingSizeRow.total);
	const prepared: Array<{ edit: FileEditSnapshot; bytes: Buffer | null; contentHash: string | null; metadata: GoalCheckpointMetadata }> = [];
	for (const edit of draft.edits) {
		const bytes = readBeforeBytes(edit);
		let available = edit.undoable && bytes !== null;
		let unavailableReason = edit.unavailableReason;
		if (available && bytes !== null && projectedSize + bytes.byteLength > MAX_GOAL_CHECKPOINT_BYTES) {
			available = false;
			unavailableReason = "goal_checkpoint_size_limit";
		}
		const contentHash = available && edit.existedBefore && bytes !== null ? sha256(bytes) : null;
		if (available && bytes !== null) projectedSize += bytes.byteLength;
		prepared.push({
			edit,
			bytes,
			contentHash,
			metadata: {
				workspaceRoot: draft.workspaceRoot,
				absolutePath: edit.absolutePath,
				existedBefore: edit.existedBefore,
				existsAfter: edit.existsAfter,
				available,
				unavailableReason: available ? undefined : (unavailableReason ?? "checkpoint_content_unavailable")
			}
		});
	}
	for (const item of prepared) {
		if (item.metadata.available && item.contentHash !== null && item.bytes !== null) {
			await writeObject(binding.goalId, item.contentHash, item.bytes);
		}
	}
	const now = new Date().toISOString();
	runSessionTransaction(db, (): void => {
		for (const item of prepared) {
			db.prepare(`
				INSERT INTO agent_goal_file_checkpoints(
					goal_id, workspace_id, relative_path, before_sha256, after_sha256,
					content_sha256, size_bytes, metadata_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(goal_id, relative_path) DO UPDATE SET
					after_sha256 = excluded.after_sha256,
					metadata_json = json_set(agent_goal_file_checkpoints.metadata_json,
						'$.existsAfter', json_extract(excluded.metadata_json, '$.existsAfter'),
						'$.available', min(json_extract(agent_goal_file_checkpoints.metadata_json, '$.available'), json_extract(excluded.metadata_json, '$.available')),
						'$.unavailableReason', coalesce(json_extract(agent_goal_file_checkpoints.metadata_json, '$.unavailableReason'), json_extract(excluded.metadata_json, '$.unavailableReason'))
					),
					updated_at = excluded.updated_at
			`).run(
				binding.goalId,
				draft.workspaceId,
				item.edit.path,
				item.edit.beforeSha256 ?? null,
				item.edit.afterSha256 ?? null,
				item.contentHash,
				item.bytes?.byteLength ?? 0,
				sqlJson(item.metadata),
				now,
				now
			);
		}
	});
	await notifySummary(binding.goalId);
}

export async function markGoalWriteCheckpointUnavailable(requestId: string, reason: string): Promise<void> {
	const binding = getGoalRunBinding(requestId);
	if (binding === undefined) return;
	const db = await getSessionDatabase();
	const syntheticPath = `__unknown_write__/${createHash("sha256").update(`${requestId}:${reason}`).digest("hex")}`;
	const now = new Date().toISOString();
	db.prepare(`
		INSERT OR IGNORE INTO agent_goal_file_checkpoints(
			goal_id, workspace_id, relative_path, before_sha256, after_sha256,
			content_sha256, size_bytes, metadata_json, created_at, updated_at
		) VALUES (?, NULL, ?, NULL, NULL, NULL, 0, ?, ?, ?)
	`).run(binding.goalId, syntheticPath, sqlJson({
		workspaceRoot: "",
		absolutePath: "",
		existedBefore: false,
		existsAfter: false,
		available: false,
		unavailableReason: reason
	} satisfies GoalCheckpointMetadata), now, now);
	await notifySummary(binding.goalId);
}

async function readRows(goalId: string): Promise<Array<GoalCheckpointRow & { metadata: GoalCheckpointMetadata }>> {
	const db = await getSessionDatabase();
	const rows = db.prepare(`SELECT * FROM agent_goal_file_checkpoints WHERE goal_id = ? ORDER BY relative_path`).all(goalId) as GoalCheckpointRow[];
	return rows.map((row: GoalCheckpointRow) => ({ ...row, metadata: parseSqlJson<GoalCheckpointMetadata>(row.metadata_json) }));
}

async function currentFileHash(absolutePath: string): Promise<{ exists: boolean; sha: string | null; bytes: Buffer | null }> {
	try {
		const bytes = await readFile(absolutePath);
		return { exists: true, sha: sha256(bytes), bytes };
	} catch {
		return { exists: false, sha: null, bytes: null };
	}
}

export async function previewAgentGoalRollback(goalId: string): Promise<GoalRollbackPreview> {
	const goal = await readAgentGoalState(goalId);
	if (goal === null) {
		return { goalId, available: false, fingerprint: null, files: [], reasons: ["goal_not_found"] };
	}
	if (!isAgentGoalTerminal(goal.stage)) {
		return { goalId, available: false, fingerprint: null, files: [], reasons: ["goal_must_be_terminal"] };
	}
	const rows = await readRows(goalId);
	const reasons: string[] = [];
	const files: GoalRollbackPreview["files"] = [];
	for (const row of rows) {
		if (!row.metadata.available) {
			reasons.push(`${row.relative_path}: ${row.metadata.unavailableReason ?? "checkpoint_unavailable"}`);
			continue;
		}
		const root = path.resolve(row.metadata.workspaceRoot);
		const absolute = path.resolve(row.metadata.absolutePath);
		const workspace = row.workspace_id === null ? undefined : findWorkspace(row.workspace_id);
		if (workspace === undefined || path.resolve(workspace.rootPath) !== root) {
			reasons.push(`${row.relative_path}: workspace_changed`);
			continue;
		}
		if (!isInside(absolute, root)) {
			reasons.push(`${row.relative_path}: path_outside_workspace`);
			continue;
		}
		const current = await currentFileHash(absolute);
		if (current.sha !== row.after_sha256 || current.exists !== row.metadata.existsAfter) {
			reasons.push(`${row.relative_path}: externally_modified`);
		}
		if (row.metadata.existedBefore && row.content_sha256 !== null) {
			try { await stat(objectPath(goalId, row.content_sha256)); } catch { reasons.push(`${row.relative_path}: checkpoint_object_missing`); }
		}
		files.push({ path: row.relative_path, existedBefore: row.metadata.existedBefore, existsAfter: row.metadata.existsAfter, sizeBytes: row.size_bytes });
	}
	if (rows.length === 0) reasons.push("goal_has_no_checkpoint_files");
	const fingerprint = reasons.length === 0
		? createHash("sha256").update(JSON.stringify(rows.map((row) => [row.relative_path, row.before_sha256, row.after_sha256, row.content_sha256]))).digest("hex")
		: null;
	return { goalId, available: reasons.length === 0, fingerprint, files, reasons };
}

export async function applyAgentGoalRollback(goalId: string, fingerprint: string): Promise<GoalRollbackPreview> {
	const preview = await previewAgentGoalRollback(goalId);
	if (!preview.available || preview.fingerprint !== fingerprint) {
		throw Object.assign(new Error("Goal rollback preflight changed or is incomplete."), { code: "goal_rollback_conflict" });
	}
	const rows = await readRows(goalId);
	const compensation = new Map<string, Buffer | null>();
	const staging = path.join(getGoalCheckpointsRoot(), goalId, `rollback-staging-${randomUUID()}`);
	await mkdir(staging, { recursive: true });
	try {
		for (let index = 0; index < rows.length; index += 1) {
			const row = rows[index]!;
			const current = await currentFileHash(row.metadata.absolutePath);
			compensation.set(row.metadata.absolutePath, current.bytes);
			if (current.bytes !== null) await writeFile(path.join(staging, `${index}.current`), current.bytes);
		}
		for (const row of rows) {
			const target = row.metadata.absolutePath;
			if (!row.metadata.existedBefore) {
				await rm(target, { force: true });
				continue;
			}
			const bytes = await readFile(objectPath(goalId, row.content_sha256!));
			await mkdir(path.dirname(target), { recursive: true });
			await writeFile(target, bytes);
		}
	} catch (error: unknown) {
		for (const [target, bytes] of compensation) {
			try {
				if (bytes === null) await rm(target, { force: true });
				else { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes); }
			} catch { /* best-effort compensation; original error remains authoritative */ }
		}
		throw error;
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
	const state = await readAgentGoalState(goalId);
	if (state !== null) {
		await saveAgentGoalState(transitionAgentGoalState(state, state.stage, {
			checkpoint: { ...state.checkpoint, status: "rolled_back" }
		}));
	}
	return { ...preview, available: false, reasons: ["rollback_applied"] };
}

export async function cleanupAgentGoalCheckpoints(now: number = Date.now()): Promise<string[]> {
	const db = await getSessionDatabase();
	const rows = db.prepare(`
		SELECT g.goal_id, g.state_json, g.completed_at, COALESCE(SUM(c.size_bytes), 0) AS total_bytes
		FROM agent_goals g
		LEFT JOIN agent_goal_file_checkpoints c ON c.goal_id = g.goal_id
		WHERE g.completed_at IS NOT NULL
		GROUP BY g.goal_id
		ORDER BY g.completed_at ASC
	`).all() as Array<{ goal_id: string; state_json: string; completed_at: string; total_bytes: number }>;
	let totalBytes = rows.reduce((sum, row): number => sum + Number(row.total_bytes), 0);
	const selected = new Set<string>();
	for (const row of rows) {
		const completedAt = Date.parse(row.completed_at);
		if (Number.isFinite(completedAt) && now - completedAt >= CHECKPOINT_RETENTION_MS) {
			selected.add(row.goal_id);
			totalBytes -= Number(row.total_bytes);
		}
	}
	for (const row of rows) {
		if (totalBytes <= MAX_GLOBAL_CHECKPOINT_BYTES) break;
		if (selected.has(row.goal_id)) continue;
		selected.add(row.goal_id);
		totalBytes -= Number(row.total_bytes);
	}
	for (const row of rows) {
		if (!selected.has(row.goal_id)) continue;
		await rm(path.join(getGoalCheckpointsRoot(), row.goal_id), { recursive: true, force: true });
		db.prepare("DELETE FROM agent_goal_file_checkpoints WHERE goal_id = ?").run(row.goal_id);
		const state = parseSqlJson<Awaited<ReturnType<typeof readAgentGoalState>>>(row.state_json);
		if (state !== null) {
			await saveAgentGoalState(transitionAgentGoalState(state, state.stage, {
				checkpoint: {
					status: "unavailable",
					fileCount: 0,
					totalBytes: 0,
					unavailableReasons: ["goal_checkpoint_retention_expired"]
				}
			}));
		}
	}
	return [...selected];
}
