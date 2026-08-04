import type { McpHost } from "../mcp/mcp-host.js";
import { evaluateToolCall, type ApprovalDecision, type ApprovalMode, type ToolRequiredConsent } from "./tool-policy.js";
import { getEffectiveToolPolicy } from "./tool-policy.js";
import { isPlanSafeDynamicMcpToolName } from "./dynamic-mcp-tools.js";
import { executeLlmToolWithIdempotency, getLlmToolExecutionIdentity } from "./tool-idempotency.js";
import type { FileEditBatchDraft } from "./file-edit-snapshots.js";
import type { ImageGenerationResult } from "../providers/image-generation.js";
import { commandRequiresUserApproval, isBoundedWorkspaceVerificationCommand, reviewWorkspaceCommand } from "./command-review.js";
import { createTerminalCommandAuthorization, type TerminalCommandAuthorization } from "../mcp/terminal/authorization.js";
import type { McpProgressNotification } from "../mcp/terminal/progress.js";
import { getGoalRunBinding } from "../server/goal-run-observer.js";
import { isGoalCheckpointCapableToolCall } from "./file-edit-snapshots.js";

export type PendingApproval = {
	approvalId: string;
	toolCallId: string;
	toolName: string;
	llmToolName: string;
	args: Record<string, unknown>;
	reason: string;
	createdAt: number;
	executionFingerprint?: string | undefined;
	workspaceId?: string | undefined;
	editorInstanceId?: string | undefined;
	sessionId?: string | undefined;
	requestId?: string | undefined;
	requiredConsent?: ToolRequiredConsent | undefined;
};

export type ApprovalResult =
	| { status: "executed"; content: string; cached?: boolean | undefined; fileEditDraft?: FileEditBatchDraft | undefined; imageGeneration?: ImageGenerationResult | undefined }
	| { status: "pending"; approval: PendingApproval }
	| { status: "denied"; reason: string };

export type ApprovalScope = {
	allowedToolNames: ReadonlySet<string>;
	maximumRisk?: "read" | "verify" | "propose" | undefined;
	allowApproval: boolean;
	baseGateway: ApprovalGateway;
};

export class ApprovalGateway {
	private pendingApprovals: Map<string, PendingApproval> = new Map();
	private mode: ApprovalMode;

	constructor(mode: ApprovalMode = "manual") {
		this.mode = mode;
	}

	setMode(mode: ApprovalMode): void {
		this.mode = mode;
	}

	getMode(): ApprovalMode {
		return this.mode;
	}

	listPending(): PendingApproval[] {
		return Array.from(this.pendingApprovals.values());
	}

	getPending(approvalId: string): PendingApproval | undefined {
		return this.pendingApprovals.get(approvalId);
	}

	replacePending(pendingApprovals: PendingApproval[]): void {
		this.pendingApprovals.clear();
		for (const pendingApproval of pendingApprovals) {
			this.pendingApprovals.set(pendingApproval.approvalId, pendingApproval);
		}
	}

	upsertPending(pendingApproval: PendingApproval): void {
		this.pendingApprovals.set(pendingApproval.approvalId, pendingApproval);
	}

	removePending(approvalId: string): PendingApproval | undefined {
		const pending: PendingApproval | undefined = this.pendingApprovals.get(approvalId);
		if (pending !== undefined) {
			this.pendingApprovals.delete(approvalId);
		}

		return pending;
	}

	async evaluate(
		llmToolName: string,
		args: Record<string, unknown>,
		toolCallId: string,
		workspaceId?: string | undefined,
		context: {
			requestId?: string | undefined;
			sessionId?: string | undefined;
			activeScenePath?: string | undefined;
		} = {}
	): Promise<ApprovalDecision> {
		const requestId: string | undefined = context.requestId;
		const goalBinding = requestId === undefined ? undefined : getGoalRunBinding(requestId);
		const effectiveMode: ApprovalMode = goalBinding?.approvalMode ?? this.mode;
		const risk = getEffectiveToolPolicy(llmToolName, args, workspaceId)?.risk;
		if (
			requestId !== undefined
			&& goalBinding !== undefined
			&& effectiveMode === "manual"
			&& (risk === "write" || risk === "destructive")
			&& !isGoalCheckpointCapableToolCall(llmToolName, args, {
				activeScenePath: context.activeScenePath
			})
		) {
			return {
				action: "request_approval",
				reason: "This Goal write cannot be included in a complete file rollback checkpoint. Continuing will make full Goal rollback unavailable."
			};
		}
		if (effectiveMode === "auto-safe" && llmToolName === "mcp_terminal_run_command") {
			const deterministicDecision: ApprovalDecision = evaluateToolCall(effectiveMode, llmToolName, args, workspaceId);
			if (
				deterministicDecision.action === "deny"
				|| (
					deterministicDecision.action === "request_approval"
					&& deterministicDecision.requiredConsent !== undefined
				)
			) {
				return deterministicDecision;
			}
			const hardRiskReason: string | null = commandRequiresUserApproval(args, workspaceId);
			if (hardRiskReason !== null) {
				return { action: "request_approval", reason: hardRiskReason };
			}
			const reviewInput = {
				toolCallId,
				requestId: context.requestId,
				sessionId: context.sessionId,
				workspaceId,
				commandLine: typeof args.commandLine === "string" ? args.commandLine : "",
				cwd: typeof args.cwd === "string" ? args.cwd : undefined,
				envKeys: args.env !== null && typeof args.env === "object" && !Array.isArray(args.env)
					? Object.keys(args.env as Record<string, unknown>).sort()
					: [],
				reason: typeof args.reason === "string" ? args.reason : undefined
			};
			const review = await reviewWorkspaceCommand(reviewInput);
			if (review.decision === "allow") {
				return { action: "allow", review: review.audit };
			}
			if (review.decision === "deny") {
				return { action: "deny", reason: review.reason, review: review.audit };
			}
			if (isBoundedWorkspaceVerificationCommand(reviewInput)) {
				const reason: string = typeof args.reason === "string" && args.reason.trim().length > 0
					? args.reason.trim()
					: "Run a bounded headless Godot verification inside the active workspace.";
				return {
					action: "allow",
					review: {
						source: "policy",
						decision: "allow",
						reason,
						provider: review.audit.provider,
						model: review.audit.model
					}
				};
			}
			return { action: "request_approval", reason: review.reason, review: review.audit };
		}
		return evaluateToolCall(effectiveMode, llmToolName, args, workspaceId);
	}

	requestApproval(
		llmToolName: string,
		args: Record<string, unknown>,
		toolCallId: string,
		reason: string,
		workspaceId?: string | undefined,
		editorInstanceId?: string | undefined,
		sessionId?: string | undefined,
		requiredConsent?: ToolRequiredConsent | undefined,
		requestId?: string | undefined
	): PendingApproval {
		const executionScope: string = workspaceId ?? "workspace:none";
		const executionFingerprint: string | undefined = getLlmToolExecutionIdentity(llmToolName, args, executionScope, workspaceId)?.fingerprint;
		if (executionFingerprint !== undefined) {
			for (const pendingApproval of this.pendingApprovals.values()) {
				if (pendingApproval.executionFingerprint === executionFingerprint) {
					return pendingApproval;
				}
			}
		}

		const approvalId: string = `approval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

		const pending: PendingApproval = {
			approvalId,
			toolCallId,
			toolName: llmToolName,
			llmToolName,
			args,
			reason,
			createdAt: Date.now(),
			executionFingerprint,
			workspaceId,
			editorInstanceId,
			sessionId,
			requestId,
			requiredConsent
		};

		this.pendingApprovals.set(approvalId, pending);
		return pending;
	}

	async approve(approvalId: string, mcpHost: McpHost, options: {
		abortSignal?: AbortSignal | undefined;
		onProgress?: ((progress: McpProgressNotification) => void) | undefined;
	} = {}): Promise<{ content: string; cached?: boolean | undefined; fileEditDraft?: FileEditBatchDraft | undefined; imageGeneration?: ImageGenerationResult | undefined }> {
		const pending: PendingApproval | undefined = this.pendingApprovals.get(approvalId);

		if (!pending) {
			throw new Error(`Approval not found: ${approvalId}`);
		}
		// 审批决定不可重试；先消费再执行，避免超时后把同一审批重新弹给用户。
		this.pendingApprovals.delete(approvalId);

		const commandAuthorization: TerminalCommandAuthorization | undefined = pending.llmToolName === "mcp_terminal_run_command"
			? createTerminalCommandAuthorization({
				source: "user",
				requestId: pending.requestId ?? pending.toolCallId,
				toolCallId: pending.toolCallId,
				workspaceId: pending.workspaceId,
				args: pending.args
			})
			: undefined;
		const result = await executeLlmToolWithIdempotency(
			mcpHost,
			pending.llmToolName,
			pending.args,
			pending.workspaceId,
			pending.editorInstanceId,
			pending.sessionId,
			options.abortSignal,
			commandAuthorization,
			false,
			options.onProgress
		);
		return { content: result.content, cached: result.reused, fileEditDraft: result.fileEditDraft, imageGeneration: result.imageGeneration };
	}

	reject(approvalId: string): PendingApproval {
		const pending: PendingApproval | undefined = this.pendingApprovals.get(approvalId);

		if (!pending) {
			throw new Error(`Approval not found: ${approvalId}`);
		}

		this.pendingApprovals.delete(approvalId);
		return pending;
	}
}

export class ReadOnlyToolApprovalGateway extends ApprovalGateway {
	private readonly allowedToolNames: ReadonlySet<string>;
	private readonly baseGateway: ApprovalGateway;
	readonly scope: ApprovalScope;

	constructor(baseGateway: ApprovalGateway, allowedToolNames: readonly string[]) {
		super(baseGateway.getMode());
		this.baseGateway = baseGateway;
		this.allowedToolNames = new Set(allowedToolNames);
		this.scope = {
			allowedToolNames: this.allowedToolNames,
			maximumRisk: "verify",
			allowApproval: false,
			baseGateway
		};
	}

	override setMode(mode: ApprovalMode): void {
		this.baseGateway.setMode(mode);
	}

	override getMode(): ApprovalMode {
		return this.baseGateway.getMode();
	}

	override listPending(): PendingApproval[] {
		return this.baseGateway.listPending();
	}

	override getPending(approvalId: string): PendingApproval | undefined {
		return this.baseGateway.getPending(approvalId);
	}

	override replacePending(pendingApprovals: PendingApproval[]): void {
		this.baseGateway.replacePending(pendingApprovals);
	}

	override upsertPending(pendingApproval: PendingApproval): void {
		this.baseGateway.upsertPending(pendingApproval);
	}

	override removePending(approvalId: string): PendingApproval | undefined {
		return this.baseGateway.removePending(approvalId);
	}

	override async evaluate(
		llmToolName: string,
		args: Record<string, unknown>,
		_toolCallId: string,
		workspaceId?: string | undefined
	): Promise<ApprovalDecision> {
		if (!this.allowedToolNames.has(llmToolName)) {
			return {
				action: "deny",
				reason: `只读上下文只允许显式授权的 read/verify 工具: ${llmToolName}`
			};
		}
		if (isPlanSafeDynamicMcpToolName(llmToolName, workspaceId)) {
			return { action: "allow" };
		}

		const policy = getEffectiveToolPolicy(llmToolName, args, workspaceId);
		if (policy?.risk === "read" || policy?.risk === "verify") {
			return { action: "allow" };
		}

		return {
			action: "deny",
			reason: `只读上下文禁止 ${policy?.risk ?? "unknown"} 风险工具: ${llmToolName}`
		};
	}

	override requestApproval(
		_llmToolName: string,
		_args: Record<string, unknown>,
		_toolCallId: string,
		_reason: string,
		_workspaceId?: string | undefined,
		_editorInstanceId?: string | undefined,
		_sessionId?: string | undefined,
		_requiredConsent?: ToolRequiredConsent | undefined,
		_requestId?: string | undefined
	): PendingApproval {
		throw new Error("只读上下文不允许触发人工审批。");
	}
}
