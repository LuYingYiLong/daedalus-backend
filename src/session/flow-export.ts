import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { getDaedalusDir, getDaedalusPath } from "../app-paths.js";
import { getSessionDatabase } from "./session-database.js";
import { appendVerifiedFile, MAX_FLOW_ARCHIVE_ARTIFACTS, MAX_FLOW_ARCHIVE_BYTES, MAX_FLOW_ARTIFACT_BYTES, writeFlowArchiveHeader, FLOW_ARCHIVE_HEADER_BYTES } from "./flow-archive-format.js";

export type FlowExportResult = {
	exported: true;
	flowId: string;
	destinationPath: string;
	byteSize: number;
	tableCounts: Record<string, number>;
	embeddedFileCount: number;
	missingFileCount: number;
};

export const FLOW_EXPORT_FORMAT = "daedalus-flow-archive";
export const FLOW_EXPORT_FORMAT_VERSION = 3;
export const FLOW_EXPORT_TABLES = ["flow_documents", "flow_nodes", "flow_groups", "flow_group_nodes", "flow_edges", "flow_runs", "flow_node_runs", "flow_node_run_events", "flow_media_attempts", "flow_artifacts", "flow_batch_items"] as const;
function inside(root: string, file: string): boolean {
	const path = relative(root, file);
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
function quote(value: string): string { return `"${value.replaceAll('"', '""')}"`; }

export async function exportFlowToSqlite(flowId: string, destinationPath: string, options: { signal?: AbortSignal } = {}): Promise<FlowExportResult> {
	options.signal?.throwIfAborted();
	if (!isAbsolute(destinationPath)) throw new Error("Flow export destination must be absolute.");
	const destination = resolve(destinationPath);
	await mkdir(dirname(destination), { recursive: true });
	const parent = await realpath(dirname(destination));
	const appRoot = await realpath(getDaedalusDir()).catch((): string => resolve(getDaedalusDir()));
	const source = await getSessionDatabase();
	const sourcePath = (source.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>).find(row => row.name === "main")?.file;
	const canonicalDestination = await realpath(destination).catch((): string => resolve(parent, relative(dirname(destination), destination)));
	if (inside(appRoot, canonicalDestination) || (sourcePath && canonicalDestination.toLowerCase() === (await realpath(sourcePath)).toLowerCase()))
		throw new Error("Cannot overwrite Daedalus application data with a Flow export.");
	const staging = `${destination}.${randomUUID()}.staging`;
	const manifestStaging = `${destination}.${randomUUID()}.manifest`;
	const backup = `${destination}.${randomUUID()}.backup`;
	let target: DatabaseSync | null = null;
	let hasBackup = false;
	try {
		target = new DatabaseSync(manifestStaging);
		target.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA foreign_keys = OFF;");
		const tableCounts: Record<string, number> = {};
		// 同步复制同一读事务中的数据，媒体读取不持有源数据库事务
		source.exec("BEGIN");
		try {
			if (!source.prepare("SELECT 1 FROM flow_documents WHERE flow_id = ?").get(flowId))
				throw Object.assign(new Error("Flow not found."), { code: "flow_not_found" });
			target.exec("BEGIN");
			for (const table of FLOW_EXPORT_TABLES) {
				const schema = source.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string };
				target.exec(schema.sql);
				const predicate = ["flow_node_runs", "flow_node_run_events", "flow_media_attempts"].includes(table) ? "run_id IN (SELECT run_id FROM flow_runs WHERE flow_id = ?)" : "flow_id = ?";
				const keys = (source.prepare(`PRAGMA table_info(${quote(table)})`).all() as Array<{ name: string }>).map(column => column.name);
				const insert = target.prepare(`INSERT INTO ${quote(table)} (${keys.map(quote).join(",")}) VALUES (${keys.map(() => "?").join(",")})`);
				tableCounts[table] = 0;
				for (const row of source.prepare(`SELECT * FROM ${quote(table)} WHERE ${predicate}`).iterate(flowId)) {
					insert.run(...keys.map(key => row[key]) as SQLInputValue[]);
					tableCounts[table]++;
				}
			}
			target.exec("CREATE TABLE daedalus_flow_export_metadata (format TEXT NOT NULL, format_version INTEGER NOT NULL, flow_id TEXT NOT NULL, exported_at TEXT NOT NULL, embedded_file_count INTEGER NOT NULL DEFAULT 0, missing_file_count INTEGER NOT NULL DEFAULT 0);");
			target.prepare("INSERT INTO daedalus_flow_export_metadata (format, format_version, flow_id, exported_at) VALUES (?, ?, ?, ?)").run(FLOW_EXPORT_FORMAT, FLOW_EXPORT_FORMAT_VERSION, flowId, new Date().toISOString());
			const schemaVersion = Number(source.prepare("PRAGMA user_version").get()?.user_version ?? 0);
			target.exec(`PRAGMA user_version = ${schemaVersion};`);
			target.exec("COMMIT");
		} finally { source.exec("ROLLBACK"); }
		let embeddedFileCount = 0, missingFileCount = 0;
		const artifacts = target.prepare("SELECT artifact_id, storage_path, sha256, byte_size FROM flow_artifacts ORDER BY artifact_id").all() as Array<{ artifact_id: string; storage_path: string; sha256: string; byte_size: number }>;
		if (artifacts.length > MAX_FLOW_ARCHIVE_ARTIFACTS) throw new Error("Flow archive contains too many artifacts.");
		let plannedBytes = FLOW_ARCHIVE_HEADER_BYTES;
		for (const artifact of artifacts) {
			options.signal?.throwIfAborted();
			try {
				const root = await realpath(getDaedalusPath("flow.artifacts.root"));
				const path = await realpath(resolve(root, artifact.storage_path));
				if (!inside(root, path)) throw new Error("Flow artifact resolves outside its storage root.");
				const info = await stat(path);
				if (!info.isFile() || info.size > MAX_FLOW_ARTIFACT_BYTES || info.size !== artifact.byte_size) throw new Error("Flow artifact size is invalid.");
				plannedBytes += info.size;
				embeddedFileCount++;
			} catch (error: unknown) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				throw new Error(`Flow artifact file is missing: ${artifact.artifact_id}.`);
			}
		}
		target.prepare("UPDATE daedalus_flow_export_metadata SET embedded_file_count = ?, missing_file_count = ?").run(embeddedFileCount, missingFileCount);
		if (target.prepare("PRAGMA foreign_key_check").all().length || target.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") throw new Error("Flow export integrity validation failed.");
		target.close(); target = null;
		const manifestBytes = (await stat(manifestStaging)).size;
		if (plannedBytes + manifestBytes > MAX_FLOW_ARCHIVE_BYTES) throw new Error("Flow archive exceeds the 2 GiB limit.");
		const archive = await open(staging, "wx");
		try {
			options.signal?.throwIfAborted();
			await writeFlowArchiveHeader(archive, manifestBytes);
			await appendVerifiedFile(archive, manifestStaging, manifestBytes, undefined, options.signal);
			for (const artifact of artifacts) {
				options.signal?.throwIfAborted();
				const root = await realpath(getDaedalusPath("flow.artifacts.root"));
				const sourcePath = await realpath(resolve(root, artifact.storage_path));
				if (!inside(root, sourcePath)) throw new Error("Flow artifact resolves outside its storage root.");
				await appendVerifiedFile(archive, sourcePath, artifact.byte_size, artifact.sha256, options.signal);
			}
			await archive.sync();
		} finally { await archive.close(); }
		options.signal?.throwIfAborted();
		try {
			if (!(await stat(destination)).isFile()) throw new Error("Flow export destination is not a file.");
			await rename(destination, backup); hasBackup = true;
		} catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		try { await rename(staging, destination); }
		catch (error: unknown) { if (hasBackup) await rename(backup, destination); throw error; }
		if (hasBackup) await rm(backup, { force: true }).catch((): void => {});
		return { exported: true, flowId, destinationPath: destination, byteSize: (await stat(destination)).size, tableCounts, embeddedFileCount, missingFileCount };
	} finally {
		target?.close();
		await rm(staging, { force: true }).catch((): void => {});
		await rm(manifestStaging, { force: true }).catch((): void => {});
	}
}
