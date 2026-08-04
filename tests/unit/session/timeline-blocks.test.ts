import assert from "node:assert/strict";
import test from "node:test";
import { buildCanonicalTimelineBlocks, type TimelineAssistantBlock, type TimelineBlock } from "../../../src/session/timeline-blocks.js";
import type { StoredMessage, StoredSession, StoredSessionEvent, SessionMetadata } from "../../../src/session/session-store.js";

function metadata(): SessionMetadata {
	return {
		id: "session-test",
		title: "Timeline test",
		createdAt: "2026-07-09T00:00:00.000Z",
		updatedAt: "2026-07-09T00:00:00.000Z"
	};
}

function session(messages: StoredMessage[], events: StoredSessionEvent[]): StoredSession {
	return {
		metadata: metadata(),
		messages,
		events
	};
}

function event(id: string, requestId: string, eventName: string, createdAt: string, data: Record<string, unknown>): StoredSessionEvent {
	return {
		id,
		requestId,
		event: eventName,
		data,
		createdAt
	};
}

function assistantBlock(block: TimelineBlock | undefined): TimelineAssistantBlock {
	assert.equal(block?.type, "assistant");
	return block as TimelineAssistantBlock;
}

test("canonical timeline keeps request order when older assistant messages are persisted late", (): void => {
	const stored: StoredSession = session(
		[
			{
				role: "user",
				requestId: "request-a",
				content: "上一轮问题",
				createdAt: "2026-07-19T00:00:00.000Z"
			},
			{
				role: "user",
				requestId: "request-b",
				content: "最后一轮问题",
				createdAt: "2026-07-19T00:01:00.000Z"
			},
			{
				role: "assistant",
				requestId: "request-b",
				content: "最后一轮回答",
				createdAt: "2026-07-19T00:01:08.000Z"
			},
			{
				role: "assistant",
				requestId: "request-a",
				content: "上一轮延迟写入的回答",
				createdAt: "2026-07-19T00:02:00.000Z"
			}
		],
		[]
	);

	const result = buildCanonicalTimelineBlocks(stored);

	assert.deepEqual(result.blocks.map((block: TimelineBlock): string => `${block.type}:${block.requestId}`), [
		"user:request-a",
		"assistant:request-a",
		"user:request-b",
		"assistant:request-b"
	]);
	assert.equal(assistantBlock(result.blocks[1]).content, "上一轮延迟写入的回答");
	assert.equal(assistantBlock(result.blocks[3]).content, "最后一轮回答");
});

test("provider reconnect events discard only failed attempt text and update one persistent part", (): void => {
	const stored: StoredSession = session([], [
		event("delta-1", "request-reconnect", "agent.message.delta", "2026-08-03T00:00:00.000Z", { text: "stable partial🙂" }),
		event("thinking-1", "request-reconnect", "agent.thinking.delta", "2026-08-03T00:00:01.000Z", { text: "thinking" }),
		event("reconnect-1", "request-reconnect", "agent.provider.reconnect", "2026-08-03T00:00:02.000Z", {
			reconnectId: "reconnect-a",
			revision: 1,
			provider: "deepseek",
			model: "deepseek-v4-flash",
			status: "waiting",
			reason: "transport",
			attempt: 1,
			maxAttempts: 5,
			timeoutMs: 60_000,
			autoExtended: false,
			discardedMessageCodePoints: 8,
			discardedThinkingCodePoints: 8
		}),
		event("reconnect-duplicate", "request-reconnect", "agent.provider.reconnect", "2026-08-03T00:00:03.000Z", {
			reconnectId: "reconnect-a",
			revision: 1,
			status: "waiting",
			reason: "transport",
			attempt: 1,
			maxAttempts: 5,
			timeoutMs: 60_000,
			autoExtended: false,
			discardedMessageCodePoints: 8,
			discardedThinkingCodePoints: 8
		}),
		event("delta-2", "request-reconnect", "agent.message.delta", "2026-08-03T00:00:04.000Z", { text: "complete" }),
		event("reconnect-2", "request-reconnect", "agent.provider.reconnect", "2026-08-03T00:00:05.000Z", {
			reconnectId: "reconnect-a",
			revision: 2,
			provider: "deepseek",
			model: "deepseek-v4-flash",
			status: "recovered",
			reason: "transport",
			attempt: 1,
			maxAttempts: 5,
			timeoutMs: 60_000,
			autoExtended: false,
			discardedMessageCodePoints: 0,
			discardedThinkingCodePoints: 0
		})
	]);

	const assistant = assistantBlock(buildCanonicalTimelineBlocks(stored).blocks[0]);
	const markdown = assistant.bodyParts.filter((part) => part.type === "markdown").map((part) => part.text).join("");
	const reconnectParts = assistant.bodyParts.filter((part) => part.type === "provider_reconnect");
	assert.equal(markdown, "stable complete");
	assert.equal(assistant.bodyParts.some((part) => part.type === "thinking"), false);
	assert.equal(reconnectParts.length, 1);
	assert.equal(reconnectParts[0]?.status, "recovered");
	assert.equal(reconnectParts[0]?.revision, 2);
});

test("canonical timeline ignores orphan persisted turns when session events identify another conversation", (): void => {
	const stored: StoredSession = session(
		[
			{
				role: "user",
				requestId: "foreign-request",
				content: "你能看到 context7 吗",
				createdAt: "2026-07-19T10:19:00.000Z"
			},
			{
				role: "assistant",
				requestId: "foreign-request",
				content: "能看到 Context7。",
				createdAt: "2026-07-19T10:19:07.000Z"
			},
			{
				role: "user",
				requestId: "local-request",
				content: "帮我做一个本地井字棋",
				createdAt: "2026-07-19T11:28:55.000Z"
			}
		],
		[
			event("event-local-start", "local-request", "agent.run.started", "2026-07-19T11:28:56.000Z", {
				runId: "run-local",
				requestId: "local-request",
				sessionId: "session-test"
			}),
			event("event-local-delta", "local-request", "agent.message.delta", "2026-07-19T11:28:58.000Z", {
				runId: "run-local",
				text: "我先确认玩法。",
				sessionId: "session-test"
			}),
			event("event-local-done", "local-request", "agent.message.done", "2026-07-19T11:29:00.000Z", {
				runId: "run-local",
				text: "我先确认玩法。",
				sessionId: "session-test"
			})
		]
	);

	const result = buildCanonicalTimelineBlocks(stored);

	assert.deepEqual(result.blocks.map((block: TimelineBlock): string => `${block.type}:${block.requestId}`), [
		"user:local-request",
		"assistant:local-request"
	]);
	const assistant = assistantBlock(result.blocks[1]);
	assert.equal(assistant.content, "");
	assert.equal(assistant.bodyParts.find((part) => part.type === "markdown")?.type, "markdown");
});

test("canonical timeline keeps plan clarification as hidden restorable state", (): void => {
	const stored: StoredSession = session(
		[
			{
				role: "user",
				requestId: "request-plan",
				content: "写一个本地井字棋",
				createdAt: "2026-07-09T00:00:00.000Z",
				excludeFromLlmContext: true
			},
			{
				role: "assistant",
				requestId: "request-plan",
				content: "需要澄清：请选择目标形态。",
				createdAt: "2026-07-09T00:00:01.000Z",
				excludeFromLlmContext: true
			}
		],
		[
			event("event-clarify", "request-plan", "plan.clarification.required", "2026-07-09T00:00:01.000Z", {
				planId: "plan-a",
				title: "目标形态",
				requestId: "request-plan",
				question: "请选择 CLI 还是 Godot 场景。",
				recommendedReplies: [
					{
						label: "CLI",
						text: "先做 CLI 版本。",
						description: "适合快速验证规则。"
					},
					{
						label: "Godot 场景",
						text: "先做 Godot 场景版本。"
					}
				]
			}),
			event("event-thinking", "plan-clarify-1", "agent.thinking.delta", "2026-07-09T00:00:02.000Z", {
				text: "读取项目结构。"
			}),
			event("event-tool-call", "plan-clarify-1", "agent.tool.call", "2026-07-09T00:00:03.000Z", {
				toolCallId: "tool-read",
				toolName: "mcp_godot_list_project_files"
			}),
			event("event-tool-result", "plan-clarify-1", "agent.tool.result", "2026-07-09T00:00:04.000Z", {
				toolCallId: "tool-read",
				toolName: "mcp_godot_list_project_files",
				summary: "列出项目文件"
			}),
			event("event-plan", "plan-clarify-1", "plan.generated", "2026-07-09T00:00:05.000Z", {
				planId: "plan-a",
				requestId: "request-plan",
				status: "ready",
				title: "井字棋计划",
				previewMarkdown: "## Summary\n\n实现井字棋。"
			})
		]
	);

	const result = buildCanonicalTimelineBlocks(stored);
	assert.equal(result.blocks.length, 2);
	const assistant = assistantBlock(result.blocks[1]);
	assert.equal(assistant.requestId, "request-plan");
	assert.deepEqual(assistant.bodyParts.map((part) => part.type), ["markdown", "thinking", "tool", "plan"]);
	assert.equal(assistant.bodyParts.find((part) => part.type === "status" && part.code === "plan.clarification.required"), undefined);
	assert.equal(assistant.bodyParts.find((part) => part.type === "tool")?.type, "tool");
	const planPart = assistant.bodyParts.find((part) => part.type === "plan");
	assert.equal(planPart?.type, "plan");
	assert.equal(planPart?.planId, "plan-a");
	assert.equal(result.latestPlanClarification, null);
	assert.deepEqual(result.latestPlanApproval, {
		planId: "plan-a",
		requestId: "request-plan",
		title: "井字棋计划",
		status: "ready",
		previewMarkdown: "## Summary\n\n实现井字棋。",
		updatedAt: ""
	});
});

test("canonical timeline restores latest pending plan clarification without rendering status", (): void => {
	const stored: StoredSession = session(
		[
			{
				role: "user",
				requestId: "request-plan",
				content: "写一个本地井字棋",
				createdAt: "2026-07-09T00:00:00.000Z",
				excludeFromLlmContext: true
			},
			{
				role: "assistant",
				requestId: "request-plan",
				content: "请选择目标形态。",
				createdAt: "2026-07-09T00:00:01.000Z",
				excludeFromLlmContext: true
			}
		],
		[
			event("event-clarify", "request-plan", "plan.clarification.required", "2026-07-09T00:00:01.000Z", {
				planId: "plan-a",
				title: "目标形态",
				requestId: "request-plan",
				question: "请选择 CLI 还是 Godot 场景。",
				recommendedReplies: [
					{
						label: "CLI",
						text: "先做 CLI 版本。",
						description: "适合快速验证规则。"
					},
					{
						label: "Godot 场景",
						text: "先做 Godot 场景版本。"
					}
				]
			})
		]
	);

	const result = buildCanonicalTimelineBlocks(stored);
	const assistant = assistantBlock(result.blocks[1]);

	assert.deepEqual(assistant.bodyParts.map((part) => part.type), ["markdown"]);
	assert.deepEqual(result.latestPlanClarification, {
		planId: "plan-a",
		requestId: "request-plan",
		title: "目标形态",
		question: "请选择 CLI 还是 Godot 场景。",
		recommendedReplies: [
			{
				label: "CLI",
				text: "先做 CLI 版本。",
				description: "适合快速验证规则。"
			},
			{
				label: "Godot 场景",
				text: "先做 Godot 场景版本。",
				description: undefined
			}
		]
	});
	assert.equal(result.latestPlanApproval, null);
});

test("canonical timeline does not restore a plan clarification after the plan operation failed", (): void => {
	const stored: StoredSession = session(
		[
			{
				role: "user",
				requestId: "request-plan",
				content: "写一个本地井字棋",
				createdAt: "2026-07-09T00:00:00.000Z",
				excludeFromLlmContext: true
			},
			{
				role: "assistant",
				requestId: "request-plan",
				content: "请选择目标形态。",
				createdAt: "2026-07-09T00:00:01.000Z",
				excludeFromLlmContext: true
			}
		],
		[
			event("event-clarify", "request-plan", "plan.clarification.required", "2026-07-09T00:00:01.000Z", {
				planId: "plan-a",
				requestId: "request-plan",
				title: "目标形态",
				question: "请选择 CLI 还是 Godot 场景。"
			}),
			event("event-plan-error", "plan-clarify-rpc", "plan.error", "2026-07-09T00:00:02.000Z", {
				code: "plan_error",
				message: "工具结果总量达到上限"
			})
		]
	);

	const result = buildCanonicalTimelineBlocks(stored);

	assert.equal(result.latestPlanClarification, null);
	assert.equal(result.latestPlanApproval, null);
});

test("canonical timeline replaces an existing plan part when the same plan is revised", (): void => {
	const stored: StoredSession = session(
		[
			{
				role: "user",
				requestId: "request-plan",
				content: "写一个本地井字棋",
				createdAt: "2026-07-09T00:00:00.000Z",
				excludeFromLlmContext: true
			},
			{
				role: "assistant",
				requestId: "request-plan",
				content: "计划初稿。",
				createdAt: "2026-07-09T00:00:01.000Z",
				excludeFromLlmContext: true
			}
		],
		[
			event("event-plan", "request-plan", "plan.generated", "2026-07-09T00:00:01.000Z", {
				planId: "plan-a",
				requestId: "request-plan",
				status: "ready",
				title: "初始计划",
				previewMarkdown: "先做 CLI。"
			}),
			event("event-revised", "request-plan", "plan.revised", "2026-07-09T00:00:02.000Z", {
				planId: "plan-a",
				requestId: "request-plan",
				status: "ready",
				title: "修订计划",
				previewMarkdown: "改做网页。"
			})
		]
	);

	const result = buildCanonicalTimelineBlocks(stored);
	const assistant = assistantBlock(result.blocks[1]);
	const planParts = assistant.bodyParts.filter((part) => part.type === "plan");

	assert.equal(planParts.length, 1);
	assert.equal(planParts[0]?.type === "plan" ? planParts[0].title : "", "修订计划");
	assert.equal(planParts[0]?.type === "plan" ? planParts[0].previewMarkdown : "", "改做网页。");
});

test("canonical timeline keeps plan execution as independent blocks with tools and inline diff", (): void => {
	const fileEditBatch = {
		batchId: "edit-a",
		workspaceId: "workspace-a",
		workspaceRoot: "D:/Project",
		editedFiles: [{
			path: "scripts/game.gd",
			absolutePath: "D:/Project/scripts/game.gd",
			workspaceRoot: "D:/Project",
			additions: 3,
			deletions: 1,
			existsAfter: true,
			afterSha256: "after",
			undoable: true
		}]
	};
	const stored: StoredSession = session(
		[
			{
				role: "user",
				requestId: "plan-exec-1",
				content: "写一个本地井字棋",
				createdAt: "2026-07-09T00:01:00.000Z"
			},
			{
				role: "assistant",
				requestId: "plan-exec-1",
				content: "完成。",
				createdAt: "2026-07-09T00:02:00.000Z"
			}
		],
		[
			event("event-exec", "plan-exec-1", "plan.execution.started", "2026-07-09T00:01:00.000Z", {
				planId: "plan-a",
				requestId: "request-plan",
				executionRequestId: "plan-exec-1"
			}),
			event("event-tool-call", "plan-exec-1", "agent.tool.call", "2026-07-09T00:01:01.000Z", {
				toolCallId: "tool-write",
				toolName: "mcp_godot_overwrite_text_file"
			}),
			event("event-tool-result", "plan-exec-1", "agent.tool.result", "2026-07-09T00:01:02.000Z", {
				toolCallId: "tool-write",
				toolName: "mcp_godot_overwrite_text_file",
				fileEditBatch
			}),
			event("event-outcome", "plan-exec-1", "agent.step.outcome", "2026-07-09T00:01:03.000Z", {
				outcome: {
					title: "实现修改",
					status: "completed",
					summary: "mcp_godot_overwrite_text_file"
				}
			}),
			event("event-todo", "plan-exec-1", "workflow.todo.updated", "2026-07-09T00:01:04.000Z", {
				workflowId: "workflow-a",
				todos: [
					{ id: "phase-write", title: "实现修改", status: "completed" }
				]
			}),
			event("event-done", "plan-exec-1", "agent.run.done", "2026-07-09T00:01:05.000Z", {
				status: "completed"
			})
		]
	);

	const result = buildCanonicalTimelineBlocks(stored);
	assert.equal(result.blocks.length, 2);
	assert.equal(result.blocks[0]?.type, "user");
	const assistant = assistantBlock(result.blocks[1]);
	assert.equal(assistant.requestId, "plan-exec-1");
	assert.deepEqual(assistant.bodyParts.map((part) => part.type), ["markdown", "tool", "inline_diff"]);
	const inlineDiff = assistant.bodyParts.find((part) => part.type === "inline_diff");
	assert.equal(inlineDiff?.type, "inline_diff");
	assert.equal(inlineDiff?.editedFileCount, 1);
	assert.equal(inlineDiff?.additions, 3);
	assert.equal(inlineDiff?.deletions, 1);
	assert.deepEqual(result.latestWorkflowSnapshot, {
		workflowId: "workflow-a",
		todos: [
			{ id: "phase-write", title: "实现修改", status: "completed" }
		]
	});
});

test("canonical timeline delays inline diff until assistant run is terminal", (): void => {
	const fileEditBatch = {
		batchId: "batch-pending",
		editedFiles: [{
			path: "res://scripts/pending.gd",
			absolutePath: "D:/project/scripts/pending.gd",
			workspaceRoot: "D:/project",
			additions: 1,
			deletions: 0,
			existsAfter: true,
			undoable: true
		}]
	};
	const stored: StoredSession = session(
		[
			{
				role: "user",
				requestId: "request-pending",
				content: "创建文件",
				createdAt: "2026-07-09T00:01:00.000Z"
			}
		],
		[
			event("event-delta", "request-pending", "agent.message.delta", "2026-07-09T00:01:01.000Z", { text: "正在创建文件。" }),
			event("event-tool-result", "request-pending", "agent.tool.result", "2026-07-09T00:01:02.000Z", {
				toolCallId: "tool-write",
				toolName: "mcp_godot_create_text_file",
				fileEditBatch
			})
		]
	);

	const assistant = assistantBlock(buildCanonicalTimelineBlocks(stored).blocks[1]);
	assert.deepEqual(assistant.bodyParts.map((part) => part.type), ["markdown", "tool"]);
});

test("canonical timeline merges approval lifecycle events into one tool part", (): void => {
	const stored: StoredSession = session(
		[
			{
				role: "user",
				requestId: "request-approval",
				content: "触发审批",
				createdAt: "2026-07-09T00:02:00.000Z"
			},
			{
				role: "assistant",
				requestId: "request-approval",
				content: "完成。",
				createdAt: "2026-07-09T00:02:30.000Z"
			}
		],
		[
			event("event-approval-required", "request-approval", "agent.tool.approval_required", "2026-07-09T00:02:01.000Z", {
				toolCallId: "tool-write",
				approvalId: "approval-a",
				toolName: "mcp_godot_create_text_file"
			}),
			event("event-approved", "request-approval", "agent.tool.approved", "2026-07-09T00:02:02.000Z", {
				approvalId: "approval-a",
				toolName: "mcp_godot_create_text_file"
			}),
			event("event-result", "request-approval", "agent.tool.result", "2026-07-09T00:02:03.000Z", {
				toolCallId: "tool-write",
				toolName: "mcp_godot_create_text_file"
			})
		]
	);

	const assistant = assistantBlock(buildCanonicalTimelineBlocks(stored).blocks[1]);
	const toolParts = assistant.bodyParts.filter((part) => part.type === "tool");

	assert.equal(toolParts.length, 1);
	assert.deepEqual(toolParts[0]?.events.map((toolEvent) => toolEvent.type), [
		"tool.approval_required",
		"tool.approved",
		"tool.result"
	]);
});

test("canonical timeline keeps workflow todo after done until dismissed", (): void => {
	const todoSnapshot = {
		workflowId: "workflow-a",
		todos: [
			{ id: "phase-write", title: "实现修改", status: "done" }
		]
	};
	const storedWithDone: StoredSession = session([], [
		event("event-todo", "workflow-run", "workflow.todo.updated", "2026-07-09T00:01:04.000Z", todoSnapshot),
		event("event-done", "workflow-run", "workflow.done", "2026-07-09T00:01:05.000Z", {
			workflowId: "workflow-a"
		})
	]);

	const doneResult = buildCanonicalTimelineBlocks(storedWithDone);
	assert.deepEqual(doneResult.latestWorkflowSnapshot, todoSnapshot);

	const storedWithDismiss: StoredSession = session([], [
		event("event-todo", "workflow-run", "workflow.todo.updated", "2026-07-09T00:01:04.000Z", todoSnapshot),
		event("event-done", "workflow-run", "workflow.done", "2026-07-09T00:01:05.000Z", {
			workflowId: "workflow-a"
		}),
		event("event-dismiss", "workflow-run", "workflow.todo.dismissed", "2026-07-09T00:01:06.000Z", {
			workflowId: "workflow-a",
			dismissedAt: "2026-07-09T00:01:06.000Z"
		})
	]);

	const dismissResult = buildCanonicalTimelineBlocks(storedWithDismiss);
	assert.equal(dismissResult.latestWorkflowSnapshot, null);
});

test("canonical timeline inserts summary start marker before final summary markdown", (): void => {
	const stored: StoredSession = session(
		[
			{
				role: "user",
				requestId: "workflow-summary",
				content: "实现并总结",
				createdAt: "2026-07-09T00:03:00.000Z"
			},
			{
				role: "assistant",
				requestId: "workflow-summary",
				content: "总结完成。",
				createdAt: "2026-07-09T00:03:20.000Z"
			}
		],
		[
			event("event-thinking", "workflow-summary", "agent.thinking.delta", "2026-07-09T00:03:01.000Z", {
				text: "先读取项目。"
			}),
			event("event-thinking-done", "workflow-summary", "agent.thinking.done", "2026-07-09T00:03:02.000Z", {}),
			event("event-summary-start", "workflow-summary", "agent.summary.started", "2026-07-09T00:03:10.000Z", {
				runId: "workflow-a",
				stepId: "summarize",
				stepRunId: "phase-run-summary",
				title: "总结交付",
				foldTitle: "总结前的过程"
			}),
			event("event-summary-delta", "workflow-summary", "agent.message.delta", "2026-07-09T00:03:11.000Z", {
				text: "总结完成。"
			})
		]
	);

	const result = buildCanonicalTimelineBlocks(stored);
	const assistant = assistantBlock(result.blocks[1]);
	assert.deepEqual(assistant.bodyParts.map((part) => part.type), ["thinking", "summary_start", "markdown"]);
	const summaryStart = assistant.bodyParts[1];
	assert.equal(summaryStart?.type, "summary_start");
	if (summaryStart?.type === "summary_start") {
		assert.equal(summaryStart.runId, "workflow-a");
		assert.equal(summaryStart.stepId, "summarize");
		assert.equal(summaryStart.stepRunId, "phase-run-summary");
		assert.equal(summaryStart.foldTitle, "总结前的过程");
	}
});

test("canonical timeline restores final message done text after earlier workflow deltas", (): void => {
	const stored: StoredSession = session(
		[
			{
				role: "user",
				requestId: "workflow-summary-done",
				content: "实现并总结",
				createdAt: "2026-07-09T00:04:00.000Z"
			},
			{
				role: "assistant",
				requestId: "workflow-summary-done",
				content: "最终总结。",
				createdAt: "2026-07-09T00:04:20.000Z"
			}
		],
		[
			event("event-early-delta", "workflow-summary-done", "agent.message.delta", "2026-07-09T00:04:01.000Z", {
				text: "前置阶段说明。"
			}),
			event("event-summary-start", "workflow-summary-done", "agent.summary.started", "2026-07-09T00:04:10.000Z", {
				runId: "workflow-b",
				stepId: "summarize",
				stepRunId: "phase-run-summary-done",
				title: "总结交付",
				foldTitle: "总结前的过程"
			}),
			event("event-summary-done", "workflow-summary-done", "agent.message.done", "2026-07-09T00:04:20.000Z", {
				runId: "workflow-b",
				stepRunId: "phase-run-summary-done",
				text: "最终总结。"
			})
		]
	);

	const result = buildCanonicalTimelineBlocks(stored);
	const assistant = assistantBlock(result.blocks[1]);

	assert.deepEqual(assistant.bodyParts.map((part) => part.type), ["markdown", "summary_start", "markdown"]);
	const markdownParts = assistant.bodyParts.filter((part) => part.type === "markdown");
	assert.equal(markdownParts[0]?.type, "markdown");
	assert.equal(markdownParts[0]?.text, "前置阶段说明。");
	assert.equal(markdownParts[1]?.type, "markdown");
	assert.equal(markdownParts[1]?.text, "最终总结。");
});

test("canonical timeline replaces drifted streamed markdown with final message done text", (): void => {
	const finalText: string = "## 五子棋文件拆分与验证步骤\n\n基于当前井字棋的实现，五子棋应该拆成棋盘逻辑、UI 控制器和场景容器。";
	const streamedText: string = "## 五子棋文件拆分与验证步骤\n\n基于当前井字棋的实现，五子棋应该拆成棋盘逻辑、UI 控制器和场景容器。## 五子棋文件拆分与验证步骤";
	const stored: StoredSession = session(
		[
			{
				role: "user",
				requestId: "request-drifted-final",
				content: "说明五子棋拆分",
				createdAt: "2026-07-09T00:05:00.000Z"
			},
			{
				role: "assistant",
				requestId: "request-drifted-final",
				content: finalText,
				createdAt: "2026-07-09T00:05:20.000Z"
			}
		],
		[
			event("event-tool", "request-drifted-final", "agent.tool.result", "2026-07-09T00:05:04.000Z", {
				toolCallId: "tool-read",
				toolName: "mcp_godot_read_text_file"
			}),
			event("event-delta", "request-drifted-final", "agent.message.delta", "2026-07-09T00:05:10.000Z", {
				text: streamedText
			}),
			event("event-done", "request-drifted-final", "agent.message.done", "2026-07-09T00:05:20.000Z", {
				text: finalText
			})
		]
	);

	const result = buildCanonicalTimelineBlocks(stored);
	const assistant = assistantBlock(result.blocks[1]);
	const markdownParts = assistant.bodyParts.filter((part) => part.type === "markdown");

	assert.deepEqual(assistant.bodyParts.map((part) => part.type), ["tool", "markdown"]);
	assert.equal(markdownParts.length, 1);
	assert.equal(markdownParts[0]?.type, "markdown");
	assert.equal(markdownParts[0]?.text, finalText);
});

test("canonical timeline groups tool progress with its tool call", (): void => {
	const stored: StoredSession = session(
		[
			{ role: "user", requestId: "request-scene-view", content: "查看场景", createdAt: "2026-07-09T00:06:00.000Z" },
			{ role: "assistant", requestId: "request-scene-view", content: "", createdAt: "2026-07-09T00:06:03.000Z" }
		],
		[
			event("event-call", "request-scene-view", "agent.tool.call", "2026-07-09T00:06:00.000Z", {
				toolCallId: "scene-view-1",
				toolName: "mcp_godot_editor_capture_scene_view"
			}),
			event("event-progress", "request-scene-view", "agent.tool.progress", "2026-07-09T00:06:01.000Z", {
				toolCallId: "scene-view-1",
				toolName: "mcp_godot_editor_capture_scene_view",
				status: "message",
				title: "保存场景视图",
				details: "正在保存当前编辑器视口截图。",
				code: "scene_view.capture.started"
			}),
			event("event-result", "request-scene-view", "agent.tool.result", "2026-07-09T00:06:02.000Z", {
				toolCallId: "scene-view-1",
				toolName: "mcp_godot_editor_capture_scene_view",
				resultChars: 42,
				truncated: false
			})
		]
	);

	const assistant = assistantBlock(buildCanonicalTimelineBlocks(stored).blocks[1]);
	assert.equal(assistant.bodyParts.length, 1);
	const toolPart = assistant.bodyParts[0];
	assert.equal(toolPart?.type, "tool");
	assert.equal(toolPart?.events.length, 3);
	assert.equal(toolPart?.events[1]?.type, "tool.progress");
	assert.equal(toolPart?.events[1]?.title, "保存场景视图");
});

test("canonical timeline restores image generation body part from tool events", (): void => {
	const stored: StoredSession = session(
		[
			{ role: "user", requestId: "request-image", content: "生成图片", createdAt: "2026-07-09T00:07:00.000Z" },
			{ role: "assistant", requestId: "request-image", content: "已生成图片。", createdAt: "2026-07-09T00:07:04.000Z" }
		],
		[
			event("event-call", "request-image", "agent.tool.call", "2026-07-09T00:07:01.000Z", {
				toolCallId: "image-tool-1",
				toolName: "mcp_image_generate",
				args: { prompt: "blue castle" }
			}),
			event("event-result", "request-image", "agent.tool.result", "2026-07-09T00:07:03.000Z", {
				toolCallId: "image-tool-1",
				toolName: "mcp_image_generate",
				imageGeneration: {
					status: "completed",
					prompt: "blue castle",
					provider: "openai",
					model: "gpt-image-1",
					artifacts: [{
						imageId: "generated-image-a",
						sessionId: "session-test",
						mimeType: "image/png",
						byteSize: 128,
						provider: "openai",
						model: "gpt-image-1",
						prompt: "blue castle",
						createdAt: "2026-07-09T00:07:03.000Z",
						fileName: "generated-image-a.png"
					}]
				}
			}),
			event("event-delta", "request-image", "agent.message.delta", "2026-07-09T00:07:04.000Z", {
				text: "已生成图片。"
			})
		]
	);

	const result = buildCanonicalTimelineBlocks(stored);
	const assistant = assistantBlock(result.blocks[1]);
	assert.deepEqual(assistant.bodyParts.map((part) => part.type), ["tool", "image_generation", "markdown"]);
	const imagePart = assistant.bodyParts.find((part) => part.type === "image_generation");
	assert.equal(imagePart?.type, "image_generation");
	if (imagePart?.type === "image_generation") {
		assert.equal(imagePart.status, "completed");
		assert.equal(imagePart.prompt, "blue castle");
		assert.equal(imagePart.artifacts?.[0]?.imageId, "generated-image-a");
	}
});

test("canonical timeline keeps all Goal cycles in the root assistant block", (): void => {
	const rootRequestId: string = "request-goal-root";
	const cycleRequestId: string = "goal-one:cycle:2";
	const stored: StoredSession = session([
		{ role: "user", requestId: rootRequestId, content: "Build the game", createdAt: "2026-08-02T00:00:00.000Z" },
		{ role: "assistant", requestId: rootRequestId, content: "First cycle", createdAt: "2026-08-02T00:01:00.000Z" },
		{ role: "assistant", requestId: cycleRequestId, content: "Second cycle", createdAt: "2026-08-02T00:02:00.000Z" }
	], [
		event("goal-cycle-state", cycleRequestId, "agent.run.state", "2026-08-02T00:01:30.000Z", {
			runId: cycleRequestId,
			requestId: cycleRequestId,
			rootRequestId,
			goalId: "goal-one",
			stage: "executing"
		}),
		event("goal-root-delta", rootRequestId, "agent.message.delta", "2026-08-02T00:00:30.000Z", { text: "First cycle" }),
		event("goal-cycle-delta", cycleRequestId, "agent.message.delta", "2026-08-02T00:01:40.000Z", { text: "Second cycle" })
	]);

	const result = buildCanonicalTimelineBlocks(stored);
	assert.deepEqual(result.blocks.map((block: TimelineBlock): string => `${block.type}:${block.requestId}`), [
		`user:${rootRequestId}`,
		`assistant:${rootRequestId}`
	]);
	const assistant = assistantBlock(result.blocks[1]);
	assert.equal(assistant.id, `message:${rootRequestId}:assistant:2026-08-02T00:01:00.000Z`);
	assert.equal(assistant.bodyParts.filter((part): boolean => part.type === "markdown").map((part): string => part.type === "markdown" ? part.text : "").join(""), "First cycleSecond cycle");
});

test("canonical timeline orders an assistant-only persisted Goal cycle by its message timestamp", (): void => {
	const stored: StoredSession = session([
		{ role: "user", requestId: "request-first", content: "Can you connect?", createdAt: "2026-07-31T08:43:10.000Z" },
		{ role: "assistant", requestId: "request-first", content: "Connected.", createdAt: "2026-07-31T08:43:16.000Z" },
		{ role: "assistant", requestId: "goal-legacy:cycle:2", content: "Legacy Goal summary.", createdAt: "2026-08-02T15:47:56.000Z" }
	], []);

	const result = buildCanonicalTimelineBlocks(stored);
	assert.deepEqual(result.blocks.map((block: TimelineBlock): string => `${block.type}:${block.requestId}`), [
		"user:request-first",
		"assistant:request-first",
		"assistant:goal-legacy:cycle:2"
	]);
	const legacyGoal = assistantBlock(result.blocks[2]);
	assert.equal(legacyGoal.startedAtUtc, "2026-08-02T15:47:56.000Z");
	assert.equal(legacyGoal.completedAtUtc, "2026-08-02T15:47:56.000Z");
});

test("canonical timeline leaves completion warnings to the final assistant summary", (): void => {
	const warning = "Godot executable was not found; verification was skipped.";
	const stored: StoredSession = session(
		[
			{ role: "user", requestId: "request-warning", content: "Verify this scene", createdAt: "2026-07-09T00:08:00.000Z" },
			{ role: "assistant", requestId: "request-warning", content: "Implemented.", createdAt: "2026-07-09T00:08:04.000Z" }
		],
		[
			event("event-workflow-done", "request-warning", "workflow.done", "2026-07-09T00:08:03.000Z", {
				resultStatus: "completed_with_warnings",
				warnings: [warning]
			}),
			event("event-run-done", "request-warning", "agent.run.done", "2026-07-09T00:08:04.000Z", {
				resultStatus: "completed_with_warnings",
				warnings: [warning]
			})
		]
	);

	const assistant = assistantBlock(buildCanonicalTimelineBlocks(stored).blocks[1]);
	const warningParts = assistant.bodyParts.filter((part) => {
		return part.type === "status" && part.code === "verification_unverified";
	});
	assert.equal(warningParts.length, 0);
});

test("canonical timeline marks an interrupted image generation as failed", (): void => {
	const stored: StoredSession = session(
		[
			{ role: "user", requestId: "request-cancel-image", content: "Generate an icon", createdAt: "2026-07-09T00:09:00.000Z" }
		],
		[
			event("event-call", "request-cancel-image", "agent.tool.call", "2026-07-09T00:09:01.000Z", {
				toolCallId: "image-tool-cancelled",
				toolName: "mcp_image_generate",
				args: { prompt: "blue icon" }
			}),
			event("event-cancelled", "request-cancel-image", "agent.run.cancelled", "2026-07-09T00:09:02.000Z", {
				reason: "Cancelled by user."
			})
		]
	);

	const assistant = assistantBlock(buildCanonicalTimelineBlocks(stored).blocks[1]);
	const imagePart = assistant.bodyParts.find((part) => part.type === "image_generation");
	assert.equal(imagePart?.type, "image_generation");
	if (imagePart?.type === "image_generation") {
		assert.equal(imagePart.status, "failed");
		assert.equal(imagePart.error, "Cancelled by user.");
	}
	assert.equal(assistant.status, "stopped");
	assert.equal(assistant.completionStatus, "stopped");
	assert.equal(assistant.bodyParts.some((part) => part.type === "status" && part.code === "agent_run_cancelled"), false);
});

test("canonical timeline restores failed transcript-only turn with tool, error and inline diff", (): void => {
	const fileEditBatch = {
		batchId: "edit-failed",
		workspaceId: "workspace-a",
		workspaceRoot: "D:/Project",
		editedFiles: [{
			path: "scripts/failed.gd",
			absolutePath: "D:/Project/scripts/failed.gd",
			workspaceRoot: "D:/Project",
			additions: 1,
			deletions: 0,
			existsAfter: true,
			afterSha256: "after",
			undoable: true
		}]
	};
	const stored: StoredSession = session(
		[
			{
				role: "user",
				requestId: "request-failed",
				content: "修复脚本",
				createdAt: "2026-07-09T00:03:00.000Z",
				excludeFromLlmContext: true
			},
			{
				role: "assistant",
				requestId: "request-failed",
				content: "",
				createdAt: "2026-07-09T00:03:30.000Z",
				excludeFromLlmContext: true,
				status: "failed",
				error: {
					code: "agent_run_error",
					message: "总结阶段不能调用工具"
				}
			}
		],
		[
			event("event-delta", "request-failed", "agent.message.delta", "2026-07-09T00:03:01.000Z", { text: "准备修改脚本。" }),
			event("event-tool", "request-failed", "agent.tool.result", "2026-07-09T00:03:02.000Z", {
				toolCallId: "tool-1",
				toolName: "mcp_godot_overwrite_text_file",
				fileEditBatch
			}),
			event("event-error", "request-failed", "agent.run.error", "2026-07-09T00:03:03.000Z", {
				code: "agent_run_error",
				message: "总结阶段不能调用工具"
			})
		]
	);

	const result = buildCanonicalTimelineBlocks(stored);
	const assistant = assistantBlock(result.blocks[1]);
	assert.deepEqual(assistant.bodyParts.map((part) => part.type), ["markdown", "tool", "status", "inline_diff"]);
	const statusPart = assistant.bodyParts.find((part) => part.type === "status");
	assert.equal(statusPart?.type, "status");
	assert.equal(statusPart?.details, "总结阶段不能调用工具");
});

test("canonical timeline deduplicates repeated terminal errors by message", (): void => {
	const stored: StoredSession = session(
		[
			{
				role: "user",
				requestId: "request-error",
				content: "帮我改一下",
				createdAt: "2026-07-09T00:03:00.000Z"
			}
		],
		[
			event("event-start", "request-error", "agent.run.started", "2026-07-09T00:03:01.000Z", {
				runId: "request-error"
			}),
			event("event-workflow-error", "request-error", "agent.run.error", "2026-07-09T00:03:02.000Z", {
				runId: "workflow-a",
				code: "agent_run_error",
				message: "oldText not found in file"
			}),
			event("event-provider-error", "request-error", "agent.run.error", "2026-07-09T00:03:03.000Z", {
				runId: "request-error",
				code: "provider_error",
				message: "oldText not found in file"
			})
		]
	);

	const result = buildCanonicalTimelineBlocks(stored);
	const assistant = assistantBlock(result.blocks[1]);
	const statusParts = assistant.bodyParts.filter((part) => part.type === "status" && part.status === "error");

	assert.equal(statusParts.length, 1);
	assert.equal(statusParts[0]?.type, "status");
	assert.equal(statusParts[0]?.details, "oldText not found in file");
});

test("canonical timeline compacts many deltas into a bounded markdown part", (): void => {
	const events: StoredSessionEvent[] = [];
	for (let index = 0; index < 2600; index += 1) {
		events.push(event(`event-${index}`, "request-large", "agent.message.delta", `2026-07-09T00:04:${(index % 60).toString().padStart(2, "0")}.000Z`, {
			text: "x"
		}));
	}
	const stored: StoredSession = session(
		[
			{ role: "user", requestId: "request-large", content: "大输出", createdAt: "2026-07-09T00:04:00.000Z" },
			{ role: "assistant", requestId: "request-large", content: "", createdAt: "2026-07-09T00:05:00.000Z" }
		],
		events
	);

	const result = buildCanonicalTimelineBlocks(stored);
	const assistant = assistantBlock(result.blocks[1]);
	assert.equal(assistant.bodyParts.length, 1);
	assert.equal(assistant.bodyParts[0]?.type, "markdown");
	assert.equal(assistant.bodyParts[0]?.text.length, 2600);
	assert.equal(result.eventCount, 2600);
});

test("canonical timeline restores v3 todo state until it is dismissed", (): void => {
	const todo = {
		runId: "run-v3-todo",
		workflowId: "workflow-v3",
		todos: [
			{ id: "implement", title: "Implement the change", status: "completed" }
		]
	};
	const state = {
		schemaVersion: 1,
		runId: "run-v3-todo",
		requestId: "request-v3-todo",
		rootRequestId: "request-v3-todo",
		revision: 5,
		intent: "mutate",
		scope: "complex",
		lane: "workflow",
		stage: "completed",
		title: "Implement the change",
		planId: "workflow-v3",
		todo,
		pause: null,
		verificationStatus: "verified",
		warnings: [],
		terminal: { resultStatus: "completed", message: "Completed.", completedAt: "2026-07-09T01:00:05.000Z" },
		createdAt: "2026-07-09T01:00:00.000Z",
		updatedAt: "2026-07-09T01:00:05.000Z"
	};

	const completed = buildCanonicalTimelineBlocks(session([], [
		event("event-run-state", "request-v3-todo", "agent.run.state", "2026-07-09T01:00:05.000Z", state)
	]));
	assert.deepEqual(completed.latestAgentSnapshot, todo);

	const dismissed = buildCanonicalTimelineBlocks(session([], [
		event("event-run-state", "request-v3-todo", "agent.run.state", "2026-07-09T01:00:05.000Z", state),
		event("event-todo-dismissed", "request-v3-todo", "agent.todo.dismissed", "2026-07-09T01:00:06.000Z", {
			runId: "run-v3-todo"
		})
	]));
	assert.equal(dismissed.latestAgentSnapshot, null);
});

test("canonical timeline reconciles a completed v3 run todo with its terminal state", (): void => {
	const result = buildCanonicalTimelineBlocks(session([], [
		event("event-run-state", "request-v3-completed-todo", "agent.run.state", "2026-07-09T01:10:05.000Z", {
			schemaVersion: 1,
			runId: "run-v3-completed-todo",
			requestId: "request-v3-completed-todo",
			rootRequestId: "request-v3-completed-todo",
			revision: 8,
			intent: "mutate",
			scope: "complex",
			lane: "workflow",
			stage: "completed",
			title: "Continue the active Goal",
			planId: "workflow-goal-cycle-6",
			todo: {
				workflowId: "workflow-goal-cycle-6",
				phases: [
					{ id: "inspect", title: "Inspect", status: "pending" },
					{ id: "implement", title: "Implement", status: "done" },
					{ id: "verify", title: "Verify", status: "done" },
					{ id: "summarize", title: "Summarize", status: "pending" }
				],
				todos: []
			},
			pause: null,
			verificationStatus: "verified",
			warnings: [],
			terminal: { resultStatus: "completed", completedAt: "2026-07-09T01:10:05.000Z" },
			createdAt: "2026-07-09T01:10:00.000Z",
			updatedAt: "2026-07-09T01:10:05.000Z"
		})
	]));
	const snapshot = result.latestAgentSnapshot as { phases: Array<{ status: string }> };
	assert.deepEqual(snapshot.phases.map((phase) => phase.status), ["done", "done", "done", "done"]);
});

test("canonical timeline restores v3 failed and interrupted run states", (): void => {
	const failedResult = buildCanonicalTimelineBlocks(session(
		[
			{
				role: "user",
				requestId: "request-v3-failed",
				content: "Apply the change",
				createdAt: "2026-07-09T02:00:00.000Z"
			}
		],
		[
			event("event-v3-failed", "request-v3-failed", "agent.run.state", "2026-07-09T02:00:03.000Z", {
				runId: "run-v3-failed",
				requestId: "request-v3-failed",
				stage: "failed",
				terminal: {
					resultStatus: "failed",
					message: "The targeted verification failed.",
					completedAt: "2026-07-09T02:00:03.000Z"
				}
			})
		]
	));
	const failedAssistant = assistantBlock(failedResult.blocks[1]);
	assert.equal(failedAssistant.status, "failed");
	const failedStatus = failedAssistant.bodyParts.find((part) => part.type === "status");
	assert.equal(failedStatus?.type, "status");
	assert.equal(failedStatus?.code, "agent_run_error");
	assert.equal(failedStatus?.details, "The targeted verification failed.");

	const interruptedResult = buildCanonicalTimelineBlocks(session(
		[
			{
				role: "user",
				requestId: "request-v3-interrupted",
				content: "Continue the refactor",
				createdAt: "2026-07-09T03:00:00.000Z"
			}
		],
		[
			event("event-v3-interrupted", "request-v3-interrupted", "agent.run.state", "2026-07-09T03:00:03.000Z", {
				runId: "run-v3-interrupted",
				requestId: "request-v3-interrupted",
				stage: "interrupted",
				terminal: null
			})
		]
	));
	const interruptedAssistant = assistantBlock(interruptedResult.blocks[1]);
	const interruptedStatus = interruptedAssistant.bodyParts.find((part) => {
		return part.type === "status" && part.code === "agent_run_interrupted";
	});
	assert.equal(interruptedStatus?.type, "status");
	assert.equal(interruptedStatus?.actionId, "retry_agent_run:run-v3-interrupted");
	assert.equal(interruptedStatus?.actionLabel, "Retry from checkpoint");
});
