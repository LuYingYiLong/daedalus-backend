import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { AdditionalContextItem } from "../protocol/types.js";
import {
	MAX_IMAGE_ATTACHMENTS,
	MAX_IMAGE_BYTES,
	MAX_TOTAL_IMAGE_BYTES,
	SUPPORTED_IMAGE_MIME_TYPES
} from "../protocol/image-attachments.js";
import {
	readGeneratedImageArtifact,
	readImageAttachmentArtifact
} from "../session/session-attachments.js";
import { createWorkspaceFileService } from "../workspace/files.js";
import { findWorkspace, getWorkspaceSourceFolder } from "../workspace/registry.js";

export const IMAGE_INSPECT_TOOL_NAME: string = "mcp_image_inspect";

export type ToolImageSource =
	| {
		kind: "workspace";
		workspaceId: string;
		sourceFolderId: string;
		relativePath: string;
	}
	| {
		kind: "session";
		sessionId: string;
		imageId: string;
	};

export type ProviderToolImageReference = {
	toolCallId?: string | undefined;
	source: ToolImageSource;
	title: string;
	mimeType: string;
	byteSize: number;
	sha256: string;
	question?: string | undefined;
	width?: number | undefined;
	height?: number | undefined;
};

export type HydratedProviderToolImage = ProviderToolImageReference & {
	dataUrl: string;
};

export type ResolvedImageInspection = {
	reference: ProviderToolImageReference;
	artifactRef: string;
};

type ImageSignature = {
	mimeType: string;
	extensions: readonly string[];
};

const IMAGE_SIGNATURES: readonly ImageSignature[] = [
	{ mimeType: "image/png", extensions: [".png"] },
	{ mimeType: "image/jpeg", extensions: [".jpg", ".jpeg"] },
	{ mimeType: "image/webp", extensions: [".webp"] },
	{ mimeType: "image/gif", extensions: [".gif"] }
];

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function detectImageMimeType(bytes: Buffer): string | null {
	if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
		return "image/png";
	}
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return "image/jpeg";
	}
	if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
		return "image/webp";
	}
	if (bytes.length >= 6) {
		const signature: string = bytes.toString("ascii", 0, 6);
		if (signature === "GIF87a" || signature === "GIF89a") {
			return "image/gif";
		}
	}
	return null;
}

function assertSupportedImage(bytes: Buffer, declaredMimeType?: string | undefined): string {
	if (bytes.byteLength <= 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
		throw new Error(`Image must be between 1 byte and ${MAX_IMAGE_BYTES} bytes.`);
	}
	const detectedMimeType: string | null = detectImageMimeType(bytes);
	if (detectedMimeType === null || !SUPPORTED_IMAGE_MIME_TYPES.includes(detectedMimeType)) {
		throw new Error("Image file signature is not a supported PNG, JPEG, WebP, or GIF image.");
	}
	if (declaredMimeType !== undefined && declaredMimeType !== detectedMimeType) {
		throw new Error(`Image MIME type does not match its file signature (${declaredMimeType} != ${detectedMimeType}).`);
	}
	return detectedMimeType;
}

function normalizeWorkspaceImagePath(value: unknown, godotSource: boolean): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error("relativePath is required for workspace images.");
	}
	const trimmed: string = value.trim().replaceAll("\\", "/");
	if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) && !trimmed.startsWith("res://")) {
		throw new Error("Image URLs and user:// paths are not allowed.");
	}
	if (trimmed.startsWith("res://")) {
		if (!godotSource) {
			throw new Error("res:// paths are only valid for Godot source folders.");
		}
		return trimmed.slice("res://".length);
	}
	return trimmed;
}

function assertNotGodotInternalPath(relativePath: string): void {
	const segments: string[] = relativePath.split("/").filter(Boolean);
	if (segments.some((segment: string): boolean => segment.toLowerCase() === ".godot")) {
		throw new Error("Images inside .godot are not available to image inspection.");
	}
}

function assertImageExtension(relativePath: string, mimeType: string): void {
	const lowerPath: string = relativePath.toLowerCase();
	const signature: ImageSignature | undefined = IMAGE_SIGNATURES.find((item: ImageSignature): boolean => item.mimeType === mimeType);
	if (signature === undefined || !signature.extensions.some((extension: string): boolean => lowerPath.endsWith(extension))) {
		throw new Error(`Image extension does not match ${mimeType}.`);
	}
}

function getOptionalQuestion(args: Record<string, unknown>): string | undefined {
	if (args.question === undefined) {
		return undefined;
	}
	if (typeof args.question !== "string") {
		throw new Error("question must be a string.");
	}
	const question: string = args.question.trim();
	if (question.length > 2000) {
		throw new Error("question must not exceed 2000 characters.");
	}
	return question.length > 0 ? question : undefined;
}

export async function resolveImageInspection(
	args: Record<string, unknown>,
	context: { workspaceId?: string | undefined; sessionId?: string | undefined }
): Promise<ResolvedImageInspection> {
	const question: string | undefined = getOptionalQuestion(args);
	if (args.source === "workspace") {
		if (context.workspaceId === undefined) {
			throw new Error("image_inspection_workspace_required");
		}
		if (args.imageId !== undefined) {
			throw new Error("imageId is only valid for session images.");
		}
		const workspace = findWorkspace(context.workspaceId);
		if (workspace === undefined) {
			throw new Error(`Workspace not found: ${context.workspaceId}`);
		}
		const sourceFolderId: string | undefined = typeof args.sourceFolderId === "string" ? args.sourceFolderId.trim() || undefined : undefined;
		const sourceFolder = getWorkspaceSourceFolder(workspace, sourceFolderId);
		const relativePath: string = normalizeWorkspaceImagePath(args.relativePath, sourceFolder.capabilities.godot);
		assertNotGodotInternalPath(relativePath);
		const service = createWorkspaceFileService({ rootPath: sourceFolder.path, readMaxBytes: MAX_IMAGE_BYTES });
		const resolved = await service.resolveReadPath(relativePath);
		const fileStat = await stat(resolved.absolutePath);
		if (!fileStat.isFile() || fileStat.size <= 0 || fileStat.size > MAX_IMAGE_BYTES) {
			throw new Error(`Workspace image must be a file no larger than ${MAX_IMAGE_BYTES} bytes.`);
		}
		const bytes: Buffer = await readFile(resolved.absolutePath);
		const mimeType: string = assertSupportedImage(bytes);
		assertImageExtension(resolved.relativePath, mimeType);
		const reference: ProviderToolImageReference = {
			source: {
				kind: "workspace",
				workspaceId: workspace.id,
				sourceFolderId: sourceFolder.id,
				relativePath: resolved.relativePath
			},
			title: basename(resolved.relativePath),
			mimeType,
			byteSize: bytes.byteLength,
			sha256: sha256(bytes),
			question
		};
		return {
			reference,
			artifactRef: `workspace:${sourceFolder.id}:${resolved.relativePath}`
		};
	}

	if (args.source !== "session") {
		throw new Error("source must be workspace or session.");
	}
	if (context.sessionId === undefined) {
		throw new Error("image_inspection_session_required");
	}
	if (args.relativePath !== undefined || args.sourceFolderId !== undefined) {
		throw new Error("relativePath and sourceFolderId are only valid for workspace images.");
	}
	if (typeof args.imageId !== "string" || args.imageId.trim().length === 0) {
		throw new Error("imageId is required for session images.");
	}
	const imageId: string = args.imageId.trim();
	if (imageId.startsWith("generated-image-")) {
		const { metadata, bytes } = await readGeneratedImageArtifact(context.sessionId, imageId);
		const mimeType: string = assertSupportedImage(bytes, metadata.mimeType);
		return {
			reference: {
				source: { kind: "session", sessionId: context.sessionId, imageId },
				title: metadata.fileName,
				mimeType,
				byteSize: bytes.byteLength,
				sha256: sha256(bytes),
				question,
				width: metadata.width,
				height: metadata.height
			},
			artifactRef: imageId
		};
	}
	const { metadata, bytes } = await readImageAttachmentArtifact(context.sessionId, imageId);
	const mimeType: string = assertSupportedImage(bytes, metadata.mimeType);
	return {
		reference: {
			source: { kind: "session", sessionId: context.sessionId, imageId },
			title: metadata.title,
			mimeType,
			byteSize: bytes.byteLength,
			sha256: sha256(bytes),
			question,
			width: metadata.width,
			height: metadata.height
		},
		artifactRef: imageId
	};
}

async function readReferenceBytes(reference: ProviderToolImageReference): Promise<Buffer> {
	if (reference.source.kind === "session") {
		return reference.source.imageId.startsWith("generated-image-")
			? (await readGeneratedImageArtifact(reference.source.sessionId, reference.source.imageId)).bytes
			: (await readImageAttachmentArtifact(reference.source.sessionId, reference.source.imageId)).bytes;
	}
	const workspace = findWorkspace(reference.source.workspaceId);
	if (workspace === undefined) {
		throw new Error(`Image workspace is no longer available: ${reference.source.workspaceId}`);
	}
	const sourceFolder = getWorkspaceSourceFolder(workspace, reference.source.sourceFolderId);
	const service = createWorkspaceFileService({ rootPath: sourceFolder.path, readMaxBytes: MAX_IMAGE_BYTES });
	const resolved = await service.resolveReadPath(reference.source.relativePath);
	return readFile(resolved.absolutePath);
}

export async function hydrateToolImageReference(reference: ProviderToolImageReference): Promise<HydratedProviderToolImage> {
	const bytes: Buffer = await readReferenceBytes(reference);
	const mimeType: string = assertSupportedImage(bytes, reference.mimeType);
	if (bytes.byteLength !== reference.byteSize || sha256(bytes) !== reference.sha256) {
		throw new Error("image_reference_conflict: the image changed after it was inspected; call mcp_image_inspect again.");
	}
	return {
		...reference,
		mimeType,
		dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}`
	};
}

export async function hydrateToolImageReferences(
	references: readonly ProviderToolImageReference[]
): Promise<HydratedProviderToolImage[]> {
	if (references.length > MAX_IMAGE_ATTACHMENTS) {
		throw new Error(`A provider continuation can include at most ${MAX_IMAGE_ATTACHMENTS} inspected images.`);
	}
	const totalBytes: number = references.reduce((sum: number, reference: ProviderToolImageReference): number => sum + reference.byteSize, 0);
	if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
		throw new Error(`Inspected images exceed the ${MAX_TOTAL_IMAGE_BYTES} byte continuation limit.`);
	}
	return Promise.all(references.map(hydrateToolImageReference));
}

export function createImageContextFromHydratedReference(image: HydratedProviderToolImage): AdditionalContextItem {
	return {
		id: `tool-image-${image.sha256.slice(0, 16)}`,
		kind: "image",
		title: image.title,
		source: "manual",
		summary: image.question ?? "Image selected by mcp_image_inspect.",
		data: {
			mimeType: image.mimeType,
			dataUrl: image.dataUrl,
			byteSize: image.byteSize,
			width: image.width,
			height: image.height
		}
	};
}
