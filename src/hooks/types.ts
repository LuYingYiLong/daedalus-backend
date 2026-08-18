import type { WorkspaceConfig } from "../workspace/types.js";

export const HOOK_EVENT_NAMES = [
	"SessionStart",
	"SessionEnd",
	"UserPromptSubmit",
	"PreToolUse",
	"PermissionRequest",
	"PostToolUse",
	"PreCompact",
	"PostCompact",
	"Stop"
] as const;

export type HookEventName = typeof HOOK_EVENT_NAMES[number];
export type HookFailurePolicy = "continue" | "block";
export type HookConfigScope = "global" | "source";

export type HookCommandHandler = {
	type: "command";
	command: string;
	commandWindows?: string | undefined;
	timeout?: number | undefined;
	statusMessage?: string | undefined;
	additionalContextLimit?: number | undefined;
	async?: boolean | undefined;
	failurePolicy?: HookFailurePolicy | undefined;
};

export type HookMatcherGroup = {
	matcher?: string | undefined;
	hooks: HookCommandHandler[];
};

export type HooksConfig = {
	description?: string | undefined;
	hooks: Partial<Record<HookEventName, HookMatcherGroup[]>>;
};

export type HookConfigSource = {
	id: string;
	scope: HookConfigScope;
	path: string;
	workspaceId?: string | undefined;
	sourceFolderId?: string | undefined;
	displayName: string;
	rootPath: string;
};

export type HookHandlerSummary = {
	event: HookEventName;
	matcher: string;
	index: number;
	handlerIndex: number;
	command: string;
	commandWindows?: string | undefined;
	statusMessage?: string | undefined;
	async: boolean;
	failurePolicy: HookFailurePolicy;
	fingerprint: string;
	trust: "trusted" | "disabled" | "review_required";
};

export type HookConfigDocument = {
	source: HookConfigSource;
	exists: boolean;
	content: string;
	revision: string;
	valid: boolean;
	errors: string[];
	description?: string | undefined;
	handlers: HookHandlerSummary[];
};

export type HookPermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export type HookCommonInput = {
	session_id: string;
	turn_id?: string | undefined;
	transcript_path: null;
	cwd: string;
	hook_event_name: HookEventName;
	model: string;
	permission_mode: HookPermissionMode;
	daedalus_approval_mode: "manual" | "auto-safe" | "full-trust";
	workspace_id?: string | undefined;
	source_folder_id?: string | undefined;
	[key: string]: unknown;
};

export type HookInvocationContext = {
	sessionId: string;
	turnId?: string | undefined;
	model: string;
	approvalMode: "manual" | "auto-safe" | "full-trust";
	chatMode?: "agent" | "ask" | "plan" | "goal" | undefined;
	workspace?: WorkspaceConfig | undefined;
	targetSourceFolderId?: string | undefined;
	abortSignal?: AbortSignal | undefined;
};

export type HookRunRequest = HookInvocationContext & {
	event: HookEventName;
	matcherValue?: string | undefined;
	input: Record<string, unknown>;
};

export type HookDecision = {
	blocked: boolean;
	reason?: string | undefined;
	continueTurn?: boolean | undefined;
	updatedInput?: Record<string, unknown> | undefined;
	additionalContext?: string | undefined;
	systemMessages: string[];
	approved?: boolean | undefined;
};

export type HookRunRecord = {
	id: string;
	sessionId: string;
	turnId?: string | undefined;
	event: HookEventName;
	sourceId: string;
	fingerprint: string;
	status: "completed" | "blocked" | "failed" | "timed_out" | "cancelled" | "queued";
	startedAt: string;
	durationMs: number;
	exitCode: number | null;
	async: boolean;
	message?: string | undefined;
	stderr?: string | undefined;
};

export type HookRuntimeEvent = {
	statusMessage?: string | undefined;
	systemMessage?: string | undefined;
	record?: HookRunRecord | undefined;
};
