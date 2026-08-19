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

export type PlatformScripts = {
	default?: string | undefined;
	windows?: string | undefined;
	macos?: string | undefined;
	linux?: string | undefined;
};

export type LocalEnvironmentAction = {
	id: string;
	name: string;
	icon?: string | undefined;
	scripts: PlatformScripts;
	network?: boolean | undefined;
};

export type LocalEnvironmentProfile = {
	id: string;
	name: string;
	description?: string | undefined;
	setup?: {
		scripts: PlatformScripts;
		timeoutSeconds?: number | undefined;
		network?: boolean | undefined;
	} | undefined;
	actions: LocalEnvironmentAction[];
};

export type LocalEnvironmentConfig = {
	version: 1;
	defaultEnvironmentId?: string | null | undefined;
	environments: LocalEnvironmentProfile[];
};

export type WorktreeStartingState =
	| { type: "head" }
	| { type: "branch"; ref: string }
	| { type: "working-tree" };

export type WorktreeSetupState = "not-required" | "pending-trust" | "running" | "ready" | "failed" | "skipped" | "interrupted";
export type SessionWorktreeLocation = "local" | "worktree";
export type WorktreeLifecycleStatus = "creating" | "setting-up" | "ready" | "setup-failed" | "handoff" | "unavailable" | "recovery-required";

export type WorktreeSetupSummary = {
	startedAt?: string | undefined;
	finishedAt?: string | undefined;
	exitCode?: number | null | undefined;
	durationMs?: number | undefined;
	message?: string | undefined;
	logPath?: string | undefined;
};

export type SessionWorktreeSource = {
	sourceFolderId: string;
	sourcePath: string;
	worktreePath: string;
	baseCommit: string;
	baseRef: string | null;
	startingState?: WorktreeStartingState | undefined;
	environmentId?: string | null | undefined;
	environmentFingerprint?: string | null | undefined;
	setupState?: WorktreeSetupState | undefined;
	setupSummary?: WorktreeSetupSummary | undefined;
	sensitiveIncludedPaths?: string[] | undefined;
};

export type SessionWorktreeMetadata = {
	id: string;
	sourceWorkspaceId: string;
	sourceWorkspaceName: string;
	runtimeWorkspaceId: string;
	sources: SessionWorktreeSource[];
	createdAt: string;
	location?: SessionWorktreeLocation | undefined;
	status?: WorktreeLifecycleStatus | undefined;
	permanent?: boolean | undefined;
	displayName?: string | undefined;
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
	permanentWorktree?: SessionWorktreeMetadata | undefined;
};
