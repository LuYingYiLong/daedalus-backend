import type { ChatCompletionMessageToolCall, ChatCompletionToolMessageParam } from "openai/resources/chat/completions";
import type { McpHost } from "../mcp/mcp-host.js";
import { type ApprovalGateway, type PendingApproval } from "./approval-gateway.js";
import type { ToolRequiredConsent, ToolReviewAudit } from "./tool-policy.js";
import { describeToolEvent, type ToolEventDisplay } from "./tool-event-describer.js";
import { executeLlmToolWithIdempotency } from "./tool-idempotency.js";
import type { IdempotentToolExecutionResult } from "./tool-idempotency.js";
import { parseToolResultSummary, type ParsedToolResultSummary } from "./tool-result-parser.js";
import type { FileEditBatchDraft } from "./file-edit-snapshots.js";
import type { ImageGenerationResult } from "../providers/image-generation.js";
import type { ProviderToolImageReference } from "../providers/tool-image-reference.js";
import type { ToolExecutionContext } from "./tool-catalog.js";
import { logger } from "../logger.js";
import { getApprovalReasonFromArgs, stripApprovalReasonArg } from "./approval-reason.js";
import { createTerminalCommandAuthorization, type TerminalCommandAuthorization } from "../mcp/terminal/authorization.js";
import { parseTerminalMcpProgress, type TerminalOutputDelta } from "../mcp/terminal/progress.js";
import {
	EXECUTION_CONTROL_TOOL_NAME,
	ExecutionDecisionSignal,
	parseExecutionDecision
} from "./execution-control.js";
import type { ProviderReconnectEvent } from "../providers/provider-types.js";
import type { ToolApplicabilityCode } from "./tool-applicability.js";
import { WorkspaceSourceResolutionError } from "../workspace/source-context.js";

export type ToolEvent =
	| { type: "ai.delta"; text: string }
	| { type: "ai.thinking.delta"; text: string }
	| { type: "ai.thinking.done" }
	| ({ type: "provider.reconnect" } & ProviderReconnectEvent)
	/** 模型流已明确工具调用，但参数流尚未结束；只用于即时 UI 反馈，不代表已执行。 */
	| ({ type: "tool.preparing"; step: number; toolCallId: string; toolName: string; args: Record<string, unknown> } & ToolEventDisplay)
	| ({ type: "tool.call"; step: number; toolCallId: string; toolName: string; args: Record<string, unknown> } & ToolEventDisplay)
	| ({ type: "tool.progress"; step: number; toolCallId: string; toolName: string } & ToolProgressUpdate)
	| ({ type: "tool.result"; step: number; toolCallId: string; toolName: string; resultChars: number; truncated: boolean; cached?: boolean; fileEditDraft?: FileEditBatchDraft | undefined; imageGeneration?: ImageGenerationResult | undefined } & ParsedToolResultSummary)
	| { type: "tool.error"; step: number; toolCallId: string; toolName: string; message: string }
	| { type: "tool.reviewed"; step: number; toolCallId: string; toolName: string; decision: "allow" | "ask_user" | "deny"; reason: string; authorizationSource: ToolReviewAudit["source"]; provider?: string | undefined; model?: string | undefined }
	| ({ type: "tool.approval_required"; step: number; toolCallId: string; toolName: string; approvalId: string; reason: string; args: Record<string, unknown>; requiredConsent?: ToolRequiredConsent | undefined } & ToolEventDisplay);

export type OnToolEvent = (event: ToolEvent) => void;

const FULL_RESULT_ENRICHMENT_TOOLS: ReadonlySet<string> = new Set([
	"mcp_godot_editor_capture_scene_view",
	"mcp_image_inspect"
]);

export type DispatchedToolResult = ChatCompletionToolMessageParam & {
	imageReferences?: ProviderToolImageReference[] | undefined;
};

export type ToolProgressUpdate = {
	status: "message" | "success" | "error";
	title: string;
	details: string;
	code: string;
	terminalOutputDelta?: TerminalOutputDelta | undefined;
};

export type ToolResultEnricher = (input: {
	toolName: string;
	args: Record<string, unknown>;
	result: IdempotentToolExecutionResult;
	onProgress?: ((progress: ToolProgressUpdate) => void) | undefined;
}) => Promise<IdempotentToolExecutionResult>;

type RuntimeCapabilityKind = "godot_cli" | "godot_lsp" | "godot_dap";

function getRuntimeCapabilityApplicabilityCode(kind: RuntimeCapabilityKind | null): ToolApplicabilityCode | undefined {
	if (kind === "godot_cli") return "godot_runtime_unavailable";
	if (kind === "godot_lsp" || kind === "godot_dap") return "diagnostics_unavailable";
	return undefined;
}

const unavailableRuntimeCapabilities: Map<string, Map<RuntimeCapabilityKind, { reason: string; expiresAt: number }>> = new Map();
const RUNTIME_CAPABILITY_CACHE_TTL_MS: number = 30 * 60 * 1000;

function readDocumentationFailureCode(content: string): string | null {
	try {
		const value = JSON.parse(content) as { ok?: unknown; code?: unknown };
		return value.ok === false && typeof value.code === "string" ? value.code : null;
	} catch {
		return null;
	}
}

function getRuntimeCapabilityKind(toolName: string, args: Record<string, unknown>): RuntimeCapabilityKind | null {
	if (toolName.startsWith("mcp_godot_lsp_")) {
		return "godot_lsp";
	}
	if (toolName.startsWith("mcp_godot_dap_")) {
		return "godot_dap";
	}
	if (
		toolName === "mcp_godot_launch_editor"
		|| toolName === "mcp_godot_run_project"
		|| (
			(toolName === "mcp_terminal_run_safe_preset" || toolName === "mcp_terminal_run_write_preset")
			&& typeof args.presetName === "string"
			&& args.presetName.startsWith("godot.")
		)
	) {
		return "godot_cli";
	}
	return null;
}

function getCachedRuntimeCapabilityFailure(
	requestId: string | undefined,
	kind: RuntimeCapabilityKind | null
): string | null {
	if (requestId === undefined || kind === null) {
		return null;
	}
	const cached = unavailableRuntimeCapabilities.get(requestId)?.get(kind);
	if (cached === undefined) {
		return null;
	}
	if (cached.expiresAt <= Date.now()) {
		unavailableRuntimeCapabilities.get(requestId)?.delete(kind);
		return null;
	}
	return cached.reason;
}

function cacheRuntimeCapabilityFailure(
	requestId: string | undefined,
	kind: RuntimeCapabilityKind | null,
	reason: string
): void {
	if (requestId === undefined || kind === null) {
		return;
	}
	if (unavailableRuntimeCapabilities.size > 500) {
		for (const [cachedRequestId, capabilities] of unavailableRuntimeCapabilities) {
			if ([...capabilities.values()].every((item): boolean => item.expiresAt <= Date.now())) {
				unavailableRuntimeCapabilities.delete(cachedRequestId);
			}
		}
	}
	const capabilities = unavailableRuntimeCapabilities.get(requestId) ?? new Map();
	capabilities.set(kind, {
		reason,
		expiresAt: Date.now() + RUNTIME_CAPABILITY_CACHE_TTL_MS
	});
	unavailableRuntimeCapabilities.set(requestId, capabilities);
}

export class ToolApprovalRequiredError extends Error {
	readonly pendingApproval: PendingApproval;

	constructor(pendingApproval: PendingApproval) {
		super(`Tool approval required: ${pendingApproval.approvalId}`);
		this.name = "ToolApprovalRequiredError";
		this.pendingApproval = pendingApproval;
	}
}

async function executeSingleToolCall(
	mcpHost: McpHost,
	toolCall: ChatCompletionMessageToolCall,
	step: number,
	gateway: ApprovalGateway,
	onEvent?: OnToolEvent,
	enricher?: ToolResultEnricher | undefined,
	toolContext?: ToolExecutionContext | undefined,
	abortSignal?: AbortSignal | undefined
): Promise<DispatchedToolResult> {
	if (abortSignal?.aborted) {
		throw new Error("Request cancelled");
	}

	if (toolCall.type !== "function") {
		return {
			role: "tool",
			tool_call_id: toolCall.id,
			content: "Error: Unsupported tool call type"
		};
	}

	const functionName: string = toolCall.function.name;

	let argsParsed: Record<string, unknown>;

	try {
		argsParsed = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
	} catch {
		const message: string = `Invalid JSON arguments: ${toolCall.function.arguments}`;
		logger.warn("tool", "arguments_invalid", {
			toolCallId: toolCall.id,
			toolName: functionName,
			step
		});
		onEvent?.({ type: "tool.error", step, toolCallId: toolCall.id, toolName: functionName, message });
		return {
			role: "tool",
			tool_call_id: toolCall.id,
			content: `Error: ${message}`
		};
	}

	const workspaceId: string | undefined = toolContext?.workspaceId ?? mcpHost.getActiveWorkspaceId();
	const executionArgs: Record<string, unknown> = stripApprovalReasonArg(argsParsed);
	const approvalReason: string = getApprovalReasonFromArgs(argsParsed, "");
	const activeScenePath: string | undefined = typeof mcpHost.getEditorBridge === "function"
		? mcpHost.getEditorBridge().getActiveScenePath()
		: undefined;
	const decision = await gateway.evaluate(functionName, executionArgs, toolCall.id, workspaceId, {
		requestId: toolContext?.requestId,
		sessionId: toolContext?.sessionId,
		activeScenePath
	});
	if (decision.review !== undefined) {
		onEvent?.({
			type: "tool.reviewed",
			step,
			toolCallId: toolCall.id,
			toolName: functionName,
			decision: decision.review.decision,
			reason: decision.review.reason,
			authorizationSource: decision.review.source,
			provider: decision.review.provider,
			model: decision.review.model
		});
	}
	logger.debug("tool", "policy_evaluated", {
		toolCallId: toolCall.id,
		toolName: functionName,
		step,
		action: decision.action,
		reason: "reason" in decision ? decision.reason : undefined,
		args: executionArgs
	});

	if (decision.action === "deny") {
		logger.warn("tool", "denied", {
			toolCallId: toolCall.id,
			toolName: functionName,
			step,
			reason: decision.reason
		});
		onEvent?.({ type: "tool.error", step, toolCallId: toolCall.id, toolName: functionName, message: decision.reason });
		return {
			role: "tool",
			tool_call_id: toolCall.id,
			content: `Error: ${decision.reason}`
		};
	}

	if (decision.action === "request_approval") {
		const reason: string = approvalReason.length > 0 ? approvalReason : decision.reason;
		const pending = gateway.requestApproval(
			functionName,
			executionArgs,
			toolCall.id,
			reason,
			workspaceId,
			toolContext?.editorInstanceId,
			toolContext?.sessionId,
			decision.requiredConsent,
			toolContext?.requestId
		);
		logger.info("tool", "approval_required", {
			toolCallId: toolCall.id,
			toolName: functionName,
			step,
			approvalId: pending.approvalId,
			workspaceId,
			reason,
			args: executionArgs
		});
		onEvent?.({
			type: "tool.approval_required",
			step,
			toolCallId: toolCall.id,
			toolName: functionName,
			approvalId: pending.approvalId,
			reason,
			args: executionArgs,
			requiredConsent: pending.requiredConsent,
			...describeToolEvent(functionName, executionArgs, workspaceId)
		});

		throw new ToolApprovalRequiredError(pending);
	}

	if (onEvent) {
		onEvent({
			type: "tool.call",
			step,
			toolCallId: toolCall.id,
			toolName: functionName,
			args: executionArgs,
			...describeToolEvent(functionName, executionArgs, workspaceId)
		});
	}

	const runtimeCapabilityKind: RuntimeCapabilityKind | null = getRuntimeCapabilityKind(functionName, executionArgs);
	const cachedCapabilityFailure: string | null = getCachedRuntimeCapabilityFailure(toolContext?.requestId, runtimeCapabilityKind);
	if (cachedCapabilityFailure !== null) {
		const applicabilityCode: ToolApplicabilityCode | undefined = getRuntimeCapabilityApplicabilityCode(runtimeCapabilityKind);
		const content: string = JSON.stringify({
			ok: false,
			code: "runtime_capability_unavailable_cached",
			environmentIssue: true,
			applicabilityCode,
			error: cachedCapabilityFailure,
			cached: true
		});
		onEvent?.({
			type: "tool.result",
			step,
			toolCallId: toolCall.id,
			toolName: functionName,
			resultChars: content.length,
			truncated: false,
			cached: true,
			ok: false,
			validationStatus: "failed",
			environmentIssue: true,
			applicabilityCode,
			summary: cachedCapabilityFailure,
			failedChecks: [cachedCapabilityFailure],
			artifactRefs: []
		});
		return {
			role: "tool",
			tool_call_id: toolCall.id,
			content
		};
	}

	const startedAtMs: number = Date.now();
	logger.info("tool", "call_started", {
		toolCallId: toolCall.id,
		toolName: functionName,
		step,
		workspaceId,
		args: executionArgs
	});
	try {
		if (abortSignal?.aborted) {
			throw new Error("Request cancelled");
		}
		const commandAuthorization: TerminalCommandAuthorization | undefined = functionName === "mcp_terminal_run_command" && decision.review?.decision === "allow"
			? createTerminalCommandAuthorization({
				source: decision.review.source,
				requestId: toolContext?.requestId ?? toolCall.id,
				toolCallId: toolCall.id,
				workspaceId,
				args: executionArgs
			})
			: undefined;
		const rawResult = await executeLlmToolWithIdempotency(
			mcpHost,
			functionName,
			executionArgs,
			workspaceId,
			toolContext?.editorInstanceId,
			toolContext?.sessionId,
			abortSignal,
			commandAuthorization,
			enricher !== undefined && FULL_RESULT_ENRICHMENT_TOOLS.has(functionName),
			functionName !== "mcp_terminal_run_command" || onEvent === undefined
				? undefined
				: (progress): void => {
					const terminalOutputDelta: TerminalOutputDelta | null = parseTerminalMcpProgress(progress);
					if (terminalOutputDelta === null) {
						return;
					}
					onEvent({
						type: "tool.progress",
						step,
						toolCallId: toolCall.id,
						toolName: functionName,
						status: "message",
						title: "Terminal output",
						details: "",
						code: "terminal_output",
						terminalOutputDelta
					});
				}
		);
		if (abortSignal?.aborted) {
			throw new Error("Request cancelled");
		}
		const effectiveEnricher: ToolResultEnricher | undefined = enricher ?? (
			functionName === "mcp_image_inspect" && toolContext?.imageRouting !== undefined
				? async (input): Promise<IdempotentToolExecutionResult> => {
					const { routeToolImageExecutionResult } = await import("../providers/tool-image-recognition.js");
					return routeToolImageExecutionResult({
						result: input.result,
						options: toolContext.imageRouting!.options,
						contextText: toolContext.imageRouting!.contextText,
						abortSignal,
						onProgress: input.onProgress
					});
				}
				: undefined
		);
		const result: IdempotentToolExecutionResult = effectiveEnricher === undefined
			? rawResult
			: await effectiveEnricher({
				toolName: functionName,
				args: executionArgs,
				result: rawResult,
				onProgress: onEvent === undefined
					? undefined
					: (progress: ToolProgressUpdate): void => {
						onEvent({
							type: "tool.progress",
							step,
							toolCallId: toolCall.id,
							toolName: functionName,
							...progress
						});
					}
			});
		if (abortSignal?.aborted) {
			throw new Error("Request cancelled");
		}
		if (functionName === "mcp_godot_search_documentation") {
			const failureCode: string | null = readDocumentationFailureCode(result.content);
			if (failureCode !== null) {
				const { reportGodotDocumentationQueryFailure } = await import("../godot-documentation/manager.js");
				await reportGodotDocumentationQueryFailure(failureCode);
			}
		}
			const parsedSummary: ParsedToolResultSummary = parseToolResultSummary(functionName, executionArgs, result.content, workspaceId);
		if (parsedSummary.environmentIssue === true) {
			cacheRuntimeCapabilityFailure(
				toolContext?.requestId,
				runtimeCapabilityKind,
				parsedSummary.summary ?? `${functionName} is unavailable in the current runtime environment.`
			);
		}
		logger.info("tool", "call_finished", {
			toolCallId: toolCall.id,
			toolName: functionName,
			step,
			workspaceId,
			durationMs: Date.now() - startedAtMs,
			resultChars: result.rawContentLength,
			truncated: result.truncated,
			cached: result.reused,
			validationStatus: parsedSummary.validationStatus,
			terminalJobId: parsedSummary.terminalJobId,
			terminalJobStatus: parsedSummary.terminalJobStatus,
			hasFileEditDraft: result.fileEditDraft !== undefined
		});

		if (onEvent) {
			onEvent({
				type: "tool.result",
				step,
				toolCallId: toolCall.id,
				toolName: functionName,
				resultChars: result.rawContentLength,
				truncated: result.truncated,
				cached: result.reused,
				fileEditDraft: result.fileEditDraft,
				imageGeneration: result.imageGeneration,
				...parsedSummary
			});
		}

		return {
			role: "tool",
			tool_call_id: toolCall.id,
			content: result.content,
			imageReferences: result.imageReferences?.map((reference: ProviderToolImageReference): ProviderToolImageReference => ({
				...reference,
				toolCallId: toolCall.id
			}))
		};
	} catch (error: unknown) {
		if (abortSignal?.aborted) {
			throw error;
		}

			const message: string = error instanceof WorkspaceSourceResolutionError
				? `${error.code}: ${error.message}`
				: error instanceof Error ? error.message : "MCP tool call failed";
		logger.error("tool", "call_failed", error, {
			toolCallId: toolCall.id,
			toolName: functionName,
			step,
			workspaceId,
			durationMs: Date.now() - startedAtMs
		});

		if (onEvent) {
			onEvent({ type: "tool.error", step, toolCallId: toolCall.id, toolName: functionName, message });
		}

		return {
			role: "tool",
			tool_call_id: toolCall.id,
			content: `Error: ${message}`
		};
	}
}

export async function dispatchToolCalls(
	mcpHost: McpHost,
	toolCalls: ChatCompletionMessageToolCall[],
	step: number,
	gateway: ApprovalGateway,
	onEvent?: OnToolEvent,
	enricher?: ToolResultEnricher | undefined,
	toolContext?: ToolExecutionContext | undefined,
	abortSignal?: AbortSignal | undefined
): Promise<DispatchedToolResult[]> {
	const controlCalls: ChatCompletionMessageToolCall[] = toolCalls.filter((
		toolCall: ChatCompletionMessageToolCall
	): boolean => toolCall.type === "function" && toolCall.function.name === EXECUTION_CONTROL_TOOL_NAME);
	if (controlCalls.length > 0) {
		if (controlCalls.length !== 1 || toolCalls.length !== 1) {
			throw new Error("Execution control cannot be mixed with workspace tool calls in one assistant batch.");
		}
		if (toolContext?.executionControl === undefined || toolContext.executionControlAvailable === false) {
			throw new Error("Execution control is not available in the current agent lane.");
		}
		const controlCall: ChatCompletionMessageToolCall = controlCalls[0] as ChatCompletionMessageToolCall;
		if (controlCall.type !== "function") {
			throw new Error("Execution control must be a function tool call.");
		}
		let rawDecision: unknown;
		try {
			rawDecision = JSON.parse(controlCall.function.arguments);
		} catch {
			throw new Error("Execution control arguments must be valid JSON.");
		}
		throw new ExecutionDecisionSignal(parseExecutionDecision(rawDecision, toolContext.executionControl));
	}

	const results: DispatchedToolResult[] = [];

	for (const toolCall of toolCalls) {
		const result = await executeSingleToolCall(mcpHost, toolCall, step, gateway, onEvent, enricher, toolContext, abortSignal);
		results.push(result);
	}

	return results;
}
