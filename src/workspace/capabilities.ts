import type { WorkspaceConfig, WorkspaceSourceFolder } from "./types.js";

/**
 * Godot capabilities are scoped to source folders, not the legacy workspace
 * `kind` field. A workspace may aggregate unrelated projects.
 */
export function getGodotSourceFolders(
	workspace: Pick<WorkspaceConfig, "sourceFolders"> | undefined
): WorkspaceSourceFolder[] {
	if (workspace === undefined) {
		return [];
	}

	return workspace.sourceFolders.filter(
		(source: WorkspaceSourceFolder): boolean => source.capabilities.godot
	);
}

export function hasGodotWorkspaceCapability(
	workspace: Pick<WorkspaceConfig, "sourceFolders"> | undefined
): boolean {
	return getGodotSourceFolders(workspace).length > 0;
}
