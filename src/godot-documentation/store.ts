import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	getGodotDocumentationConfigPath,
	getGodotDocumentationRoot
} from "../app-paths.js";
import { writeJsonFileAtomic } from "../json-file-store.js";
import type {
	DocumentationHealthStatus,
	DocumentationRepairAvailability,
	GodotDocumentationRecord,
	GodotDocumentationSourceRef,
	GodotDocumentationSettings,
	GodotDocumentationState
} from "./types.js";

const EMPTY_SETTINGS: GodotDocumentationSettings = {
	schemaVersion: 2,
	enabled: false,
	documents: {}
};

let snapshot: GodotDocumentationSettings = structuredClone(EMPTY_SETTINGS);
let initialized: boolean = false;
let writeQueue: Promise<void> = Promise.resolve();

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown, maxLength: number): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const normalized: string = value.trim();
	return normalized.length > 0 && normalized.length <= maxLength ? normalized : null;
}

function readNonNegativeInteger(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeSourceRef(value: unknown): GodotDocumentationSourceRef | null {
	if (!isRecord(value)) {
		return null;
	}
	const kind = value.kind === "official_zip" || value.kind === "local_zip" || value.kind === "local_tree"
		? value.kind
		: null;
	const sha256: string | null = readString(value.sha256, 64);
	const sizeBytes: number | null = readNonNegativeInteger(value.sizeBytes);
	return kind !== null && sha256 !== null && /^[0-9a-f]{64}$/u.test(sha256) && sizeBytes !== null
		? { kind, sha256, sizeBytes }
		: null;
}

function normalizeHealth(value: unknown): GodotDocumentationRecord["health"] {
	const statuses: ReadonlySet<DocumentationHealthStatus> = new Set([
		"checking", "ready", "degraded", "repairing", "unavailable"
	]);
	if (!isRecord(value) || typeof value.status !== "string" || !statuses.has(value.status as DocumentationHealthStatus)) {
		return { status: "unavailable", code: "documentation_index_missing", message: "Documentation index has not been verified.", checkedAt: null };
	}
	return {
		status: value.status as DocumentationHealthStatus,
		code: value.code === null ? null : readString(value.code, 120),
		message: value.message === null ? null : readString(value.message, 2_000),
		checkedAt: value.checkedAt === null ? null : readString(value.checkedAt, 80)
	};
}

function normalizeRepairAvailability(value: unknown): DocumentationRepairAvailability {
	return value === "rollback"
		|| value === "cached_source"
		|| value === "network_required"
		|| value === "source_required"
		|| value === "none"
		? value
		: "none";
}

function normalizeDocument(value: unknown): GodotDocumentationRecord | null {
	if (!isRecord(value)) {
		return null;
	}
	const id: string | null = readString(value.id, 80);
	const branch: string | null = readString(value.branch, 120);
	const commitSha: string | null = readString(value.commitSha, 40);
	const source: "official" | "local" = value.source === "local" ? "local" : "official";
	const sourcePath: string | null = source === "local" ? readString(value.sourcePath, 32_768) : null;
	const sourceRef: GodotDocumentationSourceRef | null = normalizeSourceRef(value.sourceRef);
	const activeGenerationId: string | null = value.activeGenerationId === null
		? null
		: readString(value.activeGenerationId, 180);
	const installedAt: string | null = readString(value.installedAt, 80);
	const updatedAt: string | null = readString(value.updatedAt, 80);
	const documentCount: number | null = readNonNegativeInteger(value.documentCount);
	const chunkCount: number | null = readNonNegativeInteger(value.chunkCount);
	const classCount: number | null = readNonNegativeInteger(value.classCount);
	const sizeBytes: number | null = readNonNegativeInteger(value.sizeBytes);
	if (
		id === null
		|| branch === null
		|| commitSha === null
		|| !/^[0-9a-f]{40}$/u.test(commitSha)
		|| (activeGenerationId !== null && !/^[a-zA-Z0-9._-]+$/u.test(activeGenerationId))
		|| (source === "local" && sourcePath === null)
		|| installedAt === null
		|| updatedAt === null
		|| documentCount === null
		|| chunkCount === null
		|| classCount === null
		|| sizeBytes === null
	) {
		return null;
	}
	return {
		id,
		branch,
		commitSha,
		source,
		...(sourcePath === null ? {} : { sourcePath }),
		sourceRef,
		activeGenerationId,
		health: normalizeHealth(value.health),
		repairAvailability: normalizeRepairAvailability(value.repairAvailability),
		installedAt,
		updatedAt,
		documentCount,
		chunkCount,
		classCount,
		sizeBytes
	};
}

function normalizeSettings(value: unknown): GodotDocumentationSettings {
	if (!isRecord(value) || value.schemaVersion !== 2 || !isRecord(value.documents)) {
		return structuredClone(EMPTY_SETTINGS);
	}
	const documents: Record<string, GodotDocumentationRecord> = {};
	for (const candidate of Object.values(value.documents)) {
		const document: GodotDocumentationRecord | null = normalizeDocument(candidate);
		if (document !== null && !(document.id in documents)) {
			documents[document.id] = document;
		}
	}
	return {
		schemaVersion: 2,
		enabled: value.enabled === true && Object.keys(documents).length > 0,
		documents
	};
}

export async function initializeGodotDocumentationStore(force: boolean = false): Promise<void> {
	if (initialized && !force) {
		return;
	}
	let raw: unknown = null;
	let replaceInvalid: boolean = false;
	try {
		raw = JSON.parse(await readFile(getGodotDocumentationConfigPath(), "utf8")) as unknown;
		replaceInvalid = !isRecord(raw) || raw.schemaVersion !== 2;
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			replaceInvalid = true;
		}
	}
	const normalized: GodotDocumentationSettings = normalizeSettings(raw);
	if (!replaceInvalid && JSON.stringify(normalized) !== JSON.stringify(raw)) {
		replaceInvalid = true;
	}
	snapshot = normalized;
	initialized = true;
	writeQueue = Promise.resolve();
	if (replaceInvalid) {
		await writeJsonFileAtomic(getGodotDocumentationConfigPath(), snapshot);
	}
}

export function getGodotDocumentationSnapshot(): GodotDocumentationSettings {
	return structuredClone(snapshot);
}

export function isGodotDocumentationEnabled(): boolean {
	return snapshot.enabled && Object.values(snapshot.documents).some((record): boolean => {
		return record.health.status === "ready" && record.activeGenerationId !== null;
	});
}

export function createGodotDocumentationId(branch: string): string {
	return `godot-docs-${createHash("sha256").update(branch).digest("hex").slice(0, 16)}`;
}

export function getGodotDocumentationGenerationDir(
	record: Pick<GodotDocumentationRecord, "id"> & Partial<Pick<GodotDocumentationRecord, "activeGenerationId" | "commitSha">>
): string {
	const generationId: string | null | undefined = record.activeGenerationId ?? record.commitSha;
	if (generationId === null || generationId === undefined || generationId.trim().length === 0) {
		throw new Error(`Documentation ${record.id} has no active generation.`);
	}
	return join(getGodotDocumentationRoot(), "packages", record.id, generationId);
}

export function getGodotDocumentationIndexPath(
	record: Pick<GodotDocumentationRecord, "id"> & Partial<Pick<GodotDocumentationRecord, "activeGenerationId" | "commitSha">>
): string {
	return join(getGodotDocumentationGenerationDir(record), "index.sqlite");
}

export function getGodotDocumentationManifestPath(
	record: Pick<GodotDocumentationRecord, "id"> & Partial<Pick<GodotDocumentationRecord, "activeGenerationId" | "commitSha">>
): string {
	return join(getGodotDocumentationGenerationDir(record), "manifest.json");
}

export function getGodotDocumentationPackageDir(documentId: string): string {
	return join(getGodotDocumentationRoot(), "packages", documentId);
}

export function getGodotDocumentationStagingRoot(): string {
	return join(getGodotDocumentationRoot(), ".staging");
}

export function getGodotDocumentationTrashRoot(): string {
	return join(getGodotDocumentationRoot(), ".trash");
}

export function getGodotDocumentationSourcesRoot(): string {
	return join(getGodotDocumentationRoot(), "sources");
}

export function getGodotDocumentationSourceDir(sha256: string): string {
	return join(getGodotDocumentationSourcesRoot(), sha256);
}

export function getGodotDocumentationBranchCachePath(): string {
	return join(getGodotDocumentationRoot(), "branches-cache.json");
}

export async function updateGodotDocumentationSettings(
	mutate: (draft: GodotDocumentationSettings) => void
): Promise<GodotDocumentationSettings> {
	await initializeGodotDocumentationStore();
	const operation: Promise<void> = writeQueue.then(async (): Promise<void> => {
		const draft: GodotDocumentationSettings = structuredClone(snapshot);
		mutate(draft);
		if (Object.keys(draft.documents).length === 0) {
			draft.enabled = false;
		}
		await writeJsonFileAtomic(getGodotDocumentationConfigPath(), draft);
		snapshot = draft;
	});
	writeQueue = operation.catch((): void => undefined);
	await operation;
	return structuredClone(snapshot);
}

export function createGodotDocumentationState(activeJob: GodotDocumentationState["activeJob"]): GodotDocumentationState {
	const documents: GodotDocumentationRecord[] = Object.values(snapshot.documents)
		.sort((left: GodotDocumentationRecord, right: GodotDocumentationRecord): number => {
			return compareDocumentationBranches(right.branch, left.branch);
		});
	return {
		schemaVersion: 2,
		enabled: snapshot.enabled,
		documents,
		activeJob
	};
}

export function parseStableDocumentationBranch(branch: string): { major: number; minor: number } | null {
	const match: RegExpMatchArray | null = branch.match(/^(\d+)\.(\d+)$/u);
	if (match === null) {
		return null;
	}
	return {
		major: Number.parseInt(match[1]!, 10),
		minor: Number.parseInt(match[2]!, 10)
	};
}

export function compareDocumentationBranches(left: string, right: string): number {
	const leftVersion = parseStableDocumentationBranch(left);
	const rightVersion = parseStableDocumentationBranch(right);
	if (leftVersion !== null && rightVersion !== null) {
		return leftVersion.major - rightVersion.major || leftVersion.minor - rightVersion.minor;
	}
	if (leftVersion !== null) {
		return 1;
	}
	if (rightVersion !== null) {
		return -1;
	}
	if (left === "master") {
		return 1;
	}
	if (right === "master") {
		return -1;
	}
	return left.localeCompare(right);
}
