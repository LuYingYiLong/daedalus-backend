import type WebSocket from "ws";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientRequest, FlowDocumentRun } from "../../protocol/types.js";
import {
	addConversationFlowBranch,
	archiveConversationFlow,
	createConversationFlow,
	getConversationFlow,
	getConversationFlowNode,
	listConversationFlows,
	renameConversationFlow,
	updateConversationFlowPinnedStates,
	updateConversationFlowLayout,
} from "../../session/conversation-flow-store.js";
import {
	getFlowTreeOrder,
	updateFlowTreeOrder,
	type FlowTreeOrderInventory,
} from "../../session/flow-tree-order-store.js";
import { createSessionFork } from "../../session/session-fork.js";
import {
	createSession,
	deleteSession,
	getStoredSessionMetadata,
	openSession,
	saveSession,
	type SessionMetadata,
} from "../../session/session-store.js";
import { findWorkspace, loadWorkspaces } from "../../workspace/registry.js";
import type { WorkspaceConfig } from "../../workspace/types.js";
import { broadcastGlobalEvent, getSessionRuntime } from "../client-connections.js";
import type { ClientSession } from "../client-session.js";
import { sendJson } from "../send-json.js";
import {
	archiveFlowDocument,
	createConnectedFlowNodeDocument,
	createFlowEdgeDocument,
	createFlowNodeDocument,
	createFlowRunDocument,
	createFlowDocument,
	deleteFlowEdgeDocument,
	deleteFlowNodeDocument,
	getFlowRunDocument,
	getFlowDocument,
	listFlowsDocument,
	renameFlowDocument,
	updateFlowPinnedStatesDocument,
	updateFlowNodeDocument,
	updateFlowSettingsDocument,
	updateFlowViewportDocument,
	listFlowApprovalsDocument,
} from "../../session/flow-document-store.js";
import { getActiveFlowRunIdDocument, resolveFlowRunApproval, startFlowRunDocument, stopFlowRunDocument } from "../flow-runner.js";
import { listFlowNodeTypeDefinitions } from "../flow-node-registry.js";
import { createWorkspaceToolCatalog } from "../../tools/tool-catalog.js";

type FlowRequestMethod =
	| "flow.create"
	| "flow.create.fromSession"
	| "flow.list"
	| "flow.tree.order.get"
	| "flow.tree.order.update"
	| "flow.get"
	| "flow.node.get"
	| "flow.rename"
	| "flow.archive"
	| "flow.branch.create"
	| "flow.branch.copyToChat"
	| "flow.layout.update"
	| "flow.node.create"
	| "flow.node.createConnected"
	| "flow.node.types.list"
	| "flow.node.update"
	| "flow.node.delete"
	| "flow.edge.create"
	| "flow.edge.delete"
	| "flow.viewport.update"
	| "flow.settings.update"
	| "flow.tools.list"
	| "flow.approval.list"
	| "flow.approval.resolve"
	| "flow.run.start"
	| "flow.run.stop"
	| "flow.run.retry"
	| "flow.run.get"
	| "flow.run.list"
	| "flow.import.fromSession"
	| "flow.export.toSession";

type FlowRequest = Extract<ClientRequest, { method: FlowRequestMethod }>;

async function loadFlowTreeOrderInventory(): Promise<FlowTreeOrderInventory> {
	const flows = await listFlowsDocument();
	return {
		workspaces: loadWorkspaces().map((workspace): { id: string } => ({ id: workspace.id })),
		flows: flows.map((flow) => ({ id: flow.flowId, workspaceId: flow.workspaceId, pinned: flow.pinned })),
	};
}

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
	return readFlowRevision(record.flow) ?? readFlowRevision(record.snapshot);
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
	return createFlowDocument({ title: params.title, workspaceId: params.workspaceId ?? null });
/*
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
*/
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

async function importFlowFromSessionDocument(params: Extract<FlowRequest, { method: "flow.import.fromSession" }>["params"]): Promise<unknown> {
	const source = await openSession(params.sourceSessionId);
	assertSessionConvertible(source.metadata);
	const flow = await createFlowDocument({ title: params.title, workspaceId: source.metadata.workspaceId ?? null });
	const user = source.messages.find((message): boolean => message.role === "user");
	const assistant = source.messages.find((message): boolean => message.role === "assistant");
	let current = flow;
	if (user !== undefined) {
		current = await createFlowNodeDocument({ flowId: flow.flow.flowId, revision: current.flow.revision, type: "prompt", title: "Prompt", x: 0, y: 0, config: { text: user.content } });
	}
	if (assistant !== undefined) {
		current = await createFlowNodeDocument({ flowId: flow.flow.flowId, revision: current.flow.revision, type: "llm", title: "LLM", x: 360, y: 0, config: {} });
	}
	if (user !== undefined && assistant !== undefined) {
		const promptNode = current.nodes.find((node): boolean => node.type === "prompt");
		const llmNode = current.nodes.find((node): boolean => node.type === "llm");
		if (promptNode !== undefined && llmNode !== undefined) current = await createFlowEdgeDocument({ flowId: flow.flow.flowId, revision: current.flow.revision, sourceNodeId: promptNode.nodeId, sourcePort: "output", targetNodeId: llmNode.nodeId, targetPort: "input", dataType: "text" });
	}
	if (assistant !== undefined) {
		current = await createFlowNodeDocument({ flowId: flow.flow.flowId, revision: current.flow.revision, type: "output", title: "Output", x: 720, y: 0, config: { format: "text" } });
		const llmNode = current.nodes.find((node): boolean => node.type === "llm");
		const outputNode = current.nodes.find((node): boolean => node.type === "output");
		if (llmNode !== undefined && outputNode !== undefined) current = await createFlowEdgeDocument({ flowId: flow.flow.flowId, revision: current.flow.revision, sourceNodeId: llmNode.nodeId, sourcePort: "output", targetNodeId: outputNode.nodeId, targetPort: "input", dataType: "text" });
	}
	return current;
}

async function exportFlowToSessionDocument(params: Extract<FlowRequest, { method: "flow.export.toSession" }>["params"]): Promise<unknown> {
	const snapshot = await getFlowDocument(params.flowId);
	const output = snapshot.runs.flatMap((run) => run.nodes).find((node): boolean => node.nodeId === params.outputNodeId && (node.status === "completed" || node.status === "cached"));
	if (output === undefined || typeof output !== "object" || output === null || !("output" in output)) throw flowError("flow_output_not_ready", "The selected Output node has no completed result.");
	const prompt = snapshot.nodes.find((node): boolean => node.type === "prompt");
	const metadata = await createSession(params.title, snapshot.flow.workspaceId ?? undefined);
	await saveSession(metadata.id, [
		{ role: "user", content: typeof prompt?.config.text === "string" ? prompt.config.text : "", requestId: `flow-export-${Date.now().toString(36)}` },
		{ role: "assistant", content: String((output as { output: unknown }).output ?? ""), requestId: `flow-export-${Date.now().toString(36)}-assistant` },
	]);
	return { metadata: await getStoredSessionMetadata(metadata.id) };
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
	mcpHost: McpHost,
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
			{
				const flows = await listFlowsDocument({
					...(flowRequest.params.workspaceId === undefined ? {} : { workspaceId: flowRequest.params.workspaceId }),
					...(flowRequest.params.archived === undefined ? {} : { archived: flowRequest.params.archived }),
				});
				const order = flowRequest.params.workspaceId === undefined && flowRequest.params.archived !== true
					? await getFlowTreeOrder({
						workspaces: loadWorkspaces().map((workspace): { id: string } => ({ id: workspace.id })),
						flows: flows.map((flow) => ({ id: flow.flowId, workspaceId: flow.workspaceId, pinned: flow.pinned })),
					})
					: undefined;
				result = order === undefined ? { flows } : { flows, order };
			}
			break;
		case "flow.tree.order.get":
			result = await getFlowTreeOrder(await loadFlowTreeOrderInventory());
			break;
		case "flow.tree.order.update":
			{
				const inventory = await loadFlowTreeOrderInventory();
				const order = await updateFlowTreeOrder(flowRequest.params, inventory);
				const updatedFlows = await updateFlowPinnedStatesDocument(order.pinnedFlowIds);
				result = { order, flows: updatedFlows };
			}
			break;
		case "flow.get":
			result = await getFlowDocument(flowRequest.params.flowId);
			break;
		case "flow.node.get":
			{
				const snapshot = await getFlowDocument(flowRequest.params.flowId);
				const node = snapshot.nodes.find((candidate): boolean => candidate.nodeId === flowRequest.params.nodeId);
				if (node === undefined) throw flowError("flow_node_not_found", `Flow node not found: ${flowRequest.params.nodeId}`);
				result = { node };
			}
			break;
		case "flow.rename":
			result = await renameFlowDocument(flowRequest.params.flowId, flowRequest.params.title, flowRequest.params.revision);
			break;
		case "flow.archive":
			result = await archiveFlowDocument(flowRequest.params.flowId, flowRequest.params.revision);
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
		case "flow.node.create":
			result = await createFlowNodeDocument({
				flowId: flowRequest.params.flowId,
				revision: flowRequest.params.revision,
				type: flowRequest.params.type,
				x: flowRequest.params.x,
				y: flowRequest.params.y,
				...(flowRequest.params.title === undefined ? {} : { title: flowRequest.params.title }),
				...(flowRequest.params.config === undefined ? {} : { config: flowRequest.params.config }),
			});
			break;
		case "flow.node.createConnected":
			result = await createConnectedFlowNodeDocument(flowRequest.params);
			break;
		case "flow.node.types.list": {
			const flow = flowRequest.params.flowId === undefined ? null : (await getFlowDocument(flowRequest.params.flowId)).flow;
			const workspaceId = flow?.workspaceId ?? flowRequest.params.workspaceId;
			result = { nodes: listFlowNodeTypeDefinitions(workspaceId !== undefined && workspaceId !== null) };
			break;
		}
		case "flow.node.update":
			result = await updateFlowNodeDocument({ flowId: flowRequest.params.flowId, nodeId: flowRequest.params.nodeId, revision: flowRequest.params.revision, patch: flowRequest.params.patch });
			break;
		case "flow.node.delete":
			result = await deleteFlowNodeDocument(flowRequest.params);
			break;
		case "flow.edge.create":
			result = await createFlowEdgeDocument(flowRequest.params);
			break;
		case "flow.edge.delete":
			result = await deleteFlowEdgeDocument(flowRequest.params);
			break;
		case "flow.viewport.update":
			result = await updateFlowViewportDocument(flowRequest.params);
			break;
		case "flow.settings.update":
			result = await updateFlowSettingsDocument(flowRequest.params);
			break;
		case "flow.tools.list": {
			const flow = (await getFlowDocument(flowRequest.params.flowId)).flow;
			const catalog = createWorkspaceToolCatalog({ workspaceId: flow.workspaceId ?? undefined, clientType: "studio" });
			result = {
				tools: catalog.getEntries().flatMap((entry) => entry.definition.type === "function" ? [{
					name: entry.id,
					description: entry.definition.function.description ?? "",
					inputSchema: entry.definition.function.parameters,
					risk: entry.policy.risk,
				}] : []),
			};
			break;
		}
		case "flow.approval.list":
			result = { approvals: await listFlowApprovalsDocument(flowRequest.params.flowId, flowRequest.params.runId) };
			break;
		case "flow.approval.resolve":
			result = await resolveFlowRunApproval({ ...flowRequest.params, mcpHost });
			break;
		case "flow.run.start":
			{
				const activeRunId = getActiveFlowRunIdDocument(flowRequest.params.flowId);
				if (activeRunId !== null) throw Object.assign(new Error("Another Flow run is active."), { code: "flow_busy", activeRunId });
			result = await createFlowRunDocument(flowRequest.params.flowId, flowRequest.params.revision, (await getFlowDocument(flowRequest.params.flowId)).nodes.map((node): string => node.nodeId));
			void startFlowRunDocument({
				flowId: flowRequest.params.flowId,
				revision: flowRequest.params.revision,
				runId: (result as { runId: string }).runId,
				mcpHost,
				...(flowRequest.params.forceNodeIds === undefined ? {} : { forceNodeIds: flowRequest.params.forceNodeIds }),
				onRunState: (run): void => broadcastGlobalEvent(run.runId, "flow.run.state", { flowId: run.flowId, runId: run.runId, revision: run.revision, status: run.status }),
				onNodeState: (run, nodeId): void => {
					const node = run.nodes.find((candidate): boolean => candidate.nodeId === nodeId);
					if (node !== undefined) broadcastGlobalEvent(run.runId, "flow.node.state", { flowId: run.flowId, runId: run.runId, nodeId, revision: run.revision, status: node.status });
				},
			});
			break;
			}
		case "flow.run.stop":
			if (!await stopFlowRunDocument(flowRequest.params.flowId, flowRequest.params.runId)) throw flowError("flow_run_not_running", "The Flow run is no longer active.");
			result = await getFlowRunDocument(flowRequest.params.flowId, flowRequest.params.runId);
			break;
		case "flow.run.retry":
			result = await startFlowRunDocument({ flowId: flowRequest.params.flowId, revision: (await getFlowDocument(flowRequest.params.flowId)).flow.graphRevision, mcpHost, ...(flowRequest.params.nodeId === undefined ? {} : { forceNodeIds: [flowRequest.params.nodeId] }) });
			break;
		case "flow.run.get":
			result = await getFlowRunDocument(flowRequest.params.flowId, flowRequest.params.runId);
			break;
		case "flow.run.list":
			result = (await getFlowDocument(flowRequest.params.flowId)).runs.slice(0, flowRequest.params.limit ?? 20);
			break;
		case "flow.import.fromSession":
			result = await importFlowFromSessionDocument(flowRequest.params);
			break;
		case "flow.export.toSession":
			result = await exportFlowToSessionDocument(flowRequest.params);
			break;
		default:
			throw flowError("flow_method_unsupported", `Unsupported Flow request: ${(flowRequest as { method: string }).method}`);
		}
		sendJson(socket, { type: "response", id: request.id, ok: true, result });
		if (["flow.create", "flow.create.fromSession", "flow.rename", "flow.archive", "flow.branch.create", "flow.layout.update", "flow.settings.update"].includes(flowRequest.method)) {
			const updated = readFlowRevision(result);
			if (updated !== null) broadcastGlobalEvent(request.id, "flow.updated", updated);
		}
		if (flowRequest.method === "flow.tree.order.update" && typeof result === "object" && result !== null) {
			const updatedFlows = (result as { flows?: Array<{ flowId: string; revision: number }> }).flows ?? [];
			for (const flow of updatedFlows) broadcastGlobalEvent(request.id, "flow.updated", flow);
		}
		if (["flow.node.create", "flow.node.createConnected", "flow.node.update", "flow.node.delete"].includes(flowRequest.method)) {
			const updated = readFlowRevision(result);
			const paramsRecord = flowRequest.params as Record<string, unknown>;
			const nodeId = typeof paramsRecord.nodeId === "string" ? paramsRecord.nodeId : (typeof (result as { nodeId?: unknown }).nodeId === "string" ? (result as { nodeId: string }).nodeId : ((result as { nodes?: Array<{ nodeId: string }> }).nodes?.at(-1)?.nodeId ?? ""));
			if (updated !== null) broadcastGlobalEvent(request.id, "flow.node.updated", { ...updated, nodeId });
		}
		if (["flow.node.createConnected", "flow.edge.create", "flow.edge.delete"].includes(flowRequest.method)) {
			const updated = readFlowRevision(result);
			const paramsRecord = flowRequest.params as Record<string, unknown>;
			const createdEdge = (result as { edges?: Array<{ edgeId: string; sourceNodeId: string; targetNodeId: string; targetPort: string }> }).edges?.find((edge): boolean => edge.sourceNodeId === paramsRecord.sourceNodeId && edge.targetNodeId === paramsRecord.targetNodeId && edge.targetPort === paramsRecord.targetPort);
			const edgeId = typeof paramsRecord.edgeId === "string" ? paramsRecord.edgeId : (typeof (result as { edgeId?: unknown }).edgeId === "string" ? (result as { edgeId: string }).edgeId : (createdEdge?.edgeId ?? ""));
			if (updated !== null) broadcastGlobalEvent(request.id, "flow.edge.updated", { ...updated, edgeId, ...(flowRequest.method === "flow.edge.delete" ? { deleted: true } : {}) });
		}
		if (flowRequest.method === "flow.viewport.update") {
			const updated = readFlowRevision(result);
			if (updated !== null) broadcastGlobalEvent(request.id, "flow.updated", updated);
		}
		if (["flow.approval.resolve", "flow.run.stop", "flow.run.retry"].includes(flowRequest.method) && typeof result === "object" && result !== null) {
			const run = result as FlowDocumentRun;
			broadcastGlobalEvent(request.id, "flow.run.state", { flowId: run.flowId, runId: run.runId, revision: run.revision, status: run.status });
			for (const node of run.nodes) broadcastGlobalEvent(request.id, "flow.node.state", { flowId: run.flowId, runId: run.runId, nodeId: node.nodeId, revision: run.revision, status: node.status });
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
