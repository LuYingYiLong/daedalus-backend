import { randomUUID } from "node:crypto";
import type { SessionWorktreeMetadata } from "../workspace/types.js";

export type SubagentGraphStatus =
	| "draft"
	| "running"
	| "blocked"
	| "completed"
	| "completed_with_warnings"
	| "failed"
	| "cancelled";

export type SubagentNodeStatus =
	| "pending"
	| "ready"
	| "queued"
	| "running"
	| "waiting_approval"
	| "blocked"
	| "completed"
	| "failed"
	| "cancelled";

export type SubagentRole = "researcher" | "planner" | "implementer" | "tester" | "reviewer";
export type SubagentWorkspaceMode = "shared_read_only" | "managed_worktree";
export type SubagentToolCapability = "read" | "verify" | "propose" | "write" | "destructive" | "execute";

export type SubagentContextRef = {
	kind: "message" | "context_block" | "artifact" | "source_folder";
	id: string;
};

export type SubagentToolScope = {
	capabilities: SubagentToolCapability[];
	toolNames: string[];
	sourceFolderIds: string[];
};

export type SubagentWorktreeMetadata = {
	managedMetadata: SessionWorktreeMetadata;
	sourceStates: Array<{
		sourceFolderId: string;
		headCommit: string | null;
		branch: string | null;
		detached: boolean;
	}>;
	mergeStatus: "not_requested" | "previewed" | "pending" | "merged" | "conflict" | "failed";
	cleanupStatus: "not_requested" | "pending" | "completed" | "failed";
};

export type SubagentTestResult = {
	name: string;
	status: "passed" | "failed" | "skipped";
	summary: string | null;
};

export type SubagentArtifactRef = {
	kind: string;
	id: string;
	label: string | null;
};

export type SubagentResult = {
	status: "completed" | "partial" | "failed" | "cancelled";
	summary: string;
	findings: string[];
	changedFiles: string[];
	tests: SubagentTestResult[];
	artifacts: SubagentArtifactRef[];
	needsParentDecision: boolean;
	recommendedNextAction: string | null;
	detailsMarkdown?: string | null;
};

export type SubagentRetryPolicy = {
	mode: "transient_only";
	maxRetries: number;
};

export type SubagentQueueReason =
	| "provider_capacity"
	| "worktree_capacity"
	| "terminal_capacity"
	| "system_pressure"
	| "retry_backoff";

export type SubagentFailure = {
	code: string;
	message: string;
	retryable: boolean;
	failedAt: string;
};

export type SubagentGraph = {
	graphId: string;
	sessionId: string;
	rootRunId: string;
	status: SubagentGraphStatus;
	revision: number;
	createdAt: string;
	updatedAt: string;
};

export type SubagentNode = {
	nodeId: string;
	graphId: string;
	runId: string;
	retryOfRunId?: string | null;
	name: string;
	role: SubagentRole;
	objective: string;
	dependsOn: string[];
	status: SubagentNodeStatus;
	attempt: number;
	retryPolicy: SubagentRetryPolicy;
	queueReason: SubagentQueueReason | null;
	queuedAt: string | null;
	nextRetryAt: string | null;
	contextRefs: SubagentContextRef[];
	toolScope: SubagentToolScope;
	workspaceMode: SubagentWorkspaceMode;
	worktreeMetadata: SubagentWorktreeMetadata | null;
	result: SubagentResult | null;
	failure: SubagentFailure | null;
	createdAt: string;
	updatedAt: string;
};

export type SubagentGraphSnapshot = {
	graph: SubagentGraph;
	nodes: SubagentNode[];
};

export type SubagentGraphPatch = Partial<Pick<SubagentGraph, "status">>;
export type SubagentNodePatch = Partial<Omit<
	SubagentNode,
	"nodeId" | "graphId" | "createdAt" | "updatedAt" | "status"
>>;

const GRAPH_TERMINAL_STATUSES: ReadonlySet<SubagentGraphStatus> = new Set([
	"completed",
	"completed_with_warnings",
	"failed",
	"cancelled"
]);
const NODE_TERMINAL_STATUSES: ReadonlySet<SubagentNodeStatus> = new Set(["completed", "failed", "cancelled"]);

const GRAPH_TRANSITIONS: Readonly<Record<SubagentGraphStatus, ReadonlySet<SubagentGraphStatus>>> = {
	draft: new Set(["running", "failed", "cancelled"]),
	running: new Set(["blocked", "completed", "completed_with_warnings", "failed", "cancelled"]),
	blocked: new Set(["running", "completed", "completed_with_warnings", "failed", "cancelled"]),
	completed: new Set(["running"]),
	completed_with_warnings: new Set(["running"]),
	failed: new Set(["running"]),
	cancelled: new Set()
};

const NODE_TRANSITIONS: Readonly<Record<SubagentNodeStatus, ReadonlySet<SubagentNodeStatus>>> = {
	pending: new Set(["ready", "queued", "blocked", "failed", "cancelled"]),
	ready: new Set(["pending", "queued", "running", "blocked", "failed", "cancelled"]),
	queued: new Set(["pending", "ready", "running", "blocked", "failed", "cancelled"]),
	running: new Set(["ready", "queued", "waiting_approval", "completed", "failed", "cancelled"]),
	waiting_approval: new Set(["running", "blocked", "completed", "failed", "cancelled"]),
	blocked: new Set(["pending", "ready", "failed", "cancelled"]),
	completed: new Set(),
	failed: new Set(["pending", "ready"]),
	cancelled: new Set(["pending", "ready"])
};

const ROLE_CAPABILITIES: Readonly<Record<SubagentRole, ReadonlySet<SubagentToolCapability>>> = {
	researcher: new Set(["read", "verify"]),
	planner: new Set(["read"]),
	implementer: new Set(["read", "verify", "propose", "write", "destructive", "execute"]),
	tester: new Set(["read", "verify", "execute"]),
	reviewer: new Set(["read", "verify"])
};
const GRAPH_STATUSES: ReadonlySet<string> = new Set(Object.keys(GRAPH_TRANSITIONS));
const NODE_STATUSES: ReadonlySet<string> = new Set(Object.keys(NODE_TRANSITIONS));
const ROLES: ReadonlySet<string> = new Set(Object.keys(ROLE_CAPABILITIES));
const WORKSPACE_MODES: ReadonlySet<string> = new Set(["shared_read_only", "managed_worktree"]);
const TOOL_CAPABILITIES: ReadonlySet<string> = new Set(["read", "verify", "propose", "write", "destructive", "execute"]);
const CONTEXT_REF_KINDS: ReadonlySet<string> = new Set(["message", "context_block", "artifact", "source_folder"]);

function assertNonEmpty(value: string, field: string): void {
	if (value.trim().length === 0) {
		throw new Error(`Invalid subagent ${field}: value must not be empty.`);
	}
}

function assertUniqueNonEmpty(values: readonly string[], field: string): void {
	const seen: Set<string> = new Set();
	for (const value of values) {
		assertNonEmpty(value, field);
		if (seen.has(value)) {
			throw new Error(`Invalid subagent ${field}: duplicate value ${value}.`);
		}
		seen.add(value);
	}
}

function assertTimestamp(value: string, field: string): void {
	if (!Number.isFinite(Date.parse(value))) {
		throw new Error(`Invalid subagent ${field}: expected an ISO timestamp.`);
	}
}

function assertToolScope(role: SubagentRole, workspaceMode: SubagentWorkspaceMode, scope: SubagentToolScope): void {
	assertUniqueNonEmpty(scope.toolNames, "toolScope.toolNames");
	assertUniqueNonEmpty(scope.sourceFolderIds, "toolScope.sourceFolderIds");
	const capabilities: Set<SubagentToolCapability> = new Set();
	const allowed: ReadonlySet<SubagentToolCapability> = ROLE_CAPABILITIES[role];
	for (const capability of scope.capabilities) {
		if (!TOOL_CAPABILITIES.has(capability)) {
			throw new Error(`Invalid subagent tool capability: ${String(capability)}.`);
		}
		if (!allowed.has(capability)) {
			throw new Error(`Invalid subagent tool scope: role ${role} cannot use ${capability}.`);
		}
		if (capabilities.has(capability)) {
			throw new Error(`Invalid subagent tool scope: duplicate capability ${capability}.`);
		}
		capabilities.add(capability);
	}
	if ((capabilities.has("write") || capabilities.has("destructive")) && workspaceMode !== "managed_worktree") {
		throw new Error("Invalid subagent tool scope: write capabilities require a managed worktree.");
	}
	if (role === "implementer" && workspaceMode !== "managed_worktree") {
		throw new Error("Invalid subagent workspace mode: implementers require a managed worktree.");
	}
}

function assertContextRefs(contextRefs: readonly SubagentContextRef[]): void {
	const keys: Set<string> = new Set();
	for (const ref of contextRefs) {
		if (!CONTEXT_REF_KINDS.has(ref.kind)) {
			throw new Error(`Invalid subagent context reference kind: ${String(ref.kind)}.`);
		}
		assertNonEmpty(ref.id, "contextRefs.id");
		const key: string = `${ref.kind}:${ref.id}`;
		if (keys.has(key)) {
			throw new Error(`Invalid subagent contextRefs: duplicate reference ${key}.`);
		}
		keys.add(key);
	}
}

function assertResult(result: SubagentResult): void {
	assertNonEmpty(result.summary, "result.summary");
	if (result.detailsMarkdown !== undefined && result.detailsMarkdown !== null && result.detailsMarkdown.length > 20_000) {
		throw new Error("Invalid subagent result.detailsMarkdown: maximum length is 20000 characters.");
	}
	assertUniqueNonEmpty(result.changedFiles, "result.changedFiles");
	for (const finding of result.findings) assertNonEmpty(finding, "result.findings");
	for (const test of result.tests) {
		assertNonEmpty(test.name, "result.tests.name");
	}
	for (const artifact of result.artifacts) {
		assertNonEmpty(artifact.kind, "result.artifacts.kind");
		assertNonEmpty(artifact.id, "result.artifacts.id");
	}
}

function assertWorktreeMetadata(metadata: SubagentWorktreeMetadata): void {
	assertNonEmpty(metadata.managedMetadata.id, "worktreeMetadata.managedMetadata.id");
	assertNonEmpty(metadata.managedMetadata.sourceWorkspaceId, "worktreeMetadata.managedMetadata.sourceWorkspaceId");
	assertNonEmpty(metadata.managedMetadata.runtimeWorkspaceId, "worktreeMetadata.managedMetadata.runtimeWorkspaceId");
	if (metadata.managedMetadata.sources.length === 0) {
		throw new Error("Invalid subagent worktree metadata: managed worktree must contain at least one source.");
	}
	const sourceIds: Set<string> = new Set();
	for (const source of metadata.managedMetadata.sources) {
		assertNonEmpty(source.sourceFolderId, "worktreeMetadata.managedMetadata.sources.sourceFolderId");
		assertNonEmpty(source.sourcePath, "worktreeMetadata.managedMetadata.sources.sourcePath");
		assertNonEmpty(source.worktreePath, "worktreeMetadata.managedMetadata.sources.worktreePath");
		assertNonEmpty(source.baseCommit, "worktreeMetadata.managedMetadata.sources.baseCommit");
		if (sourceIds.has(source.sourceFolderId)) {
			throw new Error(`Invalid subagent worktree metadata: duplicate source ${source.sourceFolderId}.`);
		}
		sourceIds.add(source.sourceFolderId);
	}
	const stateIds: Set<string> = new Set();
	for (const state of metadata.sourceStates) {
		assertNonEmpty(state.sourceFolderId, "worktreeMetadata.sourceStates.sourceFolderId");
		if (!sourceIds.has(state.sourceFolderId)) {
			throw new Error(`Invalid subagent worktree metadata: unknown source state ${state.sourceFolderId}.`);
		}
		if (stateIds.has(state.sourceFolderId)) {
			throw new Error(`Invalid subagent worktree metadata: duplicate source state ${state.sourceFolderId}.`);
		}
		stateIds.add(state.sourceFolderId);
	}
}

export function isSubagentGraphTerminal(status: SubagentGraphStatus): boolean {
	return GRAPH_TERMINAL_STATUSES.has(status);
}

export function isSubagentNodeTerminal(status: SubagentNodeStatus): boolean {
	return NODE_TERMINAL_STATUSES.has(status);
}

export function createSubagentGraph(params: {
	sessionId: string;
	rootRunId: string;
	graphId?: string | undefined;
	now?: string | undefined;
}): SubagentGraph {
	const now: string = params.now ?? new Date().toISOString();
	const graph: SubagentGraph = {
		graphId: params.graphId ?? `subgraph-${randomUUID()}`,
		sessionId: params.sessionId,
		rootRunId: params.rootRunId,
		status: "draft",
		revision: 1,
		createdAt: now,
		updatedAt: now
	};
	assertValidSubagentGraph(graph);
	return graph;
}

export function createSubagentNode(params: {
	graphId: string;
	runId: string;
	retryOfRunId?: string | null;
	name: string;
	role: SubagentRole;
	objective: string;
	toolScope: SubagentToolScope;
	workspaceMode: SubagentWorkspaceMode;
	retryPolicy?: SubagentRetryPolicy | undefined;
	nodeId?: string | undefined;
	dependsOn?: string[] | undefined;
	contextRefs?: SubagentContextRef[] | undefined;
	worktreeMetadata?: SubagentWorktreeMetadata | null | undefined;
	now?: string | undefined;
}): SubagentNode {
	const now: string = params.now ?? new Date().toISOString();
	const nodeId: string = params.nodeId ?? `subagent-${randomUUID()}`;
	const node: SubagentNode = {
		nodeId,
		graphId: params.graphId,
		runId: params.runId,
		retryOfRunId: params.retryOfRunId ?? null,
		name: params.name.trim(),
		role: params.role,
		objective: params.objective.trim(),
		dependsOn: [...(params.dependsOn ?? [])],
		status: "pending",
		attempt: 1,
		retryPolicy: params.retryPolicy === undefined ? { mode: "transient_only", maxRetries: 1 } : { ...params.retryPolicy },
		queueReason: null,
		queuedAt: null,
		nextRetryAt: null,
		contextRefs: structuredClone(params.contextRefs ?? []),
		toolScope: structuredClone(params.toolScope),
		workspaceMode: params.workspaceMode,
		worktreeMetadata: structuredClone(params.worktreeMetadata ?? null),
		result: null,
		failure: null,
		createdAt: now,
		updatedAt: now
	};
	assertValidSubagentNode(node);
	return node;
}

export function transitionSubagentGraph(
	current: SubagentGraph,
	nextStatus: SubagentGraphStatus,
	patch: SubagentGraphPatch = {},
	now: string = new Date().toISOString()
): SubagentGraph {
	assertSubagentGraphStatusTransition(current.status, nextStatus);
	const next: SubagentGraph = {
		...current,
		...patch,
		status: nextStatus,
		revision: current.revision + 1,
		updatedAt: now
	};
	assertValidSubagentGraph(next);
	return next;
}

export function transitionSubagentNode(
	current: SubagentNode,
	nextStatus: SubagentNodeStatus,
	patch: SubagentNodePatch = {},
	now: string = new Date().toISOString()
): SubagentNode {
	if (current.status === "completed") {
		throw new Error(`Subagent node ${current.nodeId} is completed and immutable.`);
	}
	assertSubagentNodeStatusTransition(current.status, nextStatus);
	if (
		patch.dependsOn !== undefined
		&& current.status !== "pending"
		&& current.status !== "ready"
		&& !sameStringArray(patch.dependsOn, current.dependsOn)
	) {
		throw new Error(`Subagent node ${current.nodeId} dependencies are immutable after execution starts.`);
	}
	const retrying: boolean = (current.status === "failed" || current.status === "cancelled" || current.status === "blocked")
		&& (nextStatus === "pending" || nextStatus === "ready");
	const next: SubagentNode = {
		...current,
		...patch,
		status: nextStatus,
		attempt: patch.attempt === undefined ? current.attempt : patch.attempt,
		retryPolicy: patch.retryPolicy === undefined ? { ...current.retryPolicy } : { ...patch.retryPolicy },
		queueReason: patch.queueReason === undefined ? current.queueReason : patch.queueReason,
		queuedAt: patch.queuedAt === undefined ? current.queuedAt : patch.queuedAt,
		nextRetryAt: patch.nextRetryAt === undefined ? current.nextRetryAt : patch.nextRetryAt,
		dependsOn: patch.dependsOn === undefined ? [...current.dependsOn] : [...patch.dependsOn],
		contextRefs: patch.contextRefs === undefined ? structuredClone(current.contextRefs) : structuredClone(patch.contextRefs),
		toolScope: patch.toolScope === undefined ? structuredClone(current.toolScope) : structuredClone(patch.toolScope),
		worktreeMetadata: patch.worktreeMetadata === undefined
			? structuredClone(current.worktreeMetadata)
			: structuredClone(patch.worktreeMetadata),
		result: patch.result === undefined ? (retrying ? null : structuredClone(current.result)) : structuredClone(patch.result),
		failure: patch.failure === undefined ? (retrying ? null : structuredClone(current.failure)) : structuredClone(patch.failure),
		updatedAt: now
	};
	assertValidSubagentNode(next);
	return next;
}

/** 节点终态后仍允许推进 worktree 合并和清理，其余执行字段保持不可变。 */
export function updateSubagentNodeWorktreeMetadata(
	current: SubagentNode,
	worktreeMetadata: SubagentWorktreeMetadata | null,
	now: string = new Date().toISOString()
): SubagentNode {
	const next: SubagentNode = {
		...current,
		worktreeMetadata: structuredClone(worktreeMetadata),
		updatedAt: now
	};
	assertValidSubagentNode(next);
	return next;
}

export function assertSubagentGraphStatusTransition(
	current: SubagentGraphStatus,
	next: SubagentGraphStatus
): void {
	if (next !== current && !GRAPH_TRANSITIONS[current].has(next)) {
		throw new Error(`Illegal subagent graph transition: ${current} -> ${next}.`);
	}
}

export function assertSubagentNodeStatusTransition(
	current: SubagentNodeStatus,
	next: SubagentNodeStatus
): void {
	if (next !== current && !NODE_TRANSITIONS[current].has(next)) {
		throw new Error(`Illegal subagent node transition: ${current} -> ${next}.`);
	}
}

export function assertValidSubagentGraph(graph: SubagentGraph): void {
	assertNonEmpty(graph.graphId, "graphId");
	assertNonEmpty(graph.sessionId, "sessionId");
	assertNonEmpty(graph.rootRunId, "rootRunId");
	if (!GRAPH_STATUSES.has(graph.status)) {
		throw new Error(`Invalid subagent graph status: ${String(graph.status)}.`);
	}
	if (!Number.isSafeInteger(graph.revision) || graph.revision < 1) {
		throw new Error("Invalid subagent graph revision: expected a positive integer.");
	}
	assertTimestamp(graph.createdAt, "createdAt");
	assertTimestamp(graph.updatedAt, "updatedAt");
}

export function assertValidSubagentNode(node: SubagentNode): void {
	assertNonEmpty(node.nodeId, "nodeId");
	assertNonEmpty(node.graphId, "graphId");
	assertNonEmpty(node.runId, "runId");
	if (node.retryOfRunId !== undefined && node.retryOfRunId !== null) assertNonEmpty(node.retryOfRunId, "retryOfRunId");
	if (node.retryOfRunId === node.runId) throw new Error(`Invalid subagent retryOfRunId for ${node.nodeId}: it must reference a previous run.`);
	assertNonEmpty(node.name, "name");
	if (node.name.length > 120) throw new Error("Invalid subagent name: maximum length is 120 characters.");
	assertNonEmpty(node.objective, "objective");
	if (!ROLES.has(node.role)) throw new Error(`Invalid subagent role: ${String(node.role)}.`);
	if (!NODE_STATUSES.has(node.status)) throw new Error(`Invalid subagent node status: ${String(node.status)}.`);
	if (!Number.isSafeInteger(node.attempt) || node.attempt < 1) {
		throw new Error("Invalid subagent attempt: expected a positive integer.");
	}
	if (node.retryPolicy.mode !== "transient_only") {
		throw new Error(`Invalid subagent retry policy mode: ${String(node.retryPolicy.mode)}.`);
	}
	if (!Number.isSafeInteger(node.retryPolicy.maxRetries) || node.retryPolicy.maxRetries < 0 || node.retryPolicy.maxRetries > 3) {
		throw new Error("Invalid subagent retry policy: maxRetries must be between 0 and 3.");
	}
	if (node.queueReason !== null && !["provider_capacity", "worktree_capacity", "terminal_capacity", "system_pressure", "retry_backoff"].includes(node.queueReason)) {
		throw new Error(`Invalid subagent queue reason: ${String(node.queueReason)}.`);
	}
	if (node.queuedAt !== null) assertTimestamp(node.queuedAt, "queuedAt");
	if (node.nextRetryAt !== null) assertTimestamp(node.nextRetryAt, "nextRetryAt");
	if (!WORKSPACE_MODES.has(node.workspaceMode)) {
		throw new Error(`Invalid subagent workspace mode: ${String(node.workspaceMode)}.`);
	}
	assertUniqueNonEmpty(node.dependsOn, "dependsOn");
	if (node.dependsOn.includes(node.nodeId)) {
		throw new Error(`Subagent node ${node.nodeId} cannot depend on itself.`);
	}
	assertContextRefs(node.contextRefs);
	assertToolScope(node.role, node.workspaceMode, node.toolScope);
	if (node.worktreeMetadata !== null) assertWorktreeMetadata(node.worktreeMetadata);
	if (node.workspaceMode === "shared_read_only" && node.worktreeMetadata !== null) {
		throw new Error("Invalid subagent worktree metadata: shared read-only nodes cannot own a worktree.");
	}
	if (node.result !== null) assertResult(node.result);
	if (node.status === "completed" && node.result === null) {
		throw new Error(`Completed subagent node ${node.nodeId} requires a result.`);
	}
	if (node.status === "completed" && node.result !== null && node.result.status !== "completed" && node.result.status !== "partial") {
		throw new Error(`Completed subagent node ${node.nodeId} has incompatible result status ${node.result.status}.`);
	}
	if (node.status === "failed" && node.failure === null) {
		throw new Error(`Failed subagent node ${node.nodeId} requires failure details.`);
	}
	if (node.status === "queued" && node.queueReason === null) {
		throw new Error(`Queued subagent node ${node.nodeId} requires a queue reason.`);
	}
	if (node.status === "failed" && node.result !== null && node.result.status !== "failed") {
		throw new Error(`Failed subagent node ${node.nodeId} has incompatible result status ${node.result.status}.`);
	}
	if (node.status === "cancelled" && node.result !== null && node.result.status !== "cancelled") {
		throw new Error(`Cancelled subagent node ${node.nodeId} has incompatible result status ${node.result.status}.`);
	}
	if (node.failure !== null) {
		assertNonEmpty(node.failure.code, "failure.code");
		assertNonEmpty(node.failure.message, "failure.message");
		assertTimestamp(node.failure.failedAt, "failure.failedAt");
	}
	assertTimestamp(node.createdAt, "createdAt");
	assertTimestamp(node.updatedAt, "updatedAt");
}

export function assertValidSubagentGraphSnapshot(snapshot: SubagentGraphSnapshot): void {
	assertValidSubagentGraph(snapshot.graph);
	const nodesById: Map<string, SubagentNode> = new Map();
	const runIds: Set<string> = new Set();
	for (const node of snapshot.nodes) {
		assertValidSubagentNode(node);
		if (node.graphId !== snapshot.graph.graphId) {
			throw new Error(`Subagent node ${node.nodeId} belongs to graph ${node.graphId}, expected ${snapshot.graph.graphId}.`);
		}
		if (nodesById.has(node.nodeId)) {
			throw new Error(`Duplicate subagent node id: ${node.nodeId}.`);
		}
		if (runIds.has(node.runId)) {
			throw new Error(`Duplicate subagent run id: ${node.runId}.`);
		}
		nodesById.set(node.nodeId, node);
		runIds.add(node.runId);
	}
	for (const node of snapshot.nodes) {
		for (const dependencyId of node.dependsOn) {
			if (!nodesById.has(dependencyId)) {
				throw new Error(`Subagent node ${node.nodeId} has missing dependency ${dependencyId}.`);
			}
		}
	}
	assertAcyclicSubagentNodes(snapshot.nodes);
	if (snapshot.graph.status === "completed" && snapshot.nodes.some((node: SubagentNode): boolean => node.status !== "completed")) {
		throw new Error(`Completed subagent graph ${snapshot.graph.graphId} contains unfinished nodes.`);
	}
}

export function assertAcyclicSubagentNodes(nodes: readonly SubagentNode[]): void {
	const dependencies: Map<string, readonly string[]> = new Map(
		nodes.map((node: SubagentNode): [string, readonly string[]] => [node.nodeId, node.dependsOn])
	);
	const visiting: Set<string> = new Set();
	const visited: Set<string> = new Set();
	const visit = (nodeId: string): void => {
		if (visiting.has(nodeId)) {
			throw new Error(`Subagent graph contains a dependency cycle at node ${nodeId}.`);
		}
		if (visited.has(nodeId)) return;
		visiting.add(nodeId);
		for (const dependencyId of dependencies.get(nodeId) ?? []) visit(dependencyId);
		visiting.delete(nodeId);
		visited.add(nodeId);
	};
	for (const node of nodes) visit(node.nodeId);
}

export function areSubagentDependenciesCompleted(
	node: SubagentNode,
	nodes: readonly SubagentNode[]
): boolean {
	const statuses: Map<string, SubagentNodeStatus> = new Map(
		nodes.map((candidate: SubagentNode): [string, SubagentNodeStatus] => [candidate.nodeId, candidate.status])
	);
	return node.dependsOn.every((dependencyId: string): boolean => statuses.get(dependencyId) === "completed");
}

export function cloneSubagentGraphSnapshot(snapshot: SubagentGraphSnapshot): SubagentGraphSnapshot {
	return structuredClone(snapshot);
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value: string, index: number): boolean => value === right[index]);
}
