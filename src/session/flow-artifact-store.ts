import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { getDaedalusPath } from "../app-paths.js";
import type { FlowMediaArtifactRef } from "../protocol/types.js";
import { getSessionDatabase, parseSqlJson, runSessionTransaction, sqlJson } from "./session-database.js";

const ARTIFACT_ID_PATTERN = /^flow-artifact-[a-zA-Z0-9_-]+$/u;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;

type ArtifactRow = {
	artifact_id: string;
	flow_id: string;
	run_id: string;
	node_id: string;
	mime_type: string;
	byte_size: number;
	sha256: string;
	width: number | null;
	height: number | null;
	duration_ms: number | null;
	fps: number | null;
	preview_artifact_id: string | null;
	storage_path: string;
	metadata_json: string;
	created_at: string;
};

export type SaveFlowArtifactInput = {
	flowId: string;
	runId: string;
	nodeId: string;
	bytes: Uint8Array;
	mimeType: string;
	width?: number | undefined;
	height?: number | undefined;
	durationMs?: number | undefined;
	fps?: number | undefined;
	previewArtifactId?: string | undefined;
	metadata?: Record<string, unknown> | undefined;
};

function assertArtifactId(value: string): string {
	if (!ARTIFACT_ID_PATTERN.test(value)) throw Object.assign(new Error(`Invalid Flow artifact id: ${value}`), { code: "flow_artifact_invalid" });
	return value;
}

function artifactPath(artifactId: string, mimeType: string): string {
	const extension = mimeType.includes("/") ? mimeType.split("/")[1]?.replace(/[^a-z0-9]+/giu, "").slice(0, 12) : "bin";
	return join(getDaedalusPath("flow.artifacts.root"), `${assertArtifactId(artifactId)}.${extension || "bin"}`);
}

function mapArtifact(row: ArtifactRow): FlowMediaArtifactRef {
	return {
		artifactId: row.artifact_id,
		flowId: row.flow_id,
		runId: row.run_id,
		nodeId: row.node_id,
		mimeType: row.mime_type,
		byteSize: Number(row.byte_size),
		sha256: row.sha256,
		...(row.width === null ? {} : { width: Number(row.width) }),
		...(row.height === null ? {} : { height: Number(row.height) }),
		...(row.duration_ms === null ? {} : { durationMs: Number(row.duration_ms) }),
		...(row.fps === null ? {} : { fps: Number(row.fps) }),
		...(row.preview_artifact_id === null ? {} : { previewArtifactId: row.preview_artifact_id }),
		storagePath: row.storage_path,
		metadata: parseSqlJson<Record<string, unknown>>(row.metadata_json),
		createdAt: row.created_at,
	};
}

export async function saveFlowArtifact(input: SaveFlowArtifactInput): Promise<FlowMediaArtifactRef> {
	const bytes = Buffer.from(input.bytes);
	if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARTIFACT_BYTES) throw Object.assign(new Error("Flow artifact size is outside the supported range."), { code: "flow_artifact_too_large" });
	const mimeType = input.mimeType.trim().slice(0, 160);
	if (mimeType.length === 0 || !mimeType.includes("/")) throw Object.assign(new Error("Flow artifact mimeType is invalid."), { code: "flow_artifact_mime_invalid" });
	const artifactId = `flow-artifact-${randomUUID()}`;
	const createdAt = new Date().toISOString();
	const storagePath = artifactPath(artifactId, mimeType);
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const metadata: FlowMediaArtifactRef = {
		artifactId,
		flowId: input.flowId,
		runId: input.runId,
		nodeId: input.nodeId,
		mimeType,
		byteSize: bytes.byteLength,
		sha256,
		...(input.width === undefined ? {} : { width: input.width }),
		...(input.height === undefined ? {} : { height: input.height }),
		...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
		...(input.fps === undefined ? {} : { fps: input.fps }),
		...(input.previewArtifactId === undefined ? {} : { previewArtifactId: input.previewArtifactId }),
		storagePath: relative(getDaedalusPath("flow.artifacts.root"), storagePath).replaceAll("\\", "/"),
		metadata: parseSqlJson<Record<string, unknown>>(sqlJson(input.metadata ?? {})),
		createdAt,
	};
	await mkdir(getDaedalusPath("flow.artifacts.root"), { recursive: true });
	await writeFile(storagePath, bytes, { flag: "wx" });
	try {
		const db = await getSessionDatabase();
		runSessionTransaction(db, (): void => {
			db.prepare("INSERT INTO flow_artifacts(artifact_id, flow_id, run_id, node_id, mime_type, byte_size, sha256, width, height, duration_ms, fps, preview_artifact_id, storage_path, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
				artifactId,
				input.flowId,
				input.runId,
				input.nodeId,
				mimeType,
				bytes.byteLength,
				sha256,
				input.width ?? null,
				input.height ?? null,
				input.durationMs ?? null,
				input.fps ?? null,
				input.previewArtifactId ?? null,
				metadata.storagePath,
				sqlJson(input.metadata ?? {}),
				createdAt,
			);
		});
	} catch (error: unknown) {
		await rm(storagePath, { force: true });
		throw error;
	}
	return metadata;
}

export async function getFlowArtifactReference(artifactId: string): Promise<FlowMediaArtifactRef> {
	const db = await getSessionDatabase();
	const row = db.prepare("SELECT * FROM flow_artifacts WHERE artifact_id = ?").get(assertArtifactId(artifactId)) as ArtifactRow | undefined;
	if (row === undefined) throw Object.assign(new Error(`Flow artifact not found: ${artifactId}`), { code: "flow_artifact_not_found" });
	return mapArtifact(row);
}

export async function getFlowArtifact(artifactId: string): Promise<{ ref: FlowMediaArtifactRef; bytes: Buffer }> {
	const db = await getSessionDatabase();
	const row = db.prepare("SELECT artifact_id, flow_id, run_id, node_id, mime_type, byte_size, sha256, width, height, duration_ms, fps, preview_artifact_id, storage_path, metadata_json, created_at FROM flow_artifacts WHERE artifact_id = ?").get(assertArtifactId(artifactId)) as ArtifactRow | undefined;
	if (row === undefined) throw Object.assign(new Error(`Flow artifact not found: ${artifactId}`), { code: "flow_artifact_not_found" });
	const ref = mapArtifact(row);
	const bytes = await readFile(artifactPath(row.artifact_id, row.mime_type));
	if (bytes.byteLength !== ref.byteSize || createHash("sha256").update(bytes).digest("hex") !== ref.sha256) throw Object.assign(new Error("Flow artifact integrity check failed."), { code: "flow_artifact_corrupt" });
	return { ref, bytes };
}

export async function listFlowArtifacts(flowId: string, runId?: string): Promise<FlowMediaArtifactRef[]> {
	const db = await getSessionDatabase();
	const rows = (runId === undefined
		? db.prepare("SELECT artifact_id, flow_id, run_id, node_id, mime_type, byte_size, sha256, width, height, duration_ms, fps, preview_artifact_id, storage_path, metadata_json, created_at FROM flow_artifacts WHERE flow_id = ? ORDER BY created_at DESC, artifact_id").all(flowId)
		: db.prepare("SELECT artifact_id, flow_id, run_id, node_id, mime_type, byte_size, sha256, width, height, duration_ms, fps, preview_artifact_id, storage_path, metadata_json, created_at FROM flow_artifacts WHERE flow_id = ? AND run_id = ? ORDER BY created_at DESC, artifact_id").all(flowId, runId)) as ArtifactRow[];
	return rows.map(mapArtifact);
}

export async function listFlowGeneratedArtifacts(flowId: string, limit: number): Promise<{ artifacts: FlowMediaArtifactRef[]; total: number }> {
	const db = await getSessionDatabase();
	const where = `a.flow_id = ? AND (a.mime_type LIKE 'image/%' OR a.mime_type LIKE 'video/%') AND (
		json_extract(a.metadata_json, '$.provenance.kind') = 'ai-generation'
		OR n.type_id IN ('builtin/text-to-image', 'builtin/image-to-image', 'builtin/text-to-video', 'builtin/image-to-video', 'builtin/batch-text-to-image', 'builtin/batch-image-to-image')
	)`;
	const from = "FROM flow_artifacts AS a JOIN flow_nodes AS n ON n.node_id = a.node_id";
	const totalRow = db
		.prepare(`SELECT COUNT(*) AS total ${from} WHERE ${where}`)
		.get(flowId) as { total: number };
	const rows = db
		.prepare(
			`SELECT
				a.artifact_id, a.flow_id, a.run_id, a.node_id, a.mime_type, a.byte_size,
				a.sha256, a.width, a.height, a.duration_ms, a.fps, a.preview_artifact_id,
				a.storage_path, a.metadata_json, a.created_at,
				n.type_id AS source_node_type_id, n.config_json AS source_node_config_json
			${from}
			WHERE ${where}
			ORDER BY a.created_at DESC, a.rowid DESC
			LIMIT ?`,
		)
		.all(flowId, limit) as Array<ArtifactRow & { source_node_type_id: string; source_node_config_json: string }>;
	return {
		artifacts: rows.map((row): FlowMediaArtifactRef => {
			const artifact = mapArtifact(row);
			const provenance = artifact.metadata.provenance;
			if (
				provenance !== null &&
				typeof provenance === "object" &&
				!Array.isArray(provenance) &&
				(provenance as Record<string, unknown>).kind === "ai-generation"
			)
				return artifact;
			const isVideo = row.source_node_type_id === "builtin/text-to-video" || row.source_node_type_id === "builtin/image-to-video";
			let config: Record<string, unknown> = {};
			try { config = parseSqlJson<Record<string, unknown>>(row.source_node_config_json); } catch { /* malformed legacy node config should not hide its artifact */ }
			const generationType = isVideo
				? "videoGeneration"
				: row.source_node_type_id === "builtin/image-to-image" || row.source_node_type_id === "builtin/batch-image-to-image"
					? "imageEdit"
					: "imageGeneration";
			return {
				...artifact,
				metadata: {
					...artifact.metadata,
					provenance: {
						kind: "ai-generation",
						generationType,
						...(typeof config.provider === "string" ? { provider: config.provider } : {}),
						...(typeof config.model === "string" ? { model: config.model } : {}),
						...(typeof config.prompt === "string" ? { prompt: config.prompt } : {}),
						...(typeof config.negativePrompt === "string" ? { negativePrompt: config.negativePrompt } : {}),
					},
				},
			};
		}),
		total: Number(totalRow.total),
	};
}

export async function deleteFlowArtifact(artifactId: string): Promise<void> {
	const db = await getSessionDatabase();
	const row = db.prepare("SELECT mime_type FROM flow_artifacts WHERE artifact_id = ?").get(assertArtifactId(artifactId)) as { mime_type: string } | undefined;
	if (row === undefined) return;
	db.prepare("DELETE FROM flow_artifacts WHERE artifact_id = ?").run(artifactId);
	await rm(artifactPath(artifactId, row.mime_type), { force: true });
}

export async function cleanupFlowArtifacts(flowId: string, keepRunIds: readonly string[] = []): Promise<number> {
	const db = await getSessionDatabase();
	const rows = db.prepare("SELECT artifact_id, mime_type, run_id FROM flow_artifacts WHERE flow_id = ?").all(flowId) as Array<{ artifact_id: string; mime_type: string; run_id: string }>;
	let removed = 0;
	for (const row of rows) {
		if (keepRunIds.includes(row.run_id)) continue;
		db.prepare("DELETE FROM flow_artifacts WHERE artifact_id = ?").run(row.artifact_id);
		await rm(artifactPath(row.artifact_id, row.mime_type), { force: true });
		removed += 1;
	}
	return removed;
}
