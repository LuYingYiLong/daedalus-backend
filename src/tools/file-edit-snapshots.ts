import { createHash } from "node:crypto";
import { stat, readFile } from "node:fs/promises";
import path from "node:path";
import type { McpHost } from "../mcp/mcp-host.js";
import { findWorkspace, getWorkspaceSourceFolder } from "../workspace/registry.js";

const MAX_FILE_EDIT_SNAPSHOT_BYTES: number = 20 * 1024 * 1024;

export type FileEditSnapshot = {
	path: string;
	absolutePath: string;
	workspaceRoot: string;
	existedBefore: boolean;
	existsAfter: boolean;
	beforeText?: string | undefined;
	afterText?: string | undefined;
	beforeBase64?: string | undefined;
	afterBase64?: string | undefined;
	beforeSha256?: string | undefined;
	afterSha256?: string | undefined;
	additions: number;
	deletions: number;
	undoable: boolean;
	unavailableReason?: string | undefined;
};

export type FileEditBatchDraft = {
	workspaceId: string;
	workspaceRoot: string;
	edits: FileEditSnapshot[];
};

type SnapshotRead = {
	exists: boolean;
	text?: string | undefined;
	base64?: string | undefined;
	sha256?: string | undefined;
	unavailableReason?: string | undefined;
};

type TrackedTarget = {
	path: string;
	absolutePath: string;
	workspaceRoot: string;
};

function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function isPathInsideRoot(absolutePath: string, rootPath: string): boolean {
	const relativePath: string = path.relative(rootPath, absolutePath);
	return relativePath.length === 0 || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function normalizeProjectPath(projectPath: string): string {
	const trimmedPath: string = projectPath.trim().replaceAll("\\", "/");
	if (trimmedPath.startsWith("res://")) {
		return trimmedPath.slice("res://".length);
	}
	return trimmedPath;
}

function resolveWorkspaceTarget(workspaceRoot: string, projectPath: string): TrackedTarget | null {
	const cleanedPath: string = normalizeProjectPath(projectPath);
	if (cleanedPath.length === 0) {
		return null;
	}

	const absolutePath: string = path.isAbsolute(cleanedPath)
		? path.resolve(cleanedPath)
		: path.resolve(workspaceRoot, cleanedPath);
	if (!isPathInsideRoot(absolutePath, workspaceRoot)) {
		return null;
	}

	return {
		path: path.relative(workspaceRoot, absolutePath).replaceAll(path.sep, "/"),
		absolutePath,
		workspaceRoot
	};
}

function addTarget(targets: Map<string, TrackedTarget>, workspaceRoot: string, value: unknown): void {
	if (typeof value !== "string") {
		return;
	}

	const target: TrackedTarget | null = resolveWorkspaceTarget(workspaceRoot, value);
	if (target === null) {
		return;
	}

	targets.set(target.absolutePath, target);
}

function collectTrackedTargets(mcpHost: McpHost, workspaceRoot: string, llmToolName: string, args: Record<string, unknown>): TrackedTarget[] {
	const targets: Map<string, TrackedTarget> = new Map();
	switch (llmToolName) {
		case "mcp_workspace_create_text_file":
		case "mcp_workspace_overwrite_text_file":
		case "mcp_workspace_replace_text_in_file":
		case "mcp_workspace_replace_line_in_file":
		case "mcp_workspace_delete_file":
		case "mcp_image_import_to_workspace":
		case "mcp_image_replace_workspace_asset":
			addTarget(targets, workspaceRoot, args.relativePath);
			break;
		case "mcp_godot_set_project_setting":
		case "mcp_godot_unset_project_setting":
			addTarget(targets, workspaceRoot, "project.godot");
			break;
		case "mcp_godot_create_text_file":
		case "mcp_godot_overwrite_text_file":
		case "mcp_godot_replace_text_in_file":
		case "mcp_godot_delete_file":
		case "mcp_godot_create_scene":
			addTarget(targets, workspaceRoot, args.relativePath);
			break;
		case "mcp_godot_add_node_to_scene":
		case "mcp_godot_attach_script_to_node":
		case "mcp_godot_connect_signal_in_scene":
		case "mcp_godot_apply_scene_patch":
			addTarget(targets, workspaceRoot, args.scenePath);
			break;
		case "mcp_godot_editor_apply_scene_patch":
			addTarget(targets, workspaceRoot, args.scenePath);
			addTarget(targets, workspaceRoot, mcpHost.getEditorBridge().getActiveScenePath());
			break;
	}

	return Array.from(targets.values());
}

export function isGoalCheckpointCapableToolCall(
	llmToolName: string,
	args: Record<string, unknown>,
	context: { activeScenePath?: string | undefined } = {}
): boolean {
	if (
		llmToolName === "mcp_godot_set_project_setting"
		|| llmToolName === "mcp_godot_unset_project_setting"
	) return true;
	if ([
		"mcp_workspace_create_text_file",
		"mcp_workspace_overwrite_text_file",
		"mcp_workspace_replace_text_in_file",
		"mcp_workspace_replace_line_in_file",
		"mcp_workspace_delete_file",
		"mcp_image_import_to_workspace",
		"mcp_image_replace_workspace_asset",
		"mcp_godot_create_text_file",
		"mcp_godot_overwrite_text_file",
		"mcp_godot_replace_text_in_file",
		"mcp_godot_delete_file",
		"mcp_godot_create_scene"
	].includes(llmToolName)) return typeof args.relativePath === "string" && args.relativePath.trim().length > 0;
	if ([
		"mcp_godot_add_node_to_scene",
		"mcp_godot_attach_script_to_node",
		"mcp_godot_connect_signal_in_scene",
		"mcp_godot_apply_scene_patch"
	].includes(llmToolName)) return typeof args.scenePath === "string" && args.scenePath.trim().length > 0;
	if (llmToolName === "mcp_godot_editor_apply_scene_patch") {
		if (args.saveAfter === false) {
			return false;
		}
		const targetScenePath: unknown = typeof args.scenePath === "string"
			? args.scenePath
			: context.activeScenePath;
		return typeof targetScenePath === "string" && targetScenePath.trim().length > 0;
	}
	return false;
}

async function readSnapshot(target: TrackedTarget): Promise<SnapshotRead> {
	try {
		const fileStat = await stat(target.absolutePath);
		if (!fileStat.isFile()) {
			return {
				exists: true,
				unavailableReason: "not_file"
			};
		}
		if (fileStat.size > MAX_FILE_EDIT_SNAPSHOT_BYTES) {
			return {
				exists: true,
				unavailableReason: "file_too_large"
			};
		}
		const bytes: Buffer = await readFile(target.absolutePath);
		if (bytes.includes(0)) {
			return {
				exists: true,
				sha256: sha256(bytes),
				base64: bytes.toString("base64")
			};
		}
		const text: string = bytes.toString("utf8");
		return {
			exists: true,
			text,
			sha256: sha256(text)
		};
	} catch {
		return { exists: false };
	}
}

function splitLines(text: string): string[] {
	if (text.length === 0) {
		return [];
	}
	return text.split(/\r?\n/u);
}

function countLineDiff(beforeText: string | undefined, afterText: string | undefined): { additions: number; deletions: number } {
	const beforeLines: string[] = splitLines(beforeText ?? "");
	const afterLines: string[] = splitLines(afterText ?? "");
	let prefixLength: number = 0;
	while (
		prefixLength < beforeLines.length
		&& prefixLength < afterLines.length
		&& beforeLines[prefixLength] === afterLines[prefixLength]
	) {
		prefixLength += 1;
	}

	let suffixLength: number = 0;
	while (
		suffixLength + prefixLength < beforeLines.length
		&& suffixLength + prefixLength < afterLines.length
		&& beforeLines[beforeLines.length - 1 - suffixLength] === afterLines[afterLines.length - 1 - suffixLength]
	) {
		suffixLength += 1;
	}

	return {
		additions: Math.max(0, afterLines.length - prefixLength - suffixLength),
		deletions: Math.max(0, beforeLines.length - prefixLength - suffixLength)
	};
}

function readRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
	try {
		return readRecord(JSON.parse(text));
	} catch {
		return null;
	}
}

function hasNonEmptyArray(value: unknown): boolean {
	return Array.isArray(value) && value.length > 0;
}

function isSuccessfulWriteResult(record: Record<string, unknown> | null): boolean {
	if (record === null) {
		return false;
	}
	if (record.ok === false || record.valid === false || typeof record.error === "string" || hasNonEmptyArray(record.errors)) {
		return false;
	}

	const nestedResult: Record<string, unknown> | null = readRecord(record.result);
	if (nestedResult !== null && (nestedResult.ok === false || typeof nestedResult.error === "string" || hasNonEmptyArray(nestedResult.errors))) {
		return false;
	}

	return record.created === true
		|| record.overwritten === true
		|| record.replaced === true
		|| record.deleted === true
		|| record.modified === true
		|| record.ok === true
		|| nestedResult?.ok === true
		|| nestedResult?.modified === true;
}

function createEditSnapshot(target: TrackedTarget, before: SnapshotRead, after: SnapshotRead): FileEditSnapshot | null {
	if (before.exists === after.exists && before.sha256 !== undefined && before.sha256 === after.sha256) {
		return null;
	}
	if (!before.exists && !after.exists) {
		return null;
	}

	const counts = countLineDiff(before.text, after.text);
	const unavailableReason: string | undefined = before.unavailableReason ?? after.unavailableReason;
	const undoable: boolean = unavailableReason === undefined
		&& (!before.exists || before.text !== undefined || before.base64 !== undefined)
		&& (!after.exists || after.text !== undefined || after.base64 !== undefined);
	return {
		path: target.path,
		absolutePath: target.absolutePath,
		workspaceRoot: target.workspaceRoot,
		existedBefore: before.exists,
		existsAfter: after.exists,
		beforeText: before.text,
		afterText: after.text,
		beforeBase64: before.base64,
		afterBase64: after.base64,
		beforeSha256: before.sha256,
		afterSha256: after.sha256,
		additions: counts.additions,
		deletions: counts.deletions,
		undoable,
		unavailableReason
	};
}

export async function captureFileEditBatchDraft<T extends { content: string; reused?: boolean | undefined }>(
	mcpHost: McpHost,
	llmToolName: string,
	args: Record<string, unknown>,
	execute: () => Promise<T>
): Promise<T & { fileEditDraft?: FileEditBatchDraft | undefined }> {
	const workspaceId: string | undefined = mcpHost.getActiveWorkspaceId();
	const workspace = workspaceId === undefined ? undefined : findWorkspace(workspaceId);
	if (workspaceId === undefined || workspace === undefined) {
		return await execute();
	}

	const sourceFolderId: string | undefined = typeof args.sourceFolderId === "string" ? args.sourceFolderId : undefined;
	const workspaceRoot: string = path.resolve(getWorkspaceSourceFolder(workspace, sourceFolderId).path);
	const targets: TrackedTarget[] = collectTrackedTargets(mcpHost, workspaceRoot, llmToolName, args);
	if (targets.length === 0) {
		return await execute();
	}

	const beforeSnapshots: SnapshotRead[] = await Promise.all(targets.map(readSnapshot));
	const result: T = await execute();
	if (result.reused === true || !isSuccessfulWriteResult(parseJsonObject(result.content))) {
		return result;
	}

	const afterSnapshots: SnapshotRead[] = await Promise.all(targets.map(readSnapshot));
	const edits: FileEditSnapshot[] = [];
	for (let index: number = 0; index < targets.length; index += 1) {
		const target: TrackedTarget | undefined = targets[index];
		const before: SnapshotRead | undefined = beforeSnapshots[index];
		const after: SnapshotRead | undefined = afterSnapshots[index];
		if (target === undefined || before === undefined || after === undefined) {
			continue;
		}
		const edit: FileEditSnapshot | null = createEditSnapshot(target, before, after);
		if (edit !== null) {
			edits.push(edit);
		}
	}

	if (edits.length === 0) {
		return result;
	}

	return {
		...result,
		fileEditDraft: {
			workspaceId,
			workspaceRoot,
			edits
		}
	};
}
