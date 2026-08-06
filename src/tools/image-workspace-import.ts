import { constants as fsConstants, copyFile, link, lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import { findWorkspace } from "../workspace/registry.js";
import { resolveWorkspaceSources } from "../workspace/source-context.js";
import {
	getGeneratedImageArtifactLocalPath,
	readGeneratedImageArtifact,
	type GeneratedImageArtifactMetadata
} from "../session/session-attachments.js";
import {
	assertImagePathMatchesMimeType,
	assertSupportedImageSignature,
	type SupportedImageMimeType
} from "../protocol/image-file-signature.js";

const PROTECTED_ROOT_SEGMENTS: ReadonlySet<string> = new Set([
	".git",
	".godot",
	".daedalus",
	"node_modules"
]);

type ImportMode = "propose" | "create" | "replace";

export type ImageWorkspaceImportResult = {
	ok: true;
	mode: ImportMode;
	imageId: string;
	relativePath: string;
	resourcePath: string;
	absolutePath: string;
	mimeType: string;
	byteSize: number;
	sha256: string;
	exists: boolean;
	imported: boolean;
};

async function pathExists(absolutePath: string): Promise<boolean> {
	try {
		await lstat(absolutePath);
		return true;
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return false;
		}
		throw error;
	}
}

async function findExistingAncestor(absolutePath: string): Promise<string> {
	let candidate: string = absolutePath;
	for (;;) {
		if (await pathExists(candidate)) {
			return candidate;
		}
		const parent: string = path.dirname(candidate);
		if (parent === candidate) {
			throw new Error(`Unable to resolve destination ancestor: ${absolutePath}`);
		}
		candidate = parent;
	}
}

async function resolveSafeDestination(workspaceRoot: string, relativePath: string): Promise<{
	workspaceRoot: string;
	relativePath: string;
	absolutePath: string;
}> {
	const normalizedInput: string = relativePath.trim().replaceAll("\\", "/").replace(/^res:\/\//u, "");
	if (normalizedInput.length === 0 || path.isAbsolute(normalizedInput)) {
		throw new Error("Image destination must be a workspace-relative path.");
	}
	const firstSegment: string = normalizedInput.split("/")[0]?.toLowerCase() ?? "";
	if (PROTECTED_ROOT_SEGMENTS.has(firstSegment)) {
		throw new Error(`Image destination is protected: ${firstSegment}`);
	}

	const realWorkspaceRoot: string = await realpath(path.resolve(workspaceRoot));
	const absolutePath: string = path.resolve(realWorkspaceRoot, normalizedInput);
	const relativeToRoot: string = path.relative(realWorkspaceRoot, absolutePath);
	if (relativeToRoot.length === 0 || relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
		throw new Error("Image destination is outside the active workspace.");
	}

	const existingAncestor: string = await findExistingAncestor(path.dirname(absolutePath));
	const realAncestor: string = await realpath(existingAncestor);
	const ancestorRelative: string = path.relative(realWorkspaceRoot, realAncestor);
	if (ancestorRelative.startsWith("..") || path.isAbsolute(ancestorRelative)) {
		throw new Error("Image destination resolves through a symlink outside the active workspace.");
	}

	return {
		workspaceRoot: realWorkspaceRoot,
		relativePath: relativeToRoot.replaceAll(path.sep, "/"),
		absolutePath
	};
}

function throwIfAborted(abortSignal?: AbortSignal | undefined): void {
	if (abortSignal?.aborted) {
		throw new Error("Request cancelled");
	}
}

async function copyCreateOnly(sourcePath: string, destinationPath: string, abortSignal?: AbortSignal | undefined): Promise<void> {
	const tempPath: string = `${destinationPath}.daedalus-${randomUUID()}.tmp`;
	throwIfAborted(abortSignal);
	await copyFile(sourcePath, tempPath, fsConstants.COPYFILE_EXCL);
	try {
		throwIfAborted(abortSignal);
		await link(tempPath, destinationPath);
	} finally {
		await rm(tempPath, { force: true });
	}
}

async function copyReplace(sourcePath: string, destinationPath: string, abortSignal?: AbortSignal | undefined): Promise<void> {
	const tempPath: string = `${destinationPath}.daedalus-${randomUUID()}.tmp`;
	throwIfAborted(abortSignal);
	await copyFile(sourcePath, tempPath, fsConstants.COPYFILE_EXCL);
	try {
		throwIfAborted(abortSignal);
		await rename(tempPath, destinationPath);
	} finally {
		await rm(tempPath, { force: true });
	}
}

export async function executeImageWorkspaceImport(params: {
	mode: ImportMode;
	imageId: string;
	relativePath: string;
	sessionId: string;
	workspaceId: string;
	sourceFolderId?: string | undefined;
	abortSignal?: AbortSignal | undefined;
}): Promise<ImageWorkspaceImportResult> {
	throwIfAborted(params.abortSignal);
	const workspace = findWorkspace(params.workspaceId);
	if (workspace === undefined) {
		throw new Error(`Workspace is not registered: ${params.workspaceId}`);
	}
	const sourceSelection = resolveWorkspaceSources(workspace, {
		sourceFolderId: params.sourceFolderId,
		operation: "write"
	});
	if (sourceSelection.kind !== "source") {
		throw new Error("source_required: image workspace imports require one source folder.");
	}
	const sourceFolder = sourceSelection.source;
	const generated = await readGeneratedImageArtifact(params.sessionId, params.imageId);
	const metadata: GeneratedImageArtifactMetadata = generated.metadata;
	const actualMimeType: SupportedImageMimeType = assertSupportedImageSignature(generated.bytes);
	const destination = await resolveSafeDestination(sourceFolder.path, params.relativePath);
	assertImagePathMatchesMimeType(destination.relativePath, actualMimeType);
	const exists: boolean = await pathExists(destination.absolutePath);
	if (params.mode === "create" && exists) {
		throw new Error(`Destination already exists: ${destination.relativePath}`);
	}
	if (params.mode === "replace" && !exists) {
		throw new Error(`Destination does not exist: ${destination.relativePath}`);
	}

	const sha256: string = createHash("sha256").update(generated.bytes).digest("hex");
	if (params.mode !== "propose") {
		throwIfAborted(params.abortSignal);
		await mkdir(path.dirname(destination.absolutePath), { recursive: true });
		const sourcePath: string = getGeneratedImageArtifactLocalPath(metadata);
		if (params.mode === "create") {
			await copyCreateOnly(sourcePath, destination.absolutePath, params.abortSignal);
		} else {
			await copyReplace(sourcePath, destination.absolutePath, params.abortSignal);
		}
	}

	return {
		ok: true,
		mode: params.mode,
		imageId: metadata.imageId,
		relativePath: destination.relativePath,
		resourcePath: `res://${destination.relativePath}`,
		absolutePath: destination.absolutePath,
		mimeType: actualMimeType,
		byteSize: metadata.byteSize,
		sha256,
		exists,
		imported: params.mode !== "propose"
	};
}
