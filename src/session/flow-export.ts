import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { getDaedalusDir, getDaedalusPath } from "../app-paths.js";
import { getSessionDatabase } from "./session-database.js";

export type FlowExportResult = {
	exported: true;
	flowId: string;
	destinationPath: string;
	byteSize: number;
	tableCounts: Record<string, number>;
	embeddedFileCount: number;
	missingFileCount: number;
};

export const FLOW_EXPORT_FORMAT = "daedalus-flow-sqlite";
export const FLOW_EXPORT_FORMAT_VERSION = 2;
export const FLOW_EXPORT_TABLES = ["flow_documents", "flow_nodes", "flow_groups", "flow_group_nodes", "flow_edges", "flow_runs", "flow_node_runs", "flow_artifacts", "flow_batch_items"] as const;
function inside(root: string, file: string): boolean {
	const path = relative(root, file);
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
function quote(value: string): string { return `"${value.replaceAll('"', '""')}"`; }

export async function exportFlowToSqlite(flowId: string, destinationPath: string): Promise<FlowExportResult> {
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
	const backup = `${destination}.${randomUUID()}.backup`;
	let target: DatabaseSync | null = null;
	let hasBackup = false;
	try {
		target = new DatabaseSync(staging);
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
				const predicate = table === "flow_node_runs" ? "run_id IN (SELECT run_id FROM flow_runs WHERE flow_id = ?)" : "flow_id = ?";
				const keys = (source.prepare(`PRAGMA table_info(${quote(table)})`).all() as Array<{ name: string }>).map(column => column.name);
				const insert = target.prepare(`INSERT INTO ${quote(table)} (${keys.map(quote).join(",")}) VALUES (${keys.map(() => "?").join(",")})`);
				tableCounts[table] = 0;
				for (const row of source.prepare(`SELECT * FROM ${quote(table)} WHERE ${predicate}`).iterate(flowId)) {
					insert.run(...keys.map(key => row[key]) as SQLInputValue[]);
					tableCounts[table]++;
				}
			}
			target.exec("CREATE TABLE daedalus_flow_export_metadata (format TEXT NOT NULL, format_version INTEGER NOT NULL, flow_id TEXT NOT NULL, exported_at TEXT NOT NULL, embedded_file_count INTEGER NOT NULL DEFAULT 0, missing_file_count INTEGER NOT NULL DEFAULT 0); CREATE TABLE daedalus_flow_export_files (artifact_id TEXT PRIMARY KEY REFERENCES flow_artifacts(artifact_id), sha256 TEXT NOT NULL, content BLOB NOT NULL);");
			target.prepare("INSERT INTO daedalus_flow_export_metadata (format, format_version, flow_id, exported_at) VALUES (?, ?, ?, ?)").run(FLOW_EXPORT_FORMAT, FLOW_EXPORT_FORMAT_VERSION, flowId, new Date().toISOString());
			const schemaVersion = Number(source.prepare("PRAGMA user_version").get()?.user_version ?? 0);
			target.exec(`PRAGMA user_version = ${schemaVersion};`);
			target.exec("COMMIT");
		} finally { source.exec("ROLLBACK"); }
		let embeddedFileCount = 0, missingFileCount = 0;
		const artifacts = target.prepare("SELECT artifact_id, storage_path, sha256, byte_size FROM flow_artifacts").all() as Array<{ artifact_id: string; storage_path: string; sha256: string; byte_size: number }>;
		for (const artifact of artifacts) {
			try {
				const root = await realpath(getDaedalusPath("flow.artifacts.root"));
				const path = await realpath(resolve(root, artifact.storage_path));
				if (!inside(root, path)) throw new Error("Flow artifact resolves outside its storage root.");
				const info = await stat(path);
				if (!info.isFile() || info.size > 512 * 1024 * 1024 || info.size !== artifact.byte_size) throw new Error("Flow artifact size is invalid.");
				const content = await readFile(path);
				if (createHash("sha256").update(content).digest("hex") !== artifact.sha256) throw new Error("Flow artifact integrity check failed.");
				target.prepare("INSERT INTO daedalus_flow_export_files VALUES (?, ?, ?)").run(artifact.artifact_id, artifact.sha256, content);
				embeddedFileCount++;
			} catch (error: unknown) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				throw new Error(`Flow artifact file is missing: ${artifact.artifact_id}.`);
			}
		}
		target.prepare("UPDATE daedalus_flow_export_metadata SET embedded_file_count = ?, missing_file_count = ?").run(embeddedFileCount, missingFileCount);
		if (target.prepare("PRAGMA foreign_key_check").all().length || target.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") throw new Error("Flow export integrity validation failed.");
		target.close(); target = null;
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
	}
}
