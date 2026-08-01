import type WebSocket from "ws";
import type { AiChatParams, ChatMessage, ClientRequest, MessageTextAnchor, ProviderId } from "../../protocol/types.js";
import { messageTextAnchorSchema } from "../../protocol/schema.js";
import { composeSystemPrompt } from "../../prompts/registry.js";
import { getUserPrompt } from "../../user-prompt-store.js";
import { streamChatWithProvider } from "../../providers/deepseek-client.js";
import { loadProviderConfigWithSecret, type ProviderConfigWithSecret } from "../../providers/provider-config-store.js";
import { getProviderAdapterFamily, getProviderEndpointTypeForModel } from "../../providers/provider-registry.js";
import { ProviderEmptyResponseError, isProviderEmptyResponseError } from "../../providers/provider-response-error.js";
import type { ProviderChatOptions } from "../../providers/provider-types.js";
import { withProviderUsageContext } from "../../usage/provider-recorder.js";
import { resolveModelProfile } from "../../tokens/model-profiles.js";
import {
	appendSelectionAskTurn,
	createOrReadSelectionAskThread,
	listSelectionAskThreads,
	readSelectionAskMessagesForProvider,
	readSelectionAskThread,
	readSelectionAskThreadPage,
	updateSelectionAskAssistantMessage,
	type SelectionAskMessage,
	type SelectionAskThread
} from "../../session/selection-ask-store.js";
import { openSession } from "../../session/session-store.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession } from "../client-session.js";
import { getClientConnection } from "../client-connections.js";
import { classifyProviderError } from "../../providers/provider-error.js";
import { logger } from "../../logger.js";
import { sendJson } from "../send-json.js";
import { sendStudioDirectSessionEvent } from "../session-events.js";

const INITIAL_CONTEXT_LABELS = {
	"zh-CN": {
		instruction: "请解释下面选中的文本，并结合给出的局部上下文说明它在这里的含义。回答应清楚、直接，必要时给一个简短例子。",
		selected: "选中文本",
		before: "前文",
		after: "后文"
	},
	"en-US": {
		instruction: "Explain the selected text and what it means in the supplied local context. Be clear and direct, and include a short example when useful.",
		selected: "Selected text",
		before: "Context before",
		after: "Context after"
	}
} as const;

function createInitialQuestion(anchor: MessageTextAnchor, locale: "zh-CN" | "en-US"): string {
	const labels = INITIAL_CONTEXT_LABELS[locale];
	return [
		labels.instruction,
		"",
		`${labels.selected}:`,
		anchor.quote,
		...(anchor.contextBefore.length > 0 ? ["", `${labels.before}:`, anchor.contextBefore] : []),
		...(anchor.contextAfter.length > 0 ? ["", `${labels.after}:`, anchor.contextAfter] : [])
	].join("\n");
}

function createThreadOptions(thread: SelectionAskThread, apiKey: string, requestId: string): ProviderChatOptions {
	const endpointType = getProviderEndpointTypeForModel(thread.provider, thread.model);
	return withProviderUsageContext({
		provider: thread.provider,
		apiKey,
		model: thread.model,
		baseUrl: thread.baseUrl,
		endpointType,
		adapterFamily: getProviderAdapterFamily(thread.provider, endpointType),
		modelProfile: resolveModelProfile(thread.provider, thread.model)
	}, {
		requestId,
		runId: thread.threadId,
		sessionId: thread.sessionId,
		operation: "selection_ask"
	});
}

async function assertSelectionSourceExists(sessionId: string, anchor: MessageTextAnchor): Promise<void> {
	const stored = await openSession(sessionId);
	const exists: boolean = stored.messages.some((message): boolean => (
		message.requestId === anchor.requestId
		&& message.role === anchor.role
	));
	if (!exists) {
		throw new Error("selection_source_not_found: The selected source message no longer exists.");
	}
}

function assertStudioRequest(socket: WebSocket, request: ClientRequest): void {
	if (getClientConnection(socket)?.clientType !== "studio") {
		throw new Error(`${request.method} is only available to Daedalus Studio.`);
	}
}

function assertActiveSession(session: ClientSession, sessionId: string): void {
	if (session.sessionId !== sessionId) {
		throw new Error("selection_ask_session_mismatch: Selection Ask is only available for the active session.");
	}
}

function createSelectionAskSystemPromptSuffix(anchor: MessageTextAnchor): string {
	return [
		"## Selection Ask boundary",
		"This is an isolated explanatory side conversation attached to selected message text.",
		"Answer using only the selected excerpt, its supplied local context, and this side conversation's own messages.",
		"Do not claim to have inspected the current project or editor. No tools are available in this conversation.",
		`The source role was ${anchor.role}.`
	].join("\n");
}

async function runSelectionAskResponse(params: {
	socket: WebSocket;
	thread: SelectionAskThread;
	requestId: string;
	assistantMessage: SelectionAskMessage;
	userMessage: string;
	history: ChatMessage[];
	apiKey: string;
}): Promise<void> {
	const options: ProviderChatOptions = createThreadOptions(params.thread, params.apiKey, params.requestId);
	const storedUserPrompt: string = await getUserPrompt();
	const selectionBoundary: string = createSelectionAskSystemPromptSuffix(params.thread.anchor);
	const extraPrompt: string = [storedUserPrompt.trim(), selectionBoundary].filter(Boolean).join("\n\n");
	const systemPrompt: string = await composeSystemPrompt(
		undefined,
		extraPrompt,
		`provider: ${params.thread.provider}\nmodel: ${params.thread.model}`,
		"ask"
	);
	const chatParams: AiChatParams = {
		message: params.userMessage,
		mode: "ask",
		options: {
			stream: true,
			workflow: "single",
			...(params.thread.reasoningEffort === undefined ? {} : { reasoningEffort: params.thread.reasoningEffort })
		}
	};
	let content: string = "";
	let lastPersistedAt: number = Date.now();
	try {
		for (let attempt: number = 0; attempt < 2; attempt += 1) {
			let attemptContent: string = "";
			try {
				for await (const delta of streamChatWithProvider(chatParams, options, params.history, systemPrompt)) {
					attemptContent += delta;
					content += delta;
					sendStudioDirectSessionEvent(
						params.socket,
						params.thread.sessionId,
						params.requestId,
						params.thread.threadId,
						"session.selectionAsk.message.delta",
						{
							threadId: params.thread.threadId,
							messageId: params.assistantMessage.messageId,
							text: delta
						}
					);
					if (Date.now() - lastPersistedAt >= 250) {
						await updateSelectionAskAssistantMessage(
							params.thread.threadId,
							params.assistantMessage.messageId,
							content,
							"running"
						);
						lastPersistedAt = Date.now();
					}
				}
				if (attemptContent.trim().length === 0) {
					content = "";
					throw new ProviderEmptyResponseError();
				}
				break;
			} catch (error: unknown) {
				if (attempt === 0 && content.trim().length === 0 && isProviderEmptyResponseError(error)) {
					content = "";
					continue;
				}
				throw error;
			}
		}
		await updateSelectionAskAssistantMessage(
			params.thread.threadId,
			params.assistantMessage.messageId,
			content,
			"completed"
		);
		sendStudioDirectSessionEvent(
			params.socket,
			params.thread.sessionId,
			params.requestId,
			params.thread.threadId,
			"session.selectionAsk.message.done",
			{
				threadId: params.thread.threadId,
				messageId: params.assistantMessage.messageId,
				content
			}
		);
	} catch (error: unknown) {
		const providerError = classifyProviderError(error);
		await updateSelectionAskAssistantMessage(
			params.thread.threadId,
			params.assistantMessage.messageId,
			content,
			"failed",
			providerError.message
		);
		logger.error("selection_ask", "response_failed", error, {
			sessionId: params.thread.sessionId,
			threadId: params.thread.threadId,
			requestId: params.requestId,
			provider: params.thread.provider,
			model: params.thread.model
		});
		sendStudioDirectSessionEvent(
			params.socket,
			params.thread.sessionId,
			params.requestId,
			params.thread.threadId,
			"session.selectionAsk.message.error",
			{
				threadId: params.thread.threadId,
				messageId: params.assistantMessage.messageId,
				code: providerError.code,
				message: providerError.message,
				partialContent: content
			}
		);
	}
}

function sendSelectionAskError(socket: WebSocket, request: ClientRequest, error: unknown): void {
	const rawMessage: string = error instanceof Error ? error.message : String(error);
	const separator: number = rawMessage.indexOf(": ");
	const code: string = separator > 0 ? rawMessage.slice(0, separator) : "selection_ask_error";
	const message: string = separator > 0 ? rawMessage.slice(separator + 2) : rawMessage;
	sendJson(socket, {
		type: "response",
		id: request.id,
		ok: false,
		error: { code, message }
	});
}

async function prepareSelectionAskTurn(params: {
	socket: WebSocket;
	request: ClientRequest;
	thread: SelectionAskThread;
	userMessage: string;
	apiKey: string;
}): Promise<{
	userMessage: SelectionAskMessage;
	assistantMessage: SelectionAskMessage;
	start: () => void;
}> {
	const history: ChatMessage[] = (await readSelectionAskMessagesForProvider(params.thread.threadId))
		.map((message): ChatMessage => ({ role: message.role, content: message.content }));
	const turn = await appendSelectionAskTurn(params.thread, params.request.id, params.userMessage);
	return {
		...turn,
		start: (): void => {
			void runSelectionAskResponse({
				socket: params.socket,
				thread: params.thread,
				requestId: params.request.id,
				assistantMessage: turn.assistantMessage,
				userMessage: params.userMessage,
				history,
				apiKey: params.apiKey
			});
		}
	};
}

async function loadThreadProviderSecret(thread: SelectionAskThread): Promise<string> {
	const config: ProviderConfigWithSecret | null = await loadProviderConfigWithSecret(thread.provider);
	if (config?.apiKey === undefined) {
		throw new Error(`provider_not_configured: ${thread.provider} API key is not configured.`);
	}
	return config.apiKey;
}

export async function handleSelectionAskRequest(
	socket: WebSocket,
	request: ClientRequest,
	session: ClientSession,
	_mcpHost: McpHost
): Promise<void> {
	try {
		assertStudioRequest(socket, request);
		switch (request.method) {
			case "session.selectionAsk.list":
				assertActiveSession(session, request.params.sessionId);
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: true,
					result: { sessionId: request.params.sessionId, threads: await listSelectionAskThreads(request.params.sessionId) }
				});
				return;

			case "session.selectionAsk.get": {
				assertActiveSession(session, request.params.sessionId);
				const page = await readSelectionAskThreadPage(
					request.params.sessionId,
					request.params.threadId,
					request.params.beforeSequence,
					request.params.limit
				);
				if (page === null) {
					throw new Error("selection_ask_not_found: Selection Ask thread not found.");
				}
				sendJson(socket, { type: "response", id: request.id, ok: true, result: page });
				return;
			}

			case "session.selectionAsk.create": {
				assertActiveSession(session, request.params.sessionId);
				const anchor: MessageTextAnchor = messageTextAnchorSchema.parse(request.params.anchor);
				await assertSelectionSourceExists(request.params.sessionId, anchor);
				const provider: ProviderId = session.activeProvider;
				const model: string = session.providerModel ?? session.modelProfile.model;
				const config: ProviderConfigWithSecret | null = await loadProviderConfigWithSecret(provider);
				const apiKey: string | undefined = session.providerApiKey ?? config?.apiKey;
				if (apiKey === undefined) {
					throw new Error(`provider_not_configured: ${provider} API key is not configured.`);
				}
				const result = await createOrReadSelectionAskThread({
					sessionId: request.params.sessionId,
					anchor,
					provider,
					model,
					reasoningEffort: session.workbenchComposer.reasoningEffort,
					baseUrl: session.providerBaseUrl ?? config?.baseUrl
				});
				if (!result.created) {
					const page = await readSelectionAskThreadPage(result.thread.sessionId, result.thread.threadId, undefined, 100);
					sendJson(socket, {
						type: "response",
						id: request.id,
						ok: true,
						result: { created: false, ...page }
					});
					return;
				}
				const initialQuestion: string = createInitialQuestion(anchor, request.params.locale ?? "zh-CN");
				const turn = await prepareSelectionAskTurn({ socket, request, thread: result.thread, userMessage: initialQuestion, apiKey });
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: true,
					result: { created: true, thread: { ...result.thread, status: "running" }, messages: [turn.userMessage, turn.assistantMessage], hasMoreBefore: false }
				});
				turn.start();
				return;
			}

			case "session.selectionAsk.send": {
				assertActiveSession(session, request.params.sessionId);
				const thread: SelectionAskThread | null = await readSelectionAskThread(request.params.sessionId, request.params.threadId);
				if (thread === null) {
					throw new Error("selection_ask_not_found: Selection Ask thread not found.");
				}
				const apiKey: string = await loadThreadProviderSecret(thread);
				const turn = await prepareSelectionAskTurn({
					socket,
					request,
					thread,
					userMessage: request.params.message,
					apiKey
				});
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: true,
					result: { thread: { ...thread, status: "running" }, messages: [turn.userMessage, turn.assistantMessage] }
				});
				turn.start();
				return;
			}

			default:
				throw new Error(`Unsupported selection Ask method: ${request.method}`);
		}
	} catch (error: unknown) {
		sendSelectionAskError(socket, request, error);
	}
}
