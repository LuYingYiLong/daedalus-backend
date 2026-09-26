import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import sharp from "sharp";
import { getDaedalusPath } from "../../../src/app-paths.js";
import { createFlowDocument, createFlowNodeDocument, createFlowEdgeDocument, updateFlowNodeDocument, commitFlowOperationsDocument, getFlowDocument, createFlowRunDocument, updateFlowRunDocument } from "../../../src/session/flow-document-store.js";
import { getSessionDatabase, resetSessionDatabaseForTests } from "../../../src/session/session-database.js";
import { exportFlowArtifacts, getFlowArtifact, importFlowInputArtifact, saveFlowArtifact } from "../../../src/session/flow-artifact-store.js";
import { exportFlowToSqlite } from "../../../src/session/flow-export.js";
import { importFlowFromSqlite } from "../../../src/session/flow-import.js";
import { clientRequestSchema } from "../../../src/protocol/schema.js";
import { startFlowRunDocument } from "../../../src/server/flow-runner.js";
import type { McpHost } from "../../../src/mcp/mcp-host.js";

test("Flow layout survives reopening and exports a consistent isolated archive with media", async () => {
	const profile = await mkdtemp(join(tmpdir(), "flow-export-"));
	let importProfile: string | undefined;
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
			{ mutationId: "group-create", kind: "group.create" as const, payload: { groupId: "group-export", title: "Exported group", color: "#5577aa", parentGroupId: null, x: 120, y: -100, width: 600, height: 520 } },
			{ mutationId: "group-member", kind: "group.reparent" as const, payload: { nodes: [{ nodeId: node.nodeId, groupId: "group-export" }], groups: [] } },
			{ mutationId: "viewport", kind: "viewport.update" as const, payload: { x: 40, y: 80, zoom: 1.4 } },
		];
		const ack = await commitFlowOperationsDocument({ flowId: flow.flow.flowId, clientId: "test", operations });
		assert.equal(ack.graphRevision, flow.flow.graphRevision);
		assert.equal(ack.layoutRevision, flow.flow.layoutRevision + 1);
		await commitFlowOperationsDocument({ flowId: flow.flow.flowId, clientId: "test", operations });
		await resetSessionDatabaseForTests();
		const restored = await getFlowDocument(flow.flow.flowId);
		assert.deepEqual(restored.nodes.map(n => [n.nodeId, n.x, n.y, n.width, n.height, n.collapsed]).find(n => n[0] === node.nodeId), [node.nodeId, 135, -74, 560, 490, true]);
		assert.deepEqual(restored.groups.map(group => [group.groupId, group.title, group.nodeIds]), [["group-export", "Exported group", [node.nodeId]]]);
		const run = await createFlowRunDocument(flow.flow.flowId, ack.graphRevision, [node.nodeId]);
		await updateFlowRunDocument(flow.flow.flowId, run.runId, { status: "completed" });
		const bytes = Buffer.from("test media payload");
		const artifact = await saveFlowArtifact({ flowId: flow.flow.flowId, runId: run.runId, nodeId: node.nodeId, bytes, mimeType: "image/png" });
		const singlePath = join(profile, "single.png");
		assert.deepEqual((await exportFlowArtifacts({ flowId: flow.flow.flowId, artifactIds: [artifact.artifactId], destinationPath: singlePath, directory: false })).exportedPaths, [singlePath]);
		assert.deepEqual(await readFile(singlePath), bytes);
		await assert.rejects(exportFlowArtifacts({ flowId: other.flow.flowId, artifactIds: [artifact.artifactId], destinationPath: singlePath, directory: false }), /does not belong/);
		const mediaDirectory = join(profile, "media");
		await mkdir(mediaDirectory);
		const batch = await exportFlowArtifacts({ flowId: flow.flow.flowId, artifactIds: [artifact.artifactId], destinationPath: mediaDirectory, directory: true });
		assert.deepEqual(await readFile(batch.exportedPaths[0]!), bytes);
		const nextBatch = await exportFlowArtifacts({ flowId: flow.flow.flowId, artifactIds: [artifact.artifactId], destinationPath: mediaDirectory, directory: true });
		assert.notEqual(nextBatch.exportedPaths[0], batch.exportedPaths[0]);
		assert.deepEqual(await readFile(batch.exportedPaths[0]!), bytes);
		assert.deepEqual(await readFile(nextBatch.exportedPaths[0]!), bytes);
		const destination = join(profile, "exports", "flow.sqlite");
		const result = await exportFlowToSqlite(flow.flow.flowId, destination);
		assert.equal(result.embeddedFileCount, 1);
		assert.equal(result.missingFileCount, 0);
		const exported = new DatabaseSync(destination, { readOnly: true });
		try {
			assert.equal(exported.prepare("SELECT count(*) AS n FROM flow_documents").get()?.n, 1);
			assert.equal(exported.prepare("SELECT * FROM flow_documents WHERE flow_id = ?").get(other.flow.flowId), undefined);
			assert.equal(exported.prepare("SELECT * FROM flow_nodes WHERE node_id = ?").get(node.nodeId)?.collapsed, 1);
			assert.deepEqual({ ...exported.prepare("SELECT group_id, flow_id, parent_group_id, title, color, x, y, width, height FROM flow_groups").get() }, { group_id: "group-export", flow_id: flow.flow.flowId, parent_group_id: null, title: "Exported group", color: "#5577aa", x: 120, y: -100, width: 600, height: 520 });
			assert.deepEqual({ ...exported.prepare("SELECT node_id, group_id FROM flow_group_nodes").get() }, { node_id: node.nodeId, group_id: "group-export" });
			assert.deepEqual(exported.prepare("SELECT * FROM flow_edges ORDER BY edge_id").all(), (await getSessionDatabase()).prepare("SELECT * FROM flow_edges WHERE flow_id = ? ORDER BY edge_id").all(flow.flow.flowId));
			assert.deepEqual(Buffer.from(exported.prepare("SELECT content FROM daedalus_flow_export_files WHERE artifact_id = ?").get(artifact.artifactId)!.content as Uint8Array), bytes);
			assert.equal(exported.prepare("SELECT format_version FROM daedalus_flow_export_metadata").get()?.format_version, 2);
			assert.equal(exported.prepare("SELECT name FROM sqlite_master WHERE name IN ('sessions', 'flow_approvals', 'flow_operations')").all().length, 0);
		} finally { exported.close(); }
		importProfile = await mkdtemp(join(tmpdir(), "flow-import-"));
		await resetSessionDatabaseForTests();
		process.env.USERPROFILE = importProfile;
		await resetSessionDatabaseForTests(join(importProfile, "sessions.sqlite"));
		const imported = await importFlowFromSqlite(destination);
		assert.equal(imported.flowId, flow.flow.flowId);
		assert.equal(imported.restoredArtifactCount, 1);
		assert.equal(imported.missingArtifactCount, 0);
		const importedSnapshot = await getFlowDocument(flow.flow.flowId);
		assert.deepEqual(importedSnapshot.nodes.map(n => [n.nodeId, n.x, n.y, n.width, n.height, n.collapsed]).find(n => n[0] === node.nodeId), [node.nodeId, 135, -74, 560, 490, true]);
		assert.deepEqual((await getFlowArtifact(artifact.artifactId)).bytes, bytes);
		await assert.rejects(importFlowFromSqlite(destination), /already exists/i);
		await resetSessionDatabaseForTests();
		process.env.USERPROFILE = profile;
		await rm(importProfile, { recursive: true, force: true });
		const before = await readFile(destination);
		await assert.rejects(exportFlowToSqlite("flow-missing", destination));
		assert.deepEqual(await readFile(destination), before);
		await assert.rejects(exportFlowToSqlite(flow.flow.flowId, getDaedalusPath("flow.artifacts.root") + "/bad.sqlite"));
		await writeFile(join(getDaedalusPath("flow.artifacts.root"), artifact.storagePath), "corrupt");
		await assert.rejects(exportFlowToSqlite(flow.flow.flowId, destination));
		assert.deepEqual(await readFile(destination), before);
		await rm(join(getDaedalusPath("flow.artifacts.root"), artifact.storagePath));
		await assert.rejects(exportFlowToSqlite(flow.flow.flowId, destination), /missing/i);
		assert.deepEqual(await readFile(destination), before);
	} finally {
		await resetSessionDatabaseForTests();
		if (previous === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previous;
		if (importProfile !== undefined) await rm(importProfile, { recursive: true, force: true });
		await rm(profile, { recursive: true, force: true });
	}
});

test("Flow Input media is copied into the archive and restored with its node value", async () => {
	const profile = await mkdtemp(join(tmpdir(), "flow-input-export-"));
	const importedProfile = await mkdtemp(join(tmpdir(), "flow-input-import-"));
	const previous = process.env.USERPROFILE;
	process.env.USERPROFILE = profile;
	try {
		let snapshot = await createFlowDocument({ title: "Shared input", starterGraph: {} });
		const originalNodeIds = new Set(snapshot.nodes.map((item) => item.nodeId));
		snapshot = await createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, typeId: "builtin/flow-input", x: 0, y: 0, config: { label: "Image", dataType: "image", defaultValue: null } });
		const node = snapshot.nodes.find((item) => !originalNodeIds.has(item.nodeId))!;
		const sourcePath = join(profile, "outside-workspace.png");
		await writeFile(sourcePath, await sharp({ create: { width: 2, height: 2, channels: 4, background: "#ff0000" } }).png().toBuffer());
		const ref = await importFlowInputArtifact({ flowId: snapshot.flow.flowId, nodeId: node.nodeId, sourcePath, kind: "image" });
		assert.equal(ref.runId, null);
		snapshot = await updateFlowNodeDocument({ flowId: snapshot.flow.flowId, nodeId: node.nodeId, revision: snapshot.flow.graphRevision, patch: { config: { ...node.config, defaultValue: ref } } });
		const beforeOutputIds = new Set(snapshot.nodes.map((item) => item.nodeId));
		snapshot = await createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, typeId: "builtin/media-output", x: 320, y: 0 });
		const output = snapshot.nodes.find((item) => !beforeOutputIds.has(item.nodeId))!;
		assert.deepEqual(snapshot.nodes.find((item) => item.nodeId === node.nodeId)?.ports.map((port) => [port.id, port.dataTypes, port.cardinality]), [["output", ["image"], "one"]]);
		assert.equal(output.ports.some((port) => port.id === "input" && port.dataTypes.includes("image")), true);
		snapshot = await createFlowEdgeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, sourceNodeId: node.nodeId, sourcePort: "output", targetNodeId: output.nodeId, targetPort: "input", dataType: "image" });
		const destination = join(profile, "shared-flow.sqlite");
		assert.equal((await exportFlowToSqlite(snapshot.flow.flowId, destination)).embeddedFileCount, 1);
		await resetSessionDatabaseForTests();
		process.env.USERPROFILE = importedProfile;
		await resetSessionDatabaseForTests(join(importedProfile, "sessions.sqlite"));
		await importFlowFromSqlite(destination);
		const restored = await getFlowDocument(snapshot.flow.flowId);
		assert.deepEqual(restored.nodes.find((item) => item.nodeId === node.nodeId)?.config.defaultValue, ref);
		assert.deepEqual((await getFlowArtifact(ref.artifactId)).ref, ref);
		const run = await startFlowRunDocument({ flowId: snapshot.flow.flowId, revision: restored.flow.graphRevision, mcpHost: {} as McpHost });
		assert.equal(run.status, "completed", JSON.stringify(run.nodes));
		assert.deepEqual(run.nodes.find((item) => item.nodeId === output.nodeId)?.output, { result: ref });
		const archive = new DatabaseSync(destination);
		try { archive.prepare("UPDATE daedalus_flow_export_files SET content = ? WHERE artifact_id = ?").run(Buffer.from("corrupt"), ref.artifactId); }
		finally { archive.close(); }
		await resetSessionDatabaseForTests();
		await assert.rejects(importFlowFromSqlite(destination), /invalid size|checksum/i);
	} finally {
		await resetSessionDatabaseForTests();
		if (previous === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previous;
		await rm(profile, { recursive: true, force: true });
		await rm(importedProfile, { recursive: true, force: true });
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
