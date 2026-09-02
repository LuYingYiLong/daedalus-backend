import { createHash } from "node:crypto";
import { readComputerScreenshot } from "../session/computer-observation-store.js";
import { readBrowserScreenshot } from "../session/browser-activity-store.js";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { AdditionalContextItem } from "../protocol/types.js";
import {
	MAX_IMAGE_ATTACHMENTS,
	MAX_IMAGE_BYTES,
	MAX_TOTAL_IMAGE_BYTES
} from "../protocol/image-attachments.js";
import {
	assertImagePathMatchesMimeType,
	assertSupportedImageSignature,
	type SupportedImageMimeType
} from "../protocol/image-file-signature.js";
import {
	readGeneratedImageArtifact,
	readImageAttachmentArtifact
} from "../session/session-attachments.js";
import { createWorkspaceFileService } from "../workspace/files.js";
import { findWorkspace, getWorkspaceSourceFolder } from "../workspace/registry.js";
import { resolveWorkspaceReadSource } from "../workspace/source-context.js";
import { godotRuntimeTestBridge } from "../mcp/godot/bridges/runtime-test-bridge.js";

export const IMAGE_INSPECT_TOOL_NAME: string = "mcp_image_inspect";

export type ToolImageSource =
	| { kind: "browser_activity"; sessionId: string; activityId: string }
	| { kind: "computer_observation"; sessionId: string; observationId: string }
	| { kind: "godot_runtime"; testSessionId: string; runtimeInstanceId: string; observationId: string }
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

export type ToolImageHydrationFailure = {
	reference: ProviderToolImageReference;
	code: string;
};

export type AvailableToolImageHydration = {
	images: HydratedProviderToolImage[];
	failures: ToolImageHydrationFailure[];
};

export type ResolvedImageInspection = {
	reference: ProviderToolImageReference;
	artifactRef: string;
};

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function assertSupportedImage(bytes: Buffer, declaredMimeType?: string | undefined, tolerateDeclaredMismatch: boolean = false): SupportedImageMimeType {
	if (bytes.byteLength <= 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
		throw new Error(`Image must be between 1 byte and ${MAX_IMAGE_BYTES} bytes.`);
	}
	const detectedMimeType: SupportedImageMimeType = assertSupportedImageSignature(bytes);
	if (!tolerateDeclaredMismatch && declaredMimeType !== undefined && declaredMimeType !== detectedMimeType) {
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
			const rawRelativePath: unknown = args.relativePath;
			if (typeof rawRelativePath !== "string") {
				throw new Error("relativePath is required for workspace images.");
			}
			const trimmedPath: string = rawRelativePath.trim().replaceAll("\\", "/");
			if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmedPath) && !trimmedPath.startsWith("res://")) {
				throw new Error("Image URLs and user:// paths are not allowed.");
			}
			const resolverPath: string = trimmedPath.startsWith("res://") ? trimmedPath.slice("res://".length) : trimmedPath;
			const selected = resolveWorkspaceReadSource(workspace, resolverPath, { sourceFolderId });
			const sourceFolder = selected.source;
			args.sourceFolderId = sourceFolder.id;
			const relativePath: string = normalizeWorkspaceImagePath(selected.relativePath, sourceFolder.capabilities.godot);
		assertNotGodotInternalPath(relativePath);
		const service = createWorkspaceFileService({ rootPath: sourceFolder.path, readMaxBytes: MAX_IMAGE_BYTES });
		const resolved = await service.resolveReadPath(relativePath);
		const fileStat = await stat(resolved.absolutePath);
		if (!fileStat.isFile() || fileStat.size <= 0 || fileStat.size > MAX_IMAGE_BYTES) {
			throw new Error(`Workspace image must be a file no larger than ${MAX_IMAGE_BYTES} bytes.`);
		}
		const bytes: Buffer = await readFile(resolved.absolutePath);
		const mimeType: SupportedImageMimeType = assertSupportedImage(bytes);
		assertImagePathMatchesMimeType(resolved.relativePath, mimeType);
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
		const mimeType: SupportedImageMimeType = assertSupportedImage(bytes, metadata.mimeType, true);
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
	const mimeType: SupportedImageMimeType = assertSupportedImage(bytes, metadata.mimeType);
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
	if (reference.source.kind === "browser_activity") return readBrowserScreenshot(reference.source.sessionId, reference.source.activityId);
	if (reference.source.kind === "computer_observation") return readComputerScreenshot(reference.source.sessionId, reference.source.observationId);
	if (reference.source.kind === "godot_runtime") {
		return godotRuntimeTestBridge.readScreenshot(
			reference.source.testSessionId,
			reference.source.runtimeInstanceId,
			reference.source.observationId
		);
	}
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

function getToolImageHydrationFailureCode(error: unknown): string {
	const message: string = error instanceof Error ? error.message.trim() : "";
	const leadingCode: string | undefined = /^([a-z][a-z0-9_]{1,79})(?::|$)/u.exec(message)?.[1];
	return leadingCode ?? "tool_image_unavailable";
}

export async function hydrateAvailableToolImageReferences(
	references: readonly ProviderToolImageReference[]
): Promise<AvailableToolImageHydration> {
	if (references.length > MAX_IMAGE_ATTACHMENTS) {
		return {
			images: [],
			failures: references.map((reference: ProviderToolImageReference): ToolImageHydrationFailure => ({
				reference,
				code: "tool_image_count_exceeded",
			})),
		};
	}
	const totalBytes: number = references.reduce((sum: number, reference: ProviderToolImageReference): number => sum + reference.byteSize, 0);
	if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
		return {
			images: [],
			failures: references.map((reference: ProviderToolImageReference): ToolImageHydrationFailure => ({
				reference,
				code: "tool_image_bytes_exceeded",
			})),
		};
	}

	const settled: PromiseSettledResult<HydratedProviderToolImage>[] = await Promise.allSettled(
		references.map(hydrateToolImageReference)
	);
	const images: HydratedProviderToolImage[] = [];
	const failures: ToolImageHydrationFailure[] = [];
	for (let index: number = 0; index < settled.length; index += 1) {
		const result: PromiseSettledResult<HydratedProviderToolImage> = settled[index] as PromiseSettledResult<HydratedProviderToolImage>;
		const reference: ProviderToolImageReference = references[index] as ProviderToolImageReference;
		if (result.status === "fulfilled") {
			images.push(result.value);
		} else {
			failures.push({ reference, code: getToolImageHydrationFailureCode(result.reason) });
		}
	}
	return { images, failures };
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
