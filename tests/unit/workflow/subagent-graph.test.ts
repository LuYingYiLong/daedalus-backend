import assert from "node:assert/strict";
import test from "node:test";
import {
	areSubagentDependenciesCompleted,
	assertValidSubagentGraphSnapshot,
	createSubagentGraph,
	createSubagentNode,
	transitionSubagentNode,
	type SubagentNode,
	type SubagentResult,
	type SubagentToolScope
} from "../../../src/workflow/subagent-graph.js";

const READ_SCOPE: SubagentToolScope = {
	capabilities: ["read", "verify"],
	toolNames: ["mcp_workspace_read_text_file"],
	sourceFolderIds: ["source-main"]
};

function createNode(params: {
	nodeId: string;
	runId: string;
	role?: "researcher" | "implementer";
	dependsOn?: string[];
}): SubagentNode {
	const role = params.role ?? "researcher";
	return createSubagentNode({
		graphId: "graph-domain",
		nodeId: params.nodeId,
		runId: params.runId,
		role,
		objective: `Run ${params.nodeId}`,
		dependsOn: params.dependsOn,
		workspaceMode: role === "implementer" ? "managed_worktree" : "shared_read_only",
		toolScope: role === "implementer"
			? { capabilities: ["read", "write"], toolNames: [], sourceFolderIds: ["source-main"] }
			: READ_SCOPE,
		now: "2026-09-09T00:00:00.000Z"
	});
}

test("subagent graph validates dependencies, duplicate ids, and cycles", (): void => {
	const graph = createSubagentGraph({
		graphId: "graph-domain",
		sessionId: "session-domain",
		rootRunId: "root-domain",
		now: "2026-09-09T00:00:00.000Z"
	});
	const research = createNode({ nodeId: "research", runId: "run-research" });
	const implementation = createNode({
		nodeId: "implementation",
		runId: "run-implementation",
		role: "implementer",
		dependsOn: ["research"]
	});

	assert.doesNotThrow((): void => assertValidSubagentGraphSnapshot({ graph, nodes: [research, implementation] }));
	assert.equal(areSubagentDependenciesCompleted(implementation, [research, implementation]), false);
	assert.throws(
		(): void => assertValidSubagentGraphSnapshot({ graph, nodes: [implementation] }),
		/missing dependency research/u
	);
	assert.throws(
		(): void => assertValidSubagentGraphSnapshot({ graph, nodes: [research, { ...research }] }),
		/Duplicate subagent node id/u
	);
	assert.throws(
		(): void => assertValidSubagentGraphSnapshot({
			graph,
			nodes: [
				{ ...research, dependsOn: ["implementation"] },
				implementation
			]
		}),
		/dependency cycle/u
	);
});

test("subagent roles and workspace modes constrain tool capabilities", (): void => {
	assert.throws((): SubagentNode => createSubagentNode({
		graphId: "graph-domain",
		runId: "run-invalid-research",
		role: "researcher",
		objective: "Write from research",
		workspaceMode: "managed_worktree",
		toolScope: { capabilities: ["read", "write"], toolNames: [], sourceFolderIds: [] }
	}), /role researcher cannot use write/u);

	assert.throws((): SubagentNode => createSubagentNode({
		graphId: "graph-domain",
		runId: "run-invalid-implementer",
		role: "implementer",
		objective: "Write without isolation",
		workspaceMode: "shared_read_only",
		toolScope: { capabilities: ["read", "write"], toolNames: [], sourceFolderIds: [] }
	}), /write capabilities require a managed worktree/u);

	assert.throws((): SubagentNode => createSubagentNode({
		graphId: "graph-domain",
		runId: "run-invalid-context",
		role: "researcher",
		objective: "Read duplicate context",
		workspaceMode: "shared_read_only",
		toolScope: READ_SCOPE,
		contextRefs: [
			{ kind: "message", id: "message-1" },
			{ kind: "message", id: "message-1" }
		]
	}), /duplicate reference/u);
});

test("subagent node transitions preserve execution boundaries", (): void => {
	const pending = createNode({ nodeId: "research", runId: "run-research" });
	const ready = transitionSubagentNode(pending, "ready", {}, "2026-09-09T00:00:01.000Z");
	const running = transitionSubagentNode(ready, "running", {}, "2026-09-09T00:00:02.000Z");
	assert.throws(
		(): SubagentNode => transitionSubagentNode(running, "running", { dependsOn: ["another"] }),
		/dependencies are immutable/u
	);
	assert.throws(
		(): SubagentNode => transitionSubagentNode(pending, "completed"),
		/Illegal subagent node transition/u
	);

	const result: SubagentResult = {
		status: "completed",
		summary: "Research complete.",
		findings: ["Found the relevant module."],
		changedFiles: [],
		tests: [],
		artifacts: [],
		needsParentDecision: false,
		recommendedNextAction: null
	};
	const completed = transitionSubagentNode(running, "completed", { result }, "2026-09-09T00:00:03.000Z");
	assert.equal(areSubagentDependenciesCompleted(
		createNode({ nodeId: "implementation", runId: "run-implementation", role: "implementer", dependsOn: ["research"] }),
		[completed]
	), true);
	assert.throws(
		(): SubagentNode => transitionSubagentNode(completed, "completed", { objective: "Changed" }),
		/completed and immutable/u
	);
});
