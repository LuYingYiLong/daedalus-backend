import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, open, readFile, readdir, realpath, rename, rm, stat, statfs } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { processImage } from "../media/image-processing.js";
import { getDaedalusPath } from "../app-paths.js";
import type { FlowMediaArtifactRef } from "../protocol/types.js";
import { getSessionDatabase, parseSqlJson, runSessionTransaction, sqlJson } from "./session-database.js";

const ARTIFACT_ID_PATTERN = /^flow-artifact-[a-zA-Z0-9_-]+$/u;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;

type ArtifactRow = {
	artifact_id: string;
	flow_id: string;
	run_id: string | null;
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
	runId?: string | null | undefined;
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
	const bytes = input.bytes;
	if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARTIFACT_BYTES) throw Object.assign(new Error("Flow artifact size is outside the supported range."), { code: "flow_artifact_too_large" });
	const mimeType = input.mimeType.trim().slice(0, 160);
	if (mimeType.length === 0 || !mimeType.includes("/")) throw Object.assign(new Error("Flow artifact mimeType is invalid."), { code: "flow_artifact_mime_invalid" });
	const serializedMetadata = sqlJson(input.metadata ?? {});
	const artifactId = `flow-artifact-${randomUUID()}`;
	const createdAt = new Date().toISOString();
	const storagePath = artifactPath(artifactId, mimeType);
	await mkdir(getDaedalusPath("flow.artifacts.root"), { recursive: true });
	const stagingPath = `${storagePath}.${randomUUID()}.staging`;
	const hash = createHash("sha256");
	try {
		const staging = await open(stagingPath, "wx");
		try {
			for (let offset = 0; offset < bytes.byteLength;) {
				const chunk = bytes.subarray(offset, Math.min(offset + 1024 * 1024, bytes.byteLength));
				hash.update(chunk);
				let written = 0;
				while (written < chunk.byteLength) {
					const result = await staging.write(chunk, written, chunk.byteLength - written);
					if (result.bytesWritten <= 0) throw new Error("Flow artifact write stopped unexpectedly.");
					written += result.bytesWritten;
				}
				offset += chunk.byteLength;
			}
			await staging.sync();
		} finally { await staging.close(); }
		await rename(stagingPath, storagePath);
	} catch (error: unknown) {
		await rm(stagingPath, { force: true });
		throw error;
	}
	const sha256 = hash.digest("hex");
	const metadata: FlowMediaArtifactRef = {
		artifactId,
		flowId: input.flowId,
		runId: input.runId ?? null,
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
		metadata: parseSqlJson<Record<string, unknown>>(serializedMetadata),
		createdAt,
	};
	try {
		const db = await getSessionDatabase();
		runSessionTransaction(db, (): void => {
			db.prepare("INSERT INTO flow_artifacts(artifact_id, flow_id, run_id, node_id, mime_type, byte_size, sha256, width, height, duration_ms, fps, preview_artifact_id, storage_path, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
				artifactId,
				input.flowId,
				input.runId ?? null,
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
				serializedMetadata,
				createdAt,
			);
		});
	} catch (error: unknown) {
		await rm(storagePath, { force: true });
		throw error;
	}
	return metadata;
}

async function saveFlowArtifactFromFile(input: Omit<SaveFlowArtifactInput, "bytes"> & { sourcePath: string; expectedSize: number }): Promise<FlowMediaArtifactRef> {
	const artifactId = `flow-artifact-${randomUUID()}`;
	const storagePath = artifactPath(artifactId, input.mimeType);
	const stagingPath = `${storagePath}.${randomUUID()}.staging`;
	const createdAt = new Date().toISOString();
	const hash = createHash("sha256");
	let byteSize = 0;
	await mkdir(getDaedalusPath("flow.artifacts.root"), { recursive: true });
	try {
		await pipeline(createReadStream(input.sourcePath, { highWaterMark: 1024 * 1024 }), new Transform({ transform(chunk: Buffer, _encoding, callback) {
			byteSize += chunk.byteLength;
			if (byteSize > MAX_ARTIFACT_BYTES || byteSize > input.expectedSize) { callback(Object.assign(new Error("Flow input changed or exceeds 512 MiB."), { code: "flow_input_file_invalid" })); return; }
			hash.update(chunk); callback(null, chunk);
		} }), createWriteStream(stagingPath, { flags: "wx" }));
		if (byteSize !== input.expectedSize) throw Object.assign(new Error("Flow input changed while importing."), { code: "flow_input_file_invalid" });
		const staged = await open(stagingPath, "r+");
		try { await staged.sync(); } finally { await staged.close(); }
		await rename(stagingPath, storagePath);
	} catch (error: unknown) { await rm(stagingPath, { force: true }); throw error; }
	const sha256 = hash.digest("hex");
	const metadata = input.metadata ?? {};
	const relativePath = relative(getDaedalusPath("flow.artifacts.root"), storagePath).replaceAll("\\", "/");
	try {
		const db = await getSessionDatabase();
		db.prepare("INSERT INTO flow_artifacts(artifact_id,flow_id,run_id,node_id,mime_type,byte_size,sha256,width,height,duration_ms,fps,preview_artifact_id,storage_path,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(artifactId,input.flowId,input.runId ?? null,input.nodeId,input.mimeType,byteSize,sha256,input.width ?? null,input.height ?? null,input.durationMs ?? null,input.fps ?? null,input.previewArtifactId ?? null,relativePath,sqlJson(metadata),createdAt);
	} catch (error: unknown) { await rm(storagePath, { force: true }); throw error; }
	return { artifactId, flowId: input.flowId, runId: input.runId ?? null, nodeId: input.nodeId, mimeType: input.mimeType, byteSize, sha256, ...(input.width === undefined ? {} : { width: input.width }), ...(input.height === undefined ? {} : { height: input.height }), ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }), ...(input.fps === undefined ? {} : { fps: input.fps }), ...(input.previewArtifactId === undefined ? {} : { previewArtifactId: input.previewArtifactId }), storagePath: relativePath, metadata, createdAt };
}

export async function importFlowInputArtifact(input: {
	flowId: string;
	nodeId: string;
	sourcePath: string;
	kind: "image" | "video" | "audio" | "mask" | "frames" | "artifact";
}): Promise<FlowMediaArtifactRef> {
	if (!isAbsolute(input.sourcePath)) throw Object.assign(new Error("Choose an absolute media file path."), { code: "flow_input_file_invalid" });
	const sourcePath = await realpath(input.sourcePath);
	const info = await stat(sourcePath);
	if (!info.isFile() || info.size === 0 || info.size > MAX_ARTIFACT_BYTES)
		throw Object.assign(new Error("Flow input file is empty or exceeds 512 MiB."), { code: "flow_input_file_invalid" });
	const metadata = { source: "flow-input", originalName: basename(sourcePath) };
	if (input.kind === "image" || input.kind === "mask" || input.kind === "frames") {
		if (info.size > 64 * 1024 * 1024) throw Object.assign(new Error("Flow image input exceeds 64 MiB."), { code: "flow_input_file_invalid" });
		const bytes = await readFile(sourcePath);
		const image = await processImage(bytes, { kind: "normalize" }, AbortSignal.timeout(60_000));
		return saveFlowArtifact({ flowId: input.flowId, nodeId: input.nodeId, ...image, metadata });
	}
	const handle = await open(sourcePath, "r");
	const bytes = Buffer.alloc(12);
	try { await handle.read(bytes, 0, bytes.length, 0); }
	finally { await handle.close(); }
	let mimeType: string;
	if (input.kind === "video") {
		const isMp4 = bytes.toString("ascii", 4, 8) === "ftyp";
		const isWebm = bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
		if (!isMp4 && !isWebm) throw Object.assign(new Error("Choose an MP4 or WebM video."), { code: "flow_input_media_invalid" });
		mimeType = isWebm ? "video/webm" : "video/mp4";
	} else if (input.kind === "audio") {
		const isWav = bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE";
		const isMp3 = bytes.toString("ascii", 0, 3) === "ID3" || bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0;
		const isOgg = bytes.toString("ascii", 0, 4) === "OggS";
		if (!isWav && !isMp3 && !isOgg) throw Object.assign(new Error("Choose a WAV, MP3 or Ogg audio file."), { code: "flow_input_media_invalid" });
		mimeType = isWav ? "audio/wav" : isOgg ? "audio/ogg" : "audio/mpeg";
	} else mimeType = "application/octet-stream";
	return saveFlowArtifactFromFile({ flowId: input.flowId, nodeId: input.nodeId, sourcePath, expectedSize: info.size, mimeType, metadata });
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

async function copyFlowArtifactVerified(ref: FlowMediaArtifactRef, destination: string, exclusive: boolean): Promise<void> {
	const root = await realpath(getDaedalusPath("flow.artifacts.root"));
	const source = await realpath(artifactPath(ref.artifactId, ref.mimeType));
	const sourceRelative = relative(root, source);
	if (sourceRelative.startsWith("..") || isAbsolute(sourceRelative)) throw new Error("Flow artifact path escaped its storage root.");
	const staging = `${destination}.${randomUUID()}.staging`;
	const backup = `${destination}.${randomUUID()}.backup`;
	const hash = createHash("sha256");
	let size = 0;
	let backedUp = false;
	try {
		await pipeline(createReadStream(source), new Transform({ transform(chunk: Buffer, _encoding, callback) { size += chunk.byteLength; hash.update(chunk); callback(null, chunk); } }), createWriteStream(staging, { flags: "wx" }));
		if (size !== ref.byteSize || hash.digest("hex") !== ref.sha256) throw Object.assign(new Error("Flow artifact integrity check failed."), { code: "flow_artifact_corrupt" });
		if (exclusive) await copyFile(staging, destination, constants.COPYFILE_EXCL);
		else {
			try { await rename(destination, backup); backedUp = true; }
			catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			try { await rename(staging, destination); }
			catch (error: unknown) { if (backedUp) await rename(backup, destination); throw error; }
			if (backedUp) await rm(backup, { force: true });
		}
	} finally {
		await rm(staging, { force: true });
	}
}

export async function exportFlowArtifacts(input: {
	flowId: string;
	artifactIds: string[];
	destinationPath: string;
	directory: boolean;
}): Promise<{ exportedPaths: string[] }> {
	if (!isAbsolute(input.destinationPath) || input.artifactIds.length === 0 || input.artifactIds.length > 100 ||
		(!input.directory && input.artifactIds.length !== 1))
		throw Object.assign(new Error("Invalid Flow artifact export destination."), { code: "flow_artifact_export_invalid" });
	const artifacts = await Promise.all(input.artifactIds.map(async (artifactId) => {
		const ref = await getFlowArtifactReference(artifactId);
		if (ref.flowId !== input.flowId)
			throw Object.assign(new Error("Artifact does not belong to this Flow."), { code: "flow_artifact_export_scope" });
		return ref;
	}));
	if (input.directory) {
		if (!(await stat(input.destinationPath)).isDirectory())
			throw Object.assign(new Error("Export destination is not a directory."), { code: "flow_artifact_export_invalid" });
	} else if (!(await stat(dirname(input.destinationPath))).isDirectory())
		throw Object.assign(new Error("Export destination directory is missing."), { code: "flow_artifact_export_invalid" });
	const exportedPaths: string[] = [];
	for (const [index, artifact] of artifacts.entries()) {
		const extension = artifact.mimeType === "image/jpeg" ? "jpg" :
			artifact.mimeType === "video/quicktime" ? "mov" :
			artifact.mimeType.split("/")[1]?.replace(/[^a-z0-9]/giu, "").slice(0, 12) || "bin";
		if (!input.directory) {
			await copyFlowArtifactVerified(artifact, input.destinationPath, false);
			exportedPaths.push(input.destinationPath);
			continue;
		}
		const name = `${String(index + 1).padStart(2, "0")}-${artifact.artifactId}`;
		let saved = false;
		for (let suffix = 0; suffix < 10000; suffix++) {
			const destination = join(input.destinationPath, `${name}${suffix === 0 ? "" : `-${suffix}`}.${extension}`);
			try {
				await copyFlowArtifactVerified(artifact, destination, true);
				exportedPaths.push(destination);
				saved = true;
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
		}
		if (!saved) throw Object.assign(new Error("Flow artifact export names exhausted."), { code: "flow_artifact_export_name_limit" });
	}
	return { exportedPaths };
}

export async function listFlowArtifacts(flowId: string, runId?: string): Promise<FlowMediaArtifactRef[]> {
	const db = await getSessionDatabase();
	const rows = (runId === undefined
		? db.prepare("SELECT artifact_id, flow_id, run_id, node_id, mime_type, byte_size, sha256, width, height, duration_ms, fps, preview_artifact_id, storage_path, metadata_json, created_at FROM flow_artifacts WHERE flow_id = ? ORDER BY created_at DESC, artifact_id").all(flowId)
		: db.prepare("SELECT artifact_id, flow_id, run_id, node_id, mime_type, byte_size, sha256, width, height, duration_ms, fps, preview_artifact_id, storage_path, metadata_json, created_at FROM flow_artifacts WHERE flow_id = ? AND run_id = ? ORDER BY created_at DESC, artifact_id").all(flowId, runId)) as ArtifactRow[];
	return rows.map(mapArtifact);
}

export type FlowArtifactHealthIssue = { artifactId: string; flowId: string; code: "missing" | "size_mismatch" | "checksum_mismatch" | "path_invalid" };

export async function auditFlowArtifacts(flowId?: string, artifactIds?: ReadonlySet<string>): Promise<{ checked: number; issues: FlowArtifactHealthIssue[]; stagingFiles: number }> {
	const db = await getSessionDatabase();
	const rows = (flowId === undefined
		? db.prepare("SELECT artifact_id,flow_id,mime_type,byte_size,sha256 FROM flow_artifacts").all()
		: db.prepare("SELECT artifact_id,flow_id,mime_type,byte_size,sha256 FROM flow_artifacts WHERE flow_id=?").all(flowId)) as Array<{ artifact_id: string; flow_id: string; mime_type: string; byte_size: number; sha256: string }>;
	const root = getDaedalusPath("flow.artifacts.root");
	await mkdir(root, { recursive: true });
	const canonicalRoot = await realpath(root);
	const issues: FlowArtifactHealthIssue[] = [];
	let checked = 0;
	for (const row of rows) {
		if (artifactIds && !artifactIds.has(row.artifact_id)) continue;
		checked++;
		let code: FlowArtifactHealthIssue["code"] | null = null;
		try {
			const source = await realpath(artifactPath(row.artifact_id, row.mime_type));
			const inside = relative(canonicalRoot, source);
			if (inside.startsWith("..") || isAbsolute(inside)) code = "path_invalid";
			else if ((await stat(source)).size !== row.byte_size) code = "size_mismatch";
			else {
				const hash = createHash("sha256");
				for await (const chunk of createReadStream(source, { highWaterMark: 1024 * 1024 })) hash.update(chunk);
				if (hash.digest("hex") !== row.sha256) code = "checksum_mismatch";
			}
		} catch (error: unknown) { code = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "path_invalid"; }
		if (code !== null) issues.push({ artifactId: row.artifact_id, flowId: row.flow_id, code });
	}
	const stagingFiles = (await readdir(root)).filter(name => name.endsWith(".staging")).length;
	for (const artifactId of artifactIds ?? []) if (!rows.some(row => row.artifact_id === artifactId)) issues.push({ artifactId, flowId: flowId ?? "", code: "missing" });
	return { checked, issues, stagingFiles };
}

export async function flowArtifactUsage(flowId?: string): Promise<{ byteSize: number; freeBytes: number | null; warning: boolean; warningThresholdBytes: number }> {
	const db = await getSessionDatabase();
	const row = (flowId === undefined
		? db.prepare("SELECT COALESCE(SUM(byte_size),0) AS total FROM flow_artifacts").get()
		: db.prepare("SELECT COALESCE(SUM(byte_size),0) AS total FROM flow_artifacts WHERE flow_id=?").get(flowId)) as { total: number };
	const root = getDaedalusPath("flow.artifacts.root");
	await mkdir(root, { recursive: true });
	const freeBytes = await statfs(root).then(info => info.bavail * info.bsize).catch(() => null);
	const warningThresholdBytes = 20 * 1024 ** 3;
	return { byteSize: row.total, freeBytes, warningThresholdBytes, warning: row.total >= warningThresholdBytes || freeBytes !== null && freeBytes < 2 * 1024 ** 3 };
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

export async function cleanupFlowArtifacts(input: { flowId: string; runIds: readonly string[]; dryRun: boolean; expectedArtifactIds?: readonly string[] }): Promise<{ runs: Array<{ runId: string; status: string }>; artifacts: Array<{ artifactId: string; byteSize: number }>; removed: number }> {
	const db = await getSessionDatabase();
	const runIds = [...new Set(input.runIds)].sort();
	if (runIds.length === 0 || runIds.length > 100) throw Object.assign(new Error("Select completed Flow runs to clean up."), { code: "flow_cleanup_invalid" });
	const placeholders = runIds.map(() => "?").join(",");
	const runs = db.prepare(`SELECT run_id,status FROM flow_runs WHERE flow_id=? AND run_id IN (${placeholders})`).all(input.flowId,...runIds) as Array<{ run_id: string; status: string }>;
	if (runs.length !== runIds.length || runs.some(run => ["queued","running","waiting"].includes(run.status))) throw Object.assign(new Error("All selected runs must exist in this Flow and be finished."), { code: "flow_cleanup_invalid" });
	const rows = db.prepare(`SELECT artifact_id,mime_type,byte_size FROM flow_artifacts WHERE flow_id=? AND run_id IN (${placeholders}) ORDER BY artifact_id`).all(input.flowId,...runIds) as Array<{ artifact_id: string; mime_type: string; byte_size: number }>;
	for (const row of rows) {
		const needle = `%${row.artifact_id}%`;
		if (db.prepare("SELECT 1 FROM flow_nodes WHERE flow_id=? AND config_json LIKE ? LIMIT 1").get(input.flowId,needle) ||
			db.prepare(`SELECT 1 FROM flow_node_runs WHERE run_id NOT IN (${placeholders}) AND output_json LIKE ? LIMIT 1`).get(...runIds,needle) ||
			db.prepare(`SELECT 1 FROM flow_media_attempts WHERE run_id NOT IN (${placeholders}) AND output_json LIKE ? LIMIT 1`).get(...runIds,needle) ||
			db.prepare(`SELECT 1 FROM flow_runs WHERE flow_id=? AND run_id NOT IN (${placeholders}) AND input_values_json LIKE ? LIMIT 1`).get(input.flowId,...runIds,needle) ||
			db.prepare(`SELECT 1 FROM flow_batch_items WHERE flow_id=? AND run_id NOT IN (${placeholders}) AND payload_json LIKE ? LIMIT 1`).get(input.flowId,...runIds,needle))
			throw Object.assign(new Error(`Artifact ${row.artifact_id} is still referenced outside the selected runs.`), { code: "flow_cleanup_artifact_in_use" });
	}
	const plan = { runs: runs.map(run => ({ runId: run.run_id, status: run.status })), artifacts: rows.map(row => ({ artifactId: row.artifact_id, byteSize: row.byte_size })), removed: 0 };
	if (input.dryRun) return plan;
	if (input.expectedArtifactIds === undefined || JSON.stringify([...input.expectedArtifactIds].sort()) !== JSON.stringify(rows.map(row => row.artifact_id)))
		throw Object.assign(new Error("Cleanup preview changed. Review the selected runs again."), { code: "flow_cleanup_plan_changed" });
	runSessionTransaction(db, (): void => { db.prepare(`DELETE FROM flow_runs WHERE flow_id=? AND run_id IN (${placeholders})`).run(input.flowId,...runIds); });
	for (const row of rows) await rm(artifactPath(row.artifact_id,row.mime_type), { force: true });
	return { ...plan, removed: runs.length };
}
