import type { PluginDevelopmentDiagnostic, PluginDevelopmentTestResult } from "../development/types.js";
import type { PluginSource } from "../types.js";

export type PluginMaintenanceKind = "update" | "test" | "changelog" | "release" | "publish";
export type PluginMaintenanceStage = "preflight" | "staging" | "static_validation" | "sandbox_test" | "changelog_draft" | "artifact" | "awaiting_confirmation" | "publishing" | "completed" | "failed" | "cancelled";

export type PluginMaintenanceOperation = {
	id: string;
	pluginId: string;
	kind: PluginMaintenanceKind;
	stage: PluginMaintenanceStage;
	progress?: number;
	expectedFingerprint?: string;
	status: "running" | "awaiting_confirmation" | "succeeded" | "failed" | "cancelled";
	error?: string;
	startedAt: string;
	updatedAt: string;
};

export type PluginDevelopmentRunRecord = {
	runId: string;
	pluginId: string;
	revision: string;
	trigger: "creator" | "update" | "release" | "manual";
	result: PluginDevelopmentTestResult;
	diagnostics: PluginDevelopmentDiagnostic[];
	createdAt: string;
};

export type PluginChangelogSections = {
	added: string[];
	changed: string[];
	fixed: string[];
	security: string[];
	tests: string[];
};

export type PluginChangelogDraft = {
	id: string;
	pluginId?: string;
	sourceRoot: string;
	packageName: string;
	fromVersion: string | null;
	toVersion: string;
	expectedRevision: string;
	generatedAt: string;
	generator: "deterministic" | "ai-assisted";
	sections: PluginChangelogSections;
	proposedText: string;
	accepted: boolean;
};

export type PluginReleaseArtifact = {
	path: string;
	displayPath: string;
	sha256: string;
	byteSize: number;
};

export type PluginReleasePreview = {
	pluginId?: string;
	sourceRoot: string;
	packageName: string;
	currentVersion: string;
	nextVersion: string;
	changelogDraft: PluginChangelogDraft;
	changedFiles: string[];
	capabilityChanges: Record<string, number>;
	testSummary: { required: boolean; passed: boolean; runId?: string };
	artifact?: PluginReleaseArtifact;
	warnings: string[];
	blockers: string[];
};

export type PluginUpdatePreview = {
	pluginId: string;
	expectedFingerprint: string;
	source: PluginSource;
	packageName: string;
	currentVersion: string;
	nextVersion: string;
	contentHash: string;
	fingerprint: string;
	testRequired: boolean;
	warnings: string[];
	blockers: string[];
};
