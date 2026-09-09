import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	listActiveSubagentNodesByRootRunId,
	listReadySubagentNodes,
	listRecoverableSubagentGraphSnapshots,
	listSubagentGraphSnapshots,
	readSubagentGraphSnapshot,
	readSubagentNode,
	readSubagentNodeByRunId,
	saveSubagentGraphSnapshot
} from "../../../src/session/subagent-graph-store.js";
import {
	createSubagentGraph,
	createSubagentNode,
	transitionSubagentGraph,
	transitionSubagentNode,
	updateSubagentNodeWorktreeMetadata,
	type SubagentGraphSnapshot,
	type SubagentResult
} from "../../../src/workflow/subagent-graph.js";

const RESULT: SubagentResult = {
	status: "completed",
	summary: "Research finished.",
	findings: ["The scheduler owns execution state."],
	changedFiles: [],
	tests: [{ name: "unit", status: "passed", summary: null }],
	artifacts: [],
	needsParentDecision: false,
	recommendedNextAction: "Start implementation."
};

test("subagent graph snapshots persist topology, results, worktrees, and recovery state", async (): Promise<void> => {
	const directory: string = await mkdtemp(join(tmpdir(), "daedalus-subagent-graph-store-"));
	const databasePath: string = join(directory, "sessions.sqlite3");
	const database = await import("../../../src/session/session-database.js");
	await database.resetSessionDatabaseForTests(databasePath);
	try {
		const { createSession } = await import("../../../src/session/session-store.js");
		const session = await createSession("Subagent graph", "workspace-main");
		const graph = createSubagentGraph({
			graphId: "graph-persist",
			sessionId: session.id,
			rootRunId: "root-run-persist",
			now: "2026-09-09T01:00:00.000Z"
		});
		const research = createSubagentNode({
			graphId: graph.graphId,
			nodeId: "research",
			runId: "run-research-persist",
			role: "researcher",
			objective: "Locate the implementation boundary.",
			workspaceMode: "shared_read_only",
			toolScope: {
				capabilities: ["read", "verify"],
				toolNames: ["mcp_workspace_read_text_file"],
				sourceFolderIds: ["source-a", "source-b"]
			},
			contextRefs: [{ kind: "message", id: "message-1" }],
			now: "2026-09-09T01:00:00.000Z"
		});
		const implement = createSubagentNode({
			graphId: graph.graphId,
			nodeId: "implement",
			runId: "run-implement-persist",
			role: "implementer",
			objective: "Implement the selected approach.",
			dependsOn: [research.nodeId],
			workspaceMode: "managed_worktree",
			toolScope: {
				capabilities: ["read", "verify", "write"],
				toolNames: [],
				sourceFolderIds: ["source-a", "source-b"]
			},
			worktreeMetadata: {
				managedMetadata: {
					id: "worktree-persist",
					sourceWorkspaceId: "workspace-main",
					sourceWorkspaceName: "Main workspace",
					runtimeWorkspaceId: "workspace-runtime",
					createdAt: "2026-09-09T01:00:00.000Z",
					location: "worktree",
					status: "ready",
					sources: [
						{
							sourceFolderId: "source-a",
							sourcePath: "D:\\repo-a",
							worktreePath: "D:\\worktrees\\repo-a",
							baseCommit: "aaaa",
							baseRef: "main"
						},
						{
							sourceFolderId: "source-b",
							sourcePath: "D:\\repo-b",
							worktreePath: "D:\\worktrees\\repo-b",
							baseCommit: "bbbb",
							baseRef: null
						}
					]
				},
				sourceStates: [
					{ sourceFolderId: "source-a", headCommit: "aaaa", branch: "main", detached: false },
					{ sourceFolderId: "source-b", headCommit: "bbbb", branch: null, detached: true }
				],
				mergeStatus: "not_requested",
				cleanupStatus: "not_requested"
			},
			now: "2026-09-09T01:00:00.000Z"
		});
		const initial: SubagentGraphSnapshot = { graph, nodes: [research, implement] };

		await saveSubagentGraphSnapshot(initial);
		const restoredInitial = await readSubagentGraphSnapshot(graph.graphId);
		assert.deepEqual(
			restoredInitial?.nodes.map((node) => ({ ...node, dependsOn: [...node.dependsOn].sort() })).sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
			initial.nodes.map((node) => ({ ...node, dependsOn: [...node.dependsOn].sort() })).sort((a, b) => a.nodeId.localeCompare(b.nodeId))
		);
		await saveSubagentGraphSnapshot(initial);
		assert.deepEqual(restoredInitial?.graph, graph);
		assert.deepEqual(
			restoredInitial?.nodes.map((node): string => node.nodeId).sort(),
			["implement", "research"]
		);
		assert.deepEqual((await readSubagentNode(graph.graphId, "implement"))?.worktreeMetadata, implement.worktreeMetadata);
		assert.equal((await readSubagentNodeByRunId(research.runId))?.nodeId, research.nodeId);
		assert.equal((await listSubagentGraphSnapshots(session.id)).length, 1);
		assert.equal((await listRecoverableSubagentGraphSnapshots(session.id)).length, 1);
		assert.deepEqual(
			(await listActiveSubagentNodesByRootRunId(graph.rootRunId)).map((node): string => node.nodeId).sort(),
			["implement", "research"]
		);

		const runningGraph = transitionSubagentGraph(graph, "running", {}, "2026-09-09T01:00:01.000Z");
		const readyResearch = transitionSubagentNode(research, "ready", {}, "2026-09-09T01:00:01.000Z");
		await saveSubagentGraphSnapshot({ graph: runningGraph, nodes: [readyResearch, implement] });
		assert.deepEqual((await listReadySubagentNodes(graph.graphId)).map((node): string => node.nodeId), ["research"]);

		const executionGraph = transitionSubagentGraph(runningGraph, "running", {}, "2026-09-09T01:00:02.000Z");
		const runningResearch = transitionSubagentNode(readyResearch, "running", {}, "2026-09-09T01:00:02.000Z");
		await saveSubagentGraphSnapshot({ graph: executionGraph, nodes: [runningResearch, implement] });

		const resultGraph = transitionSubagentGraph(executionGraph, "running", {}, "2026-09-09T01:00:03.000Z");
		const completedResearch = transitionSubagentNode(
			runningResearch,
			"completed",
			{ result: RESULT },
			"2026-09-09T01:00:03.000Z"
		);
		await saveSubagentGraphSnapshot({ graph: resultGraph, nodes: [completedResearch, implement] });
		assert.deepEqual((await readSubagentNode(graph.graphId, research.nodeId))?.result, RESULT);

		const readyGraph = transitionSubagentGraph(resultGraph, "running", {}, "2026-09-09T01:00:04.000Z");
		const readyImplement = transitionSubagentNode(implement, "ready", {}, "2026-09-09T01:00:04.000Z");
		await saveSubagentGraphSnapshot({ graph: readyGraph, nodes: [completedResearch, readyImplement] });
		assert.deepEqual((await listReadySubagentNodes(graph.graphId)).map((node): string => node.nodeId), ["implement"]);

		const invalidGraph = transitionSubagentGraph(readyGraph, "running", {}, "2026-09-09T01:00:05.000Z");
		await assert.rejects(
			saveSubagentGraphSnapshot({
				graph: invalidGraph,
				nodes: [{ ...completedResearch, objective: "Rewrite completed history" }, readyImplement]
			}),
			/Completed subagent node research is immutable/u
		);

		const implementRunningGraph = transitionSubagentGraph(readyGraph, "running", {}, "2026-09-09T01:00:06.000Z");
		const runningImplement = transitionSubagentNode(readyImplement, "running", {}, "2026-09-09T01:00:06.000Z");
		await saveSubagentGraphSnapshot({ graph: implementRunningGraph, nodes: [completedResearch, runningImplement] });
		const implementCompletedGraph = transitionSubagentGraph(implementRunningGraph, "completed", {}, "2026-09-09T01:00:07.000Z");
		const completedImplement = transitionSubagentNode(runningImplement, "completed", { result: RESULT }, "2026-09-09T01:00:07.000Z");
		await saveSubagentGraphSnapshot({ graph: implementCompletedGraph, nodes: [completedResearch, completedImplement] });
		const previewedImplement = updateSubagentNodeWorktreeMetadata(completedImplement, {
			...completedImplement.worktreeMetadata!,
			mergeStatus: "previewed"
		}, "2026-09-09T01:00:08.000Z");
		const previewGraph = transitionSubagentGraph(implementCompletedGraph, "completed", {}, "2026-09-09T01:00:08.000Z");
		await saveSubagentGraphSnapshot({ graph: previewGraph, nodes: [completedResearch, previewedImplement] });
		assert.equal((await readSubagentNode(graph.graphId, implement.nodeId))?.worktreeMetadata?.mergeStatus, "previewed");

		const db = await database.getSessionDatabase();
		assert.equal(
			Number((db.prepare("SELECT COUNT(*) AS count FROM subagent_edges WHERE graph_id = ?").get(graph.graphId) as { count: number }).count),
			1
		);
	} finally {
		await database.resetSessionDatabaseForTests();
		await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("subagent graph store rejects stale revisions and invalid topology", async (): Promise<void> => {
	const directory: string = await mkdtemp(join(tmpdir(), "daedalus-subagent-graph-stale-"));
	const databasePath: string = join(directory, "sessions.sqlite3");
	const database = await import("../../../src/session/session-database.js");
	await database.resetSessionDatabaseForTests(databasePath);
	try {
		const { createSession } = await import("../../../src/session/session-store.js");
		const session = await createSession("Subagent stale revision", undefined);
		const graph = createSubagentGraph({
			graphId: "graph-stale",
			sessionId: session.id,
			rootRunId: "root-run-stale",
			now: "2026-09-09T02:00:00.000Z"
		});
		const node = createSubagentNode({
			graphId: graph.graphId,
			nodeId: "node-stale",
			runId: "run-node-stale",
			role: "planner",
			objective: "Plan safely.",
			workspaceMode: "shared_read_only",
			toolScope: { capabilities: ["read"], toolNames: [], sourceFolderIds: [] },
			now: "2026-09-09T02:00:00.000Z"
		});
		await saveSubagentGraphSnapshot({ graph, nodes: [node] });

		await assert.rejects(
			saveSubagentGraphSnapshot({ graph, nodes: [{ ...node, objective: "Conflicting stale write" }] }),
			/Stale subagent graph revision/u
		);
		await assert.rejects(
			saveSubagentGraphSnapshot({
				graph: transitionSubagentGraph(graph, "running"),
				nodes: [{ ...node, dependsOn: ["missing"] }]
			}),
			/missing dependency missing/u
		);
	} finally {
		await database.resetSessionDatabaseForTests();
		await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});
