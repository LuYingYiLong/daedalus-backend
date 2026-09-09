import { createHash } from "node:crypto";
import type { SessionWorktreeMetadata, WorkspaceConfig } from "../workspace/types.js";
import { createManagedWorktree } from "../workspace/worktree-manager.js";
import {
	executeWorktreeHandoff,
	previewWorktreeHandoff,
	type WorktreeHandoffPreview
} from "../workspace/worktree-handoff.js";

export type SubagentMergePreview = WorktreeHandoffPreview & {
	graphId: string;
	nodeId: string;
	fingerprint: string;
};

function stableJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableJson).join(",")}]`;
	}
	if (typeof value === "object" && value !== null) {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]): number => left.localeCompare(right))
			.map(([key, item]): string => `${JSON.stringify(key)}:${stableJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function createPreviewFingerprint(preview: WorktreeHandoffPreview): string {
	return createHash("sha256").update(stableJson(preview)).digest("hex");
}

function createManagedDirectoryKey(graphId: string, nodeId: string): string {
	const digest: string = createHash("sha256")
		.update(`${graphId}\n${nodeId}`)
		.digest("hex")
		.slice(0, 32);
	return `subagent-${digest}`;
}

export async function createSubagentWorktree(params: {
	graphId: string;
	nodeId: string;
	workspace: WorkspaceConfig;
}): Promise<{ metadata: SessionWorktreeMetadata; workspace: WorkspaceConfig }> {
	return createManagedWorktree({
		sessionId: createManagedDirectoryKey(params.graphId, params.nodeId),
		workspace: params.workspace
	});
}

export async function previewSubagentMerge(params: {
	graphId: string;
	nodeId: string;
	metadata: SessionWorktreeMetadata;
	sourceWorkspace: WorkspaceConfig;
}): Promise<SubagentMergePreview> {
	const preview: WorktreeHandoffPreview = await previewWorktreeHandoff({
		sessionId: createManagedDirectoryKey(params.graphId, params.nodeId),
		metadata: params.metadata,
		sourceWorkspace: params.sourceWorkspace,
		target: "local"
	});
	return {
		...preview,
		graphId: params.graphId,
		nodeId: params.nodeId,
		fingerprint: createPreviewFingerprint(preview)
	};
}

export async function applySubagentMerge(params: {
	graphId: string;
	nodeId: string;
	metadata: SessionWorktreeMetadata;
	sourceWorkspace: WorkspaceConfig;
	fingerprint: string;
}): Promise<{ metadata: SessionWorktreeMetadata; preview: SubagentMergePreview }> {
	const preview: SubagentMergePreview = await previewSubagentMerge(params);
	if (preview.fingerprint !== params.fingerprint) {
		throw Object.assign(
			new Error("Subagent worktree or target workspace changed after merge preview."),
			{ code: "subagent_merge_preview_stale" }
		);
	}
	if (!preview.allowed) {
		throw Object.assign(
			new Error(preview.sources.find((source): boolean => source.blockedReason !== null)?.blockedReason ?? "Subagent merge is blocked."),
			{ code: "subagent_merge_blocked" }
		);
	}
	const metadata: SessionWorktreeMetadata = await executeWorktreeHandoff({
		sessionId: createManagedDirectoryKey(params.graphId, params.nodeId),
		metadata: params.metadata,
		sourceWorkspace: params.sourceWorkspace,
		target: "local"
	});
	return { metadata, preview };
}
