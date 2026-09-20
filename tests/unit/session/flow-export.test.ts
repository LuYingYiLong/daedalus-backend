import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { getDaedalusPath } from "../../../src/app-paths.js";
import { createFlowDocument, commitFlowOperationsDocument, getFlowDocument, createFlowRunDocument, updateFlowRunDocument } from "../../../src/session/flow-document-store.js";
import { getSessionDatabase, resetSessionDatabaseForTests } from "../../../src/session/session-database.js";
import { saveFlowArtifact } from "../../../src/session/flow-artifact-store.js";
import { exportFlowToSqlite } from "../../../src/session/flow-export.js";
import { clientRequestSchema } from "../../../src/protocol/schema.js";

test("Flow layout survives reopening and exports a consistent isolated archive with media", async () => {
	const profile = await mkdtemp(join(tmpdir(), "flow-export-"));
	const previous = process.env.USERPROFILE;
	process.env.USERPROFILE = profile;
	try {
		const flow = await createFlowDocument({ title: "Export", starterGraph: {} });
		const other = await createFlowDocument({ title: "Other", starterGraph: {} });
		const node = flow.nodes[0]!;
		assert.equal(node.collapsed, false);
		const operations = [
			{ mutationId: "move", kind: "node.move" as const, payload: { nodeId: node.nodeId, x: 135, y: -74 } },
			{ mutationId: "resize", kind: "node.resize" as const, payload: { nodeId: node.nodeId, width: 560, height: 490 } },
			{ mutationId: "fold", kind: "node.collapse" as const, payload: { nodeId: node.nodeId, collapsed: true } },
			{ mutationId: "viewport", kind: "viewport.update" as const, payload: { x: 40, y: 80, zoom: 1.4 } },
		];
		const ack = await commitFlowOperationsDocument({ flowId: flow.flow.flowId, clientId: "test", operations });
		assert.equal(ack.graphRevision, flow.flow.graphRevision);
		assert.equal(ack.layoutRevision, flow.flow.layoutRevision + 1);
		await commitFlowOperationsDocument({ flowId: flow.flow.flowId, clientId: "test", operations });
		await resetSessionDatabaseForTests();
		const restored = await getFlowDocument(flow.flow.flowId);
		assert.deepEqual(restored.nodes.map(n => [n.nodeId, n.x, n.y, n.width, n.height, n.collapsed]).find(n => n[0] === node.nodeId), [node.nodeId, 135, -74, 560, 490, true]);
		const run = await createFlowRunDocument(flow.flow.flowId, ack.graphRevision, [node.nodeId]);
		await updateFlowRunDocument(flow.flow.flowId, run.runId, { status: "completed" });
		const bytes = Buffer.from("test media payload");
		const artifact = await saveFlowArtifact({ flowId: flow.flow.flowId, runId: run.runId, nodeId: node.nodeId, bytes, mimeType: "image/png" });
		const destination = join(profile, "exports", "flow.sqlite");
		const result = await exportFlowToSqlite(flow.flow.flowId, destination);
		assert.equal(result.embeddedFileCount, 1);
		assert.equal(result.missingFileCount, 0);
		const exported = new DatabaseSync(destination, { readOnly: true });
		try {
			assert.equal(exported.prepare("SELECT count(*) AS n FROM flow_documents").get()?.n, 1);
			assert.equal(exported.prepare("SELECT * FROM flow_documents WHERE flow_id = ?").get(other.flow.flowId), undefined);
			assert.equal(exported.prepare("SELECT * FROM flow_nodes WHERE node_id = ?").get(node.nodeId)?.collapsed, 1);
			assert.deepEqual(exported.prepare("SELECT * FROM flow_edges ORDER BY edge_id").all(), (await getSessionDatabase()).prepare("SELECT * FROM flow_edges WHERE flow_id = ? ORDER BY edge_id").all(flow.flow.flowId));
			assert.deepEqual(Buffer.from(exported.prepare("SELECT content FROM daedalus_flow_export_files WHERE artifact_id = ?").get(artifact.artifactId)!.content as Uint8Array), bytes);
			assert.equal(exported.prepare("SELECT format_version FROM daedalus_flow_export_metadata").get()?.format_version, 1);
			assert.equal(exported.prepare("SELECT name FROM sqlite_master WHERE name IN ('sessions', 'flow_approvals', 'flow_operations')").all().length, 0);
		} finally { exported.close(); }
		const before = await readFile(destination);
		await assert.rejects(exportFlowToSqlite("flow-missing", destination));
		assert.deepEqual(await readFile(destination), before);
		await assert.rejects(exportFlowToSqlite(flow.flow.flowId, getDaedalusPath("flow.artifacts.root") + "/bad.sqlite"));
		await writeFile(join(getDaedalusPath("flow.artifacts.root"), artifact.storagePath), "corrupt");
		await assert.rejects(exportFlowToSqlite(flow.flow.flowId, destination));
		assert.deepEqual(await readFile(destination), before);
		await rm(join(getDaedalusPath("flow.artifacts.root"), artifact.storagePath));
		assert.equal((await exportFlowToSqlite(flow.flow.flowId, destination)).missingFileCount, 1);
	} finally {
		await resetSessionDatabaseForTests();
		if (previous === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previous;
		await rm(profile, { recursive: true, force: true });
	}
});

test("Flow collapse and export requests reject malformed payloads", () => {
	const patch = { type: "request", id: "request", method: "flow.patch.commit", params: { flowId: "flow-test", clientId: "test", operations: [{ mutationId: "fold", kind: "node.collapse", payload: { nodeId: "node-test", collapsed: true } }] } };
	assert.equal(clientRequestSchema.safeParse(patch).success, true);
	assert.equal(clientRequestSchema.safeParse({ ...patch, params: { ...patch.params, operations: [{ ...patch.params.operations[0], payload: { nodeId: "node-test", collapsed: "true" } }] } }).success, false);
	assert.equal(clientRequestSchema.safeParse({ type: "request", id: "export", method: "flow.export", params: { flowId: "flow-test", destinationPath: "/tmp/test.sqlite" } }).success, true);
});

test("Flow composable migration resets old documents without reusing old node contracts", async () => {
	const directory = await mkdtemp(join(tmpdir(), "flow-collapse-migration-"));
	const path = join(directory, "sessions.sqlite");
	await resetSessionDatabaseForTests(path);
	try {
		const flow = await createFlowDocument({ title: "Existing", starterGraph: {} });
		const db = await getSessionDatabase();
		db.exec("INSERT INTO sessions(session_id,title,metadata_json,created_at,updated_at) VALUES('chat-preserved','Chat','{}','now','now'); INSERT INTO attachments VALUES('chat-image','chat-preserved','image','{}','chat/images/image.png','now');");
		const chat = db.prepare("SELECT * FROM sessions WHERE session_id='chat-preserved'").get();
		const attachment = db.prepare("SELECT * FROM attachments WHERE attachment_id='chat-image'").get();
		db.exec("ALTER TABLE flow_nodes DROP COLUMN collapsed; PRAGMA user_version = 25;");
		await resetSessionDatabaseForTests(path);
		await assert.rejects(getFlowDocument(flow.flow.flowId), /not found/i);
		const migrated = await getSessionDatabase();
		assert.deepEqual(migrated.prepare("SELECT * FROM sessions WHERE session_id='chat-preserved'").get(), chat);
		assert.deepEqual(migrated.prepare("SELECT * FROM attachments WHERE attachment_id='chat-image'").get(), attachment);
		assert.equal(migrated.prepare("SELECT count(*) AS n FROM flow_nodes").get()?.n, 0);
	} finally { await resetSessionDatabaseForTests(); await rm(directory, { recursive: true, force: true }); }
});
