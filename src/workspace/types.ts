export type WorkspaceIcon = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type WorkspaceColor = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type WorkspaceLaunchTargetId = "file-explorer" | "terminal" | "vscode" | "visual-studio" | "github-desktop" | "git-bash" | "godot";

export type WorkspaceCapabilityStatus = "available" | "unavailable" | "unknown";

export type WorkspaceSourceCapabilities = {
	git: boolean;
	godot: boolean;
	projectMarkers?: string[] | undefined;
	typecheck?: WorkspaceCapabilityStatus | undefined;
	terminalPresets?: string[] | undefined;
	workflowProfile?: "godot" | "workspace" | undefined;
};

export type WorkspaceSourceFolder = {
	id: string;
	path: string;
	capabilities: WorkspaceSourceCapabilities;
};

export type WorkspaceConfig = {
	id: string;
	name: string;
	kind: "godot";
	rootPath: string;
	icon: WorkspaceIcon;
	color: WorkspaceColor;
	sourceFolders: WorkspaceSourceFolder[];
	primarySourceFolderId: string;
	godotExecutablePath?: string | undefined;
};
