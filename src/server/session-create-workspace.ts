export function resolveSessionCreateWorkspaceId(params: {
	requestedWorkspaceId: string | null | undefined;
}): string | undefined {
	if (params.requestedWorkspaceId === null) {
		return undefined;
	}
	if (params.requestedWorkspaceId !== undefined) {
		return params.requestedWorkspaceId;
	}
	return undefined;
}
