import type WebSocket from "ws";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { ClientRequest } from "../../protocol/types.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession } from "../client-session.js";
import { sendJson } from "../send-json.js";
import { createWorkspaceToolCatalog, type ToolCatalogEntry } from "../../tools/tool-catalog.js";
import { getEffectiveToolPolicy, type ApprovalDecision, type ToolPolicy } from "../../tools/tool-policy.js";
import { executeLlmToolWithIdempotency, type IdempotentToolExecutionResult } from "../../tools/tool-idempotency.js";
import { describeToolEvent } from "../../tools/tool-event-describer.js";
import { parseToolResultSummary } from "../../tools/tool-result-parser.js";
import { parseExternalMcpMode, isToolAllowedForExternalMcpMode, type ExternalMcpMode } from "../../tools/external-mcp-mode.js";
import { getApprovalMode } from "../../approval-settings-store.js";
import { logger } from "../../logger.js";
import { isWebSearchToolAvailable } from "../../web-search-settings-store.js";
import { getApprovalReasonFromArgs, stripApprovalReasonArg } from "../../tools/approval-reason.js";

function getToolDefinitionName(definition: ChatCompletionTool): string {
	return definition.type === "function" ? definition.function.name : "";
}

function createCatalogToolResult(entry: ToolCatalogEntry, mode: ExternalMcpMode): Record<string, unknown> {
	const definitionName: string = getToolDefinitionName(entry.definition);
	return {
		name: entry.id,
		title: entry.definition.type === "function" ? entry.definition.function.name : entry.id,
		description: entry.definition.type === "function" ? entry.definition.function.description ?? "" : "",
		inputSchema: entry.definition.type === "function" ? entry.definition.function.parameters ?? {} : {},
		risk: entry.policy.risk,
		phaseEligibility: entry.phaseEligibility,
		mode,
		capabilityRequirement: entry.capabilityRequirement ?? null,
		dynamic: entry.dynamicMetadata !== undefined,
		definitionName
	};
}

async function getAllowedCatalogEntries(session: ClientSession, mode: ExternalMcpMode): Promise<ToolCatalogEntry[]> {
	const catalog = createWorkspaceToolCatalog({
		workspaceId: session.activeWorkspace?.id,
		editorInstanceId: session.editorInstanceId
	});
	const webSearchAvailable: boolean = await isWebSearchToolAvailable();
	return catalog.getEntries()
		.filter((entry: ToolCatalogEntry): boolean => entry.id !== "mcp_image_inspect")
		.filter((entry: ToolCatalogEntry): boolean => entry.id !== "mcp_web_search" || webSearchAvailable)
		.filter((entry: ToolCatalogEntry): boolean => isToolAllowedForExternalMcpMode(mode, entry.id, entry.policy));
}

async function findCatalogEntry(session: ClientSession, toolName: string): Promise<ToolCatalogEntry | undefined> {
	if (toolName === "mcp_image_inspect") {
		return undefined;
	}
	if (toolName === "mcp_web_search" && !(await isWebSearchToolAvailable())) {
		return undefined;
	}
	const catalog = createWorkspaceToolCatalog({
		workspaceId: session.activeWorkspace?.id,
		editorInstanceId: session.editorInstanceId
	});
	return catalog.getEntry(toolName);
}

function sendToolError(socket: WebSocket, request: ClientRequest, code: string, message: string): void {
	sendJson(socket, {
		type: "response",
		id: request.id,
		ok: false,
		error: { code, message }
	});
}

export async function handleToolRequest(socket: WebSocket, request: ClientRequest, session: ClientSession, mcpHost: McpHost): Promise<void> {
	switch (request.method) {
	case "tool.catalog.list": {
		const mode: ExternalMcpMode = parseExternalMcpMode(request.params?.mode);
		const entries: ToolCatalogEntry[] = await getAllowedCatalogEntries(session, mode);
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: {
				mode,
				workspaceId: session.activeWorkspace?.id ?? null,
				tools: entries.map((entry: ToolCatalogEntry): Record<string, unknown> => createCatalogToolResult(entry, mode))
			}
		});
		break;
	}

	case "tool.execute": {
		const mode: ExternalMcpMode = parseExternalMcpMode(request.params.mode);
		const toolName: string = request.params.toolName;
		const args: Record<string, unknown> = request.params.args ?? {};
		const executionArgs: Record<string, unknown> = stripApprovalReasonArg(args);
		const approvalReason: string = getApprovalReasonFromArgs(args, "");
		const entry: ToolCatalogEntry | undefined = await findCatalogEntry(session, toolName);
		if (entry === undefined) {
			sendToolError(socket, request, "unknown_tool", `Unknown tool: ${toolName}`);
			break;
		}

		const effectivePolicy: ToolPolicy | undefined = getEffectiveToolPolicy(toolName, executionArgs, session.activeWorkspace?.id);
		if (!isToolAllowedForExternalMcpMode(mode, toolName, effectivePolicy)) {
			sendToolError(socket, request, "tool_not_allowed", `Tool is not allowed in external MCP ${mode} mode: ${toolName}`);
			break;
		}

		const approvalMode = await getApprovalMode();
		session.approvalGateway.setMode(approvalMode);
		const toolCallId: string = request.params.toolCallId ?? request.id;
		const decision: ApprovalDecision = await session.approvalGateway.evaluate(toolName, executionArgs, toolCallId, session.activeWorkspace?.id);
		if (decision.action === "deny") {
			sendToolError(socket, request, "tool_denied", decision.reason);
			break;
		}

		if (decision.action === "request_approval") {
			const reason: string = approvalReason.length > 0 ? approvalReason : decision.reason;
			const pending = session.approvalGateway.requestApproval(
				toolName,
				executionArgs,
				toolCallId,
				reason,
				session.activeWorkspace?.id,
				session.editorInstanceId,
				session.sessionId,
				decision.requiredConsent
			);
			logger.info("external_mcp", "tool_approval_required", {
				approvalId: pending.approvalId,
				toolName,
				workspaceId: session.activeWorkspace?.id,
				mode
			});
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					status: "approval_required",
					approvalId: pending.approvalId,
					reason: pending.reason,
					requiredConsent: pending.requiredConsent,
					toolName,
					args: executionArgs,
					display: describeToolEvent(toolName, executionArgs, session.activeWorkspace?.id)
				}
			});
			break;
		}

		try {
			const result: IdempotentToolExecutionResult = await executeLlmToolWithIdempotency(
				mcpHost,
				toolName,
				executionArgs,
				session.activeWorkspace?.id,
				session.editorInstanceId,
				session.sessionId
			);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					status: "executed",
					toolName,
					content: result.content,
					resultChars: result.rawContentLength,
					truncated: result.truncated,
					cached: result.reused,
					parsed: parseToolResultSummary(toolName, executionArgs, result.content)
				}
			});
		} catch (error: unknown) {
			logger.error("external_mcp", "tool_execute_failed", error, {
				toolName,
				workspaceId: session.activeWorkspace?.id,
				mode
			});
			sendToolError(socket, request, "tool_execution_failed", error instanceof Error ? error.message : "Tool execution failed");
		}
		break;
	}

	default:
		throw new Error(`Unsupported tool method: ${request.method}`);
	}
}
