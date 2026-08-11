import WebSocket from "ws";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession } from "../client-session.js";
import type { OnToolEvent, ToolEvent } from "../../tools/tool-dispatcher.js";
import { parseToolResultSummary } from "../../tools/tool-result-parser.js";
import { getEffectiveToolPolicy, getToolPolicy } from "../../tools/tool-policy.js";
import { getWorkflowToolSemantics } from "../../workflow/tool-semantics.js";
import type { WorkflowPhase } from "../../workflow/types.js";
import { sendSessionEvent, sendTransientSessionEvent } from "../session-events.js";
import { scheduleTerminalJobWakeup } from "../terminal-job-wakeup.js";
import type { WorkflowPhaseToolStats } from "./shared-types.js";
import { persistFileEditBatch } from "../file-edit-batches.js";
import { EXECUTION_CONTROL_TOOL_NAME } from "../../tools/execution-control.js";
import { TODO_UPDATE_TOOL_NAME } from "../../tools/todo-control.js";

const INTERNAL_TOOL_NAMES: ReadonlySet<string> = new Set([
	"mcp_skills_load",
	EXECUTION_CONTROL_TOOL_NAME,
	TODO_UPDATE_TOOL_NAME
]);

export type AgentToolEventForwarderOptions = {
	/** Internal planners must not persist or expose file edit batches. */
	persistFileEditBatches?: boolean | undefined;
};

function isInternalToolEvent(toolName: string): boolean {
	return INTERNAL_TOOL_NAMES.has(toolName);
}

export function createAgentToolEventForwarder(
	socket: WebSocket,
	requestId: string,
	session: ClientSession,
	runId: string,
	stepRunId: string,
	persistRequestId: string = requestId,
	mcpHost?: McpHost | undefined,
	eventMetadata: Record<string, unknown> = {},
	options: AgentToolEventForwarderOptions = {}
): OnToolEvent {
	const createdSkillRefsByToolCallId: Map<string, string> = new Map();
	return (event: ToolEvent): void => {
		if (event.type === "ai.delta") {
			sendSessionEvent(socket, requestId, session, "agent.message.delta", {
				runId,
				stepRunId,
				...eventMetadata,
				text: event.text
			}, persistRequestId);
			return;
		}
		if (event.type === "ai.thinking.delta") {
			sendSessionEvent(socket, requestId, session, "agent.thinking.delta", {
				runId,
				stepRunId,
				...eventMetadata,
				text: event.text
			}, persistRequestId);
			return;
		}
		if (event.type === "ai.thinking.done") {
			sendSessionEvent(socket, requestId, session, "agent.thinking.done", {
				runId,
				stepRunId,
				...eventMetadata
			}, persistRequestId);
			return;
		}
		if (event.type === "provider.reconnect") {
			const { type: _type, ...reconnect } = event;
			sendSessionEvent(socket, requestId, session, "agent.provider.reconnect", {
				...reconnect,
				...eventMetadata,
				runId,
				stepRunId
			}, persistRequestId);
			return;
		}
		if (event.type === "tool.preparing") {
			if (isInternalToolEvent(event.toolName)) {
				return;
			}
			sendSessionEvent(socket, requestId, session, "agent.thinking.done", {
				runId,
				stepRunId,
				...eventMetadata
			}, persistRequestId);
			sendSessionEvent(socket, requestId, session, "agent.tool.call", {
				...event,
				type: "agent.tool.call",
				preview: true,
				runId,
				stepRunId,
				...eventMetadata
			}, persistRequestId);
			return;
		}
		if (event.type === "tool.call") {
			if (isInternalToolEvent(event.toolName)) {
				return;
			}
			if (event.toolName === "mcp_skills_create" && typeof event.args.scope === "string" && typeof event.args.slug === "string") {
				createdSkillRefsByToolCallId.set(event.toolCallId, `${event.args.scope}:${event.args.slug}`);
			}
			sendSessionEvent(socket, requestId, session, "agent.tool.call", {
				...event,
				type: "agent.tool.call",
				runId,
				stepRunId,
				...eventMetadata
			}, persistRequestId);
			return;
		}
		if (event.type === "tool.reviewed") {
			sendSessionEvent(socket, requestId, session, "agent.tool.reviewed", {
				...event,
				type: "agent.tool.reviewed",
				runId,
				stepRunId,
				...eventMetadata
			}, persistRequestId);
			return;
		}
		if (event.type === "tool.progress") {
			if (isInternalToolEvent(event.toolName)) {
				return;
			}
			const sendProgress = event.code === "terminal_output"
				? sendTransientSessionEvent
				: sendSessionEvent;
			sendProgress(socket, requestId, session, "agent.tool.progress", {
				...event,
				type: "agent.tool.progress",
				runId,
				stepRunId,
				...eventMetadata
			}, persistRequestId);
			return;
		}
		if (event.type === "tool.result") {
			if (isInternalToolEvent(event.toolName)) {
				return;
			}
			const createdSkillRef: string | undefined = createdSkillRefsByToolCallId.get(event.toolCallId);
			if (event.toolName === "mcp_skills_create" && createdSkillRef !== undefined) {
				sendSessionEvent(socket, requestId, session, "skill.catalog.changed", { ref: createdSkillRef }, persistRequestId);
				createdSkillRefsByToolCallId.delete(event.toolCallId);
			}
			const { fileEditDraft, ...publicEvent } = event;
			const fileEditBatch = options.persistFileEditBatches === false
				? undefined
				: persistFileEditBatch(
					session.sessionId,
					persistRequestId,
					event.toolCallId,
					event.toolName,
					fileEditDraft
				);
			if (
				event.terminalJobStatus === "running"
				&& event.terminalJobId !== undefined
				&& event.terminalJobWakeAfterMs !== undefined
			) {
				sendSessionEvent(socket, requestId, session, "terminal.job.started", {
					jobId: event.terminalJobId,
					wakeAfterMs: event.terminalJobWakeAfterMs,
					runId,
					stepRunId,
					toolName: event.toolName,
					...eventMetadata
				}, persistRequestId);
				if (mcpHost !== undefined) {
					scheduleTerminalJobWakeup({
						socket,
						requestId,
						persistRequestId,
						session,
						mcpHost,
						jobId: event.terminalJobId,
						wakeAfterMs: event.terminalJobWakeAfterMs,
						runId,
						stepRunId
					});
				}
			}
			sendSessionEvent(socket, requestId, session, "agent.tool.result", {
				...publicEvent,
				type: "agent.tool.result",
				runId,
				stepRunId,
				...eventMetadata,
				...(fileEditBatch === undefined ? {} : { fileEditBatch })
			}, persistRequestId);
			return;
		}
		if (event.type === "tool.error") {
			if (isInternalToolEvent(event.toolName)) {
				return;
			}
			sendSessionEvent(socket, requestId, session, "agent.tool.error", {
				...event,
				type: "agent.tool.error",
				runId,
				stepRunId,
				...eventMetadata
			}, persistRequestId);
			return;
		}
		if (event.type === "tool.approval_required") {
			sendSessionEvent(socket, requestId, session, "agent.tool.approval_required", {
				...event,
				type: "agent.tool.approval_required",
				runId,
				stepRunId,
				...eventMetadata
			}, persistRequestId);
		}
	};
}

export function createEmptyWorkflowPhaseToolStats(): WorkflowPhaseToolStats {
	return {
		toolEvents: 0,
		proposeToolEvents: 0,
		writeToolEvents: 0,
		successfulProposeToolEvents: 0,
		successfulWriteToolEvents: 0,
		approvalEvents: 0,
		toolCallRisks: {}
	};
}

export function updateWorkflowPhaseToolStats(stats: WorkflowPhaseToolStats, event: ToolEvent): void {
	if (event.type !== "tool.call" && event.type !== "tool.result" && event.type !== "tool.error" && event.type !== "tool.approval_required") {
		return;
	}

	stats.toolEvents += 1;

	if (event.type === "tool.approval_required") {
		stats.approvalEvents += 1;
	}

	const toolName: string | undefined = "toolName" in event ? event.toolName : undefined;
	if (toolName === undefined) {
		return;
	}

	if (event.type === "tool.result") {
		if (event.validationStatus === "not_applicable" || event.validationStatus === "failed" || event.ok === false) {
			return;
		}
		const resultRisk: string | undefined = stats.toolCallRisks[event.toolCallId] ?? getToolPolicy(toolName)?.risk;
		if (resultRisk === "propose") {
			stats.successfulProposeToolEvents += 1;
		}
		if (resultRisk === "write" || resultRisk === "destructive") {
			stats.successfulWriteToolEvents += 1;
		}
		return;
	}

	if (event.type !== "tool.call" && event.type !== "tool.approval_required") {
		return;
	}

	const policy = getEffectiveToolPolicy(toolName, event.args);
	stats.toolCallRisks[event.toolCallId] = policy?.risk;
	if (policy?.risk === "propose") {
		stats.proposeToolEvents += 1;
	}
	if (policy?.risk === "write" || policy?.risk === "destructive") {
		stats.writeToolEvents += 1;
	}
}

export function shouldRequireWorkflowWriteTool(phase: WorkflowPhase): boolean {
	return phase.writeRequirement === "write" || (phase.writeRequirement === undefined && phase.toolGroup === "write");
}

export function didWorkflowWritePhaseExecute(phase: WorkflowPhase, stats: WorkflowPhaseToolStats): boolean {
	if (stats.successfulWriteToolEvents > 0 || stats.approvalEvents > 0) {
		return true;
	}

	return phase.writeRequirement === "propose" && stats.successfulProposeToolEvents > 0;
}

export function createWorkflowWriteGuardRetryMessage(
	phaseMessage: string,
	allowedToolNames: readonly string[] = [],
	attempt: number = 1,
	previousText: string = ""
): string {
	const lines: string[] = [
		phaseMessage,
		"",
		"## 后端执行守卫",
		"上一次候选回复没有实际调用当前阶段需要的 propose/write 工具，也没有触发审批，因此当前阶段还没有完成。",
		`这是第 ${attempt} 次守卫重试。本次重试的第一步必须发出 API tool_call，不能只输出文字说明。`,
		"如果当前阶段是预览/提案，请调用允许的 propose_* 工具；如果当前阶段是实际修改，请调用写入工具并按审批流程暂停。",
		"不要只调用 read/verify 工具替代写入工具；read/verify 结果不能完成当前写入阶段。",
		"不要只描述计划、步骤或意图，也不要写“准备调用/接下来调用”后结束。",
		"不要创建占位文件、临时文件或与用户目标无关的文件来满足写入守卫；只允许修改当前任务相关目标。"
	];
	if (allowedToolNames.length > 0) {
		lines.push("");
		lines.push("本次重试只允许调用这些写入/提案工具之一：");
		for (const toolName of allowedToolNames) {
			lines.push(`- ${toolName}`);
		}
	}
	if (previousText.trim().length > 0) {
		lines.push("");
		lines.push("上一轮未通过的文本回复如下，它不能作为完成依据：");
		lines.push(previousText.slice(0, 2000));
	}

	return lines.join("\n");
}

export function getWorkflowWriteGuardRetryAllowedTools(phase: WorkflowPhase): string[] {
	return phase.allowedTools.filter((toolName: string): boolean => {
		const risk: string | undefined = getToolPolicy(toolName)?.risk;
		return (risk === "propose" || risk === "write" || risk === "destructive")
			&& (getWorkflowToolSemantics(toolName).repairFamilies?.length ?? 0) > 0;
	});
}
