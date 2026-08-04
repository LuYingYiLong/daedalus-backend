import type { ChatMessage } from "../protocol/types.js";
import { chatWithDeepSeek } from "../providers/deepseek-client.js";
import { writeSummary, type SessionSummary } from "../session/session-store.js";
import type { ClientSession } from "./client-session.js";
import { createProviderChatOptions } from "./provider-chat-options.js";
import { createSummaryMessage, filterSessionLlmContextMessages, loadSessionCompressorPrompt } from "./token-budget.js";
import { withProviderUsageContext } from "../usage/provider-recorder.js";

export type SessionCompressionResult =
	| {
		compressed: true;
		oldMessageCount: number;
		keptMessageCount: number;
		summaryLength: number;
	}
	| {
		compressed: false;
		reason: string;
		messageCount: number;
	};

export async function compressSessionHistory(
	session: ClientSession,
	apiKey: string,
	keepRecent: number = 8,
	requestId: string = `session-compression-${Date.now().toString(36)}`
): Promise<SessionCompressionResult> {
	if (!session.sessionId) {
		return { compressed: false, reason: "No active session", messageCount: session.messages.length };
	}

	const allMessages: ChatMessage[] = session.messages;
	if (allMessages.length <= keepRecent) {
		return { compressed: false, reason: "Not enough messages", messageCount: allMessages.length };
	}

	const oldMessages: ChatMessage[] = allMessages.slice(0, allMessages.length - keepRecent);
	const recentMessages: ChatMessage[] = allMessages.slice(allMessages.length - keepRecent);
	const conversationText: string = filterSessionLlmContextMessages(session, oldMessages)
		.map((message: ChatMessage): string => `${message.role}: ${message.content.slice(0, 300)}`)
		.join("\n");
	const compressorOptions = withProviderUsageContext(createProviderChatOptions(session, apiKey), {
		requestId,
		runId: requestId,
		sessionId: session.sessionId,
		workspaceId: session.activeWorkspace?.id,
		operation: "session_compression"
	});
	const compressorPrompt: string = await loadSessionCompressorPrompt();
	const summaryContent: string = await chatWithDeepSeek({
		message: conversationText,
		options: {
			maxTokens: 800,
			workflow: "single"
		}
	}, compressorOptions, [], compressorPrompt);
	const summaryObj: SessionSummary = {
		content: summaryContent,
		messageCount: oldMessages.length,
		tokenEstimate: Math.ceil(conversationText.length / 3),
		generatedAt: new Date().toISOString()
	};

	await writeSummary(session.sessionId, summaryObj);
	session.summaryMessage = createSummaryMessage(summaryObj);
	session.summaryCoveredMessageCount = summaryObj.messageCount;
	session.messages = allMessages;

	return {
		compressed: true,
		oldMessageCount: oldMessages.length,
		keptMessageCount: recentMessages.length,
		summaryLength: summaryContent.length
	};
}
