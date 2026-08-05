import type { AdditionalContextItem, AiChatParams, ChatMessage, PromptId } from "../protocol/types.js";
import type { SkillId } from "../skills/registry.js";
import type { ToolBudgetLevel } from "../tools/llm-tool-budget.js";
import type { WorkflowExecutionProfileId } from "./execution-profile.js";

export type WorkflowPhaseId = string;

export type WorkflowTodoStatus = "pending" | "running" | "done" | "failed" | "paused";

export type WorkflowSource = "fixed" | "llm" | "godot_template" | "slash";

export type WorkflowToolGroup = "read" | "write" | "verify" | "summarize";

export type WorkflowPhaseOutcomeStatus = "completed" | "needs_fix" | "blocked" | "approval_required" | "failed";

export type WorkflowFailedCheck = {
	code: string;
	message: string;
	toolCallId?: string | undefined;
	toolName?: string | undefined;
	artifact?: string | undefined;
	severity?: string | undefined;
};

export type WorkflowToolObservation = {
	toolCallId: string;
	toolName: string;
	risk?: string | undefined;
	status: "called" | "approval_required" | "succeeded" | "failed";
	argsSummary?: Record<string, unknown> | undefined;
	parsedResult?: Record<string, unknown> | undefined;
	error?: string | undefined;
	artifactRefs?: string[] | undefined;
	/** 成功写入且内容实际变化的文件指纹，仅用于自动修复进展判定。 */
	fileEditFingerprints?: string[] | undefined;
};

export type WorkflowCompletionTarget =
	| {
		kind: "artifact";
		path: string;
	}
	| {
		kind: "project_setting";
		key: string;
	};

export type WorkflowCompletionContract = {
	targets: WorkflowCompletionTarget[];
	requireAll: boolean;
};

export type WorkflowPhase = {
	id: WorkflowPhaseId;
	title: string;
	toolGroup?: WorkflowToolGroup | undefined;
	skillId?: SkillId | undefined;
	promptId?: PromptId | undefined;
	toolBudget: ToolBudgetLevel;
	allowedTools: string[];
	instruction: string;
	acceptanceCriteria?: string[] | undefined;
	completionContract?: WorkflowCompletionContract | undefined;
	requireToolCallOnFirstStep?: boolean | undefined;
	repairOf?: string | undefined;
	repairRound?: number | undefined;
};

export type WorkflowTodoItem = {
	id: string;
	phaseId: WorkflowPhaseId;
	text: string;
	status: WorkflowTodoStatus;
};

export type WorkflowPlan = {
	id: string;
	title: string;
	phases: WorkflowPhase[];
	todos: WorkflowTodoItem[];
	source?: WorkflowSource | undefined;
	revision?: number | undefined;
	maxRevisions?: number | undefined;
	executionProfile?: WorkflowExecutionProfileId | undefined;
};

export type WorkflowPhaseOutput = {
	phaseId: WorkflowPhaseId;
	phaseRunId: string;
	title: string;
	status: WorkflowPhaseOutcomeStatus;
	summary: string;
	evidence: string[];
	failedChecks: WorkflowFailedCheck[];
	requiredFixes: string[];
	modifiedArtifacts: string[];
	verifiedArtifacts: string[];
	toolObservations: WorkflowToolObservation[];
	verificationStatus?: "verified" | "unverified" | undefined;
	warnings?: string[] | undefined;
	text?: string | undefined;
	sourcePhaseId?: WorkflowPhaseId | undefined;
	blockedReason?: string | undefined;
};

export type WorkflowRunState = {
	plan: WorkflowPlan;
	phaseIndex: number;
	phaseOutputs: WorkflowPhaseOutput[];
	originalParams: AiChatParams;
	history: ChatMessage[];
	historyBudgetTokens: number;
	planningContext?: string | undefined;
	guidePromptSection?: string | undefined;
	activePhaseRunId?: string | undefined;
	capturedAttachments?: AdditionalContextItem[] | undefined;
};

export type WorkflowTodoSnapshot = {
	workflowId: string;
	title: string;
	source?: WorkflowSource | undefined;
	revision?: number | undefined;
	phases: Array<{
		id: WorkflowPhaseId;
		title: string;
		status: WorkflowTodoStatus;
	}>;
	todos: WorkflowTodoItem[];
	phaseOutcomes?: WorkflowPhaseOutput[] | undefined;
	activePhaseRunId?: string | undefined;
	repairRound?: number | undefined;
	blockedReason?: string | undefined;
};
