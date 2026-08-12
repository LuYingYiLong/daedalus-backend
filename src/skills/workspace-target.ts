import { findWorkspace } from "../workspace/registry.js";
import type { WorkspaceConfig } from "../workspace/types.js";
import { createGlobalSkillWorkspace, createSkillWorkspace } from "./runtime.js";
import type { SkillWorkspace } from "./types.js";

export type SkillTargetParams = {
	workspaceId?: string | undefined;
	sourceFolderId?: string | undefined;
};

type WorkspaceLookup = (workspaceId: string) => WorkspaceConfig | undefined;

export function resolveSkillWorkspaceTarget(
	params: SkillTargetParams,
	options: { sourceScoped?: boolean; lookupWorkspace?: WorkspaceLookup } = {}
): SkillWorkspace {
	if (params.workspaceId === undefined) {
		if (params.sourceFolderId !== undefined) {
			throw new Error("sourceFolderId requires workspaceId for skill management.");
		}
		return createGlobalSkillWorkspace();
	}
	const workspace: WorkspaceConfig | undefined = (options.lookupWorkspace ?? findWorkspace)(params.workspaceId);
	if (workspace === undefined) {
		throw new Error(`Workspace not found for skill management: ${params.workspaceId}`);
	}
	if (options.sourceScoped !== true) {
		return createSkillWorkspace(workspace);
	}
	const sourceFolderId: string | undefined = params.sourceFolderId
		?? (workspace.sourceFolders.length === 1 ? workspace.sourceFolders[0]?.id : undefined);
	if (sourceFolderId === undefined) {
		throw new Error("sourceFolderId is required for project skill management in a multi-source workspace.");
	}
	return createSkillWorkspace(workspace, sourceFolderId);
}
