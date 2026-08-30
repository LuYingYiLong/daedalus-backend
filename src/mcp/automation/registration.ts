import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AutomationConfig } from "./config.js";
import { getAutomationRpcClient, type AutomationRpcClient } from "./rpc-client.js";
import {
	isApprovalAllowed,
	redactAutomationResult,
	selectMatchingApproval,
	type ApprovalCandidate
} from "./security.js";

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
};

function asJsonTextResult(value: unknown): ToolResult {
	return {
		content: [{
			type: "text",
			text: JSON.stringify(redactAutomationResult(value), null, 2)
		}]
	};
}

function asErrorResult(error: unknown): ToolResult {
	return {
		isError: true,
		content: [{
			type: "text",
			text: error instanceof Error ? error.message : String(error)
		}]
	};
}

async function runTool(action: () => Promise<unknown>): Promise<ToolResult> {
	try {
		return asJsonTextResult(await action());
	} catch (error: unknown) {
		return asErrorResult(error);
	}
}

function getPendingApprovals(result: unknown): ApprovalCandidate[] {
	if (result !== null && typeof result === "object" && Array.isArray((result as Record<string, unknown>).pending)) {
		return (result as Record<string, unknown>).pending as ApprovalCandidate[];
	}
	return [];
}

function getClient(config: AutomationConfig): AutomationRpcClient {
	return getAutomationRpcClient(config);
}

export function registerAutomationTools(server: McpServer, config: AutomationConfig): void {
	server.registerTool("daedalus_backend_health", {
		title: "Daedalus backend health",
		description: "Read backend health through the public WebSocket RPC boundary.",
		inputSchema: z.object({
			timeoutMs: z.number().int().positive().max(120000).optional()
		})
	}, async (input: { timeoutMs?: number | undefined }): Promise<ToolResult> => runTool(async (): Promise<unknown> => {
		const client = getClient(config);
		const result = await client.sendRequest("backend.health", undefined, input.timeoutMs);
		return {
			backendUrl: config.backendUrl,
			health: result
		};
	}));

	server.registerTool("daedalus_configure_environment", {
		title: "Configure Daedalus environment",
		description: "Configure the active runtime workspace through environment.configure before creating or opening smoke sessions.",
		inputSchema: z.object({
			workspaceRoot: z.string().min(1),
			godotExecutablePath: z.string().min(1).optional(),
			timeoutMs: z.number().int().positive().max(300000).optional()
		})
	}, async (input: {
		workspaceRoot: string;
		godotExecutablePath?: string | undefined;
		timeoutMs?: number | undefined;
	}): Promise<ToolResult> => runTool(async (): Promise<unknown> => {
		const params: Record<string, unknown> = {
			workspaceRoot: input.workspaceRoot
		};
		if (input.godotExecutablePath !== undefined) {
			params.godotExecutablePath = input.godotExecutablePath;
		}
		return getClient(config).sendRequest("environment.configure", params, input.timeoutMs);
	}));

	server.registerTool("daedalus_create_session", {
		title: "Create Daedalus session",
		description: "Create a backend session for smoke or automation testing.",
		inputSchema: z.object({
			title: z.string().min(1).max(200),
			workspaceId: z.string().min(1).optional(),
			skillId: z.string().min(1).optional()
		})
	}, async (input: { title: string; workspaceId?: string | undefined; skillId?: string | undefined }): Promise<ToolResult> => runTool(async (): Promise<unknown> =>
		getClient(config).sendRequest("session.create", input)
	));

	server.registerTool("daedalus_open_session", {
		title: "Open Daedalus session",
		description: "Open an existing session and make it active for subsequent automation calls.",
		inputSchema: z.object({
			sessionId: z.string().min(1),
			limit: z.number().int().positive().max(500).optional()
		})
	}, async (input: { sessionId: string; limit?: number | undefined }): Promise<ToolResult> => runTool(async (): Promise<unknown> =>
		getClient(config).sendRequest("session.open", input)
	));

	server.registerTool("daedalus_get_session_info", {
		title: "Get Daedalus session info",
		description: "Read provider, approval, workspace, editor and diagnostics runtime state through session.info.",
		inputSchema: z.object({
			sessionId: z.string().min(1).optional(),
			timeoutMs: z.number().int().positive().max(300000).optional()
		})
	}, async (input: { sessionId?: string | undefined; timeoutMs?: number | undefined }): Promise<ToolResult> => runTool(async (): Promise<unknown> => {
		const client = getClient(config);
		if (input.sessionId !== undefined) {
			await client.sendRequest("session.open", { sessionId: input.sessionId, limit: 100 }, input.timeoutMs);
		}
		return client.sendRequest("session.info", {}, input.timeoutMs);
	}));

	server.registerTool("daedalus_send_chat", {
		title: "Send Daedalus chat",
		description: "Send ai.chat through WebSocket. Returns the requestId immediately; use wait_for_event to observe progress.",
		inputSchema: z.object({
			sessionId: z.string().min(1).optional(),
			message: z.string().min(1),
			mode: z.enum(["agent", "ask", "plan"]).optional(),
			promptId: z.string().min(1).optional(),
			systemPrompt: z.string().optional(),
			additionalContext: z.array(z.unknown()).optional(),
			options: z.record(z.string(), z.unknown()).optional()
		})
	}, async (input: {
		sessionId?: string | undefined;
		message: string;
		mode?: "agent" | "ask" | "plan" | undefined;
		promptId?: string | undefined;
		systemPrompt?: string | undefined;
		additionalContext?: unknown[] | undefined;
		options?: Record<string, unknown> | undefined;
	}): Promise<ToolResult> => runTool(async (): Promise<unknown> => {
		const client = getClient(config);
		if (input.sessionId !== undefined) {
			await client.sendRequest("session.open", { sessionId: input.sessionId, limit: 100 });
		}
		const { sessionId: _sessionId, ...chatParams } = input;
		const requestId = await client.sendRequestNoWait("ai.chat", chatParams);
		return { requestId };
	}));

	server.registerTool("daedalus_wait_for_event", {
		title: "Wait for Daedalus event",
		description: "Low-level event waiter. Prefer daedalus_wait_for_run when checking whether an ai.chat request completed or failed.",
		inputSchema: z.object({
			eventName: z.string().min(1).optional(),
			requestId: z.string().min(1).optional(),
			planId: z.string().min(1).optional(),
			afterSequence: z.number().int().min(0).optional(),
			timeoutMs: z.number().int().positive().max(300000).optional()
		})
	}, async (input: {
		eventName?: string | undefined;
		requestId?: string | undefined;
		planId?: string | undefined;
		afterSequence?: number | undefined;
		timeoutMs?: number | undefined;
	}): Promise<ToolResult> => runTool(async (): Promise<unknown> =>
		getClient(config).waitForEvent(input)
	));

	server.registerTool("daedalus_wait_for_run", {
		title: "Wait for Daedalus run",
		description: "Wait for an ai.chat request to finish by observing workbench activeRun returning to idle, then summarize final timeline status.",
		inputSchema: z.object({
			requestId: z.string().min(1),
			timeoutMs: z.number().int().positive().max(300000).optional(),
			includeTimeline: z.boolean().optional()
		})
	}, async (input: {
		requestId: string;
		timeoutMs?: number | undefined;
		includeTimeline?: boolean | undefined;
	}): Promise<ToolResult> => runTool(async (): Promise<unknown> =>
		getClient(config).waitForRun(input)
	));

	server.registerTool("daedalus_get_session_events", {
		title: "Get session timeline",
		description: "Read a session timeline page through session.timeline.",
		inputSchema: z.object({
			sessionId: z.string().min(1),
			beforeOffset: z.number().int().min(0).optional(),
			limit: z.number().int().positive().max(500).optional()
		})
	}, async (input: { sessionId: string; beforeOffset?: number | undefined; limit?: number | undefined }): Promise<ToolResult> => runTool(async (): Promise<unknown> =>
		getClient(config).sendRequest("session.timeline", {
			sessionId: input.sessionId,
			...(input.beforeOffset === undefined ? {} : { beforeOffset: input.beforeOffset }),
			limit: input.limit
		})
	));

	server.registerTool("daedalus_get_plan", {
		title: "Get Daedalus plan",
		description: "Read persisted plan metadata and markdown by plan id.",
		inputSchema: z.object({
			sessionId: z.string().min(1).optional(),
			planId: z.string().min(1)
		})
	}, async (input: { sessionId?: string | undefined; planId: string }): Promise<ToolResult> => runTool(async (): Promise<unknown> =>
		getClient(config).sendRequest("plan.get", input)
	));

	server.registerTool("daedalus_submit_clarification", {
		title: "Submit plan clarification",
		description: "Submit a clarification reply for a plan-mode request.",
		inputSchema: z.object({
			planId: z.string().min(1),
			reply: z.string().min(1).max(8000),
			timeoutMs: z.number().int().positive().max(300000).optional()
		})
	}, async (input: { planId: string; reply: string; timeoutMs?: number | undefined }): Promise<ToolResult> => runTool(async (): Promise<unknown> =>
		getClient(config).sendRequest("plan.clarify", {
			planId: input.planId,
			reply: input.reply
		}, input.timeoutMs)
	));

	server.registerTool("daedalus_revise_plan", {
		title: "Revise Daedalus plan",
		description: "Send feedback to revise a ready plan without starting execution.",
		inputSchema: z.object({
			planId: z.string().min(1),
			feedback: z.string().min(1).max(12000),
			timeoutMs: z.number().int().positive().max(300000).optional()
		})
	}, async (input: { planId: string; feedback: string; timeoutMs?: number | undefined }): Promise<ToolResult> => runTool(async (): Promise<unknown> =>
		getClient(config).sendRequest("plan.revise", {
			planId: input.planId,
			feedback: input.feedback
		}, input.timeoutMs)
	));

	server.registerTool("daedalus_approve_plan", {
		title: "Approve Daedalus plan",
		description: "Approve a ready plan and start normal agent execution.",
		inputSchema: z.object({
			planId: z.string().min(1)
		})
	}, async (input: { planId: string }): Promise<ToolResult> => runTool(async (): Promise<unknown> =>
		getClient(config).sendRequest("plan.approve", input)
	));

	server.registerTool("daedalus_list_pending_approvals", {
		title: "List pending approvals",
		description: "List current approval requests for the active session.",
		inputSchema: z.object({})
	}, async (): Promise<ToolResult> => runTool(async (): Promise<unknown> =>
		getClient(config).sendRequest("approval.list", {})
	));

	server.registerTool("daedalus_approve_matching_tool", {
		title: "Approve matching smoke tool",
		description: "Approve exactly one pending write tool only if it matches the configured smoke whitelist.",
		inputSchema: z.object({
			approvalId: z.string().min(1).optional(),
			toolName: z.string().min(1).optional(),
			dryRun: z.boolean().optional()
		})
	}, async (input: { approvalId?: string | undefined; toolName?: string | undefined; dryRun?: boolean | undefined }): Promise<ToolResult> => runTool(async (): Promise<unknown> => {
		const client = getClient(config);
		const listResult = await client.sendRequest("approval.list", {});
		const pending = getPendingApprovals(listResult);
		const whitelist = {
			allowedTools: config.allowedTools,
			allowedPathPrefixes: config.allowedPathPrefixes
		};
		const candidate = selectMatchingApproval(pending, whitelist, input);
		if (candidate === undefined || candidate.approvalId === undefined) {
			return {
				approved: false,
				reason: "No pending approval matched the automation whitelist.",
				allowedTools: config.allowedTools,
				allowedPathPrefixes: config.allowedPathPrefixes,
				pendingCount: pending.length
			};
		}
		if (!isApprovalAllowed(candidate, whitelist)) {
			return {
				approved: false,
				reason: "Matched approval failed whitelist validation."
			};
		}
		if (input.dryRun === true) {
			return {
				approved: false,
				dryRun: true,
				approval: candidate
			};
		}
		const approvalResult = await client.sendRequest("approval.approve", { approvalId: candidate.approvalId });
		return {
			approved: true,
			approvalId: candidate.approvalId,
			approvalResult
		};
	}));

	server.registerTool("daedalus_get_file_edit_batch", {
		title: "Get file edit batch",
		description: "Read persisted file edit snapshots for a session batch.",
		inputSchema: z.object({
			sessionId: z.string().min(1),
			batchId: z.string().min(1)
		})
	}, async (input: { sessionId: string; batchId: string }): Promise<ToolResult> => runTool(async (): Promise<unknown> =>
		getClient(config).sendRequest("fileEdit.batch.get", input)
	));

	server.registerTool("daedalus_assert_session_state", {
		title: "Assert session state",
		description: "Check observed automation events for expected event names, request id, or plan id.",
		inputSchema: z.object({
			expectedEvents: z.array(z.string().min(1)).optional(),
			requestId: z.string().min(1).optional(),
			planId: z.string().min(1).optional(),
			afterSequence: z.number().int().min(0).optional()
		})
	}, async (input: {
		expectedEvents?: string[] | undefined;
		requestId?: string | undefined;
		planId?: string | undefined;
		afterSequence?: number | undefined;
	}): Promise<ToolResult> => runTool(async (): Promise<unknown> => {
		const client = getClient(config);
		const messages = client.messages.filter((message): boolean => {
			if (input.afterSequence !== undefined && message.sequence <= input.afterSequence) {
				return false;
			}
			if (input.requestId !== undefined && JSON.stringify(message.raw).includes(input.requestId) === false) {
				return false;
			}
			if (input.planId !== undefined && JSON.stringify(message.raw).includes(input.planId) === false) {
				return false;
			}
			return true;
		});
		const names = new Set(messages.map((message): unknown => message.raw.event).filter((value): value is string => typeof value === "string"));
		const missingEvents = (input.expectedEvents ?? []).filter((name: string): boolean => !names.has(name));
		const errorStatuses = messages
			.map((message): Record<string, unknown> => {
				const data = message.raw.data !== null && typeof message.raw.data === "object"
					? message.raw.data as Record<string, unknown>
					: {};
				return {
					event: message.raw.event,
					status: message.raw.status ?? data.status,
					code: message.raw.code ?? data.code,
					title: message.raw.title ?? data.title,
					message: message.raw.message ?? data.message,
					sequence: message.sequence
				};
			})
			.filter((status): boolean => {
				const event = typeof status.event === "string" ? status.event : "";
				const state = typeof status.status === "string" ? status.status : "";
				const code = typeof status.code === "string" ? status.code : "";
				return event === "agent_run_error"
					|| event === "provider_error"
					|| state === "failed"
					|| state === "error"
					|| code === "agent_run_error"
					|| code === "provider_error"
					|| code.includes("error");
			});
		return {
			ok: missingEvents.length === 0 && errorStatuses.length === 0,
			missingEvents,
			errorStatuses,
			failed: errorStatuses.length > 0,
			observedEvents: [...names],
			messageCount: messages.length,
			lastSequence: client.messages.at(-1)?.sequence ?? 0
		};
	}));
}
