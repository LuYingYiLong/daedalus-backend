import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { getSessionDatabase, parseSqlJson, runSessionTransaction, sqlJson } from "./session-database.js";
import type {
	FlowApproval,
	FlowDocument,
	FlowDocumentEdge,
	FlowDocumentNode,
	FlowDocumentNodeRun,
	FlowDocumentRun,
	FlowDocumentSnapshot,
} from "../protocol/types.js";
import type { PendingApproval } from "../tools/approval-gateway.js";
import {
	areFlowPortsCompatible,
	getFlowNodePort,
	getFlowNodeTypeDefinition,
	normalizeFlowNodeConfig,
	resolveFlowNodePorts,
} from "../server/flow-node-registry.js";

export type FlowDocumentNodeType = FlowDocumentNode["type"];
export type FlowDocumentNodeStatus = FlowDocumentNode["status"];
export type FlowDocumentRunStatus = FlowDocumentRun["status"];

type FlowRow = {
	flow_id: string;
	title: string;
	workspace_id: string | null;
	pinned: number;
	revision: number;
	graph_revision: number;
	layout_revision: number;
	approval_mode: FlowDocument["approvalMode"];
	viewport_json: string;
	archived_at: string | null;
	created_at: string;
	updated_at: string;
};
type NodeRow = {
	node_id: string;
	flow_id: string;
	type: FlowDocumentNodeType;
	title: string;
	x: number;
	y: number;
	width: number;
	height: number;
	config_json: string;
	status: FlowDocumentNodeStatus;
	created_at: string;
	updated_at: string;
};
type EdgeRow = {
	edge_id: string;
	flow_id: string;
	source_node_id: string;
	source_port: string;
	target_node_id: string;
	target_port: string;
	data_type: FlowDocumentEdge["dataType"];
};
type RunRow = {
	run_id: string;
	flow_id: string;
	revision: number;
	status: FlowDocumentRunStatus;
	started_at: string | null;
	finished_at: string | null;
	error: string | null;
};
type NodeRunRow = {
	run_id: string;
	node_id: string;
	status: FlowDocumentNodeStatus;
	input_fingerprint: string | null;
	output_json: string | null;
	error: string | null;
	started_at: string | null;
	finished_at: string | null;
};

const DEFAULT_VIEWPORT = { x: 0, y: 0, zoom: 1 };
const DEFAULT_NODE_SIZE = { width: 300, height: 180 };

export function flowDocumentError(code: string, message: string): Error & { code: string } {
	return Object.assign(new Error(message), { code });
}

function now(): string {
	return new Date().toISOString();
}

function mapFlow(row: FlowRow): FlowDocument {
	return {
		flowId: row.flow_id,
		title: row.title,
		workspaceId: row.workspace_id,
		pinned: row.pinned === 1,
		revision: Number(row.revision),
		graphRevision: Number(row.graph_revision),
		layoutRevision: Number(row.layout_revision),
		approvalMode: row.approval_mode,
		viewport: parseSqlJson<FlowDocument["viewport"]>(row.viewport_json),
		archivedAt: row.archived_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function mapNode(row: NodeRow): FlowDocumentNode {
	return {
		nodeId: row.node_id,
		flowId: row.flow_id,
		type: row.type,
		title: row.title,
		x: Number(row.x),
		y: Number(row.y),
		width: Number(row.width),
		height: Number(row.height),
		config: parseSqlJson<Record<string, unknown>>(row.config_json),
		status: row.status,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function mapEdge(row: EdgeRow): FlowDocumentEdge {
	return {
		edgeId: row.edge_id,
		flowId: row.flow_id,
		sourceNodeId: row.source_node_id,
		sourcePort: row.source_port,
		targetNodeId: row.target_node_id,
		targetPort: row.target_port,
		dataType: row.data_type,
	};
}

function mapRun(row: RunRow, nodes: FlowDocumentNodeRun[]): FlowDocumentRun {
	return {
		runId: row.run_id,
		flowId: row.flow_id,
		revision: Number(row.revision),
		status: row.status,
		startedAt: row.started_at,
		finishedAt: row.finished_at,
		error: row.error,
		nodes,
	};
}

function mapNodeRun(row: NodeRunRow): FlowDocumentNodeRun {
	return {
		runId: row.run_id,
		nodeId: row.node_id,
		status: row.status,
		inputFingerprint: row.input_fingerprint,
		output: row.output_json === null ? null : parseSqlJson<unknown>(row.output_json),
		error: row.error,
		startedAt: row.started_at,
		finishedAt: row.finished_at,
	};
}

function requireFlow(db: DatabaseSync, flowId: string, includeArchived: boolean = false): FlowDocument {
	const archivedClause: string = includeArchived ? "" : " AND archived_at IS NULL";
	const row = db.prepare(`
		SELECT flow_id, title, workspace_id, pinned, revision, graph_revision, layout_revision, approval_mode, viewport_json, archived_at, created_at, updated_at
		FROM flow_documents WHERE flow_id = ?${archivedClause}
	`).get(flowId) as FlowRow | undefined;
	if (row === undefined) throw flowDocumentError("flow_not_found", `Flow not found: ${flowId}`);
	return mapFlow(row);
}

function assertGraphEditable(db: DatabaseSync, flowId: string): void {
	const active = db.prepare("SELECT run_id FROM flow_runs WHERE flow_id = ? AND status IN ('queued', 'running', 'waiting') LIMIT 1").get(flowId) as { run_id: string } | undefined;
	if (active !== undefined) throw Object.assign(flowDocumentError("flow_graph_locked", "Stop the active Flow run before editing the graph."), { activeRunId: active.run_id });
}

function bumpRevision(db: DatabaseSync, flowId: string, revision: number): FlowDocument {
	assertGraphEditable(db, flowId);
	const result = db.prepare("UPDATE flow_documents SET revision = revision + 1, graph_revision = graph_revision + 1, updated_at = ? WHERE flow_id = ? AND graph_revision = ? AND archived_at IS NULL").run(now(), flowId, revision);
	if (Number(result.changes) !== 1) throw flowDocumentError("flow_revision_conflict", "The Flow changed elsewhere. Reload and try again.");
	return requireFlow(db, flowId);
}

function bumpLayoutRevision(db: DatabaseSync, flowId: string, revision: number): FlowDocument {
	const result = db.prepare("UPDATE flow_documents SET layout_revision = layout_revision + 1, updated_at = ? WHERE flow_id = ? AND layout_revision = ? AND archived_at IS NULL").run(now(), flowId, revision);
	if (Number(result.changes) !== 1) throw flowDocumentError("flow_layout_revision_conflict", "The Flow layout changed elsewhere. Reload and try again.");
	return requireFlow(db, flowId);
}

function assertNodeType(type: FlowDocumentNodeType): void {
	getFlowNodeTypeDefinition(type);
}

function readNodes(db: DatabaseSync, flowId: string): FlowDocumentNode[] {
	return (db.prepare("SELECT node_id, flow_id, type, title, x, y, width, height, config_json, status, created_at, updated_at FROM flow_nodes WHERE flow_id = ? ORDER BY created_at, node_id").all(flowId) as NodeRow[]).map(mapNode);
}

function readEdges(db: DatabaseSync, flowId: string): FlowDocumentEdge[] {
	return (db.prepare("SELECT edge_id, flow_id, source_node_id, source_port, target_node_id, target_port, data_type FROM flow_edges WHERE flow_id = ? ORDER BY edge_id").all(flowId) as EdgeRow[]).map(mapEdge);
}

function readRuns(db: DatabaseSync, flowId: string, limit: number = 20): FlowDocumentRun[] {
	const runs: RunRow[] = db.prepare("SELECT run_id, flow_id, revision, status, started_at, finished_at, error FROM flow_runs WHERE flow_id = ? ORDER BY COALESCE(started_at, '') DESC, run_id DESC LIMIT ?").all(flowId, limit) as RunRow[];
	return runs.map((run): FlowDocumentRun => {
		const nodeRuns = (db.prepare("SELECT run_id, node_id, status, input_fingerprint, output_json, error, started_at, finished_at FROM flow_node_runs WHERE run_id = ? ORDER BY node_id").all(run.run_id) as NodeRunRow[]).map(mapNodeRun);
		return mapRun(run, nodeRuns);
	});
}

export async function getFlowDocument(flowId: string, includeArchived: boolean = false): Promise<FlowDocumentSnapshot> {
	const db = await getSessionDatabase();
	const flow = requireFlow(db, flowId, includeArchived);
	return { flow, nodes: readNodes(db, flowId), edges: readEdges(db, flowId), runs: readRuns(db, flowId) };
}

export async function listFlowsDocument(params: { workspaceId?: string | undefined; archived?: boolean | undefined } = {}): Promise<FlowDocument[]> {
	const db = await getSessionDatabase();
	const where: string[] = [];
	const values: SQLInputValue[] = [];
	if (params.workspaceId !== undefined) { where.push("workspace_id = ?"); values.push(params.workspaceId); }
	where.push(params.archived === true ? "archived_at IS NOT NULL" : "archived_at IS NULL");
	const rows = db.prepare(`SELECT flow_id, title, workspace_id, pinned, revision, graph_revision, layout_revision, approval_mode, viewport_json, archived_at, created_at, updated_at FROM flow_documents WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, flow_id`).all(...values) as FlowRow[];
	return rows.map(mapFlow);
}

export async function updateFlowPinnedStatesDocument(pinnedFlowIds: readonly string[]): Promise<FlowDocument[]> {
	const db = await getSessionDatabase();
	runSessionTransaction(db, (): void => {
		db.prepare("UPDATE flow_documents SET pinned = 0, revision = revision + 1, updated_at = ? WHERE archived_at IS NULL").run(now());
		const update = db.prepare("UPDATE flow_documents SET pinned = 1, revision = revision + 1, updated_at = ? WHERE flow_id = ? AND archived_at IS NULL");
		for (const flowId of pinnedFlowIds) update.run(now(), flowId);
	});
	return listFlowsDocument();
}

export async function createFlowDocument(params: { title: string; workspaceId?: string | null }): Promise<FlowDocumentSnapshot> {
	const db = await getSessionDatabase();
	const title = params.title.trim();
	if (title.length === 0 || title.length > 200) throw flowDocumentError("flow_title_invalid", "Flow title must contain between 1 and 200 characters.");
	const flowId = `flow-${randomUUID()}`;
	const timestamp = now();
	runSessionTransaction(db, (): void => {
		db.prepare("INSERT INTO flow_documents(flow_id, title, workspace_id, pinned, revision, graph_revision, layout_revision, approval_mode, viewport_json, created_at, updated_at) VALUES (?, ?, ?, 0, 1, 1, 1, 'manual', ?, ?, ?)").run(flowId, title, params.workspaceId ?? null, sqlJson(DEFAULT_VIEWPORT), timestamp, timestamp);
	});
	return getFlowDocument(flowId);
}

export async function renameFlowDocument(flowId: string, title: string, revision: number): Promise<FlowDocument> {
	const db = await getSessionDatabase();
	const normalized = title.trim();
	if (normalized.length === 0 || normalized.length > 200) throw flowDocumentError("flow_title_invalid", "Flow title must contain between 1 and 200 characters.");
	runSessionTransaction(db, (): void => {
		requireFlow(db, flowId);
		const updated = db.prepare("UPDATE flow_documents SET title = ?, updated_at = ?, revision = revision + 1 WHERE flow_id = ? AND revision = ? AND archived_at IS NULL").run(normalized, now(), flowId, revision);
		if (Number(updated.changes) !== 1) throw flowDocumentError("flow_revision_conflict", "The Flow changed elsewhere. Reload and try again.");
	});
	return (await getFlowDocument(flowId)).flow;
}

export async function archiveFlowDocument(flowId: string, revision: number): Promise<FlowDocument> {
	const db = await getSessionDatabase();
	runSessionTransaction(db, (): void => {
		requireFlow(db, flowId);
		const updated = db.prepare("UPDATE flow_documents SET archived_at = ?, updated_at = ?, revision = revision + 1 WHERE flow_id = ? AND revision = ? AND archived_at IS NULL").run(now(), now(), flowId, revision);
		if (Number(updated.changes) !== 1) throw flowDocumentError("flow_revision_conflict", "The Flow changed elsewhere. Reload and try again.");
	});
	return (await getFlowDocument(flowId, true)).flow;
}

export async function createFlowNodeDocument(params: { flowId: string; revision: number; type: FlowDocumentNodeType; title?: string | undefined; x: number; y: number; config?: Record<string, unknown> | undefined }): Promise<FlowDocumentSnapshot> {
	const db = await getSessionDatabase();
	assertNodeType(params.type);
	const config = normalizeFlowNodeConfig(params.type, params.config);
	const definition = getFlowNodeTypeDefinition(params.type);
	const nodeId = `node-${randomUUID()}`;
	const timestamp = now();
	runSessionTransaction(db, (): void => {
		requireFlow(db, params.flowId);
		db.prepare("INSERT INTO flow_nodes(node_id, flow_id, type, title, x, y, width, height, config_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)").run(nodeId, params.flowId, params.type, params.title?.trim() || definition.defaultTitle, params.x, params.y, DEFAULT_NODE_SIZE.width, DEFAULT_NODE_SIZE.height, sqlJson(config), timestamp, timestamp);
		bumpRevision(db, params.flowId, params.revision);
	});
	return getFlowDocument(params.flowId);
}

export async function updateFlowNodeDocument(params: { flowId: string; nodeId: string; revision: number; patch: { title?: string | undefined; x?: number | undefined; y?: number | undefined; width?: number | undefined; height?: number | undefined; config?: Record<string, unknown> | undefined } }): Promise<FlowDocumentSnapshot> {
	const db = await getSessionDatabase();
	runSessionTransaction(db, (): void => {
		requireFlow(db, params.flowId);
		const current = db.prepare("SELECT node_id, flow_id, type, title, x, y, width, height, config_json, status, created_at, updated_at FROM flow_nodes WHERE flow_id = ? AND node_id = ?").get(params.flowId, params.nodeId) as NodeRow | undefined;
		if (current === undefined) throw flowDocumentError("flow_node_not_found", `Flow node not found: ${params.nodeId}`);
		const fields: string[] = [];
		const values: SQLInputValue[] = [];
		for (const key of ["title", "x", "y", "width", "height"] as const) {
			if (params.patch[key] !== undefined) { fields.push(`${key} = ?`); values.push(params.patch[key]); }
		}
		if (params.patch.config !== undefined) {
			const normalizedConfig = normalizeFlowNodeConfig(current.type, params.patch.config);
			fields.push("config_json = ?"); values.push(sqlJson(normalizedConfig));
			const nextNode = { ...mapNode(current), config: normalizedConfig };
			const inputIds = new Set(resolveFlowNodePorts(nextNode).filter((port): boolean => port.direction === "input").map((port): string => port.id));
			const outputIds = new Set(resolveFlowNodePorts(nextNode).filter((port): boolean => port.direction === "output").map((port): string => port.id));
			for (const edge of readEdges(db, params.flowId)) {
				if ((edge.targetNodeId === params.nodeId && !inputIds.has(edge.targetPort)) || (edge.sourceNodeId === params.nodeId && !outputIds.has(edge.sourcePort))) {
					db.prepare("DELETE FROM flow_edges WHERE edge_id = ?").run(edge.edgeId);
				}
			}
		}
		if (fields.length > 0) {
			fields.push("updated_at = ?"); values.push(now(), params.flowId, params.nodeId);
			db.prepare(`UPDATE flow_nodes SET ${fields.join(", ")} WHERE flow_id = ? AND node_id = ?`).run(...values);
		}
		if (params.patch.title !== undefined || params.patch.config !== undefined) bumpRevision(db, params.flowId, params.revision);
		else bumpLayoutRevision(db, params.flowId, params.revision);
	});
	return getFlowDocument(params.flowId);
}

export async function deleteFlowNodeDocument(params: { flowId: string; nodeId: string; revision: number }): Promise<FlowDocumentSnapshot> {
	const db = await getSessionDatabase();
	runSessionTransaction(db, (): void => {
		requireFlow(db, params.flowId);
		const result = db.prepare("DELETE FROM flow_nodes WHERE flow_id = ? AND node_id = ?").run(params.flowId, params.nodeId);
		if (Number(result.changes) !== 1) throw flowDocumentError("flow_node_not_found", `Flow node not found: ${params.nodeId}`);
		bumpRevision(db, params.flowId, params.revision);
	});
	return getFlowDocument(params.flowId);
}

function introducesCycle(edges: readonly FlowDocumentEdge[], sourceNodeId: string, targetNodeId: string): boolean {
	const children = new Map<string, string[]>();
	for (const edge of edges) children.set(edge.sourceNodeId, [...(children.get(edge.sourceNodeId) ?? []), edge.targetNodeId]);
	const stack: string[] = [targetNodeId];
	const seen = new Set<string>();
	while (stack.length > 0) {
		const current = stack.pop()!;
		if (current === sourceNodeId) return true;
		if (seen.has(current)) continue;
		seen.add(current);
		stack.push(...(children.get(current) ?? []));
	}
	return false;
}

export async function createFlowEdgeDocument(params: { flowId: string; revision: number; sourceNodeId: string; sourcePort: string; targetNodeId: string; targetPort: string; dataType: FlowDocumentEdge["dataType"] }): Promise<FlowDocumentSnapshot> {
	const db = await getSessionDatabase();
	const edgeId = `edge-${randomUUID()}`;
	runSessionTransaction(db, (): void => {
		requireFlow(db, params.flowId);
		if (params.sourceNodeId === params.targetNodeId) throw flowDocumentError("flow_cycle", "A Flow node cannot connect to itself.");
		const rows = db.prepare("SELECT node_id, flow_id, type, title, x, y, width, height, config_json, status, created_at, updated_at FROM flow_nodes WHERE flow_id = ? AND node_id IN (?, ?)").all(params.flowId, params.sourceNodeId, params.targetNodeId) as NodeRow[];
		if (rows.length !== 2) throw flowDocumentError("flow_node_not_found", "Both edge endpoints must belong to the Flow.");
		const sourceNode = mapNode(rows.find((row): boolean => row.node_id === params.sourceNodeId)!);
		const targetNode = mapNode(rows.find((row): boolean => row.node_id === params.targetNodeId)!);
		const source = getFlowNodePort(sourceNode, params.sourcePort, "output");
		const target = getFlowNodePort(targetNode, params.targetPort, "input");
		if (source === undefined || target === undefined || !areFlowPortsCompatible(source, target, params.dataType)) {
			throw flowDocumentError("flow_port_incompatible", "The selected Flow ports are not compatible.");
		}
		const edges = readEdges(db, params.flowId);
		if (introducesCycle(edges, params.sourceNodeId, params.targetNodeId)) throw flowDocumentError("flow_cycle", "Flow connections cannot create a cycle.");
		db.prepare("DELETE FROM flow_edges WHERE flow_id = ? AND target_node_id = ? AND target_port = ?").run(params.flowId, params.targetNodeId, params.targetPort);
		db.prepare("INSERT INTO flow_edges(edge_id, flow_id, source_node_id, source_port, target_node_id, target_port, data_type) VALUES (?, ?, ?, ?, ?, ?, ?)").run(edgeId, params.flowId, params.sourceNodeId, params.sourcePort, params.targetNodeId, params.targetPort, params.dataType);
		bumpRevision(db, params.flowId, params.revision);
	});
	return getFlowDocument(params.flowId);
}

export async function createConnectedFlowNodeDocument(params: {
	flowId: string;
	revision: number;
	type: FlowDocumentNodeType;
	title?: string | undefined;
	x: number;
	y: number;
	config?: Record<string, unknown> | undefined;
	connection: {
		direction: "from_existing" | "to_existing";
		existingNodeId: string;
		existingPort: string;
		newPort: string;
		dataType: FlowDocumentEdge["dataType"];
	};
}): Promise<{ snapshot: FlowDocumentSnapshot; nodeId: string; edgeId: string }> {
	const db = await getSessionDatabase();
	assertNodeType(params.type);
	const config = normalizeFlowNodeConfig(params.type, params.config);
	const definition = getFlowNodeTypeDefinition(params.type);
	const nodeId = `node-${randomUUID()}`;
	const edgeId = `edge-${randomUUID()}`;
	const timestamp = now();
	runSessionTransaction(db, (): void => {
		requireFlow(db, params.flowId);
		const existingRow = db.prepare("SELECT node_id, flow_id, type, title, x, y, width, height, config_json, status, created_at, updated_at FROM flow_nodes WHERE flow_id = ? AND node_id = ?").get(params.flowId, params.connection.existingNodeId) as NodeRow | undefined;
		if (existingRow === undefined) throw flowDocumentError("flow_node_not_found", `Flow node not found: ${params.connection.existingNodeId}`);
		const createdNode: FlowDocumentNode = {
			nodeId,
			flowId: params.flowId,
			type: params.type,
			title: params.title?.trim() || definition.defaultTitle,
			x: params.x,
			y: params.y,
			width: DEFAULT_NODE_SIZE.width,
			height: DEFAULT_NODE_SIZE.height,
			config,
			status: "idle",
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		const existingNode = mapNode(existingRow);
		const sourceNode = params.connection.direction === "from_existing" ? existingNode : createdNode;
		const targetNode = params.connection.direction === "from_existing" ? createdNode : existingNode;
		const sourcePortId = params.connection.direction === "from_existing" ? params.connection.existingPort : params.connection.newPort;
		const targetPortId = params.connection.direction === "from_existing" ? params.connection.newPort : params.connection.existingPort;
		const sourcePort = getFlowNodePort(sourceNode, sourcePortId, "output");
		const targetPort = getFlowNodePort(targetNode, targetPortId, "input");
		if (sourcePort === undefined || targetPort === undefined || !areFlowPortsCompatible(sourcePort, targetPort, params.connection.dataType)) {
			throw flowDocumentError("flow_port_incompatible", "The selected Flow ports are not compatible.");
		}
		const sourceNodeId = sourceNode.nodeId;
		const targetNodeId = targetNode.nodeId;
		if (introducesCycle(readEdges(db, params.flowId), sourceNodeId, targetNodeId)) throw flowDocumentError("flow_cycle", "Flow connections cannot create a cycle.");
		db.prepare("INSERT INTO flow_nodes(node_id, flow_id, type, title, x, y, width, height, config_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)").run(nodeId, params.flowId, params.type, createdNode.title, params.x, params.y, DEFAULT_NODE_SIZE.width, DEFAULT_NODE_SIZE.height, sqlJson(config), timestamp, timestamp);
		db.prepare("DELETE FROM flow_edges WHERE flow_id = ? AND target_node_id = ? AND target_port = ?").run(params.flowId, targetNodeId, targetPortId);
		db.prepare("INSERT INTO flow_edges(edge_id, flow_id, source_node_id, source_port, target_node_id, target_port, data_type) VALUES (?, ?, ?, ?, ?, ?, ?)").run(edgeId, params.flowId, sourceNodeId, sourcePortId, targetNodeId, targetPortId, params.connection.dataType);
		bumpRevision(db, params.flowId, params.revision);
	});
	return { snapshot: await getFlowDocument(params.flowId), nodeId, edgeId };
}

export async function deleteFlowEdgeDocument(params: { flowId: string; edgeId: string; revision: number }): Promise<FlowDocumentSnapshot> {
	const db = await getSessionDatabase();
	runSessionTransaction(db, (): void => {
		requireFlow(db, params.flowId);
		const result = db.prepare("DELETE FROM flow_edges WHERE flow_id = ? AND edge_id = ?").run(params.flowId, params.edgeId);
		if (Number(result.changes) !== 1) throw flowDocumentError("flow_edge_not_found", `Flow edge not found: ${params.edgeId}`);
		bumpRevision(db, params.flowId, params.revision);
	});
	return getFlowDocument(params.flowId);
}

export async function updateFlowViewportDocument(params: { flowId: string; revision: number; viewport: FlowDocument["viewport"] }): Promise<FlowDocument> {
	const db = await getSessionDatabase();
	runSessionTransaction(db, (): void => {
		requireFlow(db, params.flowId);
		db.prepare("UPDATE flow_documents SET viewport_json = ? WHERE flow_id = ?").run(sqlJson(params.viewport), params.flowId);
		bumpLayoutRevision(db, params.flowId, params.revision);
	});
	return (await getFlowDocument(params.flowId)).flow;
}

export async function updateFlowSettingsDocument(params: { flowId: string; revision: number; approvalMode: FlowDocument["approvalMode"] }): Promise<FlowDocument> {
	const db = await getSessionDatabase();
	runSessionTransaction(db, (): void => {
		requireFlow(db, params.flowId);
		const updated = db.prepare("UPDATE flow_documents SET approval_mode = ?, revision = revision + 1, updated_at = ? WHERE flow_id = ? AND revision = ? AND archived_at IS NULL").run(params.approvalMode, now(), params.flowId, params.revision);
		if (Number(updated.changes) !== 1) throw flowDocumentError("flow_revision_conflict", "The Flow changed elsewhere. Reload and try again.");
	});
	return (await getFlowDocument(params.flowId)).flow;
}

export async function createFlowRunDocument(flowId: string, revision: number, nodeIds: readonly string[]): Promise<FlowDocumentRun> {
	const db = await getSessionDatabase();
	const runId = `run-${randomUUID()}`;
	runSessionTransaction(db, (): void => {
		const flow = requireFlow(db, flowId);
		if (flow.graphRevision !== revision) throw flowDocumentError("flow_revision_conflict", "The Flow changed before execution started.");
		const active = db.prepare("SELECT run_id FROM flow_runs WHERE flow_id = ? AND status IN ('queued', 'running', 'waiting') LIMIT 1").get(flowId) as { run_id: string } | undefined;
		if (active !== undefined) throw Object.assign(flowDocumentError("flow_busy", "Another Flow run is active."), { activeRunId: active.run_id });
		const timestamp = now();
		db.prepare("INSERT INTO flow_runs(run_id, flow_id, revision, status, started_at) VALUES (?, ?, ?, 'running', ?)").run(runId, flowId, revision, timestamp);
		const insert = db.prepare("INSERT INTO flow_node_runs(run_id, node_id, status) VALUES (?, ?, 'queued')");
		for (const nodeId of nodeIds) insert.run(runId, nodeId);
	});
	return (await getFlowDocument(flowId)).runs.find((run): boolean => run.runId === runId)!;
}

export async function getFlowRunDocument(flowId: string, runId: string): Promise<FlowDocumentRun> {
	const db = await getSessionDatabase();
	const row = db.prepare("SELECT run_id, flow_id, revision, status, started_at, finished_at, error FROM flow_runs WHERE flow_id = ? AND run_id = ?").get(flowId, runId) as RunRow | undefined;
	if (row === undefined) throw flowDocumentError("flow_run_not_found", `Flow run not found: ${runId}`);
	const nodes = (db.prepare("SELECT run_id, node_id, status, input_fingerprint, output_json, error, started_at, finished_at FROM flow_node_runs WHERE run_id = ? ORDER BY node_id").all(runId) as NodeRunRow[]).map(mapNodeRun);
	return mapRun(row, nodes);
}

export async function updateFlowRunDocument(flowId: string, runId: string, patch: { status: FlowDocumentRunStatus; error?: string | null; finishedAt?: string | null }): Promise<FlowDocumentRun> {
	const db = await getSessionDatabase();
	db.prepare("UPDATE flow_runs SET status = ?, error = ?, finished_at = ? WHERE flow_id = ? AND run_id = ?").run(patch.status, patch.error ?? null, patch.finishedAt ?? null, flowId, runId);
	return getFlowRunDocument(flowId, runId);
}

export async function updateFlowNodeRunDocument(flowId: string, runId: string, nodeId: string, patch: { status: FlowDocumentNodeStatus; inputFingerprint?: string | null; output?: unknown; error?: string | null; startedAt?: string | null; finishedAt?: string | null }): Promise<FlowDocumentRun> {
	const db = await getSessionDatabase();
	db.prepare("UPDATE flow_node_runs SET status = ?, input_fingerprint = ?, output_json = ?, error = ?, started_at = ?, finished_at = ? WHERE run_id = ? AND node_id = (SELECT node_id FROM flow_nodes WHERE flow_id = ? AND node_id = ?)").run(patch.status, patch.inputFingerprint ?? null, patch.output === undefined ? null : sqlJson(patch.output), patch.error ?? null, patch.startedAt ?? null, patch.finishedAt ?? null, runId, flowId, nodeId);
	return getFlowRunDocument(flowId, runId);
}

export async function findCachedFlowNodeOutput(flowId: string, nodeId: string, fingerprint: string): Promise<unknown | null> {
	const db = await getSessionDatabase();
	const row = db.prepare("SELECT output_json FROM flow_node_runs WHERE node_id = ? AND input_fingerprint = ? AND status IN ('completed', 'cached') ORDER BY finished_at DESC LIMIT 1").get(nodeId, fingerprint) as { output_json: string | null } | undefined;
	return row?.output_json === null || row === undefined ? null : parseSqlJson<unknown>(row.output_json);
}

export function readFlowGraphForScheduler(flowId: string): Promise<{ flow: FlowDocument; nodes: FlowDocumentNode[]; edges: FlowDocumentEdge[] }> {
	return getSessionDatabase().then((db): { flow: FlowDocument; nodes: FlowDocumentNode[]; edges: FlowDocumentEdge[] } => ({ flow: requireFlow(db, flowId), nodes: readNodes(db, flowId), edges: readEdges(db, flowId) }));
}

type FlowApprovalRow = {
	approval_id: string;
	flow_id: string;
	run_id: string;
	node_id: string;
	tool_name: string;
	reason: string;
	pending_json: string;
	status: FlowApproval["status"];
	required_consent_json: string | null;
	created_at: string;
	resolved_at: string | null;
};

function mapFlowApproval(row: FlowApprovalRow): FlowApproval {
	return {
		approvalId: row.approval_id,
		flowId: row.flow_id,
		runId: row.run_id,
		nodeId: row.node_id,
		toolName: row.tool_name,
		reason: row.reason,
		status: row.status,
		requiredConsent: row.required_consent_json === null ? null : parseSqlJson<FlowApproval["requiredConsent"]>(row.required_consent_json),
		createdAt: row.created_at,
		resolvedAt: row.resolved_at,
	};
}

export async function createFlowApprovalDocument(params: { flowId: string; runId: string; nodeId: string; pending: PendingApproval }): Promise<FlowApproval> {
	const db = await getSessionDatabase();
	const createdAt = new Date(params.pending.createdAt).toISOString();
	db.prepare("INSERT OR REPLACE INTO flow_approvals(approval_id, flow_id, run_id, node_id, tool_name, reason, pending_json, status, required_consent_json, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL)").run(
		params.pending.approvalId,
		params.flowId,
		params.runId,
		params.nodeId,
		params.pending.llmToolName,
		params.pending.reason,
		sqlJson(params.pending),
		params.pending.requiredConsent === undefined ? null : sqlJson(params.pending.requiredConsent),
		createdAt,
	);
	return mapFlowApproval(db.prepare("SELECT * FROM flow_approvals WHERE approval_id = ?").get(params.pending.approvalId) as FlowApprovalRow);
}

export async function listFlowApprovalsDocument(flowId: string, runId?: string): Promise<FlowApproval[]> {
	const db = await getSessionDatabase();
	const rows = (runId === undefined
		? db.prepare("SELECT * FROM flow_approvals WHERE flow_id = ? ORDER BY created_at").all(flowId)
		: db.prepare("SELECT * FROM flow_approvals WHERE flow_id = ? AND run_id = ? ORDER BY created_at").all(flowId, runId)) as FlowApprovalRow[];
	return rows.map(mapFlowApproval);
}

export async function getPendingFlowApprovalDocument(flowId: string, runId: string, approvalId: string): Promise<{ approval: FlowApproval; pending: PendingApproval }> {
	const db = await getSessionDatabase();
	const row = db.prepare("SELECT * FROM flow_approvals WHERE flow_id = ? AND run_id = ? AND approval_id = ? AND status = 'pending'").get(flowId, runId, approvalId) as FlowApprovalRow | undefined;
	if (row === undefined) throw flowDocumentError("flow_approval_not_found", `Pending Flow approval not found: ${approvalId}`);
	return { approval: mapFlowApproval(row), pending: parseSqlJson<PendingApproval>(row.pending_json) };
}

export async function resolveFlowApprovalDocument(flowId: string, runId: string, approvalId: string, status: "approved" | "rejected" | "cancelled"): Promise<FlowApproval> {
	const db = await getSessionDatabase();
	const resolvedAt = now();
	const result = db.prepare("UPDATE flow_approvals SET status = ?, resolved_at = ? WHERE flow_id = ? AND run_id = ? AND approval_id = ? AND status = 'pending'").run(status, resolvedAt, flowId, runId, approvalId);
	if (Number(result.changes) !== 1) throw flowDocumentError("flow_approval_not_found", `Pending Flow approval not found: ${approvalId}`);
	return mapFlowApproval(db.prepare("SELECT * FROM flow_approvals WHERE approval_id = ?").get(approvalId) as FlowApprovalRow);
}

export async function cancelPendingFlowApprovalsDocument(flowId: string, runId: string): Promise<void> {
	const db = await getSessionDatabase();
	db.prepare("UPDATE flow_approvals SET status = 'cancelled', resolved_at = ? WHERE flow_id = ? AND run_id = ? AND status = 'pending'").run(now(), flowId, runId);
}

