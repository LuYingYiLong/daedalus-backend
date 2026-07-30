export type GodotDocumentationScope = "all" | "class_reference" | "manual";

export type GodotDocumentationRecord = {
	id: string;
	branch: string;
	commitSha: string;
	installedAt: string;
	updatedAt: string;
	documentCount: number;
	chunkCount: number;
	classCount: number;
	sizeBytes: number;
};

export type GodotDocumentationSettings = {
	schemaVersion: 1;
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
	| "finalizing"
	| "completed"
	| "failed"
	| "cancelled";

export type GodotDocumentationJob = {
	jobId: string;
	operation: "install" | "update";
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
	schemaVersion: 1;
	enabled: boolean;
	documents: GodotDocumentationRecord[];
	activeJob: GodotDocumentationJob | null;
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
