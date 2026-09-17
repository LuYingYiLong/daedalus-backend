import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { McpHost } from "../../../src/mcp/mcp-host.js";
import { startFlowRunDocument } from "../../../src/server/flow-runner.js";
import { listFlowNodeTypeDefinitions, normalizeFlowNodeConfig } from "../../../src/server/flow-node-registry.js";
import {
	createConnectedFlowNodeDocument,
	createFlowDocument,
	createFlowEdgeDocument,
	createFlowNodeDocument,
	createFlowRunDocument,
	getFlowDocument,
	updateFlowRunDocument,
	updateFlowNodeDocument,
	updateFlowViewportDocument,
} from "../../../src/session/flow-document-store.js";
import { resetSessionDatabaseForTests } from "../../../src/session/session-database.js";

async function withDatabase(run: () => Promise<void>): Promise<void> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "daedalus-document-flow-"));
	await resetSessionDatabaseForTests(path.join(directory, "sessions.sqlite"));
	try { await run(); } finally { await resetSessionDatabaseForTests(); await fs.rm(directory, { recursive: true, force: true }); }
}

test("Flow node registry exposes strict defaults and all mature node types", (): void => {
	assert.deepEqual(listFlowNodeTypeDefinitions(true).map((definition): string => definition.type), ["prompt", "text", "template", "merge", "json_extract", "condition", "file_input", "llm", "tool", "command", "output", "note"]);
	assert.throws((): Record<string, unknown> => normalizeFlowNodeConfig("command", { commandLine: "echo ok", unexpected: true }), /unrecognized/i);
	assert.equal(normalizeFlowNodeConfig("command", { commandLine: "echo ok" }).timeoutMs, 30_000);
});

test("Flow graph and layout revisions advance independently", async (): Promise<void> => withDatabase(async (): Promise<void> => {
	const created = await createFlowDocument({ title: "Revisions" });
	const withNode = await createFlowNodeDocument({ flowId: created.flow.flowId, revision: created.flow.graphRevision, type: "text", x: 10, y: 20, config: { text: "hello" } });
	assert.equal(withNode.flow.graphRevision, created.flow.graphRevision + 1);
	assert.equal(withNode.flow.layoutRevision, created.flow.layoutRevision);
	const moved = await updateFlowNodeDocument({ flowId: created.flow.flowId, nodeId: withNode.nodes[0]!.nodeId, revision: withNode.flow.layoutRevision, patch: { x: 80, y: 90 } });
	assert.equal(moved.flow.graphRevision, withNode.flow.graphRevision);
	assert.equal(moved.flow.layoutRevision, withNode.flow.layoutRevision + 1);
	const viewport = await updateFlowViewportDocument({ flowId: created.flow.flowId, revision: moved.flow.layoutRevision, viewport: { x: 20, y: 30, zoom: 1.2 } });
	assert.equal(viewport.graphRevision, moved.flow.graphRevision);
	assert.equal(viewport.layoutRevision, moved.flow.layoutRevision + 1);
}));

test("createConnected is atomic and replaces a single-input edge", async (): Promise<void> => withDatabase(async (): Promise<void> => {
	let snapshot = await createFlowDocument({ title: "Atomic" });
	snapshot = await createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, type: "text", x: 0, y: 0, config: { text: "first" } });
	const firstNodeId = snapshot.nodes[0]!.nodeId;
	const connected = await createConnectedFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, type: "output", x: 300, y: 0, connection: { direction: "from_existing", existingNodeId: firstNodeId, existingPort: "output", newPort: "input", dataType: "text" } });
	assert.equal(connected.snapshot.nodes.length, 2);
	assert.equal(connected.snapshot.edges.length, 1);
	await assert.rejects(createConnectedFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: connected.snapshot.flow.graphRevision, type: "note", x: 500, y: 0, connection: { direction: "from_existing", existingNodeId: firstNodeId, existingPort: "output", newPort: "input", dataType: "text" } }), { code: "flow_port_incompatible" });
	assert.equal((await getFlowDocument(snapshot.flow.flowId)).nodes.length, 2);
	let next = await createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: connected.snapshot.flow.graphRevision, type: "text", x: 0, y: 200, config: { text: "second" } });
	const secondNodeId = next.nodes.find((node): boolean => node.nodeId !== firstNodeId && node.type === "text")!.nodeId;
	next = await createFlowEdgeDocument({ flowId: snapshot.flow.flowId, revision: next.flow.graphRevision, sourceNodeId: secondNodeId, sourcePort: "output", targetNodeId: connected.nodeId, targetPort: "input", dataType: "text" });
	assert.equal(next.edges.length, 1);
	assert.equal(next.edges[0]!.sourceNodeId, secondNodeId);
}));

test("Flow runner passes values by port and caches pure nodes", async (): Promise<void> => withDatabase(async (): Promise<void> => {
	let snapshot = await createFlowDocument({ title: "Run" });
	snapshot = await createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, type: "text", x: 0, y: 0, config: { text: "hello" } });
	const textNode = snapshot.nodes[0]!;
	snapshot = await createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, type: "template", x: 320, y: 0, config: { template: "{{input}} world", inputs: [{ id: "input", label: "Input", dataType: "text" }] } });
	const templateNode = snapshot.nodes.find((node): boolean => node.type === "template")!;
	snapshot = await createFlowEdgeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, sourceNodeId: textNode.nodeId, sourcePort: "output", targetNodeId: templateNode.nodeId, targetPort: "input", dataType: "text" });
	const first = await startFlowRunDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, mcpHost: {} as McpHost });
	assert.equal(first.status, "completed");
	assert.deepEqual(first.nodes.find((node): boolean => node.nodeId === templateNode.nodeId)?.output, { output: "hello world" });
	const second = await startFlowRunDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, mcpHost: {} as McpHost });
	assert.equal(second.nodes.find((node): boolean => node.nodeId === templateNode.nodeId)?.status, "cached");
}));

test("an active run locks semantic edits but keeps layout editable", async (): Promise<void> => withDatabase(async (): Promise<void> => {
	let snapshot = await createFlowDocument({ title: "Locked graph" });
	snapshot = await createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, type: "text", x: 0, y: 0, config: { text: "hello" } });
	const node = snapshot.nodes[0]!;
	const run = await createFlowRunDocument(snapshot.flow.flowId, snapshot.flow.graphRevision, [node.nodeId]);
	await assert.rejects(createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, type: "note", x: 10, y: 10 }), { code: "flow_graph_locked" });
	const moved = await updateFlowNodeDocument({ flowId: snapshot.flow.flowId, nodeId: node.nodeId, revision: snapshot.flow.layoutRevision, patch: { x: 80, y: 90 } });
	assert.equal(moved.nodes[0]!.x, 80);
	assert.equal(moved.flow.graphRevision, snapshot.flow.graphRevision);
	await updateFlowRunDocument(snapshot.flow.flowId, run.runId, { status: "completed", finishedAt: new Date().toISOString() });
	const editable = await createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, type: "note", x: 10, y: 10 });
	assert.equal(editable.nodes.length, 2);
}));

test("Merge keeps configured input order and Condition activates one output branch", async (): Promise<void> => withDatabase(async (): Promise<void> => {
	let snapshot = await createFlowDocument({ title: "Branching" });
	snapshot = await createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, type: "text", x: 0, y: 0, config: { text: "first" } });
	const first = snapshot.nodes[0]!;
	snapshot = await createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, type: "text", x: 0, y: 160, config: { text: "second" } });
	const second = snapshot.nodes.find((node): boolean => node.nodeId !== first.nodeId)!;
	snapshot = await createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, type: "merge", x: 300, y: 80, config: { mode: "concat", separator: "|", inputs: [{ id: "input-1", label: "First", dataType: "text" }, { id: "input-2", label: "Second", dataType: "text" }] } });
	const merge = snapshot.nodes.find((node): boolean => node.type === "merge")!;
	snapshot = await createFlowEdgeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, sourceNodeId: first.nodeId, sourcePort: "output", targetNodeId: merge.nodeId, targetPort: "input-2", dataType: "text" });
	snapshot = await createFlowEdgeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, sourceNodeId: second.nodeId, sourcePort: "output", targetNodeId: merge.nodeId, targetPort: "input-1", dataType: "text" });
	snapshot = await createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, type: "condition", x: 620, y: 80, config: { pointer: "/", operator: "equals", value: "second|first" } });
	const condition = snapshot.nodes.find((node): boolean => node.type === "condition")!;
	snapshot = await createFlowEdgeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, sourceNodeId: merge.nodeId, sourcePort: "output", targetNodeId: condition.nodeId, targetPort: "input", dataType: "text" });
	snapshot = await createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, type: "output", x: 940, y: 0, config: { format: "text" } });
	const trueOutput = snapshot.nodes.find((node): boolean => node.type === "output")!;
	snapshot = await createFlowEdgeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, sourceNodeId: condition.nodeId, sourcePort: "true", targetNodeId: trueOutput.nodeId, targetPort: "input", dataType: "text" });
	snapshot = await createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, type: "output", x: 940, y: 180, config: { format: "text" } });
	const falseOutput = snapshot.nodes.find((node): boolean => node.type === "output" && node.nodeId !== trueOutput.nodeId)!;
	snapshot = await createFlowEdgeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, sourceNodeId: condition.nodeId, sourcePort: "false", targetNodeId: falseOutput.nodeId, targetPort: "input", dataType: "text" });
	const run = await startFlowRunDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, mcpHost: {} as McpHost });
	assert.equal(run.status, "completed");
	assert.deepEqual(run.nodes.find((node): boolean => node.nodeId === merge.nodeId)?.output, { output: "second|first" });
	assert.deepEqual(run.nodes.find((node): boolean => node.nodeId === trueOutput.nodeId)?.output, { result: "second|first" });
	assert.equal(run.nodes.find((node): boolean => node.nodeId === falseOutput.nodeId)?.status, "skipped");
}));

test("Flow schema migration preserves existing documents, nodes, and edges", async (): Promise<void> => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "daedalus-document-flow-migration-"));
	const databasePath = path.join(directory, "sessions.sqlite");
	const db = new DatabaseSync(databasePath);
	db.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE flow_documents (flow_id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_id TEXT, pinned INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1, viewport_json TEXT NOT NULL, archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
		CREATE TABLE flow_nodes (node_id TEXT PRIMARY KEY, flow_id TEXT NOT NULL REFERENCES flow_documents(flow_id) ON DELETE CASCADE, type TEXT NOT NULL CHECK(type IN ('prompt', 'llm', 'output', 'note')), title TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL, width REAL NOT NULL, height REAL NOT NULL, config_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'idle', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
		CREATE TABLE flow_edges (edge_id TEXT PRIMARY KEY, flow_id TEXT NOT NULL REFERENCES flow_documents(flow_id) ON DELETE CASCADE, source_node_id TEXT NOT NULL REFERENCES flow_nodes(node_id) ON DELETE CASCADE, source_port TEXT NOT NULL, target_node_id TEXT NOT NULL REFERENCES flow_nodes(node_id) ON DELETE CASCADE, target_port TEXT NOT NULL, data_type TEXT NOT NULL CHECK(data_type IN ('text', 'json', 'artifact')), UNIQUE(flow_id, target_node_id, target_port));
		INSERT INTO flow_documents VALUES ('flow-old', 'Existing', NULL, 0, 7, '{"x":0,"y":0,"zoom":1}', NULL, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
		INSERT INTO flow_nodes VALUES ('node-prompt', 'flow-old', 'prompt', 'Prompt', 0, 0, 300, 180, '{"text":"hello"}', 'idle', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
		INSERT INTO flow_nodes VALUES ('node-output', 'flow-old', 'output', 'Output', 320, 0, 300, 180, '{"format":"text"}', 'idle', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
		INSERT INTO flow_edges VALUES ('edge-old', 'flow-old', 'node-prompt', 'output', 'node-output', 'input', 'text');
	`);
	db.close();
	await resetSessionDatabaseForTests(databasePath);
	try {
		const migrated = await getFlowDocument("flow-old");
		assert.equal(migrated.flow.graphRevision, 7);
		assert.equal(migrated.flow.layoutRevision, 7);
		assert.equal(migrated.nodes.length, 2);
		assert.equal(migrated.edges.length, 1);
		const added = await createFlowNodeDocument({ flowId: "flow-old", revision: 7, type: "command", x: 640, y: 0, config: { commandLine: "echo ok" } });
		assert.equal(added.nodes.some((node): boolean => node.type === "command"), true);
	} finally {
		await resetSessionDatabaseForTests();
		await fs.rm(directory, { recursive: true, force: true });
	}
});
