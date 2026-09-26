import { processImage } from "../../media/image-processing.js";
import { FLOW_STORAGE_GENERATION, FLOW_TYPE_PRESENTATION } from "../../protocol/flow-value-types.js";
import { exportFlowToSqlite } from "../../session/flow-export.js";
import { importFlowFromSqlite } from "../../session/flow-import.js";
import type WebSocket from "ws";
import type { McpHost } from "../../mcp/mcp-host.js";
import { ensureFlowNodePluginRuntimes } from "../../plugins/runtime/manager.js";
import type { ClientRequest, FlowDocumentRun } from "../../protocol/types.js";
import {
	archiveFlowDocument,
	commitFlowOperationsDocument,
	createFlowDocument,
	createFlowEdgeDocument,
	createFlowNodeDocument,
	createFlowRunDocument,
	getFlowDocument,
	getFlowRunDocument,
	listFlowApprovalsDocument,
	listFlowRunsDocument,
	listFlowsDocument,
	moveFlowWorkspaceDocument,
	renameFlowDocument,
	updateFlowRunDocument,
	updateFlowPinnedStatesDocument,
	updateFlowSettingsDocument,
} from "../../session/flow-document-store.js";
import { getFlowTreeOrder, updateFlowTreeOrder, type FlowTreeOrderInventory } from "../../session/flow-tree-order-store.js";
import { createSession, getStoredSessionMetadata, openSession, saveSession, type SessionMetadata } from "../../session/session-store.js";
import { createWorkspaceToolCatalog } from "../../tools/tool-catalog.js";
import { auditFlowArtifacts, cleanupFlowArtifacts, exportFlowArtifacts, flowArtifactUsage, getFlowArtifact, getFlowArtifactReference, importFlowInputArtifact, listFlowArtifacts, listFlowGeneratedArtifacts } from "../../session/flow-artifact-store.js";
import { getFlowRunReport } from "../../session/flow-run-diagnostics.js";
import { latestFlowMediaAttempt } from "../../session/flow-media-attempt-store.js";
import { listFlowBatchItems } from "../../session/flow-batch-store.js";
import { loadWorkspaces } from "../../workspace/registry.js";
import { getClientConnection, broadcastGlobalEvent, getSessionRuntime } from "../client-connections.js";
import type { ClientSession } from "../client-session.js";
import { listFlowNodeTypeDefinitions } from "../flow-node-registry.js";
import { preflightFlowRun } from "../flow-preflight.js";
import { getActiveFlowRunIdDocument, prepareFlowRunDocument, resolveFlowRunApproval, startFlowRunDocument, stopFlowRunDocument } from "../flow-runner.js";
import { sendJson } from "../send-json.js";

type FlowRequestMethod =
	| "flow.create"
	| "flow.list"
	| "flow.tree.order.get"
	| "flow.tree.order.update"
	| "flow.workspace.move"
	| "flow.get"
	| "flow.rename"
	| "flow.archive"
	| "flow.node.types.list"
	| "flow.patch.commit"
	| "flow.settings.update"
	| "flow.tools.list"
	| "flow.approval.list"
	| "flow.approval.resolve"
	| "flow.run.start"
	| "flow.run.preflight"
	| "flow.run.stop"
	| "flow.run.retry"
	| "flow.run.get"
	| "flow.run.list"
	| "flow.run.report"
	| "flow.artifact.list"
	| "flow.artifact.usage"
	| "flow.artifact.health"
	| "flow.artifact.import"
	| "flow.artifact.get"
	| "flow.artifact.preview"
	| "flow.artifact.thumbnail"
	| "flow.artifact.download"
	| "flow.artifact.export"
	| "flow.artifact.delete"
	| "flow.artifact.cleanup"
	| "flow.import.fromSession"
	| "flow.import"
	| "flow.export"
	| "flow.transfer.cancel"
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

const activeTransfers = new Map<string, { socket: WebSocket; controller: AbortController }>();

async function runFlowTransfer<T>(socket: WebSocket, operationId: string | undefined, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
	if (operationId !== undefined && activeTransfers.has(operationId)) throw flowError("flow_transfer_busy", "This Flow transfer is already running.");
	const controller = new AbortController();
	if (operationId !== undefined) activeTransfers.set(operationId, { socket, controller });
	try {
		return await action(controller.signal);
	} catch (error: unknown) {
		if (controller.signal.aborted) throw flowError("flow_transfer_cancelled", "Flow transfer was cancelled.");
		throw error;
	} finally {
		if (operationId !== undefined) activeTransfers.delete(operationId);
	}
}

async function scopedArtifact(flowId: string, artifactId: string, maxBytes: number): Promise<Awaited<ReturnType<typeof getFlowArtifactReference>>> {
	const ref = await getFlowArtifactReference(artifactId);
	if (ref.flowId !== flowId) throw flowError("flow_artifact_scope_invalid", "Artifact does not belong to this Flow.");
	if (ref.byteSize > maxBytes) throw flowError("flow_artifact_rpc_too_large", "This artifact is too large for a single RPC response. Use the media preview or export it to a file.");
	return ref;
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
	if (metadata.archivedAt !== undefined) throw flowError("flow_conversion_archived", "Restore the session before converting it to a Flow.");
	if (metadata.worktree !== undefined) throw flowError("flow_conversion_worktree_unsupported", "Worktree sessions cannot be converted to Flow in this version.");
	if (metadata.scheduledTaskOrigin !== undefined) throw flowError("flow_conversion_scheduled_task_unsupported", "Scheduled task sessions cannot be converted to Flow.");
	const runtime: ClientSession | undefined = getSessionRuntime(metadata.id);
	if (runtime?.activeRunRequestId !== undefined || (runtime?.approvalGateway.listPending().length ?? 0) > 0) {
		throw flowError("flow_conversion_busy", "Wait for the session request to finish before converting it.");
	}
}

async function importFlowFromSessionDocument(params: Extract<FlowRequest, { method: "flow.import.fromSession" }>["params"]): Promise<unknown> {
	const source = await openSession(params.sourceSessionId);
	assertSessionConvertible(source.metadata);
	const created = await createFlowDocument({ title: params.title, workspaceId: source.metadata.workspaceId ?? null });
	const user = source.messages.find((message): boolean => message.role === "user");
	const assistant = source.messages.find((message): boolean => message.role === "assistant");
	let current = created;
	if (user !== undefined) {
		current = await createFlowNodeDocument({ flowId: created.flow.flowId, revision: current.flow.graphRevision, typeId: "builtin/user-prompt", title: "User Prompt", x: 0, y: 0, config: { text: user.content } });
	}
	if (assistant !== undefined) {
		current = await createFlowNodeDocument({ flowId: created.flow.flowId, revision: current.flow.graphRevision, typeId: "builtin/llm", title: "LLM", x: 360, y: 0, config: {} });
	}
	if (user !== undefined && assistant !== undefined) {
		const promptNode = current.nodes.find((node): boolean => node.typeId === "builtin/user-prompt");
		const llmNode = current.nodes.find((node): boolean => node.typeId === "builtin/llm");
		if (promptNode !== undefined && llmNode !== undefined) {
			current = await createFlowEdgeDocument({ flowId: created.flow.flowId, revision: current.flow.graphRevision, sourceNodeId: promptNode.nodeId, sourcePort: "output", targetNodeId: llmNode.nodeId, targetPort: "user-prompt", dataType: "text" });
		}
	}
	if (assistant !== undefined) {
		current = await createFlowNodeDocument({ flowId: created.flow.flowId, revision: current.flow.graphRevision, typeId: "builtin/output", title: "Output", x: 720, y: 0, config: { format: "text" } });
		const llmNode = current.nodes.find((node): boolean => node.typeId === "builtin/llm");
		const outputNode = current.nodes.find((node): boolean => node.typeId === "builtin/output");
		if (llmNode !== undefined && outputNode !== undefined) {
			current = await createFlowEdgeDocument({ flowId: created.flow.flowId, revision: current.flow.graphRevision, sourceNodeId: llmNode.nodeId, sourcePort: "output", targetNodeId: outputNode.nodeId, targetPort: "input", dataType: "text" });
		}
	}
	return current;
}

async function importFlowDocumentFromSqlite(socket: WebSocket, params: Extract<FlowRequest, { method: "flow.import" }>["params"], signal?: AbortSignal): Promise<unknown> {
	if (getClientConnection(socket)?.clientType !== "studio") throw flowError("studio_only", "flow.import is only available to Daedalus Studio.");
	const workspaces = loadWorkspaces();
	const imported = await importFlowFromSqlite(params.sourcePath, { validWorkspaceIds: new Set(workspaces.map(workspace => workspace.id)), ...(signal === undefined ? {} : { signal }) });
	const snapshot = await getFlowDocument(imported.flowId, imported.archived);
	return { ...imported, flow: snapshot.flow };
}

async function exportFlowToSessionDocument(params: Extract<FlowRequest, { method: "flow.export.toSession" }>["params"]): Promise<unknown> {
	const snapshot = await getFlowDocument(params.flowId);
	const output = snapshot.runs.flatMap((run) => run.nodes).find((node): boolean => node.nodeId === params.outputNodeId && (node.status === "completed" || node.status === "cached"));
	if (output === undefined || !("output" in output)) throw flowError("flow_output_not_ready", "The selected Output node has no completed result.");
	const prompt = snapshot.nodes.find((node): boolean => node.typeId === "builtin/user-prompt");
	const metadata = await createSession(params.title, snapshot.flow.workspaceId ?? undefined);
	const requestId = `flow-export-${Date.now().toString(36)}`;
	await saveSession(metadata.id, [
		{ role: "user", content: typeof prompt?.config.text === "string" ? prompt.config.text : "", requestId },
		{ role: "assistant", content: String(output.output ?? ""), requestId: `${requestId}-assistant` },
	]);
	return { metadata: await getStoredSessionMetadata(metadata.id) };
}

export async function handleConversationFlowRequest(socket: WebSocket, request: ClientRequest, _session: ClientSession, mcpHost: McpHost): Promise<void> {
	if (!request.method.startsWith("flow.")) return;
	const flowRequest = request as FlowRequest;
	try {
		let result: unknown;
		switch (flowRequest.method) {
		case "flow.create":
			result = await createFlowDocument({
				title: flowRequest.params.title,
				workspaceId: flowRequest.params.workspaceId ?? null,
				...(flowRequest.params.approvalMode === undefined ? {} : { approvalMode: flowRequest.params.approvalMode }),
				starterGraph: {
					...(flowRequest.params.provider === undefined ? {} : { provider: flowRequest.params.provider }),
					...(flowRequest.params.model === undefined ? {} : { model: flowRequest.params.model }),
					...(flowRequest.params.reasoningEffort === undefined ? {} : { reasoningEffort: flowRequest.params.reasoningEffort }),
				},
			});
			break;
		case "flow.list": {
			const flows = await listFlowsDocument({
				...(flowRequest.params.workspaceId === undefined ? {} : { workspaceId: flowRequest.params.workspaceId }),
				...(flowRequest.params.archived === undefined ? {} : { archived: flowRequest.params.archived }),
			});
			const order = flowRequest.params.workspaceId === undefined && flowRequest.params.archived !== true
				? await getFlowTreeOrder({ workspaces: loadWorkspaces().map((workspace): { id: string } => ({ id: workspace.id })), flows: flows.map((flow) => ({ id: flow.flowId, workspaceId: flow.workspaceId, pinned: flow.pinned })) })
				: undefined;
			result = order === undefined ? { flows } : { flows, order };
			break;
		}
		case "flow.tree.order.get":
			result = await getFlowTreeOrder(await loadFlowTreeOrderInventory());
			break;
		case "flow.tree.order.update": {
			const order = await updateFlowTreeOrder(flowRequest.params, await loadFlowTreeOrderInventory());
			result = { order, flows: await updateFlowPinnedStatesDocument(order.pinnedFlowIds) };
			break;
		}
		case "flow.workspace.move": {
			const { flowId, workspaceId, revision } = flowRequest.params;
			if (workspaceId !== null && !loadWorkspaces().some((workspace): boolean => workspace.id === workspaceId)) {
				throw flowError("workspace_not_found", `Workspace not found: ${workspaceId}`);
			}
			const flow = await moveFlowWorkspaceDocument(flowId, workspaceId, revision);
			const order = await getFlowTreeOrder(await loadFlowTreeOrderInventory());
			result = { flow, order };
			break;
		}
		case "flow.get":
			result = await getFlowDocument(flowRequest.params.flowId);
			break;
		case "flow.rename":
			result = await renameFlowDocument(flowRequest.params.flowId, flowRequest.params.title, flowRequest.params.revision);
			break;
		case "flow.archive":
			result = await archiveFlowDocument(flowRequest.params.flowId, flowRequest.params.revision);
			break;
		case "flow.node.types.list": {
			const flow = flowRequest.params.flowId === undefined ? null : (await getFlowDocument(flowRequest.params.flowId)).flow;
			const workspaceId = flow?.workspaceId ?? flowRequest.params.workspaceId;
			await ensureFlowNodePluginRuntimes({ sessionId: `flow-catalog:${flow?.flowId ?? "new"}`, ...(workspaceId === undefined || workspaceId === null ? {} : { workspaceId }) });
			result = { nodes: listFlowNodeTypeDefinitions(workspaceId !== undefined && workspaceId !== null), generation: FLOW_STORAGE_GENERATION, valueTypes: FLOW_TYPE_PRESENTATION };
			break;
		}
		case "flow.patch.commit":
			if (flowRequest.params.generation !== FLOW_STORAGE_GENERATION) throw flowError("flow_storage_generation_mismatch", "Reload Studio after the Flow storage upgrade.");
			result = await commitFlowOperationsDocument(flowRequest.params);
			break;
		case "flow.settings.update":
			result = await updateFlowSettingsDocument(flowRequest.params);
			break;
		case "flow.tools.list": {
			const flow = (await getFlowDocument(flowRequest.params.flowId)).flow;
			const catalog = createWorkspaceToolCatalog({ workspaceId: flow.workspaceId ?? undefined, clientType: "studio" });
			result = { tools: catalog.getEntries().flatMap((entry) => entry.definition.type === "function" ? [{ name: entry.id, description: entry.definition.function.description ?? "", inputSchema: entry.definition.function.parameters, risk: entry.policy.risk }] : []) };
			break;
		}
		case "flow.approval.list":
			result = { approvals: await listFlowApprovalsDocument(flowRequest.params.flowId, flowRequest.params.runId) };
			break;
		case "flow.approval.resolve":
			result = await resolveFlowRunApproval({ ...flowRequest.params, mcpHost });
			break;
		case "flow.run.preflight":
			result = await preflightFlowRun({ flowId: flowRequest.params.flowId, revision: flowRequest.params.revision, selection: { ...(flowRequest.params.entryNodeIds === undefined ? {} : { entryNodeIds: flowRequest.params.entryNodeIds }), ...(flowRequest.params.targetNodeIds === undefined ? {} : { targetNodeIds: flowRequest.params.targetNodeIds }), ...(flowRequest.params.inputValues === undefined ? {} : { inputValues: flowRequest.params.inputValues }) }, requireOutputTargets: true });
			break;
		case "flow.run.start": {
			const activeRunId = getActiveFlowRunIdDocument(flowRequest.params.flowId);
			if (activeRunId !== null) throw Object.assign(new Error("Another Flow run is active."), { code: "flow_busy", activeRunId });
			const preflight = await preflightFlowRun({ flowId: flowRequest.params.flowId, revision: flowRequest.params.revision, selection: { ...(flowRequest.params.entryNodeIds === undefined ? {} : { entryNodeIds: flowRequest.params.entryNodeIds }), ...(flowRequest.params.targetNodeIds === undefined ? {} : { targetNodeIds: flowRequest.params.targetNodeIds }), ...(flowRequest.params.inputValues === undefined ? {} : { inputValues: flowRequest.params.inputValues }) }, requireOutputTargets: true });
			if (preflight.blockers.length > 0) {
				const first = preflight.blockers[0]!;
				throw Object.assign(new Error(first.message), { code: first.code, nodeId: first.nodeId, blockers: preflight.blockers });
			}
			const plan = await prepareFlowRunDocument({
				flowId: flowRequest.params.flowId,
				revision: flowRequest.params.revision,
				selection: {
					...(flowRequest.params.entryNodeIds === undefined ? {} : { entryNodeIds: flowRequest.params.entryNodeIds }),
					...(flowRequest.params.targetNodeIds === undefined ? {} : { targetNodeIds: flowRequest.params.targetNodeIds }),
					...(flowRequest.params.inputValues === undefined ? {} : { inputValues: flowRequest.params.inputValues }),
				},
				requireOutputTargets: true,
			});
			result = await createFlowRunDocument(
				flowRequest.params.flowId,
				flowRequest.params.revision,
				plan.nodes.map((node): string => node.nodeId),
				{ entryNodeIds: plan.entryNodeIds, targetNodeIds: plan.targetNodeIds, inputValues: plan.inputValues },
			);
			const runId = (result as FlowDocumentRun).runId;
			void startFlowRunDocument({
				flowId: flowRequest.params.flowId,
				revision: flowRequest.params.revision,
				runId,
				mcpHost,
				...(flowRequest.params.forceNodeIds === undefined ? {} : { forceNodeIds: flowRequest.params.forceNodeIds }),
				...(flowRequest.params.forceAllSelected === undefined ? {} : { forceAllSelected: flowRequest.params.forceAllSelected }),
				onBatchItem: (item): void => broadcastGlobalEvent(item.runId, "flow.batch.item.state", item),
				onRunState: (run): void => broadcastGlobalEvent(run.runId, "flow.run.state", { flowId: run.flowId, runId: run.runId, revision: run.revision, status: run.status, run }),
				onNodeState: (run, nodeId): void => {
					const node = run.nodes.find((candidate): boolean => candidate.nodeId === nodeId);
					if (node !== undefined) broadcastGlobalEvent(run.runId, "flow.node.state", { flowId: run.flowId, runId: run.runId, nodeId, revision: run.revision, status: node.status, nodeRun: node });
				},
				onNodeProgress: (runId, nodeId, progress): void => broadcastGlobalEvent(runId, "flow.node.state", { flowId: flowRequest.params.flowId, runId, nodeId, revision: flowRequest.params.revision, status: "running", progress }),
			}).catch(async (runError: unknown): Promise<void> => {
				const failed = await updateFlowRunDocument(flowRequest.params.flowId, runId, {
					status: "failed",
					error: runError instanceof Error ? runError.message : String(runError),
					finishedAt: new Date().toISOString(),
				});
				broadcastGlobalEvent(failed.runId, "flow.run.state", { flowId: failed.flowId, runId: failed.runId, revision: failed.revision, status: failed.status, run: failed });
			});
			break;
		}
		case "flow.run.stop":
			if (!await stopFlowRunDocument(flowRequest.params.flowId, flowRequest.params.runId)) throw flowError("flow_run_not_running", "The Flow run is no longer active.");
			result = await getFlowRunDocument(flowRequest.params.flowId, flowRequest.params.runId);
			break;
		case "flow.run.retry": {
			const previous = await getFlowRunDocument(flowRequest.params.flowId, flowRequest.params.runId);
			const uncertainMedia = (await Promise.all(previous.nodes.map((node) => latestFlowMediaAttempt(previous.runId, node.nodeId))))
				.some((attempt) => attempt !== null && attempt.status === "uncertain" && attempt.providerJobId === null);
			const uncertainBatch = (await listFlowBatchItems(previous.runId))
				.some((item) => item.status === "uncertain" && item.providerJobId === null);
			if ((uncertainMedia || uncertainBatch) && flowRequest.params.confirmPossibleDuplicateCharge !== true)
				throw flowError("flow_paid_retry_confirmation_required", "A paid generation may already have been submitted. Confirm the risk of a duplicate charge before retrying.");
			const revision = (await getFlowDocument(flowRequest.params.flowId)).flow.graphRevision;
			const retrySelection = {
				...(previous.entryNodeIds.length === 0 ? {} : { entryNodeIds: previous.entryNodeIds }),
				...(previous.targetNodeIds.length === 0 ? {} : { targetNodeIds: previous.targetNodeIds }),
				inputValues: previous.inputValues,
			};
			const preflight = await preflightFlowRun({ flowId: flowRequest.params.flowId, revision, selection: retrySelection, requireOutputTargets: true });
			if (preflight.blockers.length > 0) {
				const first = preflight.blockers[0]!;
				throw Object.assign(new Error(first.message), { code: first.code, nodeId: first.nodeId, blockers: preflight.blockers });
			}
			const plan = await prepareFlowRunDocument({
				flowId: flowRequest.params.flowId,
				revision,
				selection: retrySelection,
				requireOutputTargets: true,
			});
			result = await createFlowRunDocument(
				flowRequest.params.flowId,
				revision,
				plan.nodes.map((node): string => node.nodeId),
				{ entryNodeIds: plan.entryNodeIds, targetNodeIds: plan.targetNodeIds, inputValues: plan.inputValues },
			);
			const retryRunId = (result as FlowDocumentRun).runId;
			void startFlowRunDocument({
				flowId: flowRequest.params.flowId,
				revision,
				runId: retryRunId,
				retryFailedItemsOnly: true,
				confirmPossibleDuplicateCharge: flowRequest.params.confirmPossibleDuplicateCharge === true,
				mcpHost,
				...(flowRequest.params.nodeId === undefined ? {} : { forceNodeIds: [flowRequest.params.nodeId] }),
				onBatchItem: (item): void => broadcastGlobalEvent(item.runId, "flow.batch.item.state", item),
				onRunState: (run): void => broadcastGlobalEvent(run.runId, "flow.run.state", { flowId: run.flowId, runId: run.runId, revision: run.revision, status: run.status, run }),
				onNodeState: (run, nodeId): void => {
					const node = run.nodes.find((candidate): boolean => candidate.nodeId === nodeId);
					if (node !== undefined) broadcastGlobalEvent(run.runId, "flow.node.state", { flowId: run.flowId, runId: run.runId, nodeId, revision: run.revision, status: node.status, nodeRun: node });
				},
				onNodeProgress: (runId, nodeId, progress): void => broadcastGlobalEvent(runId, "flow.node.state", { flowId: flowRequest.params.flowId, runId, nodeId, revision, status: "running", progress }),
			}).catch(async (runError: unknown): Promise<void> => {
				const failed = await updateFlowRunDocument(flowRequest.params.flowId, retryRunId, {
					status: "failed",
					error: runError instanceof Error ? runError.message : String(runError),
					finishedAt: new Date().toISOString(),
				});
				broadcastGlobalEvent(failed.runId, "flow.run.state", { flowId: failed.flowId, runId: failed.runId, revision: failed.revision, status: failed.status, run: failed });
			});
			break;
		}
		case "flow.run.get":
			result = await getFlowRunDocument(flowRequest.params.flowId, flowRequest.params.runId);
			break;
		case "flow.run.list":
			result = await listFlowRunsDocument(flowRequest.params.flowId, flowRequest.params.limit ?? 20);
			break;
		case "flow.run.report":
			result = await getFlowRunReport(flowRequest.params.flowId, flowRequest.params.runId);
			break;
		case "flow.artifact.usage":
			result = await flowArtifactUsage(flowRequest.params.flowId);
			break;
		case "flow.artifact.health":
			result = await auditFlowArtifacts(flowRequest.params.flowId);
			break;
		case "flow.artifact.list":
			result = flowRequest.params.aiGeneratedOnly === true
				? await listFlowGeneratedArtifacts(flowRequest.params.flowId, flowRequest.params.limit ?? 3)
				: { artifacts: await listFlowArtifacts(flowRequest.params.flowId, flowRequest.params.runId) };
			break;
		case "flow.artifact.import": {
			if (getClientConnection(socket)?.clientType !== "studio") throw flowError("studio_only", "Flow media import requires Daedalus Studio.");
			const snapshot = await getFlowDocument(flowRequest.params.flowId);
			const node = snapshot.nodes.find((candidate) => candidate.nodeId === flowRequest.params.nodeId);
			if (node?.typeId !== "builtin/flow-input" || node.config.dataType !== flowRequest.params.kind)
				throw flowError("flow_input_type_invalid", "Select a matching Flow Input node before importing media.");
			result = { ref: await importFlowInputArtifact(flowRequest.params) };
			break;
		}
		case "flow.artifact.get": {
				const ref = await scopedArtifact(flowRequest.params.flowId, flowRequest.params.artifactId, flowRequest.params.includeData === true ? 16 * 1024 * 1024 : Number.MAX_SAFE_INTEGER);
				result = flowRequest.params.includeData === true ? { ref, dataBase64: (await getFlowArtifact(ref.artifactId)).bytes.toString("base64") } : { ref };
				break;
			}
		case "flow.artifact.thumbnail": {
			await scopedArtifact(flowRequest.params.flowId, flowRequest.params.artifactId, 64 * 1024 * 1024);
			const artifact = await getFlowArtifact(flowRequest.params.artifactId);
			if (!artifact.ref.mimeType.startsWith("image/")) throw flowError("flow_artifact_thumbnail_unsupported", "Only image artifacts can be resized as thumbnails.");
			const thumbnail = await processImage(artifact.bytes, { kind: "resize", width: 256, height: 256, fit: "contain" }, AbortSignal.timeout(60000));
			result = { ref: artifact.ref, dataBase64: thumbnail.bytes.toString("base64") };
			break;
		}
		case "flow.artifact.preview":
		case "flow.artifact.download": {
				await scopedArtifact(flowRequest.params.flowId, flowRequest.params.artifactId, 16 * 1024 * 1024);
				const artifact = await getFlowArtifact(flowRequest.params.artifactId);
				result = { ref: artifact.ref, dataBase64: artifact.bytes.toString("base64") };
				break;
			}
		case "flow.artifact.export":
			if (getClientConnection(socket)?.clientType !== "studio") throw Object.assign(new Error("flow.artifact.export is only available to Daedalus Studio."), { code: "studio_only" });
			result = await exportFlowArtifacts(flowRequest.params);
			break;
		case "flow.artifact.delete":
			throw flowError("flow_artifact_cleanup_required", "Review the affected runs and artifacts before deleting Flow media.");
		case "flow.artifact.cleanup":
			if (getClientConnection(socket)?.clientType !== "studio") throw flowError("studio_only", "Flow artifact cleanup requires Daedalus Studio.");
			result = await cleanupFlowArtifacts({ flowId: flowRequest.params.flowId, runIds: flowRequest.params.runIds, dryRun: flowRequest.params.dryRun, ...(flowRequest.params.expectedArtifactIds === undefined ? {} : { expectedArtifactIds: flowRequest.params.expectedArtifactIds }) });
			break;
		case "flow.import.fromSession":
			result = await importFlowFromSessionDocument(flowRequest.params);
			break;
		case "flow.import":
			result = await runFlowTransfer(socket, flowRequest.params.operationId, (signal) => importFlowDocumentFromSqlite(socket, flowRequest.params, signal));
			break;
		case "flow.export":
			if (getClientConnection(socket)?.clientType !== "studio") throw Object.assign(new Error("flow.export is only available to Daedalus Studio."), { code: "studio_only" });
			result = await runFlowTransfer(socket, flowRequest.params.operationId, (signal) => exportFlowToSqlite(flowRequest.params.flowId, flowRequest.params.destinationPath, { signal }));
			break;
		case "flow.transfer.cancel": {
			if (getClientConnection(socket)?.clientType !== "studio") throw flowError("studio_only", "Flow transfer cancellation requires Daedalus Studio.");
			const transfer = activeTransfers.get(flowRequest.params.operationId);
			if (transfer === undefined || transfer.socket !== socket) throw flowError("flow_transfer_not_found", "Flow transfer is no longer active.");
			transfer.controller.abort();
			result = { cancelled: true };
			break;
		}
		case "flow.export.toSession":
			result = await exportFlowToSessionDocument(flowRequest.params);
			break;
		default:
			throw flowError("flow_method_unsupported", `Unsupported Flow request: ${(flowRequest as { method: string }).method}`);
		}

		sendJson(socket, { type: "response", id: request.id, ok: true, result });
		if (flowRequest.method === "flow.patch.commit") {
			const ack = result as { flowId: string; graphRevision: number; layoutRevision: number; acceptedMutationIds: string[]; operations: unknown[] };
			broadcastGlobalEvent(request.id, "flow.patch.applied", { flowId: ack.flowId, clientId: flowRequest.params.clientId, graphRevision: ack.graphRevision, layoutRevision: ack.layoutRevision, acceptedMutationIds: ack.acceptedMutationIds, operations: ack.operations });
		}
		if (["flow.create", "flow.rename", "flow.archive", "flow.workspace.move", "flow.settings.update", "flow.import.fromSession", "flow.import"].includes(flowRequest.method)) {
			const updated = readFlowRevision(result);
			if (updated !== null) broadcastGlobalEvent(request.id, "flow.updated", updated);
		}
		if (flowRequest.method === "flow.tree.order.update" && typeof result === "object" && result !== null) {
			const updatedFlows = (result as { flows?: Array<{ flowId: string; revision: number }> }).flows ?? [];
			for (const flow of updatedFlows) broadcastGlobalEvent(request.id, "flow.updated", flow);
		}
		if (["flow.approval.resolve", "flow.run.stop", "flow.run.retry"].includes(flowRequest.method) && typeof result === "object" && result !== null) {
			const run = result as FlowDocumentRun;
			broadcastGlobalEvent(request.id, "flow.run.state", { flowId: run.flowId, runId: run.runId, revision: run.revision, status: run.status, run });
			for (const node of run.nodes) broadcastGlobalEvent(request.id, "flow.node.state", { flowId: run.flowId, runId: run.runId, nodeId: node.nodeId, revision: run.revision, status: node.status, nodeRun: node });
		}
	} catch (error: unknown) {
		sendJson(socket, { type: "response", id: request.id, ok: false, error: { code: errorCode(error), message: error instanceof Error ? error.message : String(error) } });
	}
}
