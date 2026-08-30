import type { McpHost } from "../mcp/mcp-host.js";
import { evaluateToolCall, isSandboxedProcessToolName, type ApprovalDecision, type ApprovalMode, type ToolRequiredConsent } from "./tool-policy.js";
import { getEffectiveToolPolicy } from "./tool-policy.js";
import { isPlanSafeDynamicMcpToolName } from "./dynamic-mcp-tools.js";
import { executeLlmToolWithIdempotency, getLlmToolExecutionIdentity } from "./tool-idempotency.js";
import type { FileEditBatchDraft } from "./file-edit-snapshots.js";
import type { ImageGenerationResult } from "../providers/image-generation.js";
import { commandRequiresUserApproval, reviewWorkspaceCommand } from "./command-review.js";
import { createTerminalCommandAuthorization, type TerminalCommandAuthorization } from "../mcp/terminal/authorization.js";
import type { McpProgressNotification } from "../mcp/terminal/progress.js";
import { getGoalRunBinding } from "../server/goal-run-observer.js";
import { isGoalCheckpointCapableToolCall } from "./file-edit-snapshots.js";
import { createToolFailure, serializeToolFailure } from "./tool-failure.js";
import {
	createDownloadAuthorizationScope,
	createDownloadFingerprint,
	createNetworkAccessRequired,
	getDownloadRequest,
	isTerminalDownloadCommand,
	type DownloadAuthorizationScope,
	type NetworkAccessRequired
} from "./download-authorization.js";
import {
	CROSS_WORKSPACE_UNSANDBOXED_CONSENT_PREFIX,
	getSandboxAvailability,
	UNSANDBOXED_CONSENT_TEXT,
	type SandboxAvailability
} from "../mcp/terminal/sandbox-runner.js";

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
	approvalKind?: "network_download" | undefined;
	downloadAuthorization?: DownloadAuthorizationScope | undefined;
	networkAccessRequired?: NetworkAccessRequired | undefined;
};

export type ApprovalRequestOptions = {
	approvalKind?: "network_download" | undefined;
	downloadAuthorization?: DownloadAuthorizationScope | undefined;
	networkAccessRequired?: NetworkAccessRequired | undefined;
};

function collectApprovalArtifactRefs(args: Record<string, unknown>): string[] {
	return ["relativePath", "resourcePath", "scenePath", "scriptPath", "path"]
		.map((key: string): unknown => args[key])
		.filter((value: unknown): value is string => typeof value === "string" && value.length > 0);
}

export type ApprovalGatewayOptions = {
	reviewCommand?: typeof reviewWorkspaceCommand | undefined;
	resolveSandboxAvailability?: (() => SandboxAvailability) | undefined;
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
	private downloadAuthorizations: Map<string, Map<string, DownloadAuthorizationScope>> = new Map();
	private mode: ApprovalMode;
	private readonly reviewCommand: typeof reviewWorkspaceCommand;
	private readonly resolveSandboxAvailability: () => SandboxAvailability;

	constructor(mode: ApprovalMode = "manual", options: ApprovalGatewayOptions = {}) {
		this.mode = mode;
		this.reviewCommand = options.reviewCommand ?? reviewWorkspaceCommand;
		this.resolveSandboxAvailability = options.resolveSandboxAvailability ?? getSandboxAvailability;
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

	hasDownloadAuthorization(requestId: string | undefined, fingerprint: string): boolean {
		if (requestId === undefined) return false;
		return this.downloadAuthorizations.get(requestId)?.has(fingerprint) === true;
	}

	grantDownloadAuthorization(scope: DownloadAuthorizationScope | undefined): void {
		if (scope === undefined) return;
		const grants = this.downloadAuthorizations.get(scope.requestId) ?? new Map<string, DownloadAuthorizationScope>();
		for (const fingerprint of scope.fingerprints) {
			grants.set(fingerprint, scope);
		}
		this.downloadAuthorizations.set(scope.requestId, grants);
	}

	replaceDownloadAuthorizations(scopes: readonly DownloadAuthorizationScope[]): void {
		this.downloadAuthorizations.clear();
		for (const scope of scopes) {
			this.grantDownloadAuthorization(scope);
		}
	}

	clearDownloadAuthorizations(requestId: string): void {
		this.downloadAuthorizations.delete(requestId);
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
			computerAuthorized?: boolean | undefined;
		} = {}
	): Promise<ApprovalDecision> {
		const requestId: string | undefined = context.requestId;
		const goalBinding = requestId === undefined ? undefined : getGoalRunBinding(requestId);
		const effectiveMode: ApprovalMode = goalBinding?.approvalMode ?? this.mode;
		if (llmToolName === "mcp_computer_action") {
			return context.computerAuthorized === true && goalBinding === undefined
				? { action: "allow" }
				: { action: "deny", reason: "computer_consent_required", code: "computer_consent_required" };
		}
		if (llmToolName === "mcp_workspace_download_file") {
			const download = getDownloadRequest(args);
			if (download === null) {
				return { action: "deny", reason: "Invalid structured workspace download request." };
			}
			if (effectiveMode === "full-trust") {
				return { action: "allow" };
			}
			const fingerprint: string = createDownloadFingerprint(download);
			if (effectiveMode === "auto-safe" && this.hasDownloadAuthorization(requestId, fingerprint)) {
				return { action: "allow" };
			}
			return {
				action: "request_approval",
				reason: `Download ${download.dependency} to [${download.sourceFolderId}] ${download.relativePath}. This only downloads the file; it does not install or run it.`,
				approvalKind: "network_download",
				downloadAuthorization: createDownloadAuthorizationScope(args, requestId, workspaceId),
				...(workspaceId === undefined ? {} : { networkAccessRequired: createNetworkAccessRequired(download, workspaceId) })
			};
		}
		if (
			llmToolName === "mcp_terminal_run_command"
			&& effectiveMode !== "full-trust"
			&& isTerminalDownloadCommand(args)
		) {
			return {
				action: "deny",
				code: "network_access_required",
				reason: "Network downloads in terminal commands require explicit download approval. Use mcp_workspace_download_file with a structured URL and workspace target instead."
			};
		}
		if (effectiveMode !== "full-trust" && isSandboxedProcessToolName(llmToolName)) {
			const availability: SandboxAvailability = this.resolveSandboxAvailability();
			if (!availability.available) {
				const deterministicDecision: ApprovalDecision = evaluateToolCall(
					effectiveMode,
					llmToolName,
					args,
					workspaceId
				);
				if (deterministicDecision.action === "deny") {
					return deterministicDecision;
				}
				const existingConsent: ToolRequiredConsent | undefined = deterministicDecision.action === "request_approval"
					? deterministicDecision.requiredConsent
					: undefined;
				const crossWorkspaceTarget: string | undefined = existingConsent?.expectedText.startsWith("ALLOW CROSS-WORKSPACE: ") === true
					? existingConsent.expectedText.slice("ALLOW CROSS-WORKSPACE: ".length)
					: undefined;
				const requiredConsent: ToolRequiredConsent = crossWorkspaceTarget === undefined
					? {
						prompt: `The OS sandbox is unavailable. Running this process directly can access files and system resources outside the workspace. ${availability.error}`,
						expectedText: UNSANDBOXED_CONSENT_TEXT
					}
					: {
						prompt: `${existingConsent!.prompt} The OS sandbox is also unavailable, so this process would run directly on the host. ${availability.error}`,
						expectedText: `${CROSS_WORKSPACE_UNSANDBOXED_CONSENT_PREFIX}${crossWorkspaceTarget}`
					};
				return {
					action: "request_approval",
					reason: "The OS sandbox is unavailable. Explicit one-shot consent is required before running this process without isolation.",
					requiredConsent
				};
			}
		}
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
			const review = await this.reviewCommand(reviewInput);
			if (review.decision === "allow") {
				return { action: "allow", review: review.audit };
			}
			if (review.decision === "ask_user") {
				return { action: "request_approval", reason: review.reason, review: review.audit };
			}
			if (review.decision === "deny") {
				return { action: "deny", reason: review.reason, review: review.audit };
			}
			return { action: "deny", reason: review.reason, review: review.audit };
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
		requestId?: string | undefined,
		options: ApprovalRequestOptions = {}
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
			requiredConsent,
			approvalKind: options.approvalKind,
			downloadAuthorization: options.downloadAuthorization,
			networkAccessRequired: options.networkAccessRequired
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
		this.grantDownloadAuthorization(pending.downloadAuthorization);

		const commandAuthorization: TerminalCommandAuthorization | undefined = isSandboxedProcessToolName(pending.llmToolName)
			? createTerminalCommandAuthorization({
				source: "user",
				requestId: pending.requestId ?? pending.toolCallId,
				toolCallId: pending.toolCallId,
				workspaceId: pending.workspaceId,
				args: pending.args
			})
			: undefined;
		try {
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
		} catch (error: unknown) {
			if (options.abortSignal?.aborted) {
				throw error;
			}
			const failure = createToolFailure(error, {
				artifactRefs: collectApprovalArtifactRefs(pending.args),
				sourceFolderId: typeof pending.args.sourceFolderId === "string" ? pending.args.sourceFolderId : undefined
			});
			return { content: serializeToolFailure(failure), cached: false };
		}
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
	private readonly delegatedToolNames: ReadonlySet<string>;
	private readonly baseGateway: ApprovalGateway;
	readonly scope: ApprovalScope;

	constructor(
		baseGateway: ApprovalGateway,
		allowedToolNames: readonly string[],
		options: { delegatedToolNames?: readonly string[] | undefined } = {}
	) {
		super(baseGateway.getMode());
		this.baseGateway = baseGateway;
		this.allowedToolNames = new Set(allowedToolNames);
		this.delegatedToolNames = new Set(options.delegatedToolNames ?? []);
		this.scope = {
			allowedToolNames: this.allowedToolNames,
			maximumRisk: "verify",
			allowApproval: this.delegatedToolNames.size > 0,
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
		toolCallId: string,
		workspaceId?: string | undefined,
		context: {
			requestId?: string | undefined;
			sessionId?: string | undefined;
			activeScenePath?: string | undefined;
			computerAuthorized?: boolean | undefined;
		} = {}
	): Promise<ApprovalDecision> {
		if (!this.allowedToolNames.has(llmToolName)) {
			return {
				action: "deny",
				reason: `Read-only context permits only explicitly allowed read/verify tools: ${llmToolName}`
			};
		}
		if (this.delegatedToolNames.has(llmToolName)) {
			return this.baseGateway.evaluate(llmToolName, args, toolCallId, workspaceId, context);
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
			reason: `Read-only context does not permit ${policy?.risk ?? "unknown"}-risk tools: ${llmToolName}`
		};
	}

	override requestApproval(
		llmToolName: string,
		args: Record<string, unknown>,
		toolCallId: string,
		reason: string,
		workspaceId?: string | undefined,
		editorInstanceId?: string | undefined,
		sessionId?: string | undefined,
		requiredConsent?: ToolRequiredConsent | undefined,
		requestId?: string | undefined,
		options: ApprovalRequestOptions = {}
	): PendingApproval {
		if (this.delegatedToolNames.has(llmToolName) && this.allowedToolNames.has(llmToolName)) {
			return this.baseGateway.requestApproval(
				llmToolName,
				args,
				toolCallId,
				reason,
				workspaceId,
				editorInstanceId,
				sessionId,
				requiredConsent,
				requestId,
				options
			);
		}
		throw new Error("Read-only context cannot request manual approval.");
	}

	override hasDownloadAuthorization(requestId: string | undefined, fingerprint: string): boolean {
		return this.baseGateway.hasDownloadAuthorization(requestId, fingerprint);
	}

	override grantDownloadAuthorization(scope: DownloadAuthorizationScope | undefined): void {
		this.baseGateway.grantDownloadAuthorization(scope);
	}

	override replaceDownloadAuthorizations(scopes: readonly DownloadAuthorizationScope[]): void {
		this.baseGateway.replaceDownloadAuthorizations(scopes);
	}

	override clearDownloadAuthorizations(requestId: string): void {
		this.baseGateway.clearDownloadAuthorizations(requestId);
	}
}
