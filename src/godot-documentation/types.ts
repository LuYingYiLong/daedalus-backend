export type GodotDocumentationScope = "all" | "class_reference" | "manual";

export type DocumentationHealthStatus =
	| "checking"
	| "ready"
	| "degraded"
	| "repairing"
	| "unavailable";

export type DocumentationRepairAvailability =
	| "rollback"
	| "cached_source"
	| "network_required"
	| "source_required"
	| "none";

export type GodotDocumentationSourceRef = {
	kind: "official_zip" | "local_zip" | "local_tree";
	sha256: string;
	sizeBytes: number;
};

export type GodotDocumentationHealth = {
	status: DocumentationHealthStatus;
	code: string | null;
	message: string | null;
	checkedAt: string | null;
};

export type GodotDocumentationRecord = {
	id: string;
	branch: string;
	commitSha: string;
	source: "official" | "local";
	sourcePath?: string | undefined;
	sourceRef: GodotDocumentationSourceRef | null;
	activeGenerationId: string | null;
	health: GodotDocumentationHealth;
	repairAvailability: DocumentationRepairAvailability;
	installedAt: string;
	updatedAt: string;
	documentCount: number;
	chunkCount: number;
	classCount: number;
	sizeBytes: number;
};

export type GodotDocumentationSettings = {
	schemaVersion: 2;
	enabled: boolean;
	documents: Record<string, GodotDocumentationRecord>;
};

export type GodotDocumentationBranch = {
	name: string;
	commitSha: string;
	installed: boolean;
};

export type GodotDocumentationJobStage =
	| "resolving"
	| "downloading"
	| "extracting"
	| "indexing"
	| "validating"
	| "rolling_back"
	| "finalizing"
	| "completed"
	| "failed"
	| "cancelled";

export type GodotDocumentationJob = {
	jobId: string;
	operation: "install" | "update" | "import" | "check" | "repair";
	branch: string;
	documentId: string | null;
	stage: GodotDocumentationJobStage;
	progress: number | null;
	message: string;
	error: string | null;
	startedAt: string;
	updatedAt: string;
	completedAt: string | null;
	unchanged: boolean;
};

export type GodotDocumentationState = {
	schemaVersion: 2;
	enabled: boolean;
	documents: GodotDocumentationRecord[];
	activeJob: GodotDocumentationJob | null;
};

export type GodotDocumentationGenerationManifest = {
	schemaVersion: 1;
	indexFormatVersion: 1;
	generationId: string;
	branch: string;
	commitSha: string;
	sourceSha256: string | null;
	sqliteSha256: string;
	documentCount: number;
	chunkCount: number;
	classCount: number;
	sizeBytes: number;
	builtAt: string;
	verifiedAt: string;
};

export type GodotDocumentationSearchResult = {
	category: Exclude<GodotDocumentationScope, "all">;
	title: string;
	symbol: string | null;
	path: string;
	anchor: string | null;
	content: string;
	score: number;
	sourceUrl: string;
};

export type GodotDocumentationSearchResponse = {
	ok: boolean;
	code: string | null;
	selected: {
		branch: string;
		commitSha: string;
		projectVersion: string | null;
		reason: string;
	} | null;
	results: GodotDocumentationSearchResult[];
	truncated: boolean;
};
