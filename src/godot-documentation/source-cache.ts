import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { dirname, join } from "node:path";
import { collectRstFiles, findDocumentationRoot } from "./indexer.js";
import { sha256File } from "./health.js";
import {
	getGodotDocumentationSnapshot,
	getGodotDocumentationSourceDir,
	getGodotDocumentationSourcesRoot
} from "./store.js";
import type { GodotDocumentationSourceRef } from "./types.js";

export const GODOT_DOCUMENTATION_SOURCE_CACHE_LIMIT_BYTES: number = 2 * 1024 * 1024 * 1024;

type SourceCacheMetadata = GodotDocumentationSourceRef & {
	createdAt: string;
	accessedAt: string;
};

function metadataPath(sha256: string): string {
	return join(getGodotDocumentationSourceDir(sha256), "source.json");
}

async function readMetadata(sha256: string): Promise<SourceCacheMetadata | null> {
	try {
		const value = JSON.parse(await readFile(metadataPath(sha256), "utf8")) as Partial<SourceCacheMetadata>;
		if ((value.kind === "official_zip" || value.kind === "local_zip" || value.kind === "local_tree")
			&& value.sha256 === sha256
			&& typeof value.sizeBytes === "number"
			&& typeof value.createdAt === "string"
			&& typeof value.accessedAt === "string") {
			return value as SourceCacheMetadata;
		}
	} catch {
		// Missing or malformed cache entries are treated as unavailable.
	}
	return null;
}

async function writeMetadata(dir: string, metadata: SourceCacheMetadata): Promise<void> {
	await writeFile(join(dir, "source.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

async function listCacheEntries(): Promise<SourceCacheMetadata[]> {
	const entries: Dirent[] = await readdir(getGodotDocumentationSourcesRoot(), { withFileTypes: true }).catch((): Dirent[] => []);
	const values: SourceCacheMetadata[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !/^[0-9a-f]{64}$/u.test(entry.name)) continue;
		const metadata = await readMetadata(entry.name);
		if (metadata !== null) values.push(metadata);
	}
	return values;
}

export async function pruneGodotDocumentationSourceCache(requiredBytes: number = 0): Promise<void> {
	const referenced: Set<string> = new Set(Object.values(getGodotDocumentationSnapshot().documents)
		.flatMap((record): string[] => record.sourceRef === null ? [] : [record.sourceRef.sha256]));
	const entries = await listCacheEntries();
	let totalBytes: number = entries.reduce((sum, entry): number => sum + entry.sizeBytes, 0);
	const targetBytes: number = GODOT_DOCUMENTATION_SOURCE_CACHE_LIMIT_BYTES - Math.max(0, requiredBytes);
	for (const entry of entries
		.filter((candidate): boolean => !referenced.has(candidate.sha256))
		.sort((left, right): number => left.accessedAt.localeCompare(right.accessedAt))) {
		if (totalBytes <= targetBytes) break;
		await rm(getGodotDocumentationSourceDir(entry.sha256), { recursive: true, force: true }).catch((): void => undefined);
		totalBytes -= entry.sizeBytes;
	}
	if (totalBytes > targetBytes) {
		throw new Error(`documentation_source_cache_full: ${requiredBytes} additional bytes are required, but installed documentation sources are protected.`);
	}
}

async function activateSource(stagingDir: string, ref: GodotDocumentationSourceRef): Promise<GodotDocumentationSourceRef> {
	const targetDir: string = getGodotDocumentationSourceDir(ref.sha256);
	if (await readMetadata(ref.sha256) !== null) {
		await rm(stagingDir, { recursive: true, force: true });
		await touchGodotDocumentationSource(ref);
		return ref;
	}
	await pruneGodotDocumentationSourceCache(ref.sizeBytes);
	await mkdir(dirname(targetDir), { recursive: true });
	try {
		await rename(stagingDir, targetDir);
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		await rm(stagingDir, { recursive: true, force: true });
	}
	return ref;
}

export async function cacheGodotDocumentationArchive(
	archivePath: string,
	kind: "official_zip" | "local_zip"
): Promise<GodotDocumentationSourceRef> {
	const sha256: string = await sha256File(archivePath);
	const sizeBytes: number = (await stat(archivePath)).size;
	const existing = await readMetadata(sha256);
	if (existing !== null) {
		const ref: GodotDocumentationSourceRef = { kind: existing.kind, sha256, sizeBytes: existing.sizeBytes };
		await touchGodotDocumentationSource(ref);
		return ref;
	}
	const stagingDir: string = join(getGodotDocumentationSourcesRoot(), `.staging-${randomUUID()}`);
	await mkdir(stagingDir, { recursive: true });
	try {
		await copyFile(archivePath, join(stagingDir, "archive.zip"));
		const now: string = new Date().toISOString();
		const ref: GodotDocumentationSourceRef = { kind, sha256, sizeBytes };
		await writeMetadata(stagingDir, { ...ref, createdAt: now, accessedAt: now });
		return await activateSource(stagingDir, ref);
	} catch (error: unknown) {
		await rm(stagingDir, { recursive: true, force: true });
		throw error;
	}
}

export async function cacheGodotDocumentationTree(extractedRoot: string): Promise<GodotDocumentationSourceRef> {
	const root: string = await findDocumentationRoot(extractedRoot);
	const files = await collectRstFiles(root);
	const hash = createHash("sha256");
	let sizeBytes: number = 0;
	const confPath: string = join(root, "conf.py");
	const conf = await readFile(confPath);
	hash.update("conf.py\0");
	hash.update(conf);
	sizeBytes += conf.length;
	for (const file of files) {
		const content = await readFile(file.absolutePath);
		hash.update(`${file.relativePath}\0`);
		hash.update(content);
		sizeBytes += content.length;
	}
	const sha256: string = hash.digest("hex");
	const existing = await readMetadata(sha256);
	if (existing !== null) {
		const ref: GodotDocumentationSourceRef = { kind: "local_tree", sha256, sizeBytes: existing.sizeBytes };
		await touchGodotDocumentationSource(ref);
		return ref;
	}
	const stagingDir: string = join(getGodotDocumentationSourcesRoot(), `.staging-${randomUUID()}`);
	const treeDir: string = join(stagingDir, "tree");
	await mkdir(treeDir, { recursive: true });
	try {
		await writeFile(join(treeDir, "conf.py"), conf);
		for (const file of files) {
			const target: string = join(treeDir, ...file.relativePath.split("/"));
			await mkdir(dirname(target), { recursive: true });
			await copyFile(file.absolutePath, target);
		}
		const now: string = new Date().toISOString();
		const ref: GodotDocumentationSourceRef = { kind: "local_tree", sha256, sizeBytes };
		await writeMetadata(stagingDir, { ...ref, createdAt: now, accessedAt: now });
		return await activateSource(stagingDir, ref);
	} catch (error: unknown) {
		await rm(stagingDir, { recursive: true, force: true });
		throw error;
	}
}

export async function hasGodotDocumentationSource(ref: GodotDocumentationSourceRef | null): Promise<boolean> {
	if (ref === null) return false;
	const metadata = await readMetadata(ref.sha256);
	if (metadata === null || metadata.kind !== ref.kind) return false;
	const sourcePath: string = ref.kind === "local_tree"
		? join(getGodotDocumentationSourceDir(ref.sha256), "tree", "conf.py")
		: join(getGodotDocumentationSourceDir(ref.sha256), "archive.zip");
	return stat(sourcePath).then((): boolean => true).catch((): boolean => false);
}

export function getGodotDocumentationCachedSourcePath(ref: GodotDocumentationSourceRef): string {
	return ref.kind === "local_tree"
		? join(getGodotDocumentationSourceDir(ref.sha256), "tree")
		: join(getGodotDocumentationSourceDir(ref.sha256), "archive.zip");
}

export async function touchGodotDocumentationSource(ref: GodotDocumentationSourceRef): Promise<void> {
	const metadata = await readMetadata(ref.sha256);
	if (metadata === null) return;
	await writeMetadata(getGodotDocumentationSourceDir(ref.sha256), {
		...metadata,
		accessedAt: new Date().toISOString()
	}).catch((): void => undefined);
}

export async function cleanupGodotDocumentationSourceStaging(): Promise<void> {
	const entries: Dirent[] = await readdir(getGodotDocumentationSourcesRoot(), { withFileTypes: true }).catch((): Dirent[] => []);
	await Promise.all(entries
		.filter((entry): boolean => entry.isDirectory() && entry.name.startsWith(".staging-"))
		.map((entry): Promise<void> => rm(join(getGodotDocumentationSourcesRoot(), entry.name), { recursive: true, force: true })));
}
