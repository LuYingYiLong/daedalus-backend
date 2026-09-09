import assert from "node:assert/strict";
import test from "node:test";
import {
	clientRequestSchema,
	subagentGraphCreatedEventDataSchema,
	subagentGraphStateEventDataSchema,
	subagentMergeStateEventDataSchema,
	subagentNodeApprovalEventDataSchema,
	subagentNodeResultEventDataSchema,
	subagentNodeStateEventDataSchema
} from "../../../src/protocol/schema.js";
import type {
	CanonicalServerEventName,
	SubagentEventName,
	SubagentWorktreeMetadata as ProtocolSubagentWorktreeMetadata
} from "../../../src/protocol/types.js";
import type { SubagentWorktreeMetadata as RuntimeSubagentWorktreeMetadata } from "../../../src/workflow/subagent-graph.js";

type Assignable<From, To> = From extends To ? true : false;
const protocolAcceptsRuntimeWorktree: Assignable<RuntimeSubagentWorktreeMetadata, ProtocolSubagentWorktreeMetadata> = true;
const runtimeAcceptsProtocolWorktree: Assignable<ProtocolSubagentWorktreeMetadata, RuntimeSubagentWorktreeMetadata> = true;
void protocolAcceptsRuntimeWorktree;
void runtimeAcceptsProtocolWorktree;

function request(method: string, params: Record<string, unknown>): Record<string, unknown> {
	return { type: "request", id: `request-${method}`, method, params };
}

const result = {
	status: "completed",
	summary: "Implemented the requested change.",
	findings: ["The dependency is healthy."],
	changedFiles: ["src/example.ts"],
	tests: [{ name: "typecheck", status: "passed", summary: null }],
	artifacts: [{ kind: "diff", id: "diff-one", label: "Implementation diff" }],
	needsParentDecision: false,
	recommendedNextAction: null
} as const;

const graph = {
	graphId: "graph-one",
	sessionId: "session-one",
	rootRunId: "run-root",
	status: "running",
	revision: 3,
	createdAt: "2026-09-09T00:00:00.000Z",
	updatedAt: "2026-09-09T00:01:00.000Z"
} as const;

const worktreeMetadata = {
	managedMetadata: {
		id: "worktree-one",
		sourceWorkspaceId: "workspace-main",
		sourceWorkspaceName: "Main workspace",
		runtimeWorkspaceId: "workspace-runtime",
		sources: [{
			sourceFolderId: "source-main",
			sourcePath: "D:\\repo",
			worktreePath: "D:\\worktrees\\repo",
			baseCommit: "a".repeat(40),
			baseRef: "main",
			startingState: { type: "branch", ref: "main" },
			environmentId: "node",
			environmentFingerprint: "b".repeat(64),
			setupState: "ready",
			setupSummary: {
				startedAt: "2026-09-09T00:00:01.000Z",
				finishedAt: "2026-09-09T00:00:05.000Z",
				exitCode: 0,
				durationMs: 4_000,
				message: "Ready",
				logPath: "D:\\logs\\setup.log"
			},
			sensitiveIncludedPaths: [".env.example"]
		}],
		createdAt: "2026-09-09T00:00:00.000Z",
		location: "worktree",
		status: "ready",
		permanent: false,
		displayName: "Subagent implementation"
	},
	sourceStates: [{
		sourceFolderId: "source-main",
		headCommit: "c".repeat(40),
		branch: "codex/subagent-one",
		detached: false
	}],
	mergeStatus: "previewed",
	cleanupStatus: "not_requested"
} as const;

const node = {
	nodeId: "node-one",
	graphId: "graph-one",
	runId: "run-child",
	role: "implementer",
	objective: "Implement the feature.",
	dependsOn: ["node-research"],
	status: "completed",
	contextRefs: [{ kind: "message", id: "user-request" }],
	toolScope: {
		capabilities: ["read", "verify", "write"],
		toolNames: ["mcp_workspace_read_text", "mcp_workspace_apply_patch"],
		sourceFolderIds: ["source-main"]
	},
	workspaceMode: "managed_worktree",
	worktreeMetadata,
	result,
	failure: null,
	createdAt: "2026-09-09T00:00:10.000Z",
	updatedAt: "2026-09-09T00:00:30.000Z"
} as const;

test("subgraph RPCs accept their strict public parameter shapes", (): void => {
	const requests = [
		request("agent.subgraph.get", { graphId: "graph-one" }),
		request("agent.subgraph.list", { sessionId: "session-one", status: "running", limit: 20, cursor: "cursor-one" }),
		request("agent.subgraph.cancel", { graphId: "graph-one", reason: "No longer needed." }),
		request("agent.subgraph.cancel", { graphId: "graph-one", nodeId: "node-one" }),
		request("agent.subgraph.retry", { graphId: "graph-one", nodeId: "node-one" }),
		request("agent.subgraph.merge.preview", { graphId: "graph-one", nodeId: "node-one" }),
		request("agent.subgraph.merge.apply", {
			graphId: "graph-one",
			nodeId: "node-one",
			fingerprint: "a".repeat(64)
		})
	];
	for (const value of requests) assert.equal(clientRequestSchema.safeParse(value).success, true);
});

test("subgraph RPCs reject missing identities, stale-shaped merges, and unknown fields", (): void => {
	assert.equal(clientRequestSchema.safeParse(request("agent.subgraph.get", {})).success, false);
	assert.equal(clientRequestSchema.safeParse(request("agent.subgraph.list", { sessionId: "session-one", limit: 201 })).success, false);
	assert.equal(clientRequestSchema.safeParse(request("agent.subgraph.cancel", { graphId: "graph-one", force: true })).success, false);
	assert.equal(clientRequestSchema.safeParse(request("agent.subgraph.retry", { graphId: "graph-one" })).success, false);
	assert.equal(clientRequestSchema.safeParse(request("agent.subgraph.merge.preview", { graphId: "graph-one", nodeId: "" })).success, false);
	assert.equal(clientRequestSchema.safeParse(request("agent.subgraph.merge.apply", {
		graphId: "graph-one",
		nodeId: "node-one",
		fingerprint: "not-a-preview-fingerprint"
	})).success, false);
	assert.equal(clientRequestSchema.safeParse(request("agent.subgraph.merge.apply", {
		graphId: "graph-one",
		nodeId: "node-one",
		fingerprint: "b".repeat(64),
		approvalId: "approval-one"
	})).success, false);
});

test("subgraph event payload schemas validate graph, node, result, approval, and merge updates", (): void => {
	assert.equal(subagentGraphCreatedEventDataSchema.safeParse({ graph, nodes: [node] }).success, true);
	assert.equal(subagentGraphStateEventDataSchema.safeParse({ graph }).success, true);
	assert.equal(subagentNodeStateEventDataSchema.safeParse({ graphId: "graph-one", revision: 3, node }).success, true);
	assert.equal(subagentNodeResultEventDataSchema.safeParse({
		graphId: "graph-one",
		nodeId: "node-one",
		runId: "run-child",
		revision: 3,
		result
	}).success, true);
	assert.equal(subagentNodeApprovalEventDataSchema.safeParse({
		graphId: "graph-one",
		nodeId: "node-one",
		runId: "run-child",
		revision: 4,
		approvalId: "approval-one",
		status: "requested"
	}).success, true);
	assert.equal(subagentMergeStateEventDataSchema.safeParse({
		graphId: "graph-one",
		nodeId: "node-one",
		runId: "run-child",
		revision: 5,
		status: "preview_ready",
		fingerprint: "c".repeat(64)
	}).success, true);
});

test("subgraph event payload schemas remain strict and event names are canonical", (): void => {
	assert.equal(subagentGraphCreatedEventDataSchema.safeParse({ graph, nodes: [node], secret: "hidden" }).success, false);
	assert.equal(subagentGraphStateEventDataSchema.safeParse({ graph, secret: "hidden" }).success, false);
	assert.equal(subagentNodeStateEventDataSchema.safeParse({ graphId: "graph-one", revision: -1, node }).success, false);
	assert.equal(subagentNodeResultEventDataSchema.safeParse({
		graphId: "graph-one",
		nodeId: "node-one",
		runId: "run-child",
		revision: 3,
		result: { ...result, needsParentDecision: "no" }
	}).success, false);
	assert.equal(subagentNodeApprovalEventDataSchema.safeParse({
		graphId: "graph-one",
		nodeId: "node-one",
		runId: "run-child",
		revision: 4,
		approvalId: "approval-one",
		status: "pending"
	}).success, false);
	assert.equal(subagentMergeStateEventDataSchema.safeParse({
		graphId: "graph-one",
		nodeId: "node-one",
		runId: "run-child",
		revision: 5,
		status: "preview_ready",
		fingerprint: "short"
	}).success, false);
	assert.equal(subagentNodeStateEventDataSchema.safeParse({
		graphId: "graph-one",
		revision: 5,
		node: {
			...node,
			worktreeMetadata: {
				...worktreeMetadata,
				sourceStates: [{ sourceFolderId: "unknown-source", headCommit: null, branch: null, detached: true }]
			}
		}
	}).success, false);
	assert.equal(subagentNodeStateEventDataSchema.safeParse({
		graphId: "graph-one",
		revision: 5,
		node: {
			...node,
			worktreeMetadata: {
				sourceWorkspaceId: "workspace-main",
				worktreePath: "D:\\worktrees\\repo",
				cleanupStatus: "not_requested"
			}
		}
	}).success, false);

	const names: readonly SubagentEventName[] = [
		"agent.subgraph.created",
		"agent.subgraph.state",
		"agent.subgraph.node.state",
		"agent.subgraph.node.result",
		"agent.subgraph.node.approval",
		"agent.subgraph.merge.state"
	];
	const canonicalNames: readonly CanonicalServerEventName[] = names;
	assert.equal(canonicalNames.length, 6);
});
