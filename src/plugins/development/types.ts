import { z } from "zod";

export const PLUGIN_DEVELOPMENT_TOOL_NAMES = [
	"mcp_plugin_dev_prepare",
	"mcp_plugin_dev_apply",
	"mcp_plugin_dev_validate",
	"mcp_plugin_dev_install",
	"mcp_plugin_dev_test"
] as const;

export type PluginDevelopmentToolName = typeof PLUGIN_DEVELOPMENT_TOOL_NAMES[number];
export const PLUGIN_DEVELOPMENT_TOOL_NAME_SET: ReadonlySet<string> = new Set(PLUGIN_DEVELOPMENT_TOOL_NAMES);
export type PluginDevelopmentScope = "workspace" | "personal";

export type PluginDevelopmentDiagnostic = {
	code: string;
	message: string;
	severity: "info" | "error" | "warning";
	stage: "static" | "sandbox" | "registration" | "test" | "protocol" | "timeout" | "cleanup";
	retryable: boolean;
	path?: string | undefined;
	caseId?: string | undefined;
	capability?: string | undefined;
	hint?: string | undefined;
	details?: Record<string, string> | undefined;
};

export type PluginDevelopmentFile = {
	path: string;
	content: string;
};

export type PluginDevelopmentSnapshot = {
	slug: string;
	scope: PluginDevelopmentScope;
	sourceFolderId?: string | undefined;
	expectedRevision?: string | undefined;
	files: PluginDevelopmentFile[];
};

export type PluginDevelopmentProposal = {
	proposalToken: string;
	currentRevision: string | null;
	proposedRevision: string;
	diagnostics: PluginDevelopmentDiagnostic[];
	capabilitySummary: Record<string, number>;
	targetDisplayPath: string;
};

export type PluginDevelopmentTestCase = {
	id: string;
	capability: "registry" | "tool" | "skill" | "hook" | "mcp" | "command" | "context_provider" | "panel" | "settings" | "timeline_part" | "browser" | "language_service" | "event";
	target: string;
	input?: Record<string, unknown> | undefined;
	expect?: {
		ok?: boolean | undefined;
		contains?: string | undefined;
		registered?: boolean | undefined;
	} | undefined;
};

export type PluginDevelopmentTestPlan = {
	version: 1;
	cases: PluginDevelopmentTestCase[];
};

export type PluginDevelopmentTestResult = {
	runId: string;
	ok: boolean;
	pluginId: string;
	revision: string;
	durationMs: number;
	sandbox: {
		available: boolean;
		mode: "windows-helper" | "bubblewrap" | "sandbox-exec" | "unavailable";
		network: "disabled";
		workspaceDisplay: string;
	};
	passed: number;
	failed: number;
	cases: Array<{
		id: string;
		capability: PluginDevelopmentTestCase["capability"];
		target?: string;
		status: "passed" | "failed" | "skipped";
		durationMs: number;
		message?: string;
		code?: string;
		retryable: boolean;
	}>;
	diagnostics: PluginDevelopmentDiagnostic[];
};

export type PluginDevelopmentPhase = "idle" | "preparing" | "validating" | "awaiting_install" | "awaiting_trust" | "testing" | "passed" | "failed" | "exhausted" | "cancelled" | "interrupted";

export type PluginDevelopmentStatus = {
	slug: string;
	revision: string;
	phase: PluginDevelopmentPhase;
	staticAttempt: number;
	runtimeAttempt: number;
	staticAttemptsRemaining: number;
	runtimeAttemptsRemaining: number;
	lastDiagnostics: PluginDevelopmentDiagnostic[];
	lastTest?: PluginDevelopmentTestResult | undefined;
	updatedAt: string;
};

export type PluginDevelopmentRecord = {
	slug: string;
	rootPath: string;
	packageName: string;
	scope: PluginDevelopmentScope;
	workspaceId?: string | undefined;
	sourceFolderId?: string | undefined;
	revision: string;
	updatedAt: string;
	lastSessionId: string;
};

const relativeFilePathSchema = z.string().min(1).max(240).refine((value): boolean => {
	if (value.includes("\\") || value.startsWith("/") || /^[a-z]:/iu.test(value)) return false;
	return !value.split("/").some((segment): boolean => segment.length === 0 || segment === "." || segment === "..");
}, "Plugin file paths must be normalized relative paths.");

export const pluginDevelopmentSnapshotSchema = z.object({
	slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u),
	scope: z.enum(["workspace", "personal"]),
	sourceFolderId: z.string().min(1).max(128).optional(),
	expectedRevision: z.string().length(64).optional(),
	files: z.array(z.object({
		path: relativeFilePathSchema,
		content: z.string().max(262_144)
	}).strict()).min(5).max(64)
}).strict();

export const pluginDevelopmentTestPlanSchema = z.object({
	version: z.literal(1),
	cases: z.array(z.object({
		id: z.string().min(1).max(64),
		capability: z.enum(["registry", "tool", "skill", "hook", "mcp", "command", "context_provider", "panel", "settings", "timeline_part", "browser", "language_service", "event"]),
		target: z.string().min(1).max(240),
		input: z.record(z.string(), z.unknown()).optional(),
		expect: z.object({
			ok: z.boolean().optional(),
			contains: z.string().max(1024).optional(),
			registered: z.boolean().optional()
		}).strict().optional()
	}).strict()).min(1).max(64)
}).strict();

export type PluginDevelopmentControlContext = {
	execute: (
		toolName: PluginDevelopmentToolName,
		args: Record<string, unknown>,
		abortSignal?: AbortSignal | undefined
	) => Promise<Record<string, unknown>>;
};
