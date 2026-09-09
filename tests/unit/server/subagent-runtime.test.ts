import assert from "node:assert/strict";
import test from "node:test";
import type { ClientSession } from "../../../src/server/client-session.js";
import {
	assertSubagentContextReferencesForTest,
	assertSubagentGraphOwnershipForTest,
	filterSubagentToolNamesForTest,
	paginateSubagentGraphsForTest,
	parseSubagentResultForTest
} from "../../../src/server/subagent-runtime.js";
import type { WorkspaceConfig } from "../../../src/workspace/types.js";
import type { SubagentGraphSnapshot } from "../../../src/workflow/subagent-graph.js";

function createSnapshot(graphId: string, sessionId: string = "session-a", rootRunId: string = "root-a"): SubagentGraphSnapshot {
	return {
		graph: {
			graphId,
			sessionId,
			rootRunId,
			status: "running",
			revision: 1,
			createdAt: "2026-09-09T00:00:00.000Z",
			updatedAt: "2026-09-09T00:00:00.000Z"
		},
		nodes: []
	};
}

test("subagent result parsing enforces the strict shape and normalizes changed files", () => {
	const result = parseSubagentResultForTest(JSON.stringify({
		status: "completed",
		summary: "done",
		findings: ["finding"],
		changedFiles: [" src/b.ts ", "src/a.ts", "src/a.ts"],
		tests: [{ name: "typecheck", status: "passed", summary: null }],
		artifacts: [{ kind: "diff", id: "artifact-1", label: null }],
		needsParentDecision: false,
		recommendedNextAction: null
	}), ["src/c.ts", " src/b.ts ", "src/c.ts"]);

	assert.equal(result.status, "completed");
	assert.deepEqual(result.changedFiles, ["src/a.ts", "src/b.ts", "src/c.ts"]);
	assert.deepEqual(result.tests, [{ name: "typecheck", status: "passed", summary: null }]);
});

test("unstructured subagent output becomes a bounded partial result", () => {
	const result = parseSubagentResultForTest(` ${"x".repeat(21_000)} `, [" b.ts ", "a.ts", "", "a.ts"]);

	assert.equal(result.status, "partial");
	assert.equal(result.summary.length, 20_000);
	assert.deepEqual(result.changedFiles, ["a.ts", "b.ts"]);
	assert.equal(result.needsParentDecision, true);
	assert.match(result.recommendedNextAction ?? "", /strict result/u);
});

test("subagent details markdown is bounded and redacts credentials and absolute paths", () => {
	const result = parseSubagentResultForTest(JSON.stringify({
		status: "completed",
		summary: "done",
		findings: [],
		changedFiles: [],
		tests: [],
		artifacts: [],
		needsParentDecision: false,
		recommendedNextAction: null,
		detailsMarkdown: "Authorization: Bearer top-secret\napi_key=secret-value\nC:\\Users\\Admin\\private.log\n/home/admin/private.log"
	}), []);

	assert.match(result.detailsMarkdown ?? "", /Authorization: \[REDACTED\]/u);
	assert.doesNotMatch(result.detailsMarkdown ?? "", /top-secret|secret-value|Users\\Admin|\/home\/admin/u);
});

test("subagent result parsing rejects fields outside the strict result contract", () => {
	const result = parseSubagentResultForTest(JSON.stringify({
		status: "completed",
		summary: "done",
		findings: [],
		changedFiles: [],
		tests: [],
		artifacts: [],
		needsParentDecision: false,
		recommendedNextAction: null,
		secret: "must not pass through"
	}), []);

	assert.equal(result.status, "partial");
	assert.deepEqual(result.findings, []);
	assert.deepEqual(result.artifacts, []);
	assert.equal("secret" in result, false);
});

test("tool filtering intersects requested capabilities with the role boundary", () => {
	const availableToolNames = [
		"mcp_workspace_read_text_file",
		"mcp_workspace_overwrite_text_file",
		"mcp_terminal_run_command",
		"mcp_terminal_run_safe_preset",
		"mcp_terminal_get_job_status",
		"daedalus_subagent_status"
	];
	const researcherTools = filterSubagentToolNamesForTest({
		availableToolNames,
		role: "researcher",
		toolScope: {
			capabilities: ["read", "write", "execute"],
			toolNames: [],
			sourceFolderIds: []
		},
		workspaceMode: "shared_read_only"
	});
	assert.deepEqual(researcherTools, ["mcp_workspace_read_text_file", "mcp_terminal_get_job_status"]);

	const sharedTesterTools = filterSubagentToolNamesForTest({
		availableToolNames,
		role: "tester",
		toolScope: { capabilities: ["execute"], toolNames: [], sourceFolderIds: [] },
		workspaceMode: "shared_read_only"
	});
	assert.deepEqual(sharedTesterTools, ["mcp_terminal_run_safe_preset", "mcp_terminal_get_job_status"]);

	const worktreeTesterTools = filterSubagentToolNamesForTest({
		availableToolNames,
		role: "tester",
		toolScope: { capabilities: ["execute"], toolNames: ["mcp_terminal_run_command"], sourceFolderIds: [] },
		workspaceMode: "managed_worktree"
	});
	assert.deepEqual(worktreeTesterTools, ["mcp_terminal_run_command"]);
});

test("explicit context references must belong to the active session and workspace", () => {
	const session = {
		sessionId: "session-a",
		messages: [{
			role: "user",
			content: "request",
			requestId: "message-a",
			additionalContext: [{
				id: "context-a",
				kind: "file",
				title: "file.ts",
				source: "manual"
			}]
		}]
	} as ClientSession;
	const workspace = {
		id: "workspace-a",
		name: "repo",
		kind: "workspace",
		rootPath: "C:\\repo",
		icon: 0,
		color: 0,
		primarySourceFolderId: "source-a",
		sourceFolders: [{
			id: "source-a",
			path: "C:\\repo",
			capabilities: { git: true, godot: false }
		}]
	} satisfies WorkspaceConfig;

	assert.doesNotThrow(() => assertSubagentContextReferencesForTest(session, workspace, [
		{ kind: "message", id: "message-a" },
		{ kind: "context_block", id: "context-a" },
		{ kind: "source_folder", id: "source-a" }
	]));
	assert.throws(
		() => assertSubagentContextReferencesForTest(session, workspace, [{ kind: "message", id: "message-b" }]),
		/Unknown message context reference/u
	);
	assert.throws(
		() => assertSubagentContextReferencesForTest(session, workspace, [{ kind: "artifact", id: "context-b" }]),
		/Unknown artifact context reference/u
	);
	assert.throws(
		() => assertSubagentContextReferencesForTest(session, workspace, [{ kind: "source_folder", id: "source-b" }]),
		/Unknown source folder context reference/u
	);
});

test("graph ownership requires both the active session and the parent run", () => {
	const snapshot = createSnapshot("graph-a");
	assert.doesNotThrow(() => assertSubagentGraphOwnershipForTest(snapshot, { sessionId: "session-a" } as ClientSession, "root-a"));
	assert.throws(
		() => assertSubagentGraphOwnershipForTest(snapshot, { sessionId: "session-b" } as ClientSession),
		/belongs to another session/u
	);
	assert.throws(
		() => assertSubagentGraphOwnershipForTest(snapshot, { sessionId: "session-a" } as ClientSession, "root-b"),
		/parent Agent run/u
	);
});

test("graph pagination advances from a validated cursor without sharing mutable snapshots", () => {
	const snapshots = [createSnapshot("graph-a"), createSnapshot("graph-b"), createSnapshot("graph-c")];
	const firstPage = paginateSubagentGraphsForTest(snapshots, 2);
	assert.deepEqual(firstPage.graphs.map((snapshot) => snapshot.graph.graphId), ["graph-a", "graph-b"]);
	assert.equal(firstPage.nextCursor, "graph-b");

	const secondPage = paginateSubagentGraphsForTest(snapshots, 2, firstPage.nextCursor ?? undefined);
	assert.deepEqual(secondPage.graphs.map((snapshot) => snapshot.graph.graphId), ["graph-c"]);
	assert.equal(secondPage.nextCursor, null);
	secondPage.graphs[0]!.graph.status = "failed";
	assert.equal(snapshots[2]!.graph.status, "running");

	assert.throws(() => paginateSubagentGraphsForTest(snapshots, 2, "unknown"), /Invalid or expired/u);
});
