import OpenAI from "openai";
import type {
	ChatCompletionMessageParam,
	ChatCompletionMessageToolCall,
	ChatCompletionMessageFunctionToolCall,
	ChatCompletionTool,
	ChatCompletionToolMessageParam,
	ChatCompletionCreateParamsNonStreaming,
	ChatCompletionCreateParamsStreaming,
	ChatCompletionChunk
} from "openai/resources/chat/completions";
import type { AiChatParams, ChatMessage } from "../protocol/types.js";
import {
	createDeepSeekClient,
	createMessages,
	applyChatOptions,
	resolveChatModel,
	type DeepSeekChatOptions
} from "../providers/deepseek-client.js";
import type { McpHost } from "../mcp/mcp-host.js";
import { createWorkspaceToolCatalog, type ToolExecutionContext } from "../tools/tool-catalog.js";
import { MAX_TOTAL_TOOL_RESULT_CHARS } from "../tools/llm-tool-budget.js";
import { dispatchToolCalls, ToolApprovalRequiredError, type OnToolEvent, type ToolResultEnricher } from "../tools/tool-dispatcher.js";
import { ApprovalGateway } from "../tools/approval-gateway.js";
import { containsDsmlToolCalls } from "./deepseek-dsml-tools.js";
import { containsLooseToolCalls, isKnownLooseToolTagName, isPotentialLooseToolTagName, normalizeKnownToolName } from "./deepseek-loose-tools.js";
import type { ApprovedToolResult, ChatCompletionsAgentContinuation, ProviderAgentResult } from "./agent-types.js";
import { createToolResultLimitFallback, createToolResultLimitReason, fitToolResultContent } from "./tool-result-budget.js";
import { getProviderEndpointConfig } from "./provider-registry.js";
import {
	createToolBudgetRequiredResult,
	getContinuationMaxSteps,
	getContinuationToolResultCharLimit,
	getContinuedMaxSteps,
	getContinuedToolResultCharLimit,
	getInitialMaxToolSteps,
	shouldPauseForToolBudget
} from "./agent-tool-budget.js";
import type { NormalizedLlmUsage } from "../usage/metrics-types.js";
import { getProviderUsageErrorCode, getProviderUsageStatusForError, recordProviderUsage } from "../usage/provider-recorder.js";
import { parseOpenAIChatUsage } from "../usage/usage-parser.js";

const FINALIZE_AFTER_TOOL_LIMIT_PROMPT: string =
	"工具调用阶段已经达到后端限制。请停止请求更多工具，基于目前已经获得的工具结果直接回答用户。"
	+ "如果信息不完整，请明确说明哪些部分是根据已有信息总结的，哪些部分还需要进一步检查。";
const TOOL_PROTOCOL_VIOLATION_RETRY_LIMIT: number = 2;
export type OpenAICompatibleAgentContinuation = ChatCompletionsAgentContinuation;
export type OpenAICompatibleAgentResult = ProviderAgentResult;

type StreamedAssistantMessage = {
	contentText: string;
	reasoningContent: string;
	toolCalls: ChatCompletionMessageToolCall[];
	emittedContentText: string;
	suppressedToolSyntax: boolean;
};

type ToolCallAccumulator = {
	index: number;
	id: string;
	name: string;
	argumentsText: string;
};

type ToolNameAliasContext = {
	tools: ChatCompletionTool[];
	originalToAlias: ReadonlyMap<string, string>;
	aliasToOriginal: ReadonlyMap<string, string>;
};

function shouldRequireToolCallOnStep(params: AiChatParams, step: number, startStep: number): boolean {
	const options: Record<string, unknown> | undefined = params.options as Record<string, unknown> | undefined;
	return step === startStep && options?.requireToolCallOnFirstStep === true;
}

export function shouldSkipRequiredToolChoice(options: DeepSeekChatOptions): boolean {
	const model: string = resolveChatModel(options).toLowerCase();
	const configuredMode = getProviderEndpointConfig(options.provider, options.endpointType).requiredToolChoice;
	return configuredMode === "omit" || (options.provider === "deepseek" && model.startsWith("deepseek-v4"));
}

export function resolveRequiredToolChoice(options: DeepSeekChatOptions): "required" | "auto" | undefined {
	const configuredMode = getProviderEndpointConfig(options.provider, options.endpointType).requiredToolChoice;
	if (configuredMode === "auto") {
		return "auto";
	}
	if (shouldSkipRequiredToolChoice(options)) {
		return undefined;
	}
	return "required";
}

export function shouldDisableThinkingForToolCalls(options: DeepSeekChatOptions, tools: readonly ChatCompletionTool[]): boolean {
	const model: string = resolveChatModel(options).toLowerCase();
	return tools.length > 0 && options.provider === "deepseek" && model.startsWith("deepseek-v4");
}

function applyDeepSeekToolMode(
	requestBody: ChatCompletionCreateParamsNonStreaming | ChatCompletionCreateParamsStreaming,
	options: DeepSeekChatOptions,
	tools: readonly ChatCompletionTool[]
): void {
	if (!shouldDisableThinkingForToolCalls(options, tools)) {
		return;
	}

	const body = requestBody as unknown as Record<string, unknown>;
	const extraBody: Record<string, unknown> = typeof body.extra_body === "object" && body.extra_body !== null && !Array.isArray(body.extra_body)
		? { ...(body.extra_body as Record<string, unknown>) }
		: {};
	extraBody.thinking = { type: "disabled" };
	body.extra_body = extraBody;
}

function applyProviderToolRequestOptions(
	requestBody: ChatCompletionCreateParamsNonStreaming | ChatCompletionCreateParamsStreaming,
	options: DeepSeekChatOptions,
	tools: readonly ChatCompletionTool[]
): void {
	if (tools.length === 0) {
		return;
	}

	const endpointConfig = getProviderEndpointConfig(options.provider, options.endpointType);
	if (endpointConfig.toolCallsSwitch === true) {
		(requestBody as unknown as Record<string, unknown>).tool_calls_switch = true;
	}
}

function applyToolChoiceForStep(
	requestBody: ChatCompletionCreateParamsNonStreaming | ChatCompletionCreateParamsStreaming,
	params: AiChatParams,
	options: DeepSeekChatOptions,
	step: number,
	startStep: number,
	tools: ChatCompletionTool[]
): void {
	if (tools.length === 0 || !shouldRequireToolCallOnStep(params, step, startStep)) {
		return;
	}

	const toolChoice = resolveRequiredToolChoice(options);
	if (toolChoice === undefined) {
		return;
	}

	requestBody.tool_choice = toolChoice;
}

function isProviderSafeToolName(toolName: string): boolean {
	return /^[A-Za-z][A-Za-z0-9_]{0,31}$/u.test(toolName);
}

function createToolAlias(toolName: string, index: number, usedAliases: Set<string>): string {
	const suffix: string = `_t${index + 1}`;
	const stripped: string = toolName
		.replace(/^mcp_godot_/u, "")
		.replace(/^mcp_terminal_/u, "")
		.replace(/^mcp_/u, "");
	let base: string = stripped
		.replace(/[^A-Za-z0-9_]/gu, "_")
		.replace(/_+/gu, "_")
		.replace(/^_+/u, "");

	if (!/^[A-Za-z]/u.test(base)) {
		base = `tool_${base}`;
	}
	if (base.length === 0) {
		base = "tool";
	}

	let candidate: string = base.length <= 32 ? base : `${base.slice(0, Math.max(1, 32 - suffix.length))}${suffix}`;
	if (!/^[A-Za-z]/u.test(candidate)) {
		candidate = `t${candidate.slice(1)}`;
	}

	let collisionIndex: number = 1;
	while (usedAliases.has(candidate)) {
		const collisionSuffix: string = `_t${index + 1}_${collisionIndex}`;
		candidate = `${base.slice(0, Math.max(1, 32 - collisionSuffix.length))}${collisionSuffix}`;
		if (!/^[A-Za-z]/u.test(candidate)) {
			candidate = `t${candidate.slice(1)}`;
		}
		collisionIndex += 1;
	}

	return candidate;
}

function createToolNameAliasContext(options: DeepSeekChatOptions, tools: ChatCompletionTool[]): ToolNameAliasContext {
	if (options.provider !== "iflytek") {
		return { tools, originalToAlias: new Map(), aliasToOriginal: new Map() };
	}

	const originalToAlias: Map<string, string> = new Map();
	const aliasToOriginal: Map<string, string> = new Map();
	const usedAliases: Set<string> = new Set();
	const aliasedTools: ChatCompletionTool[] = tools.map((tool: ChatCompletionTool, index: number): ChatCompletionTool => {
		if (tool.type !== "function") {
			return tool;
		}

		const originalName: string = tool.function.name;
		const alias: string = isProviderSafeToolName(originalName) && !usedAliases.has(originalName)
			? originalName
			: createToolAlias(originalName, index, usedAliases);
		usedAliases.add(alias);
		if (alias === originalName) {
			return tool;
		}

		originalToAlias.set(originalName, alias);
		aliasToOriginal.set(alias, originalName);
		return {
			...tool,
			function: {
				...tool.function,
				name: alias,
				description: `Original tool name: ${originalName}. ${tool.function.description ?? ""}`.trim()
			}
		};
	});

	return { tools: aliasedTools, originalToAlias, aliasToOriginal };
}

function createProviderRequestMessages(
	messages: ChatCompletionMessageParam[],
	aliasContext: ToolNameAliasContext
): ChatCompletionMessageParam[] {
	if (aliasContext.originalToAlias.size === 0) {
		return messages;
	}

	return messages.map((message: ChatCompletionMessageParam): ChatCompletionMessageParam => {
		const record = message as unknown as { tool_calls?: ChatCompletionMessageToolCall[] };
		if (!Array.isArray(record.tool_calls)) {
			return message;
		}

		const toolCalls: ChatCompletionMessageToolCall[] = record.tool_calls.map((toolCall: ChatCompletionMessageToolCall): ChatCompletionMessageToolCall => {
			if (!isFunctionToolCall(toolCall)) {
				return toolCall;
			}
			const alias: string | undefined = aliasContext.originalToAlias.get(toolCall.function.name);
			if (alias === undefined) {
				return toolCall;
			}
			return {
				...toolCall,
				function: {
					...toolCall.function,
					name: alias
				}
			};
		});

		return {
			...message,
			tool_calls: toolCalls
		} as ChatCompletionMessageParam;
	});
}

function normalizeProviderToolCalls(
	toolCalls: ChatCompletionMessageToolCall[] | undefined,
	aliasContext: ToolNameAliasContext
): ChatCompletionMessageToolCall[] | undefined {
	if (toolCalls === undefined || aliasContext.aliasToOriginal.size === 0) {
		return toolCalls;
	}

	return toolCalls.map((toolCall: ChatCompletionMessageToolCall): ChatCompletionMessageToolCall => {
		if (!isFunctionToolCall(toolCall)) {
			return toolCall;
		}
		const originalName: string | undefined = aliasContext.aliasToOriginal.get(toolCall.function.name);
		if (originalName === undefined) {
			return toolCall;
		}
		return {
			...toolCall,
			function: {
				...toolCall.function,
				name: originalName
			}
		};
	});
}

function extractTextContent(content: ChatCompletionMessageParam["content"]): string {
	if (typeof content === "string") {
		return content;
	}

	if (Array.isArray(content)) {
		return content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part): string => part.text)
			.join("");
	}

	return "";
}

function isFunctionToolCall(toolCall: ChatCompletionMessageToolCall): toolCall is ChatCompletionMessageFunctionToolCall {
	return toolCall.type === "function";
}

function getAllowedToolNames(tools: ChatCompletionTool[]): ReadonlySet<string> {
	const allowedToolNames: Set<string> = new Set();

	for (const tool of tools) {
		if (tool.type === "function") {
			allowedToolNames.add(tool.function.name);
		}
	}

	return allowedToolNames;
}

function normalizeToolCallForAllowedTools(
	toolCall: ChatCompletionMessageToolCall,
	allowedToolNames: ReadonlySet<string>
): ChatCompletionMessageToolCall | null {
	if (!isFunctionToolCall(toolCall)) {
		return toolCall;
	}

	const normalizedName: string = normalizeKnownToolName(toolCall.function.name) ?? toolCall.function.name;
	if (!allowedToolNames.has(normalizedName)) {
		return null;
	}

	if (normalizedName === toolCall.function.name) {
		return toolCall;
	}

	return {
		...toolCall,
		function: {
			...toolCall.function,
			name: normalizedName
		}
	};
}

function filterToolCallsForAllowedTools(
	toolCalls: ChatCompletionMessageToolCall[],
	allowedToolNames: ReadonlySet<string>
): ChatCompletionMessageToolCall[] {
	const filteredToolCalls: ChatCompletionMessageToolCall[] = [];

	for (const toolCall of toolCalls) {
		const normalizedToolCall: ChatCompletionMessageToolCall | null = normalizeToolCallForAllowedTools(toolCall, allowedToolNames);
		if (normalizedToolCall !== null) {
			filteredToolCalls.push(normalizedToolCall);
		}
	}

	return filteredToolCalls;
}

export function createToolProtocolCorrectionMessage(allowedToolNames: readonly string[]): string {
	const lines: string[] = [
		"上一条 assistant 输出包含 XML/DSML/裸工具标签，但后端不会解析正文里的工具协议。",
		"不要再输出 <Tool>、<parameter>、DSML、JSON 工具结构或任何工具调用预告。"
	];
	if (allowedToolNames.length > 0) {
		lines.push("如果需要使用工具，下一步必须通过 Chat Completions API 的 tool_calls 字段调用真实工具。");
		lines.push("本阶段可用工具名如下：");
		for (const toolName of allowedToolNames) {
			lines.push(`- ${toolName}`);
		}
	} else {
		lines.push("当前阶段没有可用工具，请只输出面向用户的自然语言结果。");
	}

	return lines.join("\n");
}

export function createMissingRequiredToolCallCorrectionMessage(allowedToolNames: readonly string[], hadVisibleText: boolean = false): string {
	const lines: string[] = [
		hadVisibleText
			? "上一条 assistant 响应输出了正文，但没有通过 API tool_calls 调用工具。"
			: "上一条 assistant 响应没有返回用户可见正文，也没有通过 API tool_calls 调用工具。",
		"当前阶段要求先调用工具；不要只在正文、thinking/reasoning_content 中说明准备调用工具。"
	];
	if (allowedToolNames.length > 0) {
		lines.push("下一步必须通过 Chat Completions API 的 tool_calls 字段调用真实工具。");
		lines.push("本阶段可用工具名如下：");
		for (const toolName of allowedToolNames) {
			lines.push(`- ${toolName}`);
		}
	} else {
		lines.push("当前阶段没有可用工具，请输出面向用户的自然语言结果。");
	}

	return lines.join("\n");
}

export function createReasoningOnlyCorrectionMessage(allowedToolNames: readonly string[]): string {
	const lines: string[] = [
		"上一条 assistant 响应只返回了 thinking/reasoning_content，没有用户可见正文，也没有通过 API tool_calls 调用工具。",
		"下一步必须二选一：如果需要项目事实或文件内容，通过 API tool_calls 调用真实工具；如果已经有足够信息，输出用户可见正文。",
		"不要只返回 thinking/reasoning_content。"
	];
	if (allowedToolNames.length > 0) {
		lines.push("当前阶段可用工具名如下：");
		for (const toolName of allowedToolNames) {
			lines.push(`- ${toolName}`);
		}
	}

	return lines.join("\n");
}

function containsKnownToolSyntax(text: string | null | undefined): boolean {
	return containsDsmlToolCalls(text) || containsLooseToolCalls(text) || containsGenericToolCallMarkup(text);
}

function containsGenericToolCallMarkup(text: string | null | undefined): boolean {
	return text !== null
		&& text !== undefined
		&& /<\s*\/?\s*tool_calls(?:\s|>)|<\s*\/?\s*tool_call(?:\s|>)/iu.test(text);
}

function createToolCallPreludeDelta(
	contentText: string | null,
	emittedContentText: string
): string {
	if (emittedContentText.trim().length > 0) {
		return "";
	}

	const naturalPrelude: string = (contentText ?? "").trim();
	if (naturalPrelude.length > 0) {
		return `\n\n${naturalPrelude}\n\n`;
	}

	return "";
}

function emitModelToolCallPrelude(
	contentText: string | null,
	emittedContentText: string,
	onEvent?: OnToolEvent
): void {
	const preludeDelta: string = createToolCallPreludeDelta(contentText, emittedContentText);
	if (preludeDelta.length > 0) {
		onEvent?.({ type: "ai.delta", text: preludeDelta });
	}
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type LooseOpeningTag = {
	tagName: string;
	selfClosing: boolean;
};

function parseLooseOpeningTag(openingTag: string): LooseOpeningTag | null {
	const match: RegExpMatchArray | null = /^<\s*([A-Za-z_][A-Za-z0-9_.:-]*)(?:\s+[^<>]*?)?(\/?)\s*>$/u.exec(openingTag);
	const tagName: string | undefined = match?.[1];
	if (tagName === undefined) {
		return null;
	}

	return {
		tagName,
		selfClosing: (match?.[2] ?? "") === "/"
	};
}

function isDsmlToolCallsOpeningTag(openingTag: string): boolean {
	return /^<\s*[｜|]+\s*DSML\s*[｜|]+\s*tool_calls\s*>$/iu.test(openingTag);
}

function isGenericToolCallsOpeningTag(openingTag: string): boolean {
	return /^<\s*tool_calls(?:\s+[^<>]*?)?\s*>$/iu.test(openingTag);
}

function isGenericToolCallTagName(tagName: string): boolean {
	return tagName.toLowerCase() === "tool_call";
}

function isPotentialGenericToolTagName(tagName: string): boolean {
	const normalizedTagName: string = tagName.toLowerCase();
	return "tool_calls".startsWith(normalizedTagName) || "tool_call".startsWith(normalizedTagName);
}

function isPotentialToolOpeningFragment(text: string): boolean {
	if (/^<\s*[｜|]/u.test(text)) {
		return true;
	}

	const match: RegExpMatchArray | null = /^<\s*([A-Za-z_][A-Za-z0-9_.:-]*)/u.exec(text);
	return match?.[1] !== undefined
		&& (isPotentialLooseToolTagName(match[1]) || isPotentialGenericToolTagName(match[1]));
}

function findLooseClosingTagEnd(text: string, tagName: string): number {
	const closingPattern: RegExp = new RegExp(`<\\/\\s*${escapeRegExp(tagName)}\\s*>`, "iu");
	const match: RegExpExecArray | null = closingPattern.exec(text);
	return match === null ? -1 : match.index + match[0].length;
}

function findDsmlClosingTagEnd(text: string): number {
	const closingPattern: RegExp = /<\/\s*[｜|]+\s*DSML\s*[｜|]+\s*tool_calls\s*>/iu;
	const match: RegExpExecArray | null = closingPattern.exec(text);
	return match === null ? -1 : match.index + match[0].length;
}

function findGenericToolCallsClosingTagEnd(text: string): number {
	const match: RegExpExecArray | null = /<\/\s*tool_calls\s*>/iu.exec(text);
	return match === null ? -1 : match.index + match[0].length;
}

class ToolSyntaxStreamFilter {
	private pendingText: string = "";
	private strippingTagName: string | null = null;
	private strippingDsmlToolCalls: boolean = false;
	private strippingGenericToolCalls: boolean = false;
	private emittedText: string = "";
	private suppressedSyntax: boolean = false;

	push(text: string): string {
		this.pendingText += text;
		const visibleText: string = this.drain(false);
		this.emittedText += visibleText;
		return visibleText;
	}

	flush(): string {
		const visibleText: string = this.drain(true);
		this.emittedText += visibleText;
		return visibleText;
	}

	getEmittedText(): string {
		return this.emittedText;
	}

	hasSuppressedSyntax(): boolean {
		return this.suppressedSyntax;
	}

	private drain(flush: boolean): string {
		let visibleText: string = "";

		while (this.pendingText.length > 0) {
			if (this.strippingTagName !== null) {
				const closingEnd: number = findLooseClosingTagEnd(this.pendingText, this.strippingTagName);
				if (closingEnd < 0) {
					if (flush) {
						this.pendingText = "";
						this.strippingTagName = null;
					}
					break;
				}

				this.pendingText = this.pendingText.slice(closingEnd);
				this.strippingTagName = null;
				continue;
			}

			if (this.strippingDsmlToolCalls) {
				const closingEnd: number = findDsmlClosingTagEnd(this.pendingText);
				if (closingEnd < 0) {
					if (flush) {
						this.pendingText = "";
						this.strippingDsmlToolCalls = false;
					}
					break;
				}

				this.pendingText = this.pendingText.slice(closingEnd);
				this.strippingDsmlToolCalls = false;
				continue;
			}

			if (this.strippingGenericToolCalls) {
				const closingEnd: number = findGenericToolCallsClosingTagEnd(this.pendingText);
				if (closingEnd < 0) {
					if (flush) {
						this.pendingText = "";
						this.strippingGenericToolCalls = false;
					}
					break;
				}

				this.pendingText = this.pendingText.slice(closingEnd);
				this.strippingGenericToolCalls = false;
				continue;
			}

			const tagStart: number = this.pendingText.indexOf("<");
			if (tagStart < 0) {
				visibleText += this.pendingText;
				this.pendingText = "";
				break;
			}

			if (tagStart > 0) {
				visibleText += this.pendingText.slice(0, tagStart);
				this.pendingText = this.pendingText.slice(tagStart);
				continue;
			}

			const tagEnd: number = this.pendingText.indexOf(">");
			if (tagEnd < 0) {
				if (flush) {
					if (isPotentialToolOpeningFragment(this.pendingText)) {
						this.suppressedSyntax = true;
					} else {
						visibleText += this.pendingText;
					}
					this.pendingText = "";
				}
				break;
			}

			const openingTag: string = this.pendingText.slice(0, tagEnd + 1);
			const looseOpeningTag: LooseOpeningTag | null = parseLooseOpeningTag(openingTag);
			if (looseOpeningTag !== null && (isKnownLooseToolTagName(looseOpeningTag.tagName) || isGenericToolCallTagName(looseOpeningTag.tagName))) {
				this.suppressedSyntax = true;
				this.pendingText = this.pendingText.slice(tagEnd + 1);
				this.strippingTagName = looseOpeningTag.selfClosing ? null : looseOpeningTag.tagName;
				continue;
			}

			if (isDsmlToolCallsOpeningTag(openingTag)) {
				this.suppressedSyntax = true;
				this.pendingText = this.pendingText.slice(tagEnd + 1);
				this.strippingDsmlToolCalls = true;
				continue;
			}

			if (isGenericToolCallsOpeningTag(openingTag)) {
				this.suppressedSyntax = true;
				this.pendingText = this.pendingText.slice(tagEnd + 1);
				this.strippingGenericToolCalls = true;
				continue;
			}

			visibleText += openingTag;
			this.pendingText = this.pendingText.slice(tagEnd + 1);
		}

		return visibleText;
	}
}

type ThinkTagSplitResult = {
	visibleText: string;
	thinkingText: string;
	thinkingStarted: boolean;
	thinkingDone: boolean;
};

function shouldSplitThinkTags(options: DeepSeekChatOptions): boolean {
	return options.provider === "minimax";
}

function isMiniMaxThinkOpeningFragment(text: string): boolean {
	return /^<\s*(?:t(?:h(?:i(?:n(?:k)?)?)?)?)?$/iu.test(text);
}

function isMiniMaxThinkClosingFragment(text: string): boolean {
	return /^<\s*\/\s*(?:t(?:h(?:i(?:n(?:k)?)?)?)?)?$/iu.test(text);
}

function findMiniMaxThinkOpeningTag(text: string): RegExpExecArray | null {
	return /<\s*think(?:\s+[^<>]*?)?\s*>/iu.exec(text);
}

function findMiniMaxThinkClosingTag(text: string): RegExpExecArray | null {
	return /<\/\s*think\s*>/iu.exec(text);
}

function appendReasoningContent(existing: string, addition: string): string {
	if (addition.length === 0) {
		return existing;
	}
	if (existing.length === 0) {
		return addition;
	}
	return `${existing}\n${addition}`;
}

class MiniMaxThinkTagStreamFilter {
	private pendingText: string = "";
	private insideThink: boolean = false;

	push(text: string): ThinkTagSplitResult {
		this.pendingText += text;
		return this.drain(false);
	}

	flush(): ThinkTagSplitResult {
		return this.drain(true);
	}

	private drain(flush: boolean): ThinkTagSplitResult {
		let visibleText: string = "";
		let thinkingText: string = "";
		let thinkingStarted: boolean = false;
		let thinkingDone: boolean = false;

		while (this.pendingText.length > 0) {
			if (this.insideThink) {
				const closingTag: RegExpExecArray | null = findMiniMaxThinkClosingTag(this.pendingText);
				if (closingTag === null) {
					if (flush) {
						thinkingText += this.pendingText;
						this.pendingText = "";
						this.insideThink = false;
						thinkingDone = true;
						break;
					}

					const lastTagStart: number = this.pendingText.lastIndexOf("<");
					if (lastTagStart >= 0 && isMiniMaxThinkClosingFragment(this.pendingText.slice(lastTagStart))) {
						thinkingText += this.pendingText.slice(0, lastTagStart);
						this.pendingText = this.pendingText.slice(lastTagStart);
						break;
					}

					thinkingText += this.pendingText;
					this.pendingText = "";
					break;
				}

				thinkingText += this.pendingText.slice(0, closingTag.index);
				this.pendingText = this.pendingText.slice(closingTag.index + closingTag[0].length);
				this.insideThink = false;
				thinkingDone = true;
				continue;
			}

			const openingTag: RegExpExecArray | null = findMiniMaxThinkOpeningTag(this.pendingText);
			if (openingTag === null) {
				if (flush) {
					visibleText += this.pendingText;
					this.pendingText = "";
					break;
				}

				const lastTagStart: number = this.pendingText.lastIndexOf("<");
				if (lastTagStart >= 0 && isMiniMaxThinkOpeningFragment(this.pendingText.slice(lastTagStart))) {
					visibleText += this.pendingText.slice(0, lastTagStart);
					this.pendingText = this.pendingText.slice(lastTagStart);
					break;
				}

				visibleText += this.pendingText;
				this.pendingText = "";
				break;
			}

			visibleText += this.pendingText.slice(0, openingTag.index);
			this.pendingText = this.pendingText.slice(openingTag.index + openingTag[0].length);
			this.insideThink = true;
			thinkingStarted = true;
		}

		return { visibleText, thinkingText, thinkingStarted, thinkingDone };
	}
}

function splitMiniMaxThinkTags(text: string): ThinkTagSplitResult {
	const filter = new MiniMaxThinkTagStreamFilter();
	const first: ThinkTagSplitResult = filter.push(text);
	const flushed: ThinkTagSplitResult = filter.flush();
	return {
		visibleText: first.visibleText + flushed.visibleText,
		thinkingText: first.thinkingText + flushed.thinkingText,
		thinkingStarted: first.thinkingStarted || flushed.thinkingStarted,
		thinkingDone: first.thinkingDone || flushed.thinkingDone
	};
}

function getReasoningContent(message: unknown): string {
	if (message === null || typeof message !== "object") {
		return "";
	}

	const reasoningValue: unknown = (message as { reasoning_content?: unknown }).reasoning_content;
	return typeof reasoningValue === "string" ? reasoningValue : "";
}

function emitReasoningContent(message: unknown, onEvent?: OnToolEvent): void {
	const reasoningContent: string = getReasoningContent(message);
	if (reasoningContent.length === 0) {
		return;
	}

	onEvent?.({ type: "ai.thinking.delta", text: reasoningContent });
	onEvent?.({ type: "ai.thinking.done" });
}

function getContentDelta(delta: unknown): string {
	if (delta === null || typeof delta !== "object") {
		return "";
	}

	const contentValue: unknown = (delta as { content?: unknown }).content;
	return typeof contentValue === "string" ? contentValue : "";
}

function getToolCallDeltaList(delta: unknown): unknown[] {
	if (delta === null || typeof delta !== "object") {
		return [];
	}

	const toolCallsValue: unknown = (delta as { tool_calls?: unknown }).tool_calls;
	return Array.isArray(toolCallsValue) ? toolCallsValue : [];
}

function applyToolCallDelta(accumulators: Map<number, ToolCallAccumulator>, value: unknown, step: number): void {
	if (value === null || typeof value !== "object") {
		return;
	}

	const delta = value as {
		index?: unknown;
		id?: unknown;
		function?: {
			name?: unknown;
			arguments?: unknown;
		};
	};
	const index: number = typeof delta.index === "number" ? delta.index : accumulators.size;
	const existing: ToolCallAccumulator | undefined = accumulators.get(index);
	const accumulator: ToolCallAccumulator = existing ?? {
		index,
		id: `stream-tool-${step}-${index}`,
		name: "",
		argumentsText: ""
	};

	if (typeof delta.id === "string" && delta.id.length > 0) {
		accumulator.id = delta.id;
	}

	if (typeof delta.function?.name === "string" && delta.function.name.length > 0) {
		accumulator.name = delta.function.name;
	}

	if (typeof delta.function?.arguments === "string" && delta.function.arguments.length > 0) {
		accumulator.argumentsText += delta.function.arguments;
	}

	accumulators.set(index, accumulator);
}

function createToolCallsFromAccumulators(accumulators: Map<number, ToolCallAccumulator>): ChatCompletionMessageToolCall[] {
	return Array.from(accumulators.values())
		.sort((a: ToolCallAccumulator, b: ToolCallAccumulator): number => a.index - b.index)
		.filter((accumulator: ToolCallAccumulator): boolean => accumulator.name.length > 0)
		.map((accumulator: ToolCallAccumulator): ChatCompletionMessageToolCall => ({
			id: accumulator.id,
			type: "function",
			function: {
				name: accumulator.name,
				arguments: accumulator.argumentsText
			}
		}) as ChatCompletionMessageToolCall);
}

async function readStreamingAssistantMessage(
	client: OpenAI,
	params: AiChatParams,
	options: DeepSeekChatOptions,
	messages: ChatCompletionMessageParam[],
	tools: ChatCompletionTool[],
	aliasContext: ToolNameAliasContext,
	step: number,
	startStep: number,
	onEvent?: OnToolEvent,
	emitContentDeltas: boolean = true,
	abortSignal?: AbortSignal | undefined
): Promise<StreamedAssistantMessage> {
	const requestTools: ChatCompletionTool[] = aliasContext.tools;
	const requestBody: ChatCompletionCreateParamsStreaming = {
		model: resolveChatModel(options),
		messages: createProviderRequestMessages(messages, aliasContext),
		tools: requestTools,
		stream: true
	};

	applyToolChoiceForStep(requestBody, params, options, step, startStep, requestTools);
	applyChatOptions(requestBody, params, options);
	applyDeepSeekToolMode(requestBody, options, requestTools);
	applyProviderToolRequestOptions(requestBody, options, requestTools);

	const startedAtMs: number = Date.now();
	let firstTokenAtMs: number | undefined;
	let finalUsage: NormalizedLlmUsage | null = null;
	const toolCallAccumulators: Map<number, ToolCallAccumulator> = new Map();
	const contentFilter: ToolSyntaxStreamFilter = new ToolSyntaxStreamFilter();
	const thinkTagFilter: MiniMaxThinkTagStreamFilter | null = shouldSplitThinkTags(options) ? new MiniMaxThinkTagStreamFilter() : null;
	let contentText = "";
	let reasoningContent = "";
	let emittedReasoning = false;
	let openThinkTagReasoning = false;

	try {
		const stream = await client.chat.completions.create(requestBody, { signal: abortSignal });
		for await (const chunk of stream) {
			finalUsage = parseOpenAIChatUsage(chunk) ?? finalUsage;
			const delta: unknown = (chunk as ChatCompletionChunk).choices[0]?.delta;
			if (delta === undefined || delta === null) {
				continue;
			}

			if (firstTokenAtMs === undefined && (getReasoningContent(delta).length > 0 || getContentDelta(delta).length > 0 || getToolCallDeltaList(delta).length > 0)) {
				firstTokenAtMs = Date.now();
			}

			const reasoningDelta: string = getReasoningContent(delta);
			if (reasoningDelta.length > 0) {
				reasoningContent += reasoningDelta;
				emittedReasoning = true;
				onEvent?.({ type: "ai.thinking.delta", text: reasoningDelta });
			}

			const contentDelta: string = getContentDelta(delta);
			if (contentDelta.length > 0) {
				const splitContent: ThinkTagSplitResult = thinkTagFilter?.push(contentDelta) ?? {
					visibleText: contentDelta,
					thinkingText: "",
					thinkingStarted: false,
					thinkingDone: false
				};
				if (splitContent.thinkingStarted && splitContent.thinkingText.length === 0 && !splitContent.thinkingDone && !openThinkTagReasoning) {
					openThinkTagReasoning = true;
					onEvent?.({ type: "ai.thinking.delta", text: "" });
				}
				if (splitContent.thinkingText.length > 0) {
					reasoningContent = appendReasoningContent(reasoningContent, splitContent.thinkingText);
					openThinkTagReasoning = true;
					onEvent?.({ type: "ai.thinking.delta", text: splitContent.thinkingText });
				}
				if (splitContent.thinkingDone && openThinkTagReasoning) {
					onEvent?.({ type: "ai.thinking.done" });
					openThinkTagReasoning = false;
				}
				contentText += splitContent.visibleText;
				if (emitContentDeltas) {
					const visibleDelta: string = contentFilter.push(splitContent.visibleText);
					if (visibleDelta.length > 0) {
						onEvent?.({ type: "ai.delta", text: visibleDelta });
					}
				}
			}

			for (const toolCallDelta of getToolCallDeltaList(delta)) {
				applyToolCallDelta(toolCallAccumulators, toolCallDelta, step);
			}
		}
	} catch (error: unknown) {
		await recordProviderUsage({
			options,
			requestBody,
			outputText: contentText,
			startedAtMs,
			firstTokenAtMs,
			status: getProviderUsageStatusForError(error),
			errorCode: getProviderUsageErrorCode(error),
			streaming: true,
			usage: finalUsage
		});
		throw error;
	}

	if (emittedReasoning) {
		onEvent?.({ type: "ai.thinking.done" });
	}

	if (emitContentDeltas) {
		const flushedThinkTags: ThinkTagSplitResult | null = thinkTagFilter?.flush() ?? null;
		if (flushedThinkTags !== null) {
			if (flushedThinkTags.thinkingStarted && flushedThinkTags.thinkingText.length === 0 && !flushedThinkTags.thinkingDone && !openThinkTagReasoning) {
				openThinkTagReasoning = true;
				onEvent?.({ type: "ai.thinking.delta", text: "" });
			}
			if (flushedThinkTags.thinkingText.length > 0) {
				reasoningContent = appendReasoningContent(reasoningContent, flushedThinkTags.thinkingText);
				openThinkTagReasoning = true;
				onEvent?.({ type: "ai.thinking.delta", text: flushedThinkTags.thinkingText });
			}
			if (flushedThinkTags.thinkingDone && openThinkTagReasoning) {
				onEvent?.({ type: "ai.thinking.done" });
				openThinkTagReasoning = false;
			}
			contentText += flushedThinkTags.visibleText;
			const visibleDelta: string = contentFilter.push(flushedThinkTags.visibleText);
			if (visibleDelta.length > 0) {
				onEvent?.({ type: "ai.delta", text: visibleDelta });
			}
		}
		const visibleTail: string = contentFilter.flush();
		if (visibleTail.length > 0) {
			onEvent?.({ type: "ai.delta", text: visibleTail });
		}
	} else {
		const flushedThinkTags: ThinkTagSplitResult | null = thinkTagFilter?.flush() ?? null;
		if (flushedThinkTags !== null) {
			reasoningContent = appendReasoningContent(reasoningContent, flushedThinkTags.thinkingText);
			contentText += flushedThinkTags.visibleText;
		}
	}

	await recordProviderUsage({
		options,
		requestBody,
		outputText: contentText,
		startedAtMs,
		firstTokenAtMs,
		status: "success",
		streaming: true,
		usage: finalUsage
	});

	return {
		contentText,
		reasoningContent,
		toolCalls: createToolCallsFromAccumulators(toolCallAccumulators),
		emittedContentText: emitContentDeltas ? contentFilter.getEmittedText() : "",
		suppressedToolSyntax: emitContentDeltas && contentFilter.hasSuppressedSyntax()
	};
}

function createAssistantToolMessage(
	contentText: string | null,
	toolCalls: ChatCompletionMessageToolCall[],
	reasoningContent: string
): ChatCompletionMessageParam {
	const message: Record<string, unknown> = {
		role: "assistant",
		content: contentText,
		tool_calls: toolCalls
	};

	if (reasoningContent.length > 0) {
		message.reasoning_content = reasoningContent;
	}

	return message as unknown as ChatCompletionMessageParam;
}

function hasToolResultMessages(messages: readonly ChatCompletionMessageParam[]): boolean {
	return messages.some((message: ChatCompletionMessageParam): boolean => {
		const roleValue: unknown = (message as { role?: unknown }).role;
		return roleValue === "tool";
	});
}

async function createFinalAnswer(
	client: OpenAI,
	params: AiChatParams,
	options: DeepSeekChatOptions,
	messages: ChatCompletionMessageParam[],
	reason: string,
	abortSignal?: AbortSignal | undefined,
	aliasContext?: ToolNameAliasContext | undefined
): Promise<string> {
	const finalMessages: ChatCompletionMessageParam[] = [
		...messages,
		{
			role: "system",
			content: `${FINALIZE_AFTER_TOOL_LIMIT_PROMPT}\n\n收束原因：${reason}`
		}
	];
	const requestBody: ChatCompletionCreateParamsNonStreaming = {
		model: resolveChatModel(options),
		messages: aliasContext === undefined ? finalMessages : createProviderRequestMessages(finalMessages, aliasContext)
	};

	applyChatOptions(requestBody, params, options);

	const startedAtMs: number = Date.now();
	let completion;
	try {
		completion = await client.chat.completions.create(requestBody, { signal: abortSignal });
	} catch (error: unknown) {
		await recordProviderUsage({
			options,
			requestBody,
			startedAtMs,
			status: getProviderUsageStatusForError(error),
			errorCode: getProviderUsageErrorCode(error),
			streaming: false
		});
		throw error;
	}
	const text: string | null | undefined = completion.choices[0]?.message.content;
	await recordProviderUsage({
		options,
		requestBody,
		responseBody: completion,
		outputText: text ?? JSON.stringify(completion.choices[0]?.message ?? {}),
		startedAtMs,
		status: text ? "success" : "error",
		errorCode: text ? undefined : "empty_response",
		streaming: false,
		usage: parseOpenAIChatUsage(completion)
	});

	if (!text) {
		return createToolResultLimitFallback(reason);
	}

	const visibleText: string = shouldSplitThinkTags(options) ? splitMiniMaxThinkTags(text).visibleText : text;
	if (visibleText.length === 0 || containsKnownToolSyntax(visibleText)) {
		return createToolResultLimitFallback(reason);
	}

	return visibleText;
}

async function runAgentLoop(
	client: OpenAI,
	params: AiChatParams,
	options: DeepSeekChatOptions,
	messages: ChatCompletionMessageParam[],
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	tools: ChatCompletionTool[],
	startStep: number,
	maxSteps: number,
	initialToolResultChars: number,
	maxTotalToolResultChars: number,
	streamAssistant: boolean,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	toolResultEnricher?: ToolResultEnricher | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<OpenAICompatibleAgentResult> {
	let totalToolResultChars: number = initialToolResultChars;
	const aliasContext: ToolNameAliasContext = createToolNameAliasContext(options, tools);
	const allowedToolNames: ReadonlySet<string> = getAllowedToolNames(tools);
	let toolProtocolViolationRetries: number = 0;

	for (let step: number = startStep; step < maxSteps; step += 1) {
		if (abortSignal?.aborted) {
			throw new Error("Request cancelled");
		}

		let toolCalls: ChatCompletionMessageToolCall[] | undefined;
		let contentText: string | null;
		let reasoningContent: string = "";
		let emittedContentText: string = "";
		let suppressedStreamToolSyntax: boolean = false;
		const requiredToolCallOnStep: boolean = shouldRequireToolCallOnStep(params, step, startStep);
		if (streamAssistant) {
			const streamedMessage: StreamedAssistantMessage = await readStreamingAssistantMessage(
				client,
				params,
				options,
				messages,
				tools,
				aliasContext,
				step,
				startStep,
				onEvent,
				!requiredToolCallOnStep,
				abortSignal
			);
			toolCalls = streamedMessage.toolCalls;
			contentText = streamedMessage.contentText.length > 0 ? streamedMessage.contentText : null;
			reasoningContent = streamedMessage.reasoningContent;
			emittedContentText = streamedMessage.emittedContentText;
			suppressedStreamToolSyntax = streamedMessage.suppressedToolSyntax;
		} else {
			const requestTools: ChatCompletionTool[] = aliasContext.tools;
			const requestBody: ChatCompletionCreateParamsNonStreaming = {
				model: resolveChatModel(options),
				messages: createProviderRequestMessages(messages, aliasContext),
				tools: requestTools
			};

			applyToolChoiceForStep(requestBody, params, options, step, startStep, requestTools);
			applyChatOptions(requestBody, params, options);
			applyDeepSeekToolMode(requestBody, options, requestTools);
			applyProviderToolRequestOptions(requestBody, options, requestTools);

			const startedAtMs: number = Date.now();
			let completion;
			try {
				completion = await client.chat.completions.create(requestBody, { signal: abortSignal });
			} catch (error: unknown) {
				await recordProviderUsage({
					options,
					requestBody,
					startedAtMs,
					status: getProviderUsageStatusForError(error),
					errorCode: getProviderUsageErrorCode(error),
					streaming: false
				});
				throw error;
			}
			const choice = completion.choices[0];

			if (!choice) {
				await recordProviderUsage({
					options,
					requestBody,
					responseBody: completion,
					startedAtMs,
					status: "error",
					errorCode: "empty_choices",
					streaming: false,
					usage: parseOpenAIChatUsage(completion)
				});
				throw new Error("LLM returned empty choices");
			}

			const message = choice.message;
			await recordProviderUsage({
				options,
				requestBody,
				responseBody: completion,
				outputText: typeof message.content === "string" && message.content.length > 0 ? message.content : JSON.stringify(message),
				startedAtMs,
				status: "success",
				streaming: false,
				usage: parseOpenAIChatUsage(completion)
			});
			reasoningContent = getReasoningContent(message);
			emitReasoningContent(message, onEvent);
			toolCalls = message.tool_calls;
			contentText = message.content;
			if (shouldSplitThinkTags(options) && typeof contentText === "string") {
				const splitContent: ThinkTagSplitResult = splitMiniMaxThinkTags(contentText);
				if (splitContent.thinkingText.length > 0) {
					reasoningContent = appendReasoningContent(reasoningContent, splitContent.thinkingText);
					onEvent?.({ type: "ai.thinking.delta", text: splitContent.thinkingText });
					onEvent?.({ type: "ai.thinking.done" });
				}
				contentText = splitContent.visibleText.length > 0 ? splitContent.visibleText : null;
			}
		}

		toolCalls = normalizeProviderToolCalls(toolCalls, aliasContext);
		if (toolCalls !== undefined && toolCalls.length > 0) {
			toolCalls = filterToolCallsForAllowedTools(toolCalls, allowedToolNames);
		}

		if (!toolCalls || toolCalls.length === 0) {
			const text: string | null = contentText;

			if (requiredToolCallOnStep && allowedToolNames.size > 0) {
				if (toolProtocolViolationRetries < TOOL_PROTOCOL_VIOLATION_RETRY_LIMIT) {
					toolProtocolViolationRetries += 1;
					messages.push({
						role: "system",
						content: createMissingRequiredToolCallCorrectionMessage(Array.from(allowedToolNames), text !== null && text.length > 0)
					});
					step -= 1;
					continue;
				}

				return {
					status: "protocol_violation",
					text: "",
					reason: text
						? "模型返回了正文，但没有通过 API tool_calls 调用当前阶段要求的工具。"
						: "模型没有通过 API tool_calls 调用当前阶段要求的工具，且没有返回用户可见正文。"
				};
			}

			if (!text) {
				if (reasoningContent.trim().length > 0 && hasToolResultMessages(messages)) {
					const finalText: string = await createFinalAnswer(
						client,
						params,
						options,
						messages,
						"模型读取工具结果后只返回了 thinking/reasoning_content，没有返回用户可见正文",
						abortSignal,
						aliasContext
					);
					if (streamAssistant) {
						onEvent?.({ type: "ai.delta", text: finalText });
					}

					return { status: "completed", text: finalText };
				}

				if (reasoningContent.trim().length > 0) {
					if (allowedToolNames.size > 0 && toolProtocolViolationRetries < TOOL_PROTOCOL_VIOLATION_RETRY_LIMIT) {
						toolProtocolViolationRetries += 1;
						messages.push({
							role: "system",
							content: createReasoningOnlyCorrectionMessage(Array.from(allowedToolNames))
						});
						step -= 1;
						continue;
					}

					return {
						status: "protocol_violation",
						text: "",
						reason: "模型只返回了 thinking/reasoning_content，没有返回用户可见正文，也没有通过 API tool_calls 调用工具。"
					};
				}

				throw new Error("LLM returned empty response");
			}

			const hasKnownToolSyntax: boolean = containsKnownToolSyntax(text) || suppressedStreamToolSyntax;
			if (hasKnownToolSyntax) {
				if (toolProtocolViolationRetries < TOOL_PROTOCOL_VIOLATION_RETRY_LIMIT) {
					toolProtocolViolationRetries += 1;
					messages.push({
						role: "system",
						content: createToolProtocolCorrectionMessage(Array.from(allowedToolNames))
					});
					step -= 1;
					continue;
				}

				return {
					status: "protocol_violation",
					text: "",
					reason: "模型在文本内容中输出了 XML/DSML/裸工具标签；AgentRun v2 只接受 API tool_calls。"
				};
			}

			return { status: "completed", text };
		}

		emitModelToolCallPrelude(contentText, streamAssistant ? emittedContentText : "", onEvent);

		const assistantMessage: ChatCompletionMessageParam = createAssistantToolMessage(contentText, toolCalls, reasoningContent);

		messages.push(assistantMessage);

		let toolResults;
		try {
			if (abortSignal?.aborted) {
				throw new Error("Request cancelled");
			}
			toolResults = await dispatchToolCalls(mcpHost, toolCalls, step, gateway, onEvent, toolResultEnricher, toolContext, abortSignal);
		} catch (error: unknown) {
			if (error instanceof ToolApprovalRequiredError) {
				const pendingToolCall: ChatCompletionMessageToolCall | undefined = toolCalls.find(
					(toolCall: ChatCompletionMessageToolCall): boolean => toolCall.id === error.pendingApproval.toolCallId
				);
				const continuationMessages: ChatCompletionMessageParam[] = [...messages];

				if (pendingToolCall !== undefined) {
					continuationMessages[continuationMessages.length - 1] = createAssistantToolMessage(contentText, [pendingToolCall], reasoningContent);
				}

				return {
					status: "approval_required",
					approvalId: error.pendingApproval.approvalId,
					toolName: error.pendingApproval.llmToolName,
					reason: error.pendingApproval.reason,
					continuation: {
						kind: "chat_completions",
						messages: continuationMessages,
						nextStep: step + 1,
						totalToolResultChars,
						maxSteps,
						toolResultCharLimit: maxTotalToolResultChars
					}
				};
			}

			throw error;
		}

		let toolResultLimitReason: string | null = null;
		for (const result of toolResults) {
			const contentText: string = extractTextContent(result.content);
			const budgetedResult = fitToolResultContent(contentText, totalToolResultChars, maxTotalToolResultChars);
			totalToolResultChars += budgetedResult.chars;
			messages.push({
				...result,
				content: budgetedResult.content
			});
			if (budgetedResult.limitReached) {
				toolResultLimitReason = budgetedResult.reason ?? createToolResultLimitReason(totalToolResultChars);
			}
		}

		if (toolResultLimitReason !== null || totalToolResultChars >= maxTotalToolResultChars) {
			const reason: string = toolResultLimitReason ?? createToolResultLimitReason(totalToolResultChars, maxTotalToolResultChars);
			if (shouldPauseForToolBudget(gateway)) {
				return createToolBudgetRequiredResult({
					limitKind: "tool_result_chars",
					reason,
					usedSteps: step + 1,
					maxSteps,
					totalToolResultChars,
					toolResultCharLimit: maxTotalToolResultChars,
					continuation: {
						kind: "chat_completions",
						messages: [...messages],
						nextStep: step + 1,
						totalToolResultChars,
						maxSteps,
						toolResultCharLimit: maxTotalToolResultChars
					}
				});
			}
			const finalText: string = await createFinalAnswer(
				client,
				params,
				options,
				messages,
				reason,
				abortSignal,
				aliasContext
			);
			if (streamAssistant) {
				onEvent?.({ type: "ai.delta", text: finalText });
			}

			return {
				status: "completed",
				text: finalText
			};
		}
	}

	const stepLimitReason: string = `工具调用达到最大步数 ${maxSteps}，当前工具结果总量为 ${totalToolResultChars} 字符`;
	if (shouldPauseForToolBudget(gateway)) {
		return createToolBudgetRequiredResult({
			limitKind: "steps",
			reason: stepLimitReason,
			usedSteps: maxSteps,
			maxSteps,
			totalToolResultChars,
			toolResultCharLimit: maxTotalToolResultChars,
			continuation: {
				kind: "chat_completions",
				messages: [...messages],
				nextStep: maxSteps,
				totalToolResultChars,
				maxSteps,
				toolResultCharLimit: maxTotalToolResultChars
			}
		});
	}

	const finalText: string = await createFinalAnswer(
		client,
		params,
		options,
		messages,
		stepLimitReason,
		abortSignal,
		aliasContext
	);
	if (streamAssistant) {
		onEvent?.({ type: "ai.delta", text: finalText });
	}

	return {
		status: "completed",
		text: finalText
	};
}

export async function runOpenAICompatibleAgent(
	params: AiChatParams,
	options: DeepSeekChatOptions,
	history: ChatMessage[],
	systemPrompt: string,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames?: readonly string[] | undefined,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	toolResultEnricher?: ToolResultEnricher | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<OpenAICompatibleAgentResult> {
	const client: OpenAI = createDeepSeekClient(options);
	const toolCatalog = createWorkspaceToolCatalog(toolContext);
	const tools = allowedToolNames !== undefined
		? toolCatalog.getDefinitionsForNames(allowedToolNames)
		: toolCatalog.getDefinitions();

	const maxSteps: number = getInitialMaxToolSteps(params);

	const messages: ChatCompletionMessageParam[] = createMessages(params, history, systemPrompt);

	return runAgentLoop(client, params, options, messages, mcpHost, gateway, tools, 0, maxSteps, 0, MAX_TOTAL_TOOL_RESULT_CHARS, false, onEvent, abortSignal, toolResultEnricher, toolContext);
}

export async function runOpenAICompatibleAgentStreaming(
	params: AiChatParams,
	options: DeepSeekChatOptions,
	history: ChatMessage[],
	systemPrompt: string,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames?: readonly string[] | undefined,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	toolResultEnricher?: ToolResultEnricher | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<OpenAICompatibleAgentResult> {
	const client: OpenAI = createDeepSeekClient(options);
	const toolCatalog = createWorkspaceToolCatalog(toolContext);
	const tools = allowedToolNames !== undefined
		? toolCatalog.getDefinitionsForNames(allowedToolNames)
		: toolCatalog.getDefinitions();

	const maxSteps: number = getInitialMaxToolSteps(params);

	const messages: ChatCompletionMessageParam[] = createMessages(params, history, systemPrompt);

	return runAgentLoop(client, params, options, messages, mcpHost, gateway, tools, 0, maxSteps, 0, MAX_TOTAL_TOOL_RESULT_CHARS, true, onEvent, abortSignal, toolResultEnricher, toolContext);
}

export async function continueOpenAICompatibleAgent(
	params: AiChatParams,
	options: DeepSeekChatOptions,
	continuation: OpenAICompatibleAgentContinuation,
	approvedToolResult: ApprovedToolResult,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames?: readonly string[] | undefined,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	toolResultEnricher?: ToolResultEnricher | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<OpenAICompatibleAgentResult> {
	const client: OpenAI = createDeepSeekClient(options);
	const toolCatalog = createWorkspaceToolCatalog(toolContext);
	const tools = allowedToolNames !== undefined
		? toolCatalog.getDefinitionsForNames(allowedToolNames)
		: toolCatalog.getDefinitions();
	const aliasContext: ToolNameAliasContext = createToolNameAliasContext(options, tools);
	const messages: ChatCompletionMessageParam[] = [...continuation.messages];
	const maxTotalToolResultChars: number = getContinuationToolResultCharLimit(continuation);
	const budgetedResult = fitToolResultContent(approvedToolResult.content, continuation.totalToolResultChars, maxTotalToolResultChars);
	const toolMessage: ChatCompletionToolMessageParam = {
		role: "tool",
		tool_call_id: approvedToolResult.toolCallId,
		content: budgetedResult.content
	};
	const totalToolResultChars: number = continuation.totalToolResultChars + budgetedResult.chars;

	messages.push(toolMessage);

	if (budgetedResult.limitReached || totalToolResultChars >= maxTotalToolResultChars) {
		const reason: string = budgetedResult.reason ?? createToolResultLimitReason(totalToolResultChars, maxTotalToolResultChars);
		if (shouldPauseForToolBudget(gateway)) {
			return createToolBudgetRequiredResult({
				limitKind: "tool_result_chars",
				reason,
				usedSteps: continuation.nextStep,
				maxSteps: getContinuationMaxSteps(params, continuation),
				totalToolResultChars,
				toolResultCharLimit: maxTotalToolResultChars,
				continuation: {
					...continuation,
					messages: [...messages],
					totalToolResultChars,
					maxSteps: getContinuationMaxSteps(params, continuation),
					toolResultCharLimit: maxTotalToolResultChars
				}
			});
		}
		return {
			status: "completed",
			text: await createFinalAnswer(
				client,
				params,
				options,
				messages,
				reason,
				abortSignal,
				aliasContext
			)
		};
	}

	const maxSteps: number = getContinuationMaxSteps(params, continuation);

	return runAgentLoop(
		client,
		params,
		options,
		messages,
		mcpHost,
		gateway,
		tools,
		continuation.nextStep,
		maxSteps,
		totalToolResultChars,
		maxTotalToolResultChars,
		false,
		onEvent,
		abortSignal,
		toolResultEnricher,
		toolContext
	);
}

export async function continueOpenAICompatibleAgentStreaming(
	params: AiChatParams,
	options: DeepSeekChatOptions,
	continuation: OpenAICompatibleAgentContinuation,
	approvedToolResult: ApprovedToolResult,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames?: readonly string[] | undefined,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	toolResultEnricher?: ToolResultEnricher | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<OpenAICompatibleAgentResult> {
	const client: OpenAI = createDeepSeekClient(options);
	const toolCatalog = createWorkspaceToolCatalog(toolContext);
	const tools = allowedToolNames !== undefined
		? toolCatalog.getDefinitionsForNames(allowedToolNames)
		: toolCatalog.getDefinitions();
	const aliasContext: ToolNameAliasContext = createToolNameAliasContext(options, tools);
	const messages: ChatCompletionMessageParam[] = [...continuation.messages];
	const maxTotalToolResultChars: number = getContinuationToolResultCharLimit(continuation);
	const budgetedResult = fitToolResultContent(approvedToolResult.content, continuation.totalToolResultChars, maxTotalToolResultChars);
	const toolMessage: ChatCompletionToolMessageParam = {
		role: "tool",
		tool_call_id: approvedToolResult.toolCallId,
		content: budgetedResult.content
	};
	const totalToolResultChars: number = continuation.totalToolResultChars + budgetedResult.chars;

	messages.push(toolMessage);

	if (budgetedResult.limitReached || totalToolResultChars >= maxTotalToolResultChars) {
		const reason: string = budgetedResult.reason ?? createToolResultLimitReason(totalToolResultChars, maxTotalToolResultChars);
		if (shouldPauseForToolBudget(gateway)) {
			return createToolBudgetRequiredResult({
				limitKind: "tool_result_chars",
				reason,
				usedSteps: continuation.nextStep,
				maxSteps: getContinuationMaxSteps(params, continuation),
				totalToolResultChars,
				toolResultCharLimit: maxTotalToolResultChars,
				continuation: {
					...continuation,
					messages: [...messages],
					totalToolResultChars,
					maxSteps: getContinuationMaxSteps(params, continuation),
					toolResultCharLimit: maxTotalToolResultChars
				}
			});
		}
		const finalText: string = await createFinalAnswer(
			client,
			params,
			options,
			messages,
			reason,
			abortSignal,
			aliasContext
		);
		onEvent?.({ type: "ai.delta", text: finalText });

		return {
			status: "completed",
			text: finalText
		};
	}

	const maxSteps: number = getContinuationMaxSteps(params, continuation);

	return runAgentLoop(
		client,
		params,
		options,
		messages,
		mcpHost,
		gateway,
		tools,
		continuation.nextStep,
		maxSteps,
		totalToolResultChars,
		maxTotalToolResultChars,
		true,
		onEvent,
		abortSignal,
		toolResultEnricher,
		toolContext
	);
}

async function continueOpenAICompatibleAgentAfterToolBudgetInternal(
	params: AiChatParams,
	options: DeepSeekChatOptions,
	continuation: OpenAICompatibleAgentContinuation,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames: readonly string[] | undefined,
	onEvent: OnToolEvent | undefined,
	abortSignal: AbortSignal | undefined,
	toolResultEnricher: ToolResultEnricher | undefined,
	toolContext: ToolExecutionContext | undefined,
	streamAssistant: boolean
): Promise<OpenAICompatibleAgentResult> {
	const client: OpenAI = createDeepSeekClient(options);
	const toolCatalog = createWorkspaceToolCatalog(toolContext);
	const tools = allowedToolNames !== undefined
		? toolCatalog.getDefinitionsForNames(allowedToolNames)
		: toolCatalog.getDefinitions();
	return runAgentLoop(
		client,
		params,
		options,
		[...continuation.messages],
		mcpHost,
		gateway,
		tools,
		continuation.nextStep,
		getContinuedMaxSteps(params, continuation),
		continuation.totalToolResultChars,
		getContinuedToolResultCharLimit(continuation),
		streamAssistant,
		onEvent,
		abortSignal,
		toolResultEnricher,
		toolContext
	);
}

export async function continueOpenAICompatibleAgentAfterToolBudget(
	params: AiChatParams,
	options: DeepSeekChatOptions,
	continuation: OpenAICompatibleAgentContinuation,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames?: readonly string[] | undefined,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	toolResultEnricher?: ToolResultEnricher | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<OpenAICompatibleAgentResult> {
	return continueOpenAICompatibleAgentAfterToolBudgetInternal(params, options, continuation, mcpHost, gateway, allowedToolNames, onEvent, abortSignal, toolResultEnricher, toolContext, false);
}

export async function continueOpenAICompatibleAgentAfterToolBudgetStreaming(
	params: AiChatParams,
	options: DeepSeekChatOptions,
	continuation: OpenAICompatibleAgentContinuation,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames?: readonly string[] | undefined,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	toolResultEnricher?: ToolResultEnricher | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<OpenAICompatibleAgentResult> {
	return continueOpenAICompatibleAgentAfterToolBudgetInternal(params, options, continuation, mcpHost, gateway, allowedToolNames, onEvent, abortSignal, toolResultEnricher, toolContext, true);
}

async function finalizeOpenAICompatibleAgentAfterToolBudgetInternal(
	params: AiChatParams,
	options: DeepSeekChatOptions,
	continuation: OpenAICompatibleAgentContinuation,
	allowedToolNames: readonly string[] | undefined,
	reason: string,
	onEvent: OnToolEvent | undefined,
	abortSignal: AbortSignal | undefined,
	toolContext: ToolExecutionContext | undefined,
	streamAssistant: boolean
): Promise<OpenAICompatibleAgentResult> {
	const client: OpenAI = createDeepSeekClient(options);
	const toolCatalog = createWorkspaceToolCatalog(toolContext);
	const tools = allowedToolNames !== undefined
		? toolCatalog.getDefinitionsForNames(allowedToolNames)
		: toolCatalog.getDefinitions();
	const aliasContext: ToolNameAliasContext = createToolNameAliasContext(options, tools);
	const finalText: string = await createFinalAnswer(
		client,
		params,
		options,
		[...continuation.messages],
		reason,
		abortSignal,
		aliasContext
	);
	if (streamAssistant) {
		onEvent?.({ type: "ai.delta", text: finalText });
	}
	return {
		status: "completed",
		text: finalText
	};
}

export async function finalizeOpenAICompatibleAgentAfterToolBudget(
	params: AiChatParams,
	options: DeepSeekChatOptions,
	continuation: OpenAICompatibleAgentContinuation,
	allowedToolNames: readonly string[] | undefined,
	reason: string,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<OpenAICompatibleAgentResult> {
	return finalizeOpenAICompatibleAgentAfterToolBudgetInternal(params, options, continuation, allowedToolNames, reason, onEvent, abortSignal, toolContext, false);
}

export async function finalizeOpenAICompatibleAgentAfterToolBudgetStreaming(
	params: AiChatParams,
	options: DeepSeekChatOptions,
	continuation: OpenAICompatibleAgentContinuation,
	allowedToolNames: readonly string[] | undefined,
	reason: string,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<OpenAICompatibleAgentResult> {
	return finalizeOpenAICompatibleAgentAfterToolBudgetInternal(params, options, continuation, allowedToolNames, reason, onEvent, abortSignal, toolContext, true);
}
