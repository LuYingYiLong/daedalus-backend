export type WorkspaceIcon = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type WorkspaceColor = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type WorkspaceSourceFolder = {
	id: string;
	path: string;
	capabilities: {
		git: boolean;
		godot: boolean;
	};
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
