import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
	assertSubagentGraphStatusTransition,
	assertSubagentNodeStatusTransition,
	assertValidSubagentGraphSnapshot,
	cloneSubagentGraphSnapshot,
	type SubagentGraph,
	type SubagentGraphSnapshot,
	type SubagentNode,
	type SubagentNodeStatus
} from "../workflow/subagent-graph.js";
import {
	getSessionDatabase,
	parseSqlJson,
	runSessionTransaction,
	sqlJson
} from "./session-database.js";

type GraphRow = {
	graph_id: string;
	session_id: string;
	root_run_id: string;
	revision: number;
	status: SubagentGraph["status"];
	created_at: string;
	updated_at: string;
};

type NodeRow = {
	graph_id: string;
	node_id: string;
	run_id: string;
	role: SubagentNode["role"];
	objective: string;
	status: SubagentNodeStatus;
	context_refs_json: unknown;
	tool_scope_json: unknown;
	workspace_mode: SubagentNode["workspaceMode"];
	worktree_metadata_json: unknown | null;
	result_json: unknown | null;
	failure_json: unknown | null;
	created_at: string;
	updated_at: string;
};

type EdgeRow = {
	dependency_node_id: string;
	dependent_node_id: string;
};

const RECOVERABLE_GRAPH_STATUSES: readonly SubagentGraph["status"][] = ["draft", "running", "blocked"];

function readSnapshot(db: DatabaseSync, graphId: string): SubagentGraphSnapshot | null {
	const graphRow = db.prepare(`
		SELECT graph_id, session_id, root_run_id, revision, status, created_at, updated_at
		FROM subagent_graphs WHERE graph_id = ?
	`).get(graphId) as GraphRow | undefined;
	if (graphRow === undefined) return null;

	const nodeRows = db.prepare(`
		SELECT graph_id, node_id, run_id, role, objective, status,
			context_refs_json, tool_scope_json, workspace_mode,
			worktree_metadata_json, result_json, failure_json, created_at, updated_at
		FROM subagent_nodes
		WHERE graph_id = ?
		ORDER BY created_at, node_id
	`).all(graphId) as NodeRow[];
	const edgeRows = db.prepare(`
		SELECT dependency_node_id, dependent_node_id
		FROM subagent_edges
		WHERE graph_id = ?
		ORDER BY dependent_node_id, dependency_node_id
	`).all(graphId) as EdgeRow[];
	const dependenciesByNode: Map<string, string[]> = new Map();
	for (const edge of edgeRows) {
		const dependencies: string[] = dependenciesByNode.get(edge.dependent_node_id) ?? [];
		dependencies.push(edge.dependency_node_id);
		dependenciesByNode.set(edge.dependent_node_id, dependencies);
	}

	const snapshot: SubagentGraphSnapshot = {
		graph: {
			graphId: graphRow.graph_id,
			sessionId: graphRow.session_id,
			rootRunId: graphRow.root_run_id,
			revision: Number(graphRow.revision),
			status: graphRow.status,
			createdAt: graphRow.created_at,
			updatedAt: graphRow.updated_at
		},
		nodes: nodeRows.map((row: NodeRow): SubagentNode => ({
			nodeId: row.node_id,
			graphId: row.graph_id,
			runId: row.run_id,
			role: row.role,
			objective: row.objective,
			dependsOn: dependenciesByNode.get(row.node_id) ?? [],
			status: row.status,
			contextRefs: parseSqlJson<SubagentNode["contextRefs"]>(row.context_refs_json),
			toolScope: parseSqlJson<SubagentNode["toolScope"]>(row.tool_scope_json),
			workspaceMode: row.workspace_mode,
			worktreeMetadata: row.worktree_metadata_json === null
				? null
				: parseSqlJson<SubagentNode["worktreeMetadata"]>(row.worktree_metadata_json),
			result: row.result_json === null ? null : parseSqlJson<SubagentNode["result"]>(row.result_json),
			failure: row.failure_json === null ? null : parseSqlJson<SubagentNode["failure"]>(row.failure_json),
			createdAt: row.created_at,
			updatedAt: row.updated_at
		}))
	};
	assertValidSubagentGraphSnapshot(snapshot);
	return snapshot;
}

function snapshotsEqual(left: SubagentGraphSnapshot, right: SubagentGraphSnapshot): boolean {
	const normalize = (snapshot: SubagentGraphSnapshot): SubagentGraphSnapshot => ({
		graph: snapshot.graph,
		nodes: snapshot.nodes
			.map((node: SubagentNode): SubagentNode => ({ ...node, dependsOn: [...node.dependsOn].sort() }))
			.sort((a: SubagentNode, b: SubagentNode): number => a.nodeId.localeCompare(b.nodeId))
	});
	return isDeepStrictEqual(normalize(left), normalize(right));
}

function assertSafeUpdate(current: SubagentGraphSnapshot, next: SubagentGraphSnapshot): void {
	if (next.graph.sessionId !== current.graph.sessionId) {
		throw new Error(`Subagent graph ${current.graph.graphId} cannot change session.`);
	}
	if (next.graph.rootRunId !== current.graph.rootRunId) {
		throw new Error(`Subagent graph ${current.graph.graphId} cannot change root run.`);
	}
	if (next.graph.createdAt !== current.graph.createdAt) {
		throw new Error(`Subagent graph ${current.graph.graphId} cannot change its creation timestamp.`);
	}
	if (next.graph.revision <= current.graph.revision) {
		throw new Error(
			`Stale subagent graph revision for ${current.graph.graphId}: expected a revision greater than ${current.graph.revision}, received ${next.graph.revision}.`
		);
	}
	assertSubagentGraphStatusTransition(current.graph.status, next.graph.status);

	const nextNodes: Map<string, SubagentNode> = new Map(
		next.nodes.map((node: SubagentNode): [string, SubagentNode] => [node.nodeId, node])
	);
	for (const currentNode of current.nodes) {
		const nextNode: SubagentNode | undefined = nextNodes.get(currentNode.nodeId);
		if (nextNode === undefined) {
			throw new Error(`Subagent graph updates cannot remove node ${currentNode.nodeId}.`);
		}
		if (currentNode.createdAt !== nextNode.createdAt) {
			throw new Error(`Subagent node ${currentNode.nodeId} cannot change its creation timestamp.`);
		}
		if (currentNode.status === "completed") {
			const currentWithoutWorktreeLifecycle: SubagentNode = {
				...currentNode,
				worktreeMetadata: null,
				updatedAt: nextNode.updatedAt
			};
			const nextWithoutWorktreeLifecycle: SubagentNode = {
				...nextNode,
				worktreeMetadata: null
			};
			if (!isDeepStrictEqual(currentWithoutWorktreeLifecycle, nextWithoutWorktreeLifecycle)) {
				throw new Error(`Completed subagent node ${currentNode.nodeId} is immutable except for worktree lifecycle metadata.`);
			}
			continue;
		}
		assertSubagentNodeStatusTransition(currentNode.status, nextNode.status);
		if (
			currentNode.status !== "pending"
			&& currentNode.status !== "ready"
			&& !isDeepStrictEqual(currentNode.dependsOn, nextNode.dependsOn)
		) {
			throw new Error(`Subagent node ${currentNode.nodeId} dependencies are immutable after execution starts.`);
		}
		if (currentNode.runId !== nextNode.runId) {
			const retrying: boolean = (currentNode.status === "failed" || currentNode.status === "cancelled" || currentNode.status === "blocked")
				&& (nextNode.status === "pending" || nextNode.status === "ready");
			const recovering: boolean = currentNode.status === "running" && nextNode.status === "ready";
			if (!retrying && !recovering) {
				throw new Error(`Subagent node ${currentNode.nodeId} can only change run id when retried.`);
			}
		}
	}
}

function writeGraph(db: DatabaseSync, graph: SubagentGraph): void {
	db.prepare(`
		INSERT INTO subagent_graphs(
			graph_id, session_id, root_run_id, revision, status, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(graph_id) DO UPDATE SET
			revision = excluded.revision,
			status = excluded.status,
			updated_at = excluded.updated_at
	`).run(
		graph.graphId,
		graph.sessionId,
		graph.rootRunId,
		graph.revision,
		graph.status,
		graph.createdAt,
		graph.updatedAt
	);
}

function writeNodes(db: DatabaseSync, nodes: readonly SubagentNode[]): void {
	const writeNode = db.prepare(`
		INSERT INTO subagent_nodes(
			graph_id, node_id, run_id, role, objective, status,
			context_refs_json, tool_scope_json, workspace_mode,
			worktree_metadata_json, result_json, failure_json, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(graph_id, node_id) DO UPDATE SET
			run_id = excluded.run_id,
			role = excluded.role,
			objective = excluded.objective,
			status = excluded.status,
			context_refs_json = excluded.context_refs_json,
			tool_scope_json = excluded.tool_scope_json,
			workspace_mode = excluded.workspace_mode,
			worktree_metadata_json = excluded.worktree_metadata_json,
			result_json = excluded.result_json,
			failure_json = excluded.failure_json,
			updated_at = excluded.updated_at
	`);
	for (const node of nodes) {
		writeNode.run(
			node.graphId,
			node.nodeId,
			node.runId,
			node.role,
			node.objective,
			node.status,
			sqlJson(node.contextRefs),
			sqlJson(node.toolScope),
			node.workspaceMode,
			node.worktreeMetadata === null ? null : sqlJson(node.worktreeMetadata),
			node.result === null ? null : sqlJson(node.result),
			node.failure === null ? null : sqlJson(node.failure),
			node.createdAt,
			node.updatedAt
		);
	}
}

function writeEdges(db: DatabaseSync, graphId: string, nodes: readonly SubagentNode[]): void {
	db.prepare("DELETE FROM subagent_edges WHERE graph_id = ?").run(graphId);
	const writeEdge = db.prepare(`
		INSERT INTO subagent_edges(graph_id, dependency_node_id, dependent_node_id, created_at)
		VALUES (?, ?, ?, ?)
	`);
	for (const node of nodes) {
		for (const dependencyId of node.dependsOn) {
			writeEdge.run(graphId, dependencyId, node.nodeId, node.createdAt);
		}
	}
}

export async function saveSubagentGraphSnapshot(snapshot: SubagentGraphSnapshot): Promise<void> {
	assertValidSubagentGraphSnapshot(snapshot);
	const safeSnapshot: SubagentGraphSnapshot = cloneSubagentGraphSnapshot(snapshot);
	const db: DatabaseSync = await getSessionDatabase();
	runSessionTransaction(db, (): void => {
		const current: SubagentGraphSnapshot | null = readSnapshot(db, safeSnapshot.graph.graphId);
		if (current !== null) {
			if (safeSnapshot.graph.revision === current.graph.revision && snapshotsEqual(current, safeSnapshot)) {
				return;
			}
			assertSafeUpdate(current, safeSnapshot);
		} else if (safeSnapshot.graph.revision !== 1) {
			throw new Error(`New subagent graph ${safeSnapshot.graph.graphId} must start at revision 1.`);
		}
		writeGraph(db, safeSnapshot.graph);
		writeNodes(db, safeSnapshot.nodes);
		writeEdges(db, safeSnapshot.graph.graphId, safeSnapshot.nodes);
	});
}

export async function readSubagentGraphSnapshot(graphId: string): Promise<SubagentGraphSnapshot | null> {
	const snapshot: SubagentGraphSnapshot | null = readSnapshot(await getSessionDatabase(), graphId);
	return snapshot === null ? null : cloneSubagentGraphSnapshot(snapshot);
}

export async function listSubagentGraphSnapshots(sessionId: string): Promise<SubagentGraphSnapshot[]> {
	const db: DatabaseSync = await getSessionDatabase();
	const rows = db.prepare(`
		SELECT graph_id FROM subagent_graphs
		WHERE session_id = ?
		ORDER BY updated_at DESC, graph_id
	`).all(sessionId) as Array<{ graph_id: string }>;
	return rows.map((row: { graph_id: string }): SubagentGraphSnapshot => {
		const snapshot: SubagentGraphSnapshot | null = readSnapshot(db, row.graph_id);
		if (snapshot === null) throw new Error(`Subagent graph ${row.graph_id} disappeared while listing.`);
		return cloneSubagentGraphSnapshot(snapshot);
	});
}

export async function listRecoverableSubagentGraphSnapshots(
	sessionId?: string
): Promise<SubagentGraphSnapshot[]> {
	const db: DatabaseSync = await getSessionDatabase();
	const placeholders: string = RECOVERABLE_GRAPH_STATUSES.map((): string => "?").join(", ");
	const sql: string = sessionId === undefined
		? `SELECT graph_id FROM subagent_graphs WHERE status IN (${placeholders}) ORDER BY updated_at, graph_id`
		: `SELECT graph_id FROM subagent_graphs WHERE status IN (${placeholders}) AND session_id = ? ORDER BY updated_at, graph_id`;
	const params: string[] = sessionId === undefined
		? [...RECOVERABLE_GRAPH_STATUSES]
		: [...RECOVERABLE_GRAPH_STATUSES, sessionId];
	const rows = db.prepare(sql).all(...params) as Array<{ graph_id: string }>;
	return rows.map((row: { graph_id: string }): SubagentGraphSnapshot => {
		const snapshot: SubagentGraphSnapshot | null = readSnapshot(db, row.graph_id);
		if (snapshot === null) throw new Error(`Subagent graph ${row.graph_id} disappeared while recovering.`);
		return cloneSubagentGraphSnapshot(snapshot);
	});
}

export async function readSubagentNode(graphId: string, nodeId: string): Promise<SubagentNode | null> {
	const snapshot: SubagentGraphSnapshot | null = await readSubagentGraphSnapshot(graphId);
	const node: SubagentNode | undefined = snapshot?.nodes.find(
		(candidate: SubagentNode): boolean => candidate.nodeId === nodeId
	);
	return node === undefined ? null : structuredClone(node);
}

export async function readSubagentNodeByRunId(runId: string): Promise<SubagentNode | null> {
	const db: DatabaseSync = await getSessionDatabase();
	const row = db.prepare("SELECT graph_id, node_id FROM subagent_nodes WHERE run_id = ?").get(runId) as
		| { graph_id: string; node_id: string }
		| undefined;
	if (row === undefined) return null;
	const snapshot: SubagentGraphSnapshot | null = readSnapshot(db, row.graph_id);
	const node: SubagentNode | undefined = snapshot?.nodes.find(
		(candidate: SubagentNode): boolean => candidate.nodeId === row.node_id
	);
	return node === undefined ? null : structuredClone(node);
}

export async function listReadySubagentNodes(graphId: string): Promise<SubagentNode[]> {
	const snapshot: SubagentGraphSnapshot | null = await readSubagentGraphSnapshot(graphId);
	return snapshot?.nodes
		.filter((node: SubagentNode): boolean => node.status === "ready")
		.map((node: SubagentNode): SubagentNode => structuredClone(node)) ?? [];
}

export async function listActiveSubagentNodesByRootRunId(rootRunId: string): Promise<SubagentNode[]> {
	const db: DatabaseSync = await getSessionDatabase();
	const rows = db.prepare(`
		SELECT graph_id FROM subagent_graphs
		WHERE root_run_id = ? AND status IN ('draft', 'running', 'blocked')
		ORDER BY updated_at, graph_id
	`).all(rootRunId) as Array<{ graph_id: string }>;
	const nodes: SubagentNode[] = [];
	for (const row of rows) {
		const snapshot: SubagentGraphSnapshot | null = readSnapshot(db, row.graph_id);
		if (snapshot === null) continue;
		for (const node of snapshot.nodes) {
			if (node.status !== "completed" && node.status !== "failed" && node.status !== "cancelled") {
				nodes.push(structuredClone(node));
			}
		}
	}
	return nodes;
}
