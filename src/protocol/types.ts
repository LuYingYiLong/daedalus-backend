import type { z } from "zod";
import type { additionalContextItemSchema, aiChatParamsSchema, clientRequestSchema, messageTextAnchorSchema, promptIdSchema, skillIdSchema, skillRefSchema } from "./schema.js";

export type AiChatParams = z.infer<typeof aiChatParamsSchema>;

export type AdditionalContextItem = z.infer<typeof additionalContextItemSchema>;
export type MessageTextAnchor = z.infer<typeof messageTextAnchorSchema>;

export type ClientRequest = z.infer<typeof clientRequestSchema>;

export type PromptId = z.infer<typeof promptIdSchema>;

export type SkillId = z.infer<typeof skillIdSchema>;
export type SkillRef = z.infer<typeof skillRefSchema>;

export type ProviderId = string;

export type ChatMessage = {
	role: "system" | "user" | "assistant";
	content: string;
	requestId?: string | undefined;
	createdAt?: string | undefined;
	additionalContext?: AdditionalContextItem[] | undefined;
	skillRefs?: SkillRef[] | undefined;
	excludeFromLlmContext?: true | undefined;
	status?: "failed" | undefined;
	error?: {
		code: string;
		message: string;
	} | undefined;
};

export type ServerResponse =
	| {
		type: "response";
		id: string;
		ok: true;
		result: unknown;
	}
	| {
		type: "response";
		id: string;
		ok: false;
		error: {
			code: string;
			message: string;
		};
	};

export type CanonicalServerEventName =
	| "agent.run.state"
	| "agent.goal.state"
	| "agent.run.started"
	| "agent.run.snapshot"
	| "agent.step.started"
	| "agent.step.outcome"
	| "agent.summary.started"
	| "agent.status"
	| "agent.todo.dismissed"
	| "agent.message.delta"
	| "agent.message.done"
	| "agent.thinking.delta"
	| "agent.thinking.done"
	| "agent.provider.reconnect"
	| "agent.context.compression"
	| "agent.tool.call"
	| "agent.tool.reviewed"
	| "agent.tool.progress"
	| "agent.tool.result"
	| "agent.tool.error"
	| "agent.tool.approval_required"
	| "agent.tool.approved"
	| "agent.tool.rejected"
	| "agent.run.paused"
	| "agent.run.tool_budget_required"
	| "agent.run.tool_budget.resolved"
	| "agent.run.done"
	| "agent.run.error"
	| "agent.run.cancelled"
	| "terminal.job.started"
	| "terminal.job.timer"
	| "terminal.job.completed"
	| "terminal.job.failed"
	| "terminal.job.cancelled"
	| "terminal.job.resume_started"
	| "terminal.job.resume_skipped"
	| "client.connected"
	| "client.disconnected"
	| "editor.instance.updated"
	| "editor.instance.offline"
	| "session.subscriber.updated"
	| "session.run.busy"
	| "session.workbench.updated"
	| "session.model.changed"
	| "message.queue.updated"
	| "plan.clarification.required"
	| "plan.generated"
	| "plan.revised"
	| "plan.approved"
	| "plan.execution.started"
	| "plan.error"
	| "guide.added"
	| "guide.updated"
	| "guide.deleted"
	| "guide.reordered"
	| "guide.applied"
	| "session.renamed"
	| "editor.tool.requested"
	| "mcp.config.updated"
	| "skill.catalog.changed"
	| "usage.metrics.recorded";

export type InternalLegacyServerEventName =
	| "ai.delta"
	| "ai.done"
	| "ai.status"
	| "ai.paused"
	| "ai.thinking.delta"
	| "ai.thinking.done"
	| "tool.call"
	| "tool.progress"
	| "tool.result"
	| "tool.error"
	| "tool.approval_required"
	| "tool.approved"
	| "tool.rejected"
	| "workflow.started"
	| "workflow.phase.started"
	| "workflow.todo.updated"
	| "workflow.todo.dismissed"
	| "workflow.phase.outcome"
	| "workflow.phase.done"
	| "workflow.done"
	| "workflow.error";

export type ServerEventNameInput = CanonicalServerEventName | InternalLegacyServerEventName;

export type StudioDirectEventName =
	| "session.selectionAsk.message.delta"
	| "session.selectionAsk.message.done"
	| "session.selectionAsk.message.error"
	| "browser.tool.request"
	| "browser.tool.cancel";

export type ServerEvent = {
	protocolVersion: 3;
	type: "event";
	eventId: string;
	event: CanonicalServerEventName | StudioDirectEventName;
	sessionId: string;
	requestId: string;
	runId: string;
	sequence: number;
	createdAt: string;
	data?: unknown;
};

export type ModelProfile = {
	provider: ProviderId;
	model: string;
	contextWindowTokens: number;
	maxOutputTokens: number;
	defaultOutputReserveTokens: number;
	safetyMarginTokens: number;
};
