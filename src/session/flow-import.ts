import { createHash } from "node:crypto";
import { mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { getDaedalusPath } from "../app-paths.js";
import { getSessionDatabase, runSessionTransaction } from "./session-database.js";
import { FLOW_EXPORT_FORMAT, FLOW_EXPORT_FORMAT_VERSION, FLOW_EXPORT_TABLES } from "./flow-export.js";

const FLOW_ID_PATTERN = /^flow-[A-Za-z0-9_-]+$/u;
const ARTIFACT_ID_PATTERN = /^flow-artifact-[A-Za-z0-9_-]+$/u;
const MAX_EXPORT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const INTERRUPTED_MESSAGE = "This run was active when the Flow was exported and could not be resumed on this device.";
const ACTIVE_RUN_STATUSES = new Set(["queued", "running", "waiting"]);
const ACTIVE_BATCH_STATUSES = new Set(["queued", "submitting", "running"]);

type FlowExportMetadata = {
	format: string;
	format_version: number;
	flow_id: string;
	embedded_file_count: number;
	missing_file_count: number;
};

type FlowRow = {
	flow_id: string;
	title: string;
	workspace_id: string | null;
	archived_at: string | null;
};

type ArtifactRow = {
	artifact_id: string;
	flow_id: string;
	mime_type: string;
	byte_size: number;
	sha256: string;
};

type EmbeddedArtifactRow = {
	artifact_id: string;
	sha256: string;
	content: Uint8Array;
};

export type FlowImportResult = {
	imported: true;
	flowId: string;
	title: string;
	workspaceId: string | null;
	archived: boolean;
	sourcePath: string;
	tableCounts: Record<string, number>;
	restoredArtifactCount: number;
	missingArtifactCount: number;
};

function importError(code: string, message: string): Error & { code: string } {
	return Object.assign(new Error(message), { code });
}

function quoteIdentifier(identifier: string): string {
	return `"${identifier.replaceAll("\"", "\"\"")}"`;
}

function hasTable(db: DatabaseSync, name: string): boolean {
	return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function getColumns(db: DatabaseSync, table: string): string[] {
	return (db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string }>).map(column => column.name);
}

function isInside(root: string, target: string): boolean {
	const path = relative(root, target);
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function artifactFileName(artifactId: string, mimeType: string): string {
	if (!ARTIFACT_ID_PATTERN.test(artifactId) || !mimeType.includes("/"))
		throw importError("flow_import_invalid_format", "Flow export contains invalid media metadata.");
	const extension = mimeType.split("/")[1]?.replace(/[^a-z0-9]+/giu, "").slice(0, 12) || "bin";
	return `${artifactId}.${extension}`;
}

async function resolveSourcePath(sourcePath: string): Promise<string> {
	if (!isAbsolute(sourcePath)) throw importError("flow_import_source_invalid", "Flow import source must be an absolute path.");
	const source = resolve(sourcePath);
	const info = await stat(source);
	if (!info.isFile()) throw importError("flow_import_source_invalid", "Flow import source is not a file.");
	if (info.size <= 0 || info.size > MAX_EXPORT_BYTES) throw importError("flow_import_source_invalid", "Flow export size is outside the supported range.");
	return realpath(source);
}

function validateDatabase(source: DatabaseSync): void {
	const integrity = source.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown } | undefined;
	if (String(integrity?.integrity_check ?? "") !== "ok")
		throw importError("flow_import_sqlite_invalid", "Flow import SQLite integrity validation failed.");
	if (source.prepare("PRAGMA foreign_key_check").all().length > 0)
		throw importError("flow_import_sqlite_invalid", "Flow import foreign key validation failed.");
}

function readMetadata(source: DatabaseSync): FlowExportMetadata {
	if (!hasTable(source, "daedalus_flow_export_metadata") || !hasTable(source, "daedalus_flow_export_files"))
		throw importError("flow_import_invalid_format", "The selected SQLite file is not a Daedalus Flow export.");
	const metadataColumns = getColumns(source, "daedalus_flow_export_metadata");
	if (!["format", "format_version", "flow_id", "exported_at", "embedded_file_count", "missing_file_count"].every(column => metadataColumns.includes(column)))
		throw importError("flow_import_invalid_format", "Flow export metadata is incomplete.");
	const fileColumns = getColumns(source, "daedalus_flow_export_files");
	if (!["artifact_id", "sha256", "content"].every(column => fileColumns.includes(column)))
		throw importError("flow_import_invalid_format", "Flow export media data is incomplete.");
	const rows = source.prepare("SELECT format, format_version, flow_id, embedded_file_count, missing_file_count FROM daedalus_flow_export_metadata").all() as FlowExportMetadata[];
	if (rows.length !== 1) throw importError("flow_import_invalid_format", "Flow export metadata is invalid.");
	const metadata = rows[0]!;
	if (metadata.format !== FLOW_EXPORT_FORMAT || Number(metadata.format_version) !== FLOW_EXPORT_FORMAT_VERSION)
		throw importError("flow_import_unsupported_format", "This Flow export format is not supported by this version of Daedalus.");
	if (!FLOW_ID_PATTERN.test(metadata.flow_id)) throw importError("flow_import_invalid_format", "Flow export has an invalid Flow ID.");
	const embeddedFileCount = Number(metadata.embedded_file_count);
	const missingFileCount = Number(metadata.missing_file_count);
	const actualEmbeddedFileCount = Number((source.prepare("SELECT count(*) AS count FROM daedalus_flow_export_files").get() as { count: number }).count);
	if (!Number.isSafeInteger(embeddedFileCount) || embeddedFileCount < 0 || !Number.isSafeInteger(missingFileCount) || missingFileCount < 0 || actualEmbeddedFileCount !== embeddedFileCount)
		throw importError("flow_import_invalid_format", "Flow export media counts do not match its metadata.");
	return metadata;
}

function checkSchemaVersion(source: DatabaseSync, target: DatabaseSync): void {
	const sourceVersion = Number((source.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined)?.user_version ?? 0);
	const targetVersion = Number((target.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined)?.user_version ?? 0);
	if (sourceVersion !== targetVersion)
		throw importError("flow_import_unsupported_schema", "This Flow was exported with a different database schema version. Update Daedalus or re-export it with the current version.");
	for (const table of FLOW_EXPORT_TABLES) {
		if (!hasTable(source, table) || !hasTable(target, table))
			throw importError("flow_import_invalid_format", `Flow export is missing a required table: ${table}.`);
		const sourceColumns = getColumns(source, table);
		const targetColumns = getColumns(target, table);
		if (sourceColumns.length === 0 || sourceColumns.join("\0") !== targetColumns.join("\0"))
			throw importError("flow_import_unsupported_schema", `Flow export table schema does not match this version: ${table}.`);
	}
}

function readRootFlow(source: DatabaseSync, flowId: string): FlowRow {
	const rows = source.prepare("SELECT flow_id, title, workspace_id, archived_at FROM flow_documents").all() as FlowRow[];
	if (rows.length !== 1 || rows[0]?.flow_id !== flowId)
		throw importError("flow_import_invalid_format", "Flow export must contain exactly one matching Flow document.");
	return rows[0]!;
}

function assertExportIsolated(source: DatabaseSync, flowId: string): void {
	for (const table of FLOW_EXPORT_TABLES) {
		if (table === "flow_node_runs") {
			const extra = source.prepare("SELECT 1 FROM flow_node_runs WHERE run_id NOT IN (SELECT run_id FROM flow_runs WHERE flow_id = ?) LIMIT 1").get(flowId);
			if (extra !== undefined) throw importError("flow_import_invalid_format", "Flow export contains run data outside its root Flow.");
		} else {
			const extra = source.prepare(`SELECT 1 FROM ${quoteIdentifier(table)} WHERE flow_id <> ? LIMIT 1`).get(flowId);
			if (extra !== undefined) throw importError("flow_import_invalid_format", "Flow export contains data outside its root Flow.");
		}
	}
}

function sanitizeRow(table: string, row: Record<string, unknown>, validWorkspaceIds?: ReadonlySet<string>): Record<string, unknown> {
	const copy = { ...row };
	const timestamp = new Date().toISOString();
	if (table === "flow_documents" && typeof copy.workspace_id === "string" && validWorkspaceIds !== undefined && !validWorkspaceIds.has(copy.workspace_id))
		copy.workspace_id = null;
	if (table === "flow_nodes" && ACTIVE_RUN_STATUSES.has(String(copy.status))) copy.status = "failed";
	if (table === "flow_runs" && ACTIVE_RUN_STATUSES.has(String(copy.status))) {
		copy.status = "failed";
		copy.finished_at = timestamp;
		copy.error = INTERRUPTED_MESSAGE;
	}
	if (table === "flow_node_runs" && ACTIVE_RUN_STATUSES.has(String(copy.status))) {
		copy.status = "failed";
		copy.provider_job_id = null;
		copy.finished_at = timestamp;
		copy.error = INTERRUPTED_MESSAGE;
	}
	if (table === "flow_artifacts") {
		copy.storage_path = artifactFileName(String(copy.artifact_id), String(copy.mime_type));
	}
	if (table === "flow_batch_items") {
		let payload: Record<string, unknown>;
		try {
			const value: unknown = JSON.parse(String(copy.payload_json));
			if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("payload is not an object");
			payload = value as Record<string, unknown>;
		} catch {
			throw importError("flow_import_invalid_format", "Flow export contains an invalid batch item record.");
		}
		if (ACTIVE_BATCH_STATUSES.has(String(copy.status))) {
			copy.status = "failed";
			payload.status = "failed";
			payload.providerJobId = null;
			payload.error = INTERRUPTED_MESSAGE;
			copy.payload_json = JSON.stringify(payload);
		}
	}
	return copy;
}

function copyTableRows(
	source: DatabaseSync,
	target: DatabaseSync,
	table: typeof FLOW_EXPORT_TABLES[number],
	flowId: string,
	validWorkspaceIds: ReadonlySet<string> | undefined,
): number {
	const columns = getColumns(target, table);
	const predicate = table === "flow_node_runs"
		? "run_id IN (SELECT run_id FROM flow_runs WHERE flow_id = ?)"
		: "flow_id = ?";
	const insert = target.prepare(`INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
	let count = 0;
	for (const value of source.prepare(`SELECT * FROM ${quoteIdentifier(table)} WHERE ${predicate}`).iterate(flowId)) {
		const row = sanitizeRow(table, value as Record<string, unknown>, validWorkspaceIds);
		insert.run(...columns.map(column => row[column] as SQLInputValue));
		count++;
	}
	return count;
}

async function restoreArtifacts(source: DatabaseSync, target: DatabaseSync): Promise<{ paths: string[]; missingCount: number }> {
	const artifacts = source.prepare("SELECT artifact_id, flow_id, mime_type, byte_size, sha256 FROM flow_artifacts").all() as ArtifactRow[];
	const files = source.prepare("SELECT artifact_id, sha256, content FROM daedalus_flow_export_files").iterate();
	const artifactsById = new Map(artifacts.map(row => [row.artifact_id, row]));
	const root = getDaedalusPath("flow.artifacts.root");
	await mkdir(root, { recursive: true });
	const rootPath = await realpath(root);
	const paths: string[] = [];
	let restoredCount = 0;
	let totalBytes = 0;
	try {
		for (const value of files) {
			const file = value as EmbeddedArtifactRow;
			const artifact = artifactsById.get(file.artifact_id);
			if (artifact === undefined || artifact.flow_id.length === 0 || !ARTIFACT_ID_PATTERN.test(file.artifact_id))
				throw importError("flow_import_invalid_format", "Flow export contains an unreferenced media file.");
			const bytes = Buffer.from(file.content);
			const expectedSize = Number(artifact.byte_size);
			if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0 || expectedSize > MAX_ARTIFACT_BYTES || bytes.byteLength !== expectedSize)
				throw importError("flow_import_file_invalid", `Embedded Flow artifact has an invalid size: ${file.artifact_id}.`);
			if (file.sha256 !== artifact.sha256 || !/^[a-f0-9]{64}$/u.test(file.sha256) || createHash("sha256").update(bytes).digest("hex") !== file.sha256)
				throw importError("flow_import_file_invalid", `Embedded Flow artifact checksum does not match: ${file.artifact_id}.`);
			totalBytes += bytes.byteLength;
			if (totalBytes > MAX_EXPORT_BYTES) throw importError("flow_import_source_invalid", "Total embedded Flow media exceeds the supported import size.");
			const destination = resolve(rootPath, artifactFileName(file.artifact_id, artifact.mime_type));
			if (!isInside(rootPath, destination) || basename(destination) !== artifactFileName(file.artifact_id, artifact.mime_type))
				throw importError("flow_import_file_invalid", "Embedded Flow artifact path is invalid.");
			if (target.prepare("SELECT 1 FROM flow_artifacts WHERE artifact_id = ?").get(file.artifact_id) !== undefined)
				throw importError("flow_import_conflict", `Flow artifact already exists: ${file.artifact_id}.`);
			await writeFile(destination, bytes, { flag: "wx" });
			paths.push(destination);
			artifactsById.delete(file.artifact_id);
			restoredCount++;
		}
		return { paths, missingCount: artifactsById.size };
	} catch (error: unknown) {
		await Promise.all(paths.map(path => rm(path, { force: true }).catch((): void => {})));
		throw error;
	}
}

export async function importFlowFromSqlite(
	sourcePath: string,
	options: { validWorkspaceIds?: ReadonlySet<string> } = {},
): Promise<FlowImportResult> {
	const sourceFilePath = await resolveSourcePath(sourcePath);
	const target = await getSessionDatabase();
	const activePath = (target.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>).find(row => row.name === "main")?.file;
	if (activePath !== undefined && resolve(sourceFilePath).toLocaleLowerCase() === resolve(activePath).toLocaleLowerCase())
		throw importError("flow_import_source_invalid", "Cannot import the active Daedalus database as a Flow export.");
	const source = new DatabaseSync(sourceFilePath, { readOnly: true, timeout: 5000 });
	let createdArtifactPaths: string[] = [];
	try {
		validateDatabase(source);
		const metadata = readMetadata(source);
		checkSchemaVersion(source, target);
		assertExportIsolated(source, metadata.flow_id);
		const flow = readRootFlow(source, metadata.flow_id);
		if (target.prepare("SELECT 1 FROM flow_documents WHERE flow_id = ?").get(flow.flow_id) !== undefined)
			throw importError("flow_import_conflict", `Flow already exists: ${flow.flow_id}.`);
		const artifacts = await restoreArtifacts(source, target);
		createdArtifactPaths = artifacts.paths;
		const tableCounts: Record<string, number> = {};
		try {
			runSessionTransaction(target, (): void => {
				for (const table of FLOW_EXPORT_TABLES)
					tableCounts[table] = copyTableRows(source, target, table, metadata.flow_id, options.validWorkspaceIds);
				if (target.prepare("PRAGMA foreign_key_check").all().length > 0)
					throw importError("flow_import_invalid_format", "Imported Flow failed foreign key validation.");
			});
		} catch (error: unknown) {
			await Promise.all(createdArtifactPaths.map(path => rm(path, { force: true }).catch((): void => {})));
			createdArtifactPaths = [];
			throw error;
		}
		const workspaceId = flow.workspace_id !== null && options.validWorkspaceIds !== undefined && !options.validWorkspaceIds.has(flow.workspace_id)
			? null
			: flow.workspace_id;
		return {
			imported: true,
			flowId: flow.flow_id,
			title: flow.title,
			workspaceId,
			archived: flow.archived_at !== null,
			sourcePath: sourceFilePath,
			tableCounts,
			restoredArtifactCount: createdArtifactPaths.length,
			missingArtifactCount: artifacts.missingCount,
		};
	} finally {
		source.close();
	}
}
