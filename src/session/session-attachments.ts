import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AdditionalContextItem, AiChatParams } from "../protocol/types.js";
import {
	MAX_IMAGE_BYTES,
	MAX_IMAGE_THUMBNAIL_DATA_URL_CHARS,
	SUPPORTED_IMAGE_MIME_TYPES
} from "../protocol/image-attachments.js";
import { assertSupportedImageSignature } from "../protocol/image-file-signature.js";
import { getSessionDir, openSession } from "./session-store.js";
import { getSessionDatabase, parseSqlJson, sqlJson } from "./session-database.js";

const ATTACHMENT_ID_PATTERN: RegExp = /^image-[a-zA-Z0-9_-]+$/;
const GENERATED_IMAGE_ID_PATTERN: RegExp = /^generated-image-[a-zA-Z0-9_-]+$/;
const TEXT_ATTACHMENT_ID_PATTERN: RegExp = /^text-[a-zA-Z0-9_-]+$/;
const MAX_TEXT_ATTACHMENT_BYTES: number = 1_000_000;

export type SaveImageAttachmentInput = {
	sessionId: string;
	mimeType: string;
	dataUrl: string;
	byteSize: number;
	width?: number | undefined;
	height?: number | undefined;
	title?: string | undefined;
	sourcePath?: string | undefined;
	source?: "editor" | "manual" | undefined;
	summary?: string | undefined;
};

export type ImageAttachmentMetadata = {
	id: string;
	mimeType: string;
	byteSize: number;
	width?: number | undefined;
	height?: number | undefined;
	title: string;
	sourcePath?: string | undefined;
	source: "editor" | "manual";
	summary: string;
	createdAt: string;
	fileName: string;
};

export type GeneratedImageArtifactMetadata = {
	imageId: string;
	sessionId: string;
	mimeType: string;
	width?: number | undefined;
	height?: number | undefined;
	byteSize: number;
	provider: string;
	model: string;
	prompt: string;
	revisedPrompt?: string | undefined;
	createdAt: string;
	fileName: string;
	storagePath: string;
};

export type SaveTextAttachmentInput = {
	sessionId: string;
	content: string;
	title?: string | undefined;
};

export type TextAttachmentMetadata = {
	id: string;
	mimeType: "text/plain";
	byteSize: number;
	title: string;
	source: "manual";
	summary: string;
	createdAt: string;
	fileName: string;
	storagePath: string;
};

export type SaveGeneratedImageArtifactInput = {
	sessionId: string;
	bytes: Buffer;
	mimeType: string;
	width?: number | undefined;
	height?: number | undefined;
	provider: string;
	model: string;
	prompt: string;
	revisedPrompt?: string | undefined;
};

function getAttachmentsDir(sessionId: string): string {
	return join(getSessionDir(sessionId), "attachments");
}

function getGeneratedImagesDir(sessionId: string): string {
	return join(getAttachmentsDir(sessionId), "images");
}

function getTextAttachmentsDir(sessionId: string): string {
	return join(getAttachmentsDir(sessionId), "text");
}

function assertSafeAttachmentId(attachmentId: string): string {
	if (!ATTACHMENT_ID_PATTERN.test(attachmentId)) {
		throw new Error(`Invalid image attachment id: ${attachmentId}`);
	}
	return attachmentId;
}

function attachmentImagePath(sessionId: string, attachmentId: string): string {
	return join(getAttachmentsDir(sessionId), `${assertSafeAttachmentId(attachmentId)}.png`);
}

function assertSafeGeneratedImageId(imageId: string): string {
	if (!GENERATED_IMAGE_ID_PATTERN.test(imageId)) {
		throw new Error(`Invalid generated image id: ${imageId}`);
	}
	return imageId;
}

function assertSafeTextAttachmentId(attachmentId: string): string {
	if (!TEXT_ATTACHMENT_ID_PATTERN.test(attachmentId)) {
		throw new Error(`Invalid text attachment id: ${attachmentId}`);
	}
	return attachmentId;
}

function getImageExtension(mimeType: string): string {
	if (mimeType === "image/jpeg") {
		return "jpg";
	}
	if (mimeType === "image/webp") {
		return "webp";
	}
	return "png";
}

function generatedImagePath(sessionId: string, imageId: string, mimeType: string): string {
	return join(getGeneratedImagesDir(sessionId), `${assertSafeGeneratedImageId(imageId)}.${getImageExtension(mimeType)}`);
}

function generatedImageStoragePath(fileName: string): string {
	return `attachments/images/${fileName}`;
}

function textAttachmentPath(sessionId: string, attachmentId: string): string {
	return join(getTextAttachmentsDir(sessionId), `${assertSafeTextAttachmentId(attachmentId)}.txt`);
}

function textAttachmentStoragePath(fileName: string): string {
	return `attachments/text/${fileName}`;
}

function collectPersistedAttachmentIds(value: unknown, ids: Set<string>): void {
	if (Array.isArray(value)) {
		for (const item of value) {
			collectPersistedAttachmentIds(item, ids);
		}
		return;
	}
	if (typeof value !== "object" || value === null) {
		return;
	}
	const record: Record<string, unknown> = value as Record<string, unknown>;
	const kind: unknown = record.kind;
	const data: unknown = record.data;
	if ((kind === "image" || kind === "text_attachment") && typeof data === "object" && data !== null) {
		const attachmentId: unknown = (data as Record<string, unknown>).attachmentId;
		if (typeof attachmentId === "string") {
			ids.add(attachmentId);
		}
	}
	for (const child of Object.values(record)) {
		collectPersistedAttachmentIds(child, ids);
	}
}

export async function listMessageAttachmentIds(sessionId: string): Promise<Set<string>> {
	const ids: Set<string> = new Set();
	const rows = (await getSessionDatabase()).prepare(`
		SELECT payload_json FROM messages WHERE session_id = ?
	`).all(sessionId) as Record<string, unknown>[];
	for (const row of rows) {
		try {
			collectPersistedAttachmentIds(parseSqlJson<unknown>(row.payload_json), ids);
		} catch {
			// Ignore damaged legacy message payloads while preserving valid sources.
		}
	}
	return ids;
}

/**
 * Composer-only attachments are intentionally short-lived. Only snapshots that
 * were persisted with a message or queued event survive a backend restart.
 */
export async function cleanupUnsentSessionAttachments(): Promise<number> {
	const db = await getSessionDatabase();
	const referencedIdsBySession: Map<string, Set<string>> = new Map();
	const addReferences = (sessionId: string, json: unknown): void => {
		let parsed: unknown;
		try {
			parsed = parseSqlJson<unknown>(json);
		} catch {
			return;
		}
		const ids: Set<string> = referencedIdsBySession.get(sessionId) ?? new Set<string>();
		collectPersistedAttachmentIds(parsed, ids);
		referencedIdsBySession.set(sessionId, ids);
	};
	for (const row of db.prepare("SELECT session_id, payload_json FROM messages").all() as Record<string, unknown>[]) {
		addReferences(String(row.session_id), row.payload_json);
	}
	for (const row of db.prepare("SELECT session_id, data_json FROM session_events").all() as Record<string, unknown>[]) {
		addReferences(String(row.session_id), row.data_json);
	}

	const rows = db.prepare(`
		SELECT attachment_id, session_id, kind FROM attachments
		WHERE kind IN ('image', 'text')
	`).all() as Record<string, unknown>[];
	let removed: number = 0;
	for (const row of rows) {
		const attachmentId: string = String(row.attachment_id);
		const sessionId: string = String(row.session_id);
		const kind: string = String(row.kind);
		if (referencedIdsBySession.get(sessionId)?.has(attachmentId) === true) {
			continue;
		}
		const filePath: string = kind === "image"
			? attachmentImagePath(sessionId, attachmentId)
			: textAttachmentPath(sessionId, attachmentId);
		await rm(filePath, { force: true }).catch((): void => {});
		db.prepare("DELETE FROM attachments WHERE attachment_id = ? AND session_id = ?").run(attachmentId, sessionId);
		removed += 1;
	}
	return removed;
}

function parseImageDataUrl(mimeType: string, dataUrl: string): Buffer {
	const prefix: string = `data:${mimeType};base64,`;
	if (!dataUrl.startsWith(prefix)) {
		throw new Error("Image dataUrl must match mimeType.");
	}

	const base64Text: string = dataUrl.slice(prefix.length);
	if (base64Text.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64Text)) {
		throw new Error("Image dataUrl must contain valid base64 data.");
	}

	return Buffer.from(base64Text, "base64");
}

function formatByteSize(byteSize: number): string {
	if (byteSize >= 1024 * 1024) {
		return `${(byteSize / 1024 / 1024).toFixed(1)} MiB`;
	}
	if (byteSize >= 1024) {
		return `${Math.round(byteSize / 1024)} KiB`;
	}
	return `${byteSize} B`;
}

function createImageAttachmentContext(metadata: ImageAttachmentMetadata, thumbnailDataUrl?: string | undefined): AdditionalContextItem {
	const dimensionText: string = metadata.width !== undefined && metadata.height !== undefined
		? `${metadata.width}x${metadata.height}`
		: "未知尺寸";
	const data: Record<string, unknown> = {
		mimeType: metadata.mimeType,
		attachmentId: metadata.id,
		byteSize: metadata.byteSize
	};
	if (metadata.width !== undefined) {
		data.width = metadata.width;
	}
	if (metadata.height !== undefined) {
		data.height = metadata.height;
	}
	if (metadata.sourcePath !== undefined && metadata.sourcePath.trim().length > 0) {
		data.sourcePath = metadata.sourcePath;
	}
	if (thumbnailDataUrl !== undefined) {
		data.thumbnailDataUrl = thumbnailDataUrl;
	}

	return {
		id: metadata.id,
		kind: "image",
		title: metadata.title,
		subtitle: `${metadata.mimeType} · ${formatByteSize(metadata.byteSize)} · ${dimensionText}`,
		pinned: false,
		source: metadata.source,
		summary: metadata.summary,
		data
	};
}

function createTextAttachmentContext(metadata: TextAttachmentMetadata): AdditionalContextItem {
	return {
		id: metadata.id,
		kind: "text_attachment",
		title: metadata.title,
		subtitle: `text/plain · ${formatByteSize(metadata.byteSize)}`,
		pinned: false,
		source: "manual",
		summary: metadata.summary,
		data: {
			attachmentId: metadata.id,
			mimeType: metadata.mimeType,
			byteSize: metadata.byteSize,
			fileName: metadata.fileName
		}
	};
}

async function writeAttachmentMetadata(
	sessionId: string,
	attachmentId: string,
	kind: "image" | "generated_image" | "text",
	metadata: ImageAttachmentMetadata | GeneratedImageArtifactMetadata | TextAttachmentMetadata,
	storagePath: string
): Promise<void> {
	(await getSessionDatabase()).prepare(`
		INSERT INTO attachments(attachment_id, session_id, kind, metadata_json, storage_path, created_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(attachment_id) DO UPDATE SET
			metadata_json = excluded.metadata_json,
			storage_path = excluded.storage_path
	`).run(attachmentId, sessionId, kind, sqlJson(metadata), storagePath, metadata.createdAt);
}

async function readAttachmentMetadata<T>(sessionId: string, attachmentId: string, kind: string): Promise<T> {
	const row = (await getSessionDatabase()).prepare(`
		SELECT metadata_json FROM attachments
		WHERE session_id = ? AND attachment_id = ? AND kind = ?
	`).get(sessionId, attachmentId, kind) as Record<string, unknown> | undefined;
	if (row === undefined) {
		throw new Error(`Attachment not found: ${attachmentId}`);
	}
	return parseSqlJson<T>(row.metadata_json);
}

export async function saveImageAttachment(input: SaveImageAttachmentInput): Promise<AdditionalContextItem> {
	await openSession(input.sessionId);
	if (!SUPPORTED_IMAGE_MIME_TYPES.includes(input.mimeType)) {
		throw new Error("Unsupported image mimeType.");
	}
	if (input.byteSize <= 0 || input.byteSize > MAX_IMAGE_BYTES) {
		throw new Error(`Image is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MiB.`);
	}

	const bytes: Buffer = parseImageDataUrl(input.mimeType, input.dataUrl);
	if (bytes.byteLength !== input.byteSize) {
		throw new Error("Image byteSize does not match decoded data.");
	}

	const attachmentId: string = `image-${randomUUID()}`;
	const createdAt: string = new Date().toISOString();
	const metadata: ImageAttachmentMetadata = {
		id: attachmentId,
		mimeType: input.mimeType,
		byteSize: input.byteSize,
		title: input.title?.trim() || `Clipboard image ${createdAt.replace("T", " ").slice(0, 19)}`,
		sourcePath: input.sourcePath?.trim() || undefined,
		source: input.source ?? "manual",
		summary: input.summary?.trim() || "用户为本轮消息附加了一张剪贴板图片；图片内容保存在当前会话附件中。",
		createdAt,
		fileName: `${attachmentId}.png`
	};
	if (input.width !== undefined) {
		metadata.width = input.width;
	}
	if (input.height !== undefined) {
		metadata.height = input.height;
	}

	await mkdir(getAttachmentsDir(input.sessionId), { recursive: true });
	await writeFile(attachmentImagePath(input.sessionId, attachmentId), bytes);
	try {
		await writeAttachmentMetadata(input.sessionId, attachmentId, "image", metadata, `attachments/${metadata.fileName}`);
	} catch (error: unknown) {
		await rm(attachmentImagePath(input.sessionId, attachmentId), { force: true });
		throw error;
	}
	const thumbnailDataUrl: string | undefined = input.dataUrl.length <= MAX_IMAGE_THUMBNAIL_DATA_URL_CHARS
		? input.dataUrl
		: undefined;
	return createImageAttachmentContext(metadata, thumbnailDataUrl);
}

export async function readImageAttachmentDataUrl(sessionId: string, attachmentId: string): Promise<string> {
	const { metadata, bytes } = await readImageAttachmentArtifact(sessionId, attachmentId);
	return `data:${metadata.mimeType};base64,${bytes.toString("base64")}`;
}

export async function readImageAttachmentArtifact(
	sessionId: string,
	attachmentId: string
): Promise<{ metadata: ImageAttachmentMetadata; bytes: Buffer }> {
	await openSession(sessionId);
	const safeAttachmentId: string = assertSafeAttachmentId(attachmentId);
	const metadata: ImageAttachmentMetadata = await readAttachmentMetadata<ImageAttachmentMetadata>(
		sessionId,
		safeAttachmentId,
		"image"
	);
	if (metadata.id !== safeAttachmentId) {
		throw new Error("Image attachment metadata does not match request.");
	}
	const bytes: Buffer = await readFile(attachmentImagePath(sessionId, safeAttachmentId));
	if (bytes.byteLength !== metadata.byteSize) {
		throw new Error("Image attachment bytes do not match metadata.");
	}
	return { metadata, bytes };
}

export async function saveTextAttachment(input: SaveTextAttachmentInput): Promise<AdditionalContextItem> {
	await openSession(input.sessionId);
	const bytes: Buffer = Buffer.from(input.content, "utf8");
	if (bytes.byteLength === 0 || bytes.byteLength > MAX_TEXT_ATTACHMENT_BYTES) {
		throw new Error("Text attachment must be between 1 byte and 1 MiB.");
	}

	const attachmentId: string = `text-${randomUUID()}`;
	const createdAt: string = new Date().toISOString();
	const fileName: string = `${attachmentId}.txt`;
	const metadata: TextAttachmentMetadata = {
		id: attachmentId,
		mimeType: "text/plain",
		byteSize: bytes.byteLength,
		title: input.title?.trim() || `Pasted text ${createdAt.replace("T", " ").slice(0, 19)}.txt`,
		source: "manual",
		summary: "Pasted text saved as a session attachment for this turn.",
		createdAt,
		fileName,
		storagePath: textAttachmentStoragePath(fileName)
	};

	await mkdir(getTextAttachmentsDir(input.sessionId), { recursive: true });
	await writeFile(textAttachmentPath(input.sessionId, attachmentId), bytes);
	try {
		await writeAttachmentMetadata(input.sessionId, attachmentId, "text", metadata, metadata.storagePath);
	} catch (error: unknown) {
		await rm(textAttachmentPath(input.sessionId, attachmentId), { force: true });
		throw error;
	}
	return createTextAttachmentContext(metadata);
}

export async function readTextAttachmentContent(sessionId: string, attachmentId: string): Promise<{ metadata: TextAttachmentMetadata; content: string }> {
	await openSession(sessionId);
	const safeAttachmentId: string = assertSafeTextAttachmentId(attachmentId);
	const metadata: TextAttachmentMetadata = await readAttachmentMetadata<TextAttachmentMetadata>(sessionId, safeAttachmentId, "text");
	const bytes: Buffer = await readFile(textAttachmentPath(sessionId, safeAttachmentId));
	if (bytes.byteLength !== metadata.byteSize) {
		throw new Error("Text attachment bytes do not match metadata.");
	}
	return { metadata, content: bytes.toString("utf8") };
}

export async function saveGeneratedImageArtifact(input: SaveGeneratedImageArtifactInput): Promise<GeneratedImageArtifactMetadata> {
	await openSession(input.sessionId);
	if (!SUPPORTED_IMAGE_MIME_TYPES.includes(input.mimeType)) {
		throw new Error("Unsupported generated image mimeType.");
	}
	if (input.bytes.byteLength <= 0) {
		throw new Error("Generated image is empty.");
	}

	// 兼容接口可能声明 PNG 却返回 JPEG；以文件签名为准，避免污染工作区资源。
	const mimeType = assertSupportedImageSignature(input.bytes);
	const imageId: string = `generated-image-${randomUUID()}`;
	const createdAt: string = new Date().toISOString();
	const fileName: string = `${imageId}.${getImageExtension(mimeType)}`;
	const metadata: GeneratedImageArtifactMetadata = {
		imageId,
		sessionId: input.sessionId,
		mimeType,
		byteSize: input.bytes.byteLength,
		provider: input.provider,
		model: input.model,
		prompt: input.prompt,
		createdAt,
		fileName,
		storagePath: generatedImageStoragePath(fileName)
	};
	if (input.width !== undefined) {
		metadata.width = input.width;
	}
	if (input.height !== undefined) {
		metadata.height = input.height;
	}
	if (input.revisedPrompt !== undefined && input.revisedPrompt.trim().length > 0) {
		metadata.revisedPrompt = input.revisedPrompt.trim();
	}

	await mkdir(getGeneratedImagesDir(input.sessionId), { recursive: true });
	await writeFile(generatedImagePath(input.sessionId, imageId, mimeType), input.bytes);
	try {
		await writeAttachmentMetadata(input.sessionId, imageId, "generated_image", metadata, metadata.storagePath);
	} catch (error: unknown) {
		await rm(generatedImagePath(input.sessionId, imageId, mimeType), { force: true });
		throw error;
	}
	return metadata;
}

export function getGeneratedImageArtifactLocalPath(metadata: GeneratedImageArtifactMetadata): string {
	return generatedImagePath(metadata.sessionId, metadata.imageId, metadata.mimeType);
}

export async function readGeneratedImageDataUrl(sessionId: string, imageId: string): Promise<{ imageId: string; mimeType: string; dataUrl: string; metadata: GeneratedImageArtifactMetadata }> {
	await openSession(sessionId);
	const metadata: GeneratedImageArtifactMetadata = await readAttachmentMetadata<GeneratedImageArtifactMetadata>(
		sessionId,
		assertSafeGeneratedImageId(imageId),
		"generated_image"
	);
	if (metadata.sessionId !== sessionId || metadata.imageId !== imageId) {
		throw new Error("Generated image metadata does not match request.");
	}
	const bytes: Buffer = await readFile(generatedImagePath(sessionId, imageId, metadata.mimeType));
	return {
		imageId,
		mimeType: metadata.mimeType,
		dataUrl: `data:${metadata.mimeType};base64,${bytes.toString("base64")}`,
		metadata
	};
}

export async function readGeneratedImageArtifact(
	sessionId: string,
	imageId: string
): Promise<{ metadata: GeneratedImageArtifactMetadata; bytes: Buffer }> {
	await openSession(sessionId);
	const metadata: GeneratedImageArtifactMetadata = await readAttachmentMetadata<GeneratedImageArtifactMetadata>(
		sessionId,
		assertSafeGeneratedImageId(imageId),
		"generated_image"
	);
	if (metadata.sessionId !== sessionId || metadata.imageId !== imageId) {
		throw new Error("Generated image metadata does not match request.");
	}
	const bytes: Buffer = await readFile(generatedImagePath(sessionId, imageId, metadata.mimeType));
	if (bytes.byteLength !== metadata.byteSize) {
		throw new Error("Generated image bytes do not match metadata.");
	}
	return { metadata, bytes };
}

export async function deleteGeneratedImageArtifact(metadata: GeneratedImageArtifactMetadata): Promise<void> {
	await rm(generatedImagePath(metadata.sessionId, metadata.imageId, metadata.mimeType), { force: true });
	(await getSessionDatabase()).prepare(`
		DELETE FROM attachments WHERE session_id = ? AND attachment_id = ? AND kind = 'generated_image'
	`).run(metadata.sessionId, metadata.imageId);
}

export async function hydrateAttachmentContexts(sessionId: string | undefined, params: AiChatParams): Promise<AiChatParams> {
	if (sessionId === undefined || params.additionalContext === undefined) {
		return params;
	}

	let changed: boolean = false;
	const additionalContext: AdditionalContextItem[] = [];
	for (const item of params.additionalContext) {
		if (typeof item.data !== "object" || item.data === null || Array.isArray(item.data)) {
			additionalContext.push(item);
			continue;
		}

		const data: Record<string, unknown> = item.data as Record<string, unknown>;
		if (item.kind === "image" && typeof data.dataUrl === "string" && data.dataUrl.length > 0) {
			additionalContext.push(item);
			continue;
		}
		if (item.kind === "text_attachment" && typeof data.content === "string") {
			additionalContext.push(item);
			continue;
		}
		if ((item.kind !== "image" && item.kind !== "text_attachment") || typeof data.attachmentId !== "string" || data.attachmentId.length === 0) {
			additionalContext.push(item);
			continue;
		}

		const hydratedData: Record<string, unknown> = item.kind === "image"
			? { ...data, dataUrl: await readImageAttachmentDataUrl(sessionId, data.attachmentId) }
			: { ...data, content: (await readTextAttachmentContent(sessionId, data.attachmentId)).content };
		additionalContext.push({
			...item,
			data: hydratedData
		});
		changed = true;
	}

	return changed ? { ...params, additionalContext } : params;
}

export async function hydrateImageAttachmentContexts(sessionId: string | undefined, params: AiChatParams): Promise<AiChatParams> {
	return hydrateAttachmentContexts(sessionId, params);
}
