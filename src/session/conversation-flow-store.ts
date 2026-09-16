import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getSessionDatabase, runSessionTransaction, toSqlValue } from "./session-database.js";
import {
	archiveSession,
	getStoredSessionMetadata,
	normalizeSessionMetadata,
	openSession,
	restoreArchivedSession,
	updateSessionMetadata,
	type SessionMetadata,
} from "./session-store.js";
import {
	buildCanonicalTimelineBlocks,
	type TimelineAssistantBlock,
	type TimelineBlock,
	type TimelineUserBlock,
} from "./timeline-blocks.js";

const MAX_NODE_PREVIEW_CHARS: number = 1_200;

export type ConversationFlowNodeRole = "user" | "assistant";
export type ConversationFlowNodeStatus = "completed" | "streaming" | "waiting" | "failed" | "stopped";

export type ConversationFlow = {
	flowId: string;
	title: string;
	workspaceId: string | null;
	pinned: boolean;
	rootBranchId: string;
	revision: number;
	activeBranchId: string | null;
	activeRequestId: string | null;
	archivedAt: string | null;
	createdFromSessionId: string | null;
	createdAt: string;
	updatedAt: string;
};

export type ConversationFlowBranch = {
	branchId: string;
	flowId: string;
	sessionId: string;
	parentBranchId: string | null;
	forkRequestId: string | null;
	forkRole: ConversationFlowNodeRole | null;
	seedRequestId: string | null;
	headNodeId: string | null;
	pendingRegenerate: boolean;
	createdAt: string;
	updatedAt: string;
};

export type ConversationFlowNode = {
	nodeId: string;
	flowId: string;
	branchId: string;
	sessionId: string;
	requestId: string;
	role: ConversationFlowNodeRole;
	parentNodeId: string | null;
	status: ConversationFlowNodeStatus;
	contentPreview: string;
	createdAt: string;
	updatedAt: string;
};

export type ConversationFlowNodePosition = {
	nodeId: string;
	x: number;
	y: number;
};

export type ConversationFlowSummary = ConversationFlow & {
	branchCount: number;
};

export type ConversationFlowSnapshot = {
	flow: ConversationFlow;
	branches: ConversationFlowBranch[];
	nodes: ConversationFlowNode[];
	positions: ConversationFlowNodePosition[];
};

type FlowRow = {
	flow_id: string;
	title: string;
	workspace_id: string | null;
	pinned: number;
	root_branch_id: string;
	revision: number;
	active_branch_id: string | null;
	active_request_id: string | null;
	archived_at: string | null;
	created_from_session_id: string | null;
	created_at: string;
	updated_at: string;
};

type BranchRow = {
	branch_id: string;
	flow_id: string;
	session_id: string;
	parent_branch_id: string | null;
	fork_request_id: string | null;
	fork_role: ConversationFlowNodeRole | null;
	seed_request_id: string | null;
	head_node_id: string | null;
	pending_regenerate: number;
	created_at: string;
	updated_at: string;
};

type NodeRow = {
	flow_id: string;
	node_id: string;
	branch_id: string;
	session_id: string;
	request_id: string;
	role: ConversationFlowNodeRole;
	parent_node_id: string | null;
	status: ConversationFlowNodeStatus;
	content_preview: string;
	created_at: string;
	updated_at: string;
};

function flowError(code: string, message: string): Error & { code: string } {
	return Object.assign(new Error(message), { code });
}

function normalizeTitle(title: string): string {
	const normalized: string = title.trim();
	if (normalized.length === 0 || normalized.length > 200) {
		throw flowError("flow_title_invalid", "Flow title must contain between 1 and 200 characters.");
	}
	return normalized;
}

function mapFlow(row: FlowRow): ConversationFlow {
	return {
		flowId: row.flow_id,
		title: row.title,
		workspaceId: row.workspace_id,
		pinned: row.pinned === 1,
		rootBranchId: row.root_branch_id,
		revision: Number(row.revision),
		activeBranchId: row.active_branch_id,
		activeRequestId: row.active_request_id,
		archivedAt: row.archived_at,
		createdFromSessionId: row.created_from_session_id,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function mapBranch(row: BranchRow): ConversationFlowBranch {
	return {
		branchId: row.branch_id,
		flowId: row.flow_id,
		sessionId: row.session_id,
		parentBranchId: row.parent_branch_id,
		forkRequestId: row.fork_request_id,
		forkRole: row.fork_role,
		seedRequestId: row.seed_request_id,
		headNodeId: row.head_node_id,
		pendingRegenerate: row.pending_regenerate === 1,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function requireFlow(db: DatabaseSync, flowId: string, includeArchived: boolean = false): ConversationFlow {
	const archivedClause: string = includeArchived ? "" : " AND archived_at IS NULL";
	const row = db.prepare(`
		SELECT flow_id, title, workspace_id, pinned, root_branch_id, revision, active_branch_id,
			active_request_id, archived_at, created_from_session_id, created_at, updated_at
		FROM conversation_flows WHERE flow_id = ?${archivedClause}
	`).get(flowId) as FlowRow | undefined;
	if (row === undefined) {
		throw flowError("flow_not_found", `Flow not found: ${flowId}`);
	}
	return mapFlow(row);
}

function readBranches(db: DatabaseSync, flowId: string): ConversationFlowBranch[] {
	const rows = db.prepare(`
		SELECT branch_id, flow_id, session_id, parent_branch_id, fork_request_id,
			fork_role, seed_request_id, head_node_id, pending_regenerate, created_at, updated_at
		FROM conversation_flow_branches
		WHERE flow_id = ? ORDER BY created_at, branch_id
	`).all(flowId) as BranchRow[];
	return rows.map(mapBranch);
}

function readNodes(db: DatabaseSync, flowId: string): ConversationFlowNode[] {
	const rows = db.prepare(`
		SELECT flow_id, node_id, branch_id, session_id, request_id, role, parent_node_id,
			status, content_preview, created_at, updated_at
		FROM conversation_flow_nodes WHERE flow_id = ? ORDER BY created_at, node_id
	`).all(flowId) as NodeRow[];
	return rows.map((row): ConversationFlowNode => ({
		flowId: row.flow_id,
		nodeId: row.node_id,
		branchId: row.branch_id,
		sessionId: row.session_id,
		requestId: row.request_id,
		role: row.role,
		parentNodeId: row.parent_node_id,
		status: row.status,
		contentPreview: row.content_preview,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}));
}

function nodeId(requestId: string, role: ConversationFlowNodeRole): string {
	return `${role}:${requestId}`;
}

function preview(content: string): string {
	const normalized: string = content.trim();
	return normalized.length <= MAX_NODE_PREVIEW_CHARS
		? normalized
		: `${normalized.slice(0, MAX_NODE_PREVIEW_CHARS - 1)}…`;
}

function assistantStatus(block: TimelineAssistantBlock): ConversationFlowNodeStatus {
	if (block.status === "failed") return "failed";
	if (block.status === "stopped" || block.completionStatus === "stopped") return "stopped";
	return block.completedAtUtc.length > 0 ? "completed" : "streaming";
}

function blockCreatedAt(block: TimelineUserBlock | TimelineAssistantBlock): string {
	return block.type === "user" ? block.sentAtUtc : block.startedAtUtc;
}

function blockUpdatedAt(block: TimelineUserBlock | TimelineAssistantBlock): string {
	return block.type === "user" ? block.sentAtUtc : (block.completedAtUtc || block.startedAtUtc);
}

async function projectNodes(
	db: DatabaseSync,
	flow: ConversationFlow,
	branches: readonly ConversationFlowBranch[],
): Promise<ConversationFlowNode[]> {
	const nodesById: Map<string, ConversationFlowNode> = new Map(
		readNodes(db, flow.flowId).map((node): [string, ConversationFlowNode] => [node.nodeId, node]),
	);
	for (const branch of branches) {
		const session = await openSession(branch.sessionId);
		const blocks: TimelineBlock[] = buildCanonicalTimelineBlocks(session).blocks;
		const timelineNodeIds: Set<string> = new Set(
			blocks.flatMap((block): string[] => block.type === "divider" ? [] : [nodeId(block.requestId, block.type)]),
		);
		let previousNodeId: string | null = null;
		for (const block of blocks) {
			if (block.type === "divider") continue;
			const currentNodeId: string = nodeId(block.requestId, block.type);
			const isRegenerationSeed: boolean = branch.forkRole === "user"
				&& branch.seedRequestId !== null
				&& block.type === "user"
				&& block.requestId === branch.seedRequestId;
			if (isRegenerationSeed) {
				previousNodeId = nodeId(branch.forkRequestId!, "user");
				continue;
			}
			const existing: ConversationFlowNode | undefined = nodesById.get(currentNodeId);
			if (existing === undefined) {
				const status: ConversationFlowNodeStatus = block.type === "user" ? "completed" : assistantStatus(block);
				const node: ConversationFlowNode = {
					nodeId: currentNodeId,
					flowId: flow.flowId,
					branchId: branch.branchId,
					sessionId: branch.sessionId,
					requestId: block.requestId,
					role: block.type,
					parentNodeId: previousNodeId,
					status,
					contentPreview: preview(block.content),
					createdAt: blockCreatedAt(block),
					updatedAt: blockUpdatedAt(block),
				};
				nodesById.set(currentNodeId, node);
			} else if (block.type === "assistant") {
				existing.status = assistantStatus(block);
				existing.contentPreview = preview(block.content);
				existing.updatedAt = blockUpdatedAt(block);
			}
			previousNodeId = currentNodeId;
		}
		if (branch.headNodeId !== null && !timelineNodeIds.has(branch.headNodeId)) {
			previousNodeId = branch.headNodeId;
		}
		db.prepare(`
			UPDATE conversation_flow_branches SET head_node_id = ?, updated_at = ? WHERE branch_id = ?
		`).run(toSqlValue(previousNodeId ?? undefined), new Date().toISOString(), branch.branchId);
	}

	const nodes: ConversationFlowNode[] = [...nodesById.values()];
	const upsert = db.prepare(`
		INSERT INTO conversation_flow_nodes(
			flow_id, node_id, branch_id, session_id, request_id, role, parent_node_id,
			status, content_preview, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(flow_id, node_id) DO UPDATE SET
			branch_id = excluded.branch_id,
			session_id = excluded.session_id,
			parent_node_id = excluded.parent_node_id,
			status = excluded.status,
			content_preview = excluded.content_preview,
			updated_at = excluded.updated_at
	`);
	runSessionTransaction(db, (): void => {
		for (const node of nodes) {
			upsert.run(
				node.flowId,
				node.nodeId,
				node.branchId,
				node.sessionId,
				node.requestId,
				node.role,
				toSqlValue(node.parentNodeId ?? undefined),
				node.status,
				node.contentPreview,
				node.createdAt,
				node.updatedAt,
			);
		}
	});
	return nodes;
}

function readPositions(db: DatabaseSync, flowId: string): ConversationFlowNodePosition[] {
	const rows = db.prepare(`
		SELECT node_id, x, y FROM conversation_flow_layout WHERE flow_id = ? ORDER BY node_id
	`).all(flowId) as Array<{ node_id: string; x: number; y: number }>;
	return rows.map((row): ConversationFlowNodePosition => ({ nodeId: row.node_id, x: Number(row.x), y: Number(row.y) }));
}

export async function createConversationFlow(params: {
	title: string;
	rootSession: SessionMetadata;
	createdFromSessionId?: string | undefined;
}): Promise<ConversationFlowSnapshot> {
	const db: DatabaseSync = await getSessionDatabase();
	const timestamp: string = new Date().toISOString();
	const flowId: string = `flow-${randomUUID()}`;
	const branchId: string = `flow-branch-${randomUUID()}`;
	const title: string = normalizeTitle(params.title);
	runSessionTransaction(db, (): void => {
		db.prepare(`
			INSERT INTO conversation_flows(
				flow_id, title, workspace_id, pinned, root_branch_id, revision, archived_at,
				created_from_session_id, created_at, updated_at
			) VALUES (?, ?, ?, 0, ?, 1, NULL, ?, ?, ?)
		`).run(
			flowId,
			title,
			toSqlValue(params.rootSession.workspaceId),
			branchId,
			toSqlValue(params.createdFromSessionId),
			timestamp,
			timestamp,
		);
		db.prepare(`
			INSERT INTO conversation_flow_branches(
				branch_id, flow_id, session_id, parent_branch_id, fork_request_id,
				fork_role, seed_request_id, head_node_id, pending_regenerate, created_at, updated_at
			) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL, 0, ?, ?)
		`).run(branchId, flowId, params.rootSession.id, timestamp, timestamp);
	});
	try {
		await updateSessionMetadata(params.rootSession.id, {
			surface: "flow_branch",
			flow: { flowId, branchId },
		});
	} catch (error: unknown) {
		db.prepare("DELETE FROM conversation_flows WHERE flow_id = ?").run(flowId);
		throw error;
	}
	return await getConversationFlow(flowId);
}

export async function addConversationFlowBranch(params: {
	flowId: string;
	session: SessionMetadata;
	parentBranchId: string;
	forkRequestId: string;
	forkRole: ConversationFlowNodeRole;
}): Promise<ConversationFlowBranch> {
	const db: DatabaseSync = await getSessionDatabase();
	const flow: ConversationFlow = requireFlow(db, params.flowId);
	if (flow.workspaceId !== (params.session.workspaceId ?? null)) {
		throw flowError("flow_workspace_mismatch", "Flow branches must use the Flow workspace.");
	}
	const parent = db.prepare(`
		SELECT branch_id FROM conversation_flow_branches WHERE flow_id = ? AND branch_id = ?
	`).get(params.flowId, params.parentBranchId);
	if (parent === undefined) {
		throw flowError("flow_branch_not_found", `Flow branch not found: ${params.parentBranchId}`);
	}
	const branchId: string = `flow-branch-${randomUUID()}`;
	const timestamp: string = new Date().toISOString();
	runSessionTransaction(db, (): void => {
		db.prepare(`
			INSERT INTO conversation_flow_branches(
				branch_id, flow_id, session_id, parent_branch_id, fork_request_id,
				fork_role, seed_request_id, head_node_id, pending_regenerate, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
		`).run(
			branchId,
			params.flowId,
			params.session.id,
			params.parentBranchId,
			params.forkRequestId,
			params.forkRole,
			nodeId(params.forkRequestId, params.forkRole),
			params.forkRole === "user" ? 1 : 0,
			timestamp,
			timestamp,
		);
		db.prepare(`UPDATE conversation_flows SET revision = revision + 1, updated_at = ? WHERE flow_id = ?`)
			.run(timestamp, params.flowId);
	});
	try {
		await updateSessionMetadata(params.session.id, {
			surface: "flow_branch",
			flow: { flowId: params.flowId, branchId },
		});
	} catch (error: unknown) {
		runSessionTransaction(db, (): void => {
			db.prepare("DELETE FROM conversation_flow_branches WHERE branch_id = ?").run(branchId);
			db.prepare(`UPDATE conversation_flows SET revision = revision + 1, updated_at = ? WHERE flow_id = ?`)
				.run(new Date().toISOString(), params.flowId);
		});
		throw error;
	}
	return readBranches(db, params.flowId).find((branch): boolean => branch.branchId === branchId)!;
}

export async function setConversationFlowBranchSeedRequest(branchId: string, requestId: string): Promise<void> {
	const db: DatabaseSync = await getSessionDatabase();
	const timestamp: string = new Date().toISOString();
	db.prepare(`
		UPDATE conversation_flow_branches SET seed_request_id = ?, pending_regenerate = 0, updated_at = ?
		WHERE branch_id = ? AND fork_role = 'user' AND seed_request_id IS NULL
	`).run(requestId, timestamp, branchId);
}

export async function listConversationFlows(params?: {
	workspaceId?: string | undefined;
	archived?: boolean | undefined;
}): Promise<ConversationFlowSummary[]> {
	const db: DatabaseSync = await getSessionDatabase();
	const archived: boolean = params?.archived === true;
	const rows = (params?.workspaceId === undefined
		? db.prepare(`
			SELECT f.flow_id, f.title, f.workspace_id, f.pinned, f.root_branch_id, f.revision,
				f.active_branch_id, f.active_request_id, f.archived_at, f.created_from_session_id,
				f.created_at, f.updated_at, COUNT(b.branch_id) AS branch_count
			FROM conversation_flows f
			LEFT JOIN conversation_flow_branches b ON b.flow_id = f.flow_id
			WHERE ${archived ? "f.archived_at IS NOT NULL" : "f.archived_at IS NULL"}
			GROUP BY f.flow_id ORDER BY f.updated_at DESC
		`).all()
		: db.prepare(`
			SELECT f.flow_id, f.title, f.workspace_id, f.pinned, f.root_branch_id, f.revision,
				f.active_branch_id, f.active_request_id, f.archived_at, f.created_from_session_id,
				f.created_at, f.updated_at, COUNT(b.branch_id) AS branch_count
			FROM conversation_flows f
			LEFT JOIN conversation_flow_branches b ON b.flow_id = f.flow_id
			WHERE f.workspace_id = ? AND ${archived ? "f.archived_at IS NOT NULL" : "f.archived_at IS NULL"}
			GROUP BY f.flow_id ORDER BY f.updated_at DESC
		`).all(params.workspaceId)) as Array<FlowRow & { branch_count: number }>;
	return rows.map((row): ConversationFlowSummary => ({ ...mapFlow(row), branchCount: Number(row.branch_count) }));
}

export async function updateConversationFlowPinnedStates(pinnedFlowIds: readonly string[]): Promise<ConversationFlow[]> {
	const db: DatabaseSync = await getSessionDatabase();
	const pinnedSet: ReadonlySet<string> = new Set(pinnedFlowIds);
	const activeRows = db.prepare("SELECT flow_id, pinned FROM conversation_flows WHERE archived_at IS NULL").all() as Array<{
		flow_id: string;
		pinned: number;
	}>;
	const changed: string[] = activeRows
		.filter((row): boolean => (row.pinned === 1) !== pinnedSet.has(row.flow_id))
		.map((row): string => row.flow_id);
	if (changed.length === 0) return [];
	const timestamp: string = new Date().toISOString();
	runSessionTransaction(db, (): void => {
		const update = db.prepare(`
			UPDATE conversation_flows
			SET pinned = ?, revision = revision + 1, updated_at = ?
			WHERE flow_id = ? AND archived_at IS NULL
		`);
		for (const flowId of changed) update.run(pinnedSet.has(flowId) ? 1 : 0, timestamp, flowId);
	});
	return changed.map((flowId): ConversationFlow => requireFlow(db, flowId));
}

export async function getConversationFlow(flowId: string): Promise<ConversationFlowSnapshot> {
	const db: DatabaseSync = await getSessionDatabase();
	const flow: ConversationFlow = requireFlow(db, flowId);
	const branches: ConversationFlowBranch[] = readBranches(db, flowId);
	const nodes: ConversationFlowNode[] = await projectNodes(db, flow, branches);
	return {
		flow,
		branches: readBranches(db, flowId),
		nodes,
		positions: readPositions(db, flowId),
	};
}

export async function getConversationFlowNode(flowId: string, requestedNodeId: string): Promise<{
	node: ConversationFlowNode;
	block: TimelineBlock;
}> {
	const snapshot: ConversationFlowSnapshot = await getConversationFlow(flowId);
	const node: ConversationFlowNode | undefined = snapshot.nodes.find((candidate): boolean => candidate.nodeId === requestedNodeId);
	if (node === undefined) {
		throw flowError("flow_node_not_found", `Flow node not found: ${requestedNodeId}`);
	}
	const session = await openSession(node.sessionId);
	const block: TimelineBlock | undefined = buildCanonicalTimelineBlocks(session).blocks.find(
		(candidate: TimelineBlock): boolean => candidate.type === node.role && candidate.requestId === node.requestId,
	);
	if (block === undefined) {
		throw flowError("flow_node_content_unavailable", "The Flow node content is unavailable.");
	}
	return { node, block };
}

export async function renameConversationFlow(flowId: string, title: string, revision: number): Promise<ConversationFlow> {
	const db: DatabaseSync = await getSessionDatabase();
	const normalized: string = normalizeTitle(title);
	const timestamp: string = new Date().toISOString();
	const result = db.prepare(`
		UPDATE conversation_flows SET title = ?, revision = revision + 1, updated_at = ?
		WHERE flow_id = ? AND revision = ? AND archived_at IS NULL
	`).run(normalized, timestamp, flowId, revision);
	if (Number(result.changes) !== 1) {
		requireFlow(db, flowId);
		throw flowError("flow_revision_conflict", "The Flow changed before it could be renamed.");
	}
	return requireFlow(db, flowId);
}

export async function updateConversationFlowLayout(
	flowId: string,
	revision: number,
	positions: readonly ConversationFlowNodePosition[],
): Promise<ConversationFlow> {
	const db: DatabaseSync = await getSessionDatabase();
	const timestamp: string = new Date().toISOString();
	runSessionTransaction(db, (): void => {
		const nodeExists = db.prepare(`
			SELECT 1 FROM conversation_flow_nodes WHERE flow_id = ? AND node_id = ?
		`);
		for (const position of positions) {
			if (nodeExists.get(flowId, position.nodeId) === undefined) {
				throw flowError("flow_node_not_found", `Flow node not found: ${position.nodeId}`);
			}
		}
		const result = db.prepare(`
			UPDATE conversation_flows SET revision = revision + 1, updated_at = ?
			WHERE flow_id = ? AND revision = ? AND archived_at IS NULL
		`).run(timestamp, flowId, revision);
		if (Number(result.changes) !== 1) {
			requireFlow(db, flowId);
			throw flowError("flow_revision_conflict", "The Flow changed before its layout could be saved.");
		}
		const upsert = db.prepare(`
			INSERT INTO conversation_flow_layout(flow_id, node_id, x, y, updated_at)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(flow_id, node_id) DO UPDATE SET
				x = excluded.x, y = excluded.y, updated_at = excluded.updated_at
		`);
		for (const position of positions) {
			upsert.run(flowId, position.nodeId, position.x, position.y, timestamp);
		}
	});
	return requireFlow(db, flowId);
}

export async function archiveConversationFlow(flowId: string, revision: number): Promise<ConversationFlow> {
	const db: DatabaseSync = await getSessionDatabase();
	const flow: ConversationFlow = requireFlow(db, flowId);
	if (flow.revision !== revision) {
		throw flowError("flow_revision_conflict", "The Flow changed before it could be archived.");
	}
	if (flow.activeRequestId !== null) {
		throw flowError("flow_busy", "A Flow branch is still active.");
	}
	const branches: ConversationFlowBranch[] = readBranches(db, flowId);
	const archivedSessionIds: string[] = [];
	try {
		for (const branch of branches) {
			await archiveSession(branch.sessionId);
			archivedSessionIds.push(branch.sessionId);
		}
	} catch (error: unknown) {
		for (const sessionId of archivedSessionIds.reverse()) {
			await restoreArchivedSession(sessionId).catch((): void => {});
		}
		throw error;
	}
	const timestamp: string = new Date().toISOString();
	db.prepare(`
		UPDATE conversation_flows SET archived_at = ?, revision = revision + 1, updated_at = ?
		WHERE flow_id = ?
	`).run(timestamp, timestamp, flowId);
	return requireFlow(db, flowId, true);
}

export async function findConversationFlowBranchBySession(sessionId: string): Promise<ConversationFlowBranch | null> {
	const db: DatabaseSync = await getSessionDatabase();
	const row = db.prepare(`
		SELECT branch_id, flow_id, session_id, parent_branch_id, fork_request_id,
			fork_role, seed_request_id, head_node_id, pending_regenerate, created_at, updated_at
		FROM conversation_flow_branches WHERE session_id = ?
	`).get(sessionId) as BranchRow | undefined;
	return row === undefined ? null : mapBranch(row);
}

export async function acquireConversationFlowRun(
	sessionId: string,
	requestId: string,
	userMessage?: string,
): Promise<ConversationFlow | null> {
	const branch: ConversationFlowBranch | null = await findConversationFlowBranchBySession(sessionId);
	if (branch === null) return null;
	const db: DatabaseSync = await getSessionDatabase();
	const flow: ConversationFlow = requireFlow(db, branch.flowId);
	if (flow.activeRequestId !== null && flow.activeRequestId !== requestId) {
		throw Object.assign(new Error("Another Flow branch is active."), {
			code: "flow_busy",
			activeBranchId: flow.activeBranchId,
		});
	}
	if (flow.activeRequestId === requestId) return flow;
	const timestamp: string = new Date().toISOString();
	runSessionTransaction(db, (): void => {
		db.prepare(`
			UPDATE conversation_flows
			SET active_branch_id = ?, active_request_id = ?, revision = revision + 1, updated_at = ?
			WHERE flow_id = ? AND active_request_id IS NULL
		`).run(branch.branchId, requestId, timestamp, branch.flowId);
		if (userMessage === undefined) return;
		const regeneratingUser: boolean = branch.pendingRegenerate && branch.forkRole === "user";
		const userNodeId: string = regeneratingUser
			? nodeId(branch.forkRequestId!, "user")
			: nodeId(requestId, "user");
		const assistantNodeId: string = nodeId(requestId, "assistant");
		const insert = db.prepare(`
			INSERT OR IGNORE INTO conversation_flow_nodes(
				flow_id, node_id, branch_id, session_id, request_id, role, parent_node_id,
				status, content_preview, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		if (!regeneratingUser) {
			insert.run(
				branch.flowId,
				userNodeId,
				branch.branchId,
				branch.sessionId,
				requestId,
				"user",
				toSqlValue(branch.headNodeId ?? undefined),
				"completed",
				preview(userMessage),
				timestamp,
				timestamp,
			);
		}
		insert.run(
			branch.flowId,
			assistantNodeId,
			branch.branchId,
			branch.sessionId,
			requestId,
			"assistant",
			userNodeId,
			"streaming",
			"",
			timestamp,
			timestamp,
		);
		db.prepare(`
			UPDATE conversation_flow_branches SET head_node_id = ?, updated_at = ? WHERE branch_id = ?
		`).run(assistantNodeId, timestamp, branch.branchId);
	});
	return requireFlow(db, branch.flowId);
}

export async function updateConversationFlowNodeState(
	sessionId: string,
	requestId: string,
	status: ConversationFlowNodeStatus,
): Promise<{ flow: ConversationFlow; nodeId: string } | null> {
	const branch: ConversationFlowBranch | null = await findConversationFlowBranchBySession(sessionId);
	if (branch === null) return null;
	const db: DatabaseSync = await getSessionDatabase();
	const assistantNodeId: string = nodeId(requestId, "assistant");
	const timestamp: string = new Date().toISOString();
	const result = db.prepare(`
		UPDATE conversation_flow_nodes SET status = ?, updated_at = ?
		WHERE flow_id = ? AND node_id = ?
	`).run(status, timestamp, branch.flowId, assistantNodeId);
	if (Number(result.changes) === 0) return null;
	db.prepare(`
		UPDATE conversation_flows SET revision = revision + 1, updated_at = ? WHERE flow_id = ?
	`).run(timestamp, branch.flowId);
	return { flow: requireFlow(db, branch.flowId), nodeId: assistantNodeId };
}

export async function releaseConversationFlowRun(sessionId: string, requestId: string): Promise<ConversationFlow | null> {
	const branch: ConversationFlowBranch | null = await findConversationFlowBranchBySession(sessionId);
	if (branch === null) return null;
	const db: DatabaseSync = await getSessionDatabase();
	const timestamp: string = new Date().toISOString();
	db.prepare(`
		UPDATE conversation_flows
		SET active_branch_id = NULL, active_request_id = NULL, revision = revision + 1, updated_at = ?
		WHERE flow_id = ? AND active_request_id = ?
	`).run(timestamp, branch.flowId, requestId);
	return requireFlow(db, branch.flowId);
}

export async function assertSessionCanUseStandaloneMutation(sessionId: string): Promise<void> {
	const metadata: SessionMetadata = normalizeSessionMetadata(await getStoredSessionMetadata(sessionId));
	if (metadata.surface === "flow_branch") {
		throw flowError("flow_session_managed", "Flow branch sessions must be managed through Flow operations.");
	}
}
