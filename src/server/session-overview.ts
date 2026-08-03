import { readFile } from "node:fs/promises";
import path from "node:path";
import { getSessionDir, openSession, type SessionMetadata } from "../session/session-store.js";
import type { GeneratedImageArtifactMetadata, ImageAttachmentMetadata, TextAttachmentMetadata } from "../session/session-attachments.js";
import { getSessionDatabase, parseSqlJson } from "../session/session-database.js";
import { isInsideGitWorkTree, readGitBranch, runGit } from "./git-utils.js";
import { findWorkspace } from "../workspace/registry.js";
import type { WorkspaceSourceFolder } from "../workspace/types.js";

const DEFAULT_OVERVIEW_LIMIT: number = 3;
const MAX_OVERVIEW_LIMIT: number = 100;

export type SessionOverviewGitInfo = {
	sourceFolderId: string;
	sourceFolderPath: string;
	title: string;
	hasGitRepository: boolean;
	branch: string | null;
	additions: number;
	deletions: number;
	changedFiles: number;
};

export type SessionOverviewPlanItem = {
	planId: string;
	title: string;
	status: string;
	updatedAt: string;
	planPath: string;
	previewMarkdown: string;
};

export type SessionOverviewSourceItem = {
	id: string;
	kind: "image_attachment" | "generated_image" | "text_attachment";
	title: string;
	mimeType: string;
	createdAt: string;
	width?: number | undefined;
	height?: number | undefined;
	byteSize: number;
	thumbnailDataUrl?: string | undefined;
	textPreview?: string | undefined;
};

export type SessionOverviewResult = {
	sessionId: string;
	envInfo: SessionOverviewGitInfo | null;
	envInfos: SessionOverviewGitInfo[];
	plans: {
		total: number;
		items: SessionOverviewPlanItem[];
	};
	sources: {
		total: number;
		items: SessionOverviewSourceItem[];
	};
};

function clampLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) {
		return DEFAULT_OVERVIEW_LIMIT;
	}
	return Math.max(0, Math.min(MAX_OVERVIEW_LIMIT, Math.trunc(limit)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: Record<string, unknown>, key: string): string {
	const raw: unknown = value[key];
	return typeof raw === "string" ? raw : "";
}

function getOptionalNumber(value: Record<string, unknown>, key: string): number | undefined {
	const raw: unknown = value[key];
	return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

async function loadGitInfo(sourceFolder: Pick<WorkspaceSourceFolder, "id" | "path">): Promise<SessionOverviewGitInfo | null> {
	const workspaceRoot: string = sourceFolder.path;
	if (workspaceRoot.trim().length === 0) {
		return null;
	}

	if (!await isInsideGitWorkTree(workspaceRoot)) {
		return null;
	}

	const branch: string | null = await readGitBranch(workspaceRoot);

	let additions: number = 0;
	let deletions: number = 0;
	try {
		const diffOutput: string = (await runGit(workspaceRoot, ["diff", "--numstat", "HEAD", "--"])).stdout;
		for (const line of diffOutput.split(/\r?\n/)) {
			const [addedText, deletedText] = line.split(/\s+/, 2);
			const added: number = Number.parseInt(addedText ?? "", 10);
			const deleted: number = Number.parseInt(deletedText ?? "", 10);
			if (Number.isFinite(added)) {
				additions += added;
			}
			if (Number.isFinite(deleted)) {
				deletions += deleted;
			}
		}
	} catch {
		// 空仓库没有 HEAD 时 diff 可能失败；仍然显示分支和 changed file count。
	}

	let changedFiles: number = 0;
	try {
		const statusOutput: string = (await runGit(workspaceRoot, ["status", "--porcelain=v1"])).stdout;
		changedFiles = statusOutput.split(/\r?\n/).filter((line: string): boolean => line.trim().length > 0).length;
	} catch {
		changedFiles = 0;
	}

	return {
		sourceFolderId: sourceFolder.id,
		sourceFolderPath: workspaceRoot,
		title: path.basename(workspaceRoot) || workspaceRoot,
		hasGitRepository: true,
		branch,
		additions,
		deletions,
		changedFiles
	};
}

async function listPlanItems(
	sessionId: string,
	limit: number,
	includePreviews: boolean
): Promise<{ total: number; items: SessionOverviewPlanItem[] }> {
	const db = await getSessionDatabase();
	const countRow = db.prepare("SELECT COUNT(*) AS total FROM plans WHERE session_id = ?").get(sessionId) as Record<string, unknown>;
	const rows = db.prepare(`
		SELECT metadata_json${includePreviews ? ", markdown" : ""}
		FROM plans WHERE session_id = ? ORDER BY updated_at DESC LIMIT ?
	`).all(sessionId, limit) as Record<string, unknown>[];
	const items: SessionOverviewPlanItem[] = rows.map((row: Record<string, unknown>): SessionOverviewPlanItem => {
		const metadata: Record<string, unknown> = parseSqlJson<Record<string, unknown>>(row.metadata_json);
		const planId: string = getString(metadata, "planId");
		return {
			planId,
			title: getString(metadata, "title") || "Untitled plan",
			status: getString(metadata, "status") || "unknown",
			updatedAt: getString(metadata, "updatedAt") || getString(metadata, "createdAt"),
			planPath: getString(metadata, "planPath") || `plans/${planId}/PLAN.md`,
			previewMarkdown: includePreviews
				? getString(metadata, "previewMarkdown") || String(row.markdown).slice(0, 4000)
				: ""
		};
	});
	return {
		total: Number(countRow.total),
		items
	};
}

async function loadGitInfos(metadata: SessionMetadata): Promise<SessionOverviewGitInfo[]> {
	const workspace = metadata.workspaceId === undefined ? undefined : findWorkspace(metadata.workspaceId);
	const sourceFolders: Array<Pick<WorkspaceSourceFolder, "id" | "path">> = workspace?.sourceFolders
		?? (metadata.workspaceRoot?.trim()
			? [{ id: "primary", path: metadata.workspaceRoot }]
			: []);
	const infos: Array<SessionOverviewGitInfo | null> = await Promise.all(
		sourceFolders.map((sourceFolder): Promise<SessionOverviewGitInfo | null> => loadGitInfo(sourceFolder))
	);
	return infos.filter((info): info is SessionOverviewGitInfo => info !== null);
}

function createDataUrl(mimeType: string, bytes: Buffer): string {
	return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

async function readAttachmentSource(
	sessionId: string,
	metadataRaw: Record<string, unknown>,
	includeImageData: boolean
): Promise<SessionOverviewSourceItem | null> {
	const metadata: ImageAttachmentMetadata = metadataRaw as ImageAttachmentMetadata;
	if (!metadata.id?.startsWith("image-") || typeof metadata.mimeType !== "string") {
		return null;
	}

	const source: SessionOverviewSourceItem = {
		id: metadata.id,
		kind: "image_attachment",
		title: metadata.title || metadata.fileName || metadata.id,
		mimeType: metadata.mimeType,
		createdAt: metadata.createdAt || "",
		width: getOptionalNumber(metadataRaw, "width"),
		height: getOptionalNumber(metadataRaw, "height"),
		byteSize: metadata.byteSize
	};
	if (!includeImageData) {
		return source;
	}

	try {
		const imagePath: string = path.join(getSessionDir(sessionId), "attachments", metadata.fileName || `${metadata.id}.png`);
		const bytes: Buffer = await readFile(imagePath);
		return {
			...source,
			thumbnailDataUrl: createDataUrl(metadata.mimeType, bytes)
		};
	} catch {
		return null;
	}
}

async function readGeneratedImageSource(
	sessionId: string,
	metadataRaw: Record<string, unknown>,
	includeImageData: boolean
): Promise<SessionOverviewSourceItem | null> {
	const metadata: GeneratedImageArtifactMetadata = metadataRaw as GeneratedImageArtifactMetadata;
	if (!metadata.imageId?.startsWith("generated-image-") || metadata.sessionId !== sessionId || typeof metadata.mimeType !== "string") {
		return null;
	}

	const source: SessionOverviewSourceItem = {
		id: metadata.imageId,
		kind: "generated_image",
		title: metadata.prompt || metadata.fileName || metadata.imageId,
		mimeType: metadata.mimeType,
		createdAt: metadata.createdAt || "",
		width: getOptionalNumber(metadataRaw, "width"),
		height: getOptionalNumber(metadataRaw, "height"),
		byteSize: metadata.byteSize
	};
	if (!includeImageData) {
		return source;
	}

	try {
		const imagePath: string = path.join(getSessionDir(sessionId), "attachments", "images", metadata.fileName);
		const bytes: Buffer = await readFile(imagePath);
		return {
			...source,
			thumbnailDataUrl: createDataUrl(metadata.mimeType, bytes)
		};
	} catch {
		return null;
	}
}

async function readTextAttachmentSource(sessionId: string, metadataRaw: Record<string, unknown>): Promise<SessionOverviewSourceItem | null> {
	const metadata: TextAttachmentMetadata = metadataRaw as TextAttachmentMetadata;
	if (!metadata.id?.startsWith("text-") || metadata.mimeType !== "text/plain") {
		return null;
	}

	try {
		const textPath: string = path.join(getSessionDir(sessionId), "attachments", "text", metadata.fileName);
		const content: string = await readFile(textPath, "utf8");
		return {
			id: metadata.id,
			kind: "text_attachment",
			title: metadata.title || metadata.fileName || metadata.id,
			mimeType: metadata.mimeType,
			createdAt: metadata.createdAt || "",
			byteSize: metadata.byteSize,
			textPreview: content.slice(0, 12_000)
		};
	} catch {
		return null;
	}
}

async function listSourceItems(
	sessionId: string,
	limit: number,
	includeImageData: boolean
): Promise<{ total: number; items: SessionOverviewSourceItem[] }> {
	const db = await getSessionDatabase();
	const countRow = db.prepare("SELECT COUNT(*) AS total FROM attachments WHERE session_id = ?").get(sessionId) as Record<string, unknown>;
	const rows = db.prepare(`
		SELECT kind, metadata_json FROM attachments WHERE session_id = ? ORDER BY created_at DESC LIMIT ?
	`).all(sessionId, limit) as Record<string, unknown>[];
	const items: SessionOverviewSourceItem[] = [];
	for (const row of rows) {
		const metadata: Record<string, unknown> = parseSqlJson<Record<string, unknown>>(row.metadata_json);
		const item: SessionOverviewSourceItem | null = row.kind === "generated_image"
			? await readGeneratedImageSource(sessionId, metadata, includeImageData)
			: row.kind === "text"
				? await readTextAttachmentSource(sessionId, metadata)
				: await readAttachmentSource(sessionId, metadata, includeImageData);
		if (item !== null) {
			items.push(item);
		}
	}

	return {
		total: Number(countRow.total),
		items
	};
}

export async function createSessionOverview(params: {
	sessionId: string;
	planLimit?: number | undefined;
	sourceLimit?: number | undefined;
	includePlanPreviews?: boolean | undefined;
	includeSourceImages?: boolean | undefined;
}): Promise<SessionOverviewResult> {
	const session = await openSession(params.sessionId);
	const metadata: SessionMetadata = session.metadata;
	const [envInfos, plans, sources] = await Promise.all([
		loadGitInfos(metadata),
		listPlanItems(params.sessionId, clampLimit(params.planLimit), params.includePlanPreviews !== false),
		listSourceItems(params.sessionId, clampLimit(params.sourceLimit), params.includeSourceImages !== false)
	]);

	return {
		sessionId: params.sessionId,
		envInfo: envInfos[0] ?? null,
		envInfos,
		plans,
		sources
	};
}
