import type { AiChatParams, ChatMessage } from "../protocol/types.js";
import type { McpHost } from "../mcp/mcp-host.js";
import type { ApprovalGateway } from "../tools/approval-gateway.js";
import type { OnToolEvent, ToolResultEnricher } from "../tools/tool-dispatcher.js";
import type { AgentContinuation, ApprovedToolResult, ProviderAgentResult } from "./agent-types.js";
import type { ProviderChatOptions } from "./provider-types.js";
import { WorkspaceToolCatalog, type ToolExecutionContext } from "../tools/tool-catalog.js";
import { resolveProviderAdapter } from "./provider-adapter.js";
import "./provider-adapters.js";
import { resolveImageGenerationAvailability, type ImageGenerationAvailability } from "./image-generation.js";
import { resolveChatModel } from "./deepseek-client.js";
import { modelSupportsImageInput } from "./provider-image-content.js";
import { resolveProviderTaskModelOptions } from "./task-model-routing.js";
import { beginProviderTrace, completeProviderTrace, runWithProviderTraceContext } from "../trace/trace-recorder.js";

const IMAGE_GENERATION_TOOL_NAME: string = "mcp_image_generate";
const IMAGE_INSPECTION_TOOL_NAME: string = "mcp_image_inspect";
const IMAGE_AVAILABILITY_CACHE_TTL_MS: number = 5 * 60 * 1000;
const imageAvailabilityByRequestId: Map<string, { value: ImageGenerationAvailability; expiresAt: number }> = new Map();

async function runWithProviderTrace(
	params: AiChatParams,
	options: ProviderChatOptions,
	toolContext: ToolExecutionContext | undefined,
	request: unknown,
	execute: () => Promise<ProviderAgentResult>
): Promise<ProviderAgentResult> {
	let callId: string | null = null;
	try {
		callId = await beginProviderTrace({
			sessionId: toolContext?.sessionId,
			requestId: options.traceRequestId ?? toolContext?.requestId,
			runId: options.usageContext?.runId,
			provider: options.provider,
			model: resolveChatModel(options),
			request
		});
	} catch {
		// Tracing is observational and must never block provider execution.
	}
	try {
		const result: ProviderAgentResult = await runWithProviderTraceContext(callId, execute);
		try {
			await completeProviderTrace(callId, {
				status: "success",
				provider: options.provider,
				model: resolveChatModel(options),
				response: result
			});
		} catch {
			// The model result remains authoritative when trace persistence fails.
		}
		return result;
	} catch (error: unknown) {
		try {
			await completeProviderTrace(callId, {
				status: error instanceof Error && error.name === "AbortError" ? "cancelled" : "error",
				provider: options.provider,
				model: resolveChatModel(options),
				error
			});
		} catch {
			// Preserve the original provider failure.
		}
		throw error;
	}
}

async function getImageGenerationAvailability(toolContext?: ToolExecutionContext | undefined): Promise<ImageGenerationAvailability> {
	const requestId: string | undefined = toolContext?.requestId;
	const cached = requestId === undefined ? undefined : imageAvailabilityByRequestId.get(requestId);
	if (cached !== undefined && cached.expiresAt > Date.now()) {
		return cached.value;
	}
	const value: ImageGenerationAvailability = await resolveImageGenerationAvailability();
	if (requestId !== undefined) {
		if (imageAvailabilityByRequestId.size > 500) {
			for (const [cachedRequestId, item] of imageAvailabilityByRequestId) {
				if (item.expiresAt <= Date.now()) {
					imageAvailabilityByRequestId.delete(cachedRequestId);
				}
			}
		}
		imageAvailabilityByRequestId.set(requestId, {
			value,
			expiresAt: Date.now() + IMAGE_AVAILABILITY_CACHE_TTL_MS
		});
	}
	return value;
}

async function prepareToolAvailability(
	allowedToolNames: readonly string[] | undefined,
	systemPrompt: string,
	toolContext: ToolExecutionContext | undefined,
	options: ProviderChatOptions
): Promise<{ allowedToolNames: readonly string[] | undefined; systemPrompt: string }> {
	let effectiveAllowedToolNames: readonly string[] | undefined = allowedToolNames;
	let effectiveSystemPrompt: string = systemPrompt;
	const includesImageInspection: boolean = effectiveAllowedToolNames === undefined
		|| effectiveAllowedToolNames.includes(IMAGE_INSPECTION_TOOL_NAME);
	if (includesImageInspection) {
		let available: boolean = toolContext?.clientType === "studio"
			&& (toolContext?.workspaceId !== undefined || toolContext?.sessionId !== undefined);
		if (available) {
			const currentModel: string = resolveChatModel(options);
			available = await modelSupportsImageInput(options.provider, currentModel);
			if (!available) {
				try {
					const imageModel = await resolveProviderTaskModelOptions("imageRecognition", options);
					available = await modelSupportsImageInput(imageModel.provider, imageModel.model);
				} catch {
					available = false;
				}
			}
		}
		if (!available) {
			effectiveAllowedToolNames = (effectiveAllowedToolNames ?? new WorkspaceToolCatalog(toolContext).getEntries().map((entry): string => entry.id))
				.filter((toolName: string): boolean => toolName !== IMAGE_INSPECTION_TOOL_NAME);
			effectiveSystemPrompt = `${effectiveSystemPrompt}\n\nRuntime capability note: image inspection is unavailable for this run. The current model cannot accept images and no usable image recognition model is configured.`;
		}
	}
	const includesImageGeneration: boolean = effectiveAllowedToolNames === undefined
		|| effectiveAllowedToolNames.includes(IMAGE_GENERATION_TOOL_NAME);
	if (!includesImageGeneration) {
		return { allowedToolNames: effectiveAllowedToolNames, systemPrompt: effectiveSystemPrompt };
	}
	const availability: ImageGenerationAvailability = await getImageGenerationAvailability(toolContext);
	if (availability.available) {
		return { allowedToolNames: effectiveAllowedToolNames, systemPrompt: effectiveSystemPrompt };
	}
	const effectiveNames: string[] = (effectiveAllowedToolNames ?? new WorkspaceToolCatalog(toolContext).getEntries().map((entry): string => entry.id))
		.filter((toolName: string): boolean => toolName !== IMAGE_GENERATION_TOOL_NAME);
	return {
		allowedToolNames: effectiveNames,
		systemPrompt: `${effectiveSystemPrompt}\n\nRuntime capability note: image generation is unavailable for this run and mcp_image_generate is not exposed. Reason: ${availability.reason ?? "not configured"}`
	};
}

async function filterContinuationTools(
	allowedToolNames: readonly string[] | undefined,
	toolContext: ToolExecutionContext | undefined,
	options: ProviderChatOptions
): Promise<readonly string[] | undefined> {
	return (await prepareToolAvailability(allowedToolNames, "", toolContext, options)).allowedToolNames;
}

function assertContinuationMatchesAdapter(options: ProviderChatOptions, continuation: AgentContinuation): void {
	const adapter = resolveProviderAdapter(options);
	const continuationKind: string = continuation.kind ?? "chat_completions";
	if (continuationKind === "responses" && adapter.adapterFamily !== "openai-responses") {
		throw new Error("Responses continuation cannot resume on a non-Responses provider adapter.");
	}
	if (continuationKind === "chat_completions" && adapter.adapterFamily !== "openai-compatible") {
		throw new Error("Chat Completions continuation cannot resume on a non-Chat-Completions provider adapter.");
	}
	if (continuationKind === "anthropic_messages" && adapter.adapterFamily !== "anthropic-compatible") {
		throw new Error("Anthropic Messages continuation cannot resume on a non-Anthropic provider adapter.");
	}
}

function withComputerRequestGate(options: ProviderChatOptions, context: ToolExecutionContext | undefined): ProviderChatOptions {
  if (!context?.requestId || !context.computerControl?.waitUntilRunning) return options;
  const prior = options.waitBeforeRequest;
  return { ...options, waitBeforeRequest: async signal => {
    await prior?.(signal);
    await context.computerControl!.waitUntilRunning!(context.requestId!, signal);
  } };
}

function withComputerInputPolicy(params: AiChatParams, allowedTools: readonly string[] | undefined, context: ToolExecutionContext | undefined): ToolExecutionContext | undefined {
	if (!context?.computerControl?.withInputPolicy) return context;
	const allowed = (params.mode ?? "agent") === "agent" && params.options?.executionPolicy !== "read_only"
		&& (allowedTools === undefined || allowedTools.includes("mcp_computer_action"));
	return { ...context, computerControl: context.computerControl.withInputPolicy(allowed) };
}

function withImageRoutingContext(
	toolContext: ToolExecutionContext | undefined,
	options: ProviderChatOptions,
	contextText: string
): ToolExecutionContext {
	return {
		...(toolContext ?? {}),
		imageRouting: { options, contextText }
	};
}

export async function runProviderAgent(
	params: AiChatParams,
	options: ProviderChatOptions,
	history: ChatMessage[],
	systemPrompt: string,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames?: readonly string[] | undefined,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	toolResultEnricher?: ToolResultEnricher | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<ProviderAgentResult> {
	toolContext = withComputerInputPolicy(params, allowedToolNames, toolContext);
	options = withComputerRequestGate(options, toolContext);
	const prepared = await prepareToolAvailability(allowedToolNames, systemPrompt, toolContext, options);
	return runWithProviderTrace(params, options, toolContext, {
		params,
		history,
		systemPrompt: prepared.systemPrompt,
		allowedToolNames: prepared.allowedToolNames,
		provider: { provider: options.provider, model: resolveChatModel(options), baseUrl: options.baseUrl, endpointType: options.endpointType, requestOverrides: options.requestOverrides }
	}, (): Promise<ProviderAgentResult> => resolveProviderAdapter(options).runAgent(params, options, history, prepared.systemPrompt, mcpHost, gateway, prepared.allowedToolNames, onEvent, abortSignal, toolResultEnricher, withImageRoutingContext(toolContext, options, params.message)));
}

export async function runProviderAgentStreaming(
	params: AiChatParams,
	options: ProviderChatOptions,
	history: ChatMessage[],
	systemPrompt: string,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames?: readonly string[] | undefined,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	toolResultEnricher?: ToolResultEnricher | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<ProviderAgentResult> {
	toolContext = withComputerInputPolicy(params, allowedToolNames, toolContext);
	options = withComputerRequestGate(options, toolContext);
	const prepared = await prepareToolAvailability(allowedToolNames, systemPrompt, toolContext, options);
	return runWithProviderTrace(params, options, toolContext, {
		params,
		history,
		systemPrompt: prepared.systemPrompt,
		allowedToolNames: prepared.allowedToolNames,
		provider: { provider: options.provider, model: resolveChatModel(options), baseUrl: options.baseUrl, endpointType: options.endpointType, requestOverrides: options.requestOverrides }
	}, (): Promise<ProviderAgentResult> => resolveProviderAdapter(options).runAgentStreaming(params, options, history, prepared.systemPrompt, mcpHost, gateway, prepared.allowedToolNames, onEvent, abortSignal, toolResultEnricher, withImageRoutingContext(toolContext, options, params.message)));
}

export async function continueProviderAgent(
	params: AiChatParams,
	options: ProviderChatOptions,
	continuation: AgentContinuation,
	approvedToolResult: ApprovedToolResult,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames?: readonly string[] | undefined,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<ProviderAgentResult> {
	assertContinuationMatchesAdapter(options, continuation);
	toolContext = withComputerInputPolicy(params, allowedToolNames, toolContext);
	options = withComputerRequestGate(options, toolContext);
	const effectiveTools = await filterContinuationTools(allowedToolNames, toolContext, options);
	return runWithProviderTrace(params, options, toolContext, { params, continuation, approvedToolResult, allowedToolNames: effectiveTools },
		(): Promise<ProviderAgentResult> => resolveProviderAdapter(options).continueAgent(params, options, continuation, approvedToolResult, mcpHost, gateway, effectiveTools, onEvent, abortSignal, withImageRoutingContext(toolContext, options, params.message)));
}

export async function continueProviderAgentStreaming(
	params: AiChatParams,
	options: ProviderChatOptions,
	continuation: AgentContinuation,
	approvedToolResult: ApprovedToolResult,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames?: readonly string[] | undefined,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<ProviderAgentResult> {
	assertContinuationMatchesAdapter(options, continuation);
	toolContext = withComputerInputPolicy(params, allowedToolNames, toolContext);
	options = withComputerRequestGate(options, toolContext);
	const effectiveTools = await filterContinuationTools(allowedToolNames, toolContext, options);
	return runWithProviderTrace(params, options, toolContext, { params, continuation, approvedToolResult, allowedToolNames: effectiveTools },
		(): Promise<ProviderAgentResult> => resolveProviderAdapter(options).continueAgentStreaming(params, options, continuation, approvedToolResult, mcpHost, gateway, effectiveTools, onEvent, abortSignal, withImageRoutingContext(toolContext, options, params.message)));
}

export async function continueProviderAgentAfterToolBudget(
	params: AiChatParams,
	options: ProviderChatOptions,
	continuation: AgentContinuation,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames?: readonly string[] | undefined,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<ProviderAgentResult> {
	assertContinuationMatchesAdapter(options, continuation);
	toolContext = withComputerInputPolicy(params, allowedToolNames, toolContext);
	options = withComputerRequestGate(options, toolContext);
	const effectiveTools = await filterContinuationTools(allowedToolNames, toolContext, options);
	return runWithProviderTrace(params, options, toolContext, { params, continuation, allowedToolNames: effectiveTools, reason: "tool_budget_resumed" },
		(): Promise<ProviderAgentResult> => resolveProviderAdapter(options).continueAgentAfterToolBudget(params, options, continuation, mcpHost, gateway, effectiveTools, onEvent, abortSignal, withImageRoutingContext(toolContext, options, params.message)));
}

export async function continueProviderAgentAfterToolBudgetStreaming(
	params: AiChatParams,
	options: ProviderChatOptions,
	continuation: AgentContinuation,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames?: readonly string[] | undefined,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<ProviderAgentResult> {
	assertContinuationMatchesAdapter(options, continuation);
	toolContext = withComputerInputPolicy(params, allowedToolNames, toolContext);
	options = withComputerRequestGate(options, toolContext);
	const effectiveTools = await filterContinuationTools(allowedToolNames, toolContext, options);
	return runWithProviderTrace(params, options, toolContext, { params, continuation, allowedToolNames: effectiveTools, reason: "tool_budget_resumed" },
		(): Promise<ProviderAgentResult> => resolveProviderAdapter(options).continueAgentAfterToolBudgetStreaming(params, options, continuation, mcpHost, gateway, effectiveTools, onEvent, abortSignal, withImageRoutingContext(toolContext, options, params.message)));
}

export async function finalizeProviderAgentAfterToolBudget(
	params: AiChatParams,
	options: ProviderChatOptions,
	continuation: AgentContinuation,
	allowedToolNames: readonly string[] | undefined,
	reason: string,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<ProviderAgentResult> {
	assertContinuationMatchesAdapter(options, continuation);
	return runWithProviderTrace(params, options, toolContext, { params, continuation, allowedToolNames, reason },
		(): Promise<ProviderAgentResult> => resolveProviderAdapter(options).finalizeAgentAfterToolBudget(params, options, continuation, allowedToolNames, reason, onEvent, abortSignal, toolContext));
}

export async function finalizeProviderAgentAfterToolBudgetStreaming(
	params: AiChatParams,
	options: ProviderChatOptions,
	continuation: AgentContinuation,
	allowedToolNames: readonly string[] | undefined,
	reason: string,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<ProviderAgentResult> {
	assertContinuationMatchesAdapter(options, continuation);
	return runWithProviderTrace(params, options, toolContext, { params, continuation, allowedToolNames, reason },
		(): Promise<ProviderAgentResult> => resolveProviderAdapter(options).finalizeAgentAfterToolBudgetStreaming(params, options, continuation, allowedToolNames, reason, onEvent, abortSignal, toolContext));
}
