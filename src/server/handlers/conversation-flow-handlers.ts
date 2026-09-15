import type WebSocket from "ws";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientRequest } from "../../protocol/types.js";
import {
	addConversationFlowBranch,
	archiveConversationFlow,
	createConversationFlow,
	getConversationFlow,
	getConversationFlowNode,
	listConversationFlows,
	renameConversationFlow,
	updateConversationFlowLayout,
} from "../../session/conversation-flow-store.js";
import { createSessionFork } from "../../session/session-fork.js";
import {
	createSession,
	deleteSession,
	getStoredSessionMetadata,
	type SessionMetadata,
} from "../../session/session-store.js";
import { findWorkspace } from "../../workspace/registry.js";
import type { WorkspaceConfig } from "../../workspace/types.js";
import { broadcastGlobalEvent, getSessionRuntime } from "../client-connections.js";
import type { ClientSession } from "../client-session.js";
import { sendJson } from "../send-json.js";

type FlowRequestMethod =
	| "flow.create"
	| "flow.create.fromSession"
	| "flow.list"
	| "flow.get"
	| "flow.node.get"
	| "flow.rename"
	| "flow.archive"
	| "flow.branch.create"
	| "flow.branch.copyToChat"
	| "flow.layout.update";

type FlowRequest = Extract<ClientRequest, { method: FlowRequestMethod }>;

function flowError(code: string, message: string): Error & { code: string } {
	return Object.assign(new Error(message), { code });
}

function errorCode(error: unknown): string {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code ?? "flow_error")
		: "flow_error";
}

function readFlowRevision(value: unknown): { flowId: string; revision: number } | null {
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.flowId === "string" && typeof record.revision === "number") {
		return { flowId: record.flowId, revision: record.revision };
	}
	return readFlowRevision(record.flow);
}

function assertSessionConvertible(metadata: SessionMetadata): void {
	if (metadata.archivedAt !== undefined) {
		throw flowError("flow_conversion_archived", "Restore the session before converting it to a Flow.");
	}
	if (metadata.surface === "flow_branch") {
		throw flowError("flow_conversion_invalid", "The session already belongs to a Flow.");
	}
	if (metadata.worktree !== undefined) {
		throw flowError("flow_conversion_worktree_unsupported", "Worktree sessions cannot be converted to Flow in this version.");
	}
	if (metadata.scheduledTaskOrigin !== undefined) {
		throw flowError("flow_conversion_scheduled_task_unsupported", "Scheduled task sessions cannot be converted to Flow.");
	}
	const runtime: ClientSession | undefined = getSessionRuntime(metadata.id);
	if (runtime?.activeRunRequestId !== undefined || (runtime?.approvalGateway.listPending().length ?? 0) > 0) {
		throw flowError("flow_conversion_busy", "Wait for the session request to finish before converting it.");
	}
}

function createMetadataParams(params: Extract<FlowRequest, { method: "flow.create" }>["params"]): Partial<SessionMetadata> {
	return {
		provider: params.provider,
		model: params.model,
		reasoningEffort: params.reasoningEffort,
		chatMode: params.chatMode,
		approvalMode: params.approvalMode,
	};
}

async function createEmptyFlow(params: Extract<FlowRequest, { method: "flow.create" }>["params"]): Promise<unknown> {
	const workspace: WorkspaceConfig | undefined = params.workspaceId === undefined
		? undefined
		: findWorkspace(params.workspaceId);
	if (params.workspaceId !== undefined && workspace === undefined) {
		throw flowError("workspace_not_found", `Workspace not found: ${params.workspaceId}`);
	}
	const rootSession: SessionMetadata = await createSession(
		params.title,
		workspace?.id,
		undefined,
		workspace,
		createMetadataParams(params),
	);
	try {
		return await createConversationFlow({ title: params.title, rootSession });
	} catch (error: unknown) {
		await deleteSession(rootSession.id).catch((): void => {});
		throw error;
	}
}

async function createFlowFromSession(
	params: Extract<FlowRequest, { method: "flow.create.fromSession" }>["params"],
): Promise<unknown> {
	const source: SessionMetadata = await getStoredSessionMetadata(params.sourceSessionId);
	assertSessionConvertible(source);
	const clone = await createSessionFork({
		sourceSessionId: source.id,
		title: params.title,
		cutoff: "through_latest",
	});
	try {
		return await createConversationFlow({
			title: params.title,
			rootSession: clone.metadata,
			createdFromSessionId: source.id,
		});
	} catch (error: unknown) {
		await deleteSession(clone.metadata.id).catch((): void => {});
		throw error;
	}
}

async function createFlowBranch(
	params: Extract<FlowRequest, { method: "flow.branch.create" }>["params"],
): Promise<unknown> {
	const snapshot = await getConversationFlow(params.flowId);
	if (snapshot.flow.activeRequestId !== null) {
		throw Object.assign(new Error("Another Flow branch is active."), {
			code: "flow_busy",
			activeBranchId: snapshot.flow.activeBranchId,
		});
	}
	const parentBranch = snapshot.branches.find((branch): boolean => branch.branchId === params.parentBranchId);
	if (parentBranch === undefined) {
		throw flowError("flow_branch_not_found", `Flow branch not found: ${params.parentBranchId}`);
	}
	const nodeResult = await getConversationFlowNode(params.flowId, params.sourceNodeId);
	if (!snapshot.nodes.some((node): boolean => node.nodeId === params.sourceNodeId)) {
		throw flowError("flow_node_not_found", `Flow node not found: ${params.sourceNodeId}`);
	}
	const sourceRuntime: ClientSession | undefined = getSessionRuntime(parentBranch.sessionId);
	if (sourceRuntime?.activeRunRequestId !== undefined || (sourceRuntime?.approvalGateway.listPending().length ?? 0) > 0) {
		throw flowError("flow_branch_source_busy", "Wait for the source branch to finish before deriving from it.");
	}
	const clone = await createSessionFork({
		sourceSessionId: parentBranch.sessionId,
		sourceRequestId: nodeResult.node.requestId,
		title: params.title ?? snapshot.flow.title,
		cutoff: nodeResult.node.role === "user" ? "before_user" : "through_request",
	});
	try {
		const branch = await addConversationFlowBranch({
			flowId: params.flowId,
			session: clone.metadata,
			parentBranchId: params.parentBranchId,
			forkRequestId: nodeResult.node.requestId,
			forkRole: nodeResult.node.role,
		});
		return {
			branch,
			session: await getStoredSessionMetadata(clone.metadata.id),
			seedAction: nodeResult.node.role === "user" ? "regenerate" : "compose",
			draft: clone.draft,
			flow: await getConversationFlow(params.flowId),
		};
	} catch (error: unknown) {
		await deleteSession(clone.metadata.id).catch((): void => {});
		throw error;
	}
}

async function copyFlowBranchToChat(
	params: Extract<FlowRequest, { method: "flow.branch.copyToChat" }>["params"],
): Promise<unknown> {
	const snapshot = await getConversationFlow(params.flowId);
	if (snapshot.flow.activeRequestId !== null) {
		throw flowError("flow_busy", "Wait for the active Flow request to finish before copying a branch.");
	}
	const branch = snapshot.branches.find((candidate): boolean => candidate.branchId === params.branchId);
	if (branch === undefined) {
		throw flowError("flow_branch_not_found", `Flow branch not found: ${params.branchId}`);
	}
	const clone = await createSessionFork({
		sourceSessionId: branch.sessionId,
		title: params.title,
		cutoff: "through_latest",
	});
	return { metadata: clone.metadata, draft: clone.draft };
}

export async function handleConversationFlowRequest(
	socket: WebSocket,
	request: ClientRequest,
	_session: ClientSession,
	_mcpHost: McpHost,
): Promise<void> {
	if (!request.method.startsWith("flow.")) return;
	const flowRequest: FlowRequest = request as FlowRequest;
	try {
		let result: unknown;
		switch (flowRequest.method) {
		case "flow.create":
			result = await createEmptyFlow(flowRequest.params);
			break;
		case "flow.create.fromSession":
			result = await createFlowFromSession(flowRequest.params);
			break;
		case "flow.list":
			result = { flows: await listConversationFlows(flowRequest.params) };
			break;
		case "flow.get":
			result = await getConversationFlow(flowRequest.params.flowId);
			break;
		case "flow.node.get":
			result = await getConversationFlowNode(flowRequest.params.flowId, flowRequest.params.nodeId);
			break;
		case "flow.rename":
			result = await renameConversationFlow(flowRequest.params.flowId, flowRequest.params.title, flowRequest.params.revision);
			break;
		case "flow.archive":
			result = await archiveConversationFlow(flowRequest.params.flowId, flowRequest.params.revision);
			break;
		case "flow.branch.create":
			result = await createFlowBranch(flowRequest.params);
			break;
		case "flow.branch.copyToChat":
			result = await copyFlowBranchToChat(flowRequest.params);
			break;
		case "flow.layout.update":
			result = await updateConversationFlowLayout(
				flowRequest.params.flowId,
				flowRequest.params.revision,
				flowRequest.params.positions,
			);
			break;
		default:
			throw flowError("flow_method_unsupported", `Unsupported Flow request: ${(flowRequest as { method: string }).method}`);
		}
		sendJson(socket, { type: "response", id: request.id, ok: true, result });
		if (["flow.create", "flow.create.fromSession", "flow.rename", "flow.archive", "flow.branch.create", "flow.layout.update"].includes(flowRequest.method)) {
			const updated = readFlowRevision(result);
			if (updated !== null) broadcastGlobalEvent(request.id, "flow.updated", updated);
		}
	} catch (error: unknown) {
		const candidate = error as Error & { activeBranchId?: string | null };
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: false,
				error: {
					code: errorCode(error),
					message: error instanceof Error ? error.message : String(error),
					...(candidate.activeBranchId === undefined ? {} : {
						details: { activeBranchId: candidate.activeBranchId },
					}),
				},
		});
	}
}
