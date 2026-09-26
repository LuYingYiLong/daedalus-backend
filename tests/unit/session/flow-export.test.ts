import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import sharp from "sharp";
import { getDaedalusPath } from "../../../src/app-paths.js";
import { createFlowDocument, createFlowNodeDocument, createFlowEdgeDocument, updateFlowNodeDocument, commitFlowOperationsDocument, getFlowDocument, createFlowRunDocument, updateFlowRunDocument } from "../../../src/session/flow-document-store.js";
import { getSessionDatabase, resetSessionDatabaseForTests } from "../../../src/session/session-database.js";
import { auditFlowArtifacts, cleanupFlowArtifacts, exportFlowArtifacts, flowArtifactUsage, getFlowArtifact, importFlowInputArtifact, saveFlowArtifact } from "../../../src/session/flow-artifact-store.js";
import { exportFlowToSqlite } from "../../../src/session/flow-export.js";
import { importFlowFromSqlite } from "../../../src/session/flow-import.js";
import { extractFlowArchiveSlice, FLOW_ARCHIVE_HEADER_BYTES, readFlowArchiveHeader } from "../../../src/session/flow-archive-format.js";
import { clientRequestSchema } from "../../../src/protocol/schema.js";
import { startFlowRunDocument } from "../../../src/server/flow-runner.js";
import { preflightFlowRun } from "../../../src/server/flow-preflight.js";
import { getFlowRunReport, recordFlowRunEvent } from "../../../src/session/flow-run-diagnostics.js";
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
		await recordFlowRunEvent(run.runId, node.nodeId, "failed", { attempt: 2, prompt: "private prompt", apiKey: "private key" });
		const report = await getFlowRunReport(flow.flow.flowId, run.runId);
		assert.deepEqual(report.nodes.find(item => item.nodeId === node.nodeId)?.events[0]?.details, { attempt: 2 });
		assert.equal(JSON.stringify(report).includes("private"), false);
		assert.equal(JSON.stringify((await getSessionDatabase()).prepare("SELECT payload_json FROM flow_node_run_events WHERE run_id=?").get(run.runId)).includes("private"), false);
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
		const destination = join(profile, "exports", "flow.daedalus-flow");
		const result = await exportFlowToSqlite(flow.flow.flowId, destination);
		assert.equal(result.embeddedFileCount, 1);
		assert.equal(result.missingFileCount, 0);
		const archive = await open(destination, "r");
		const manifestBytes = await readFlowArchiveHeader(archive, (await archive.stat()).size);
		const manifestPath = join(profile, "export-manifest.sqlite");
		await extractFlowArchiveSlice(archive, FLOW_ARCHIVE_HEADER_BYTES, manifestBytes, manifestPath);
		await archive.close();
		const exported = new DatabaseSync(manifestPath, { readOnly: true });
		try {
			assert.equal(exported.prepare("SELECT count(*) AS n FROM flow_documents").get()?.n, 1);
			assert.equal(exported.prepare("SELECT * FROM flow_documents WHERE flow_id = ?").get(other.flow.flowId), undefined);
			assert.equal(exported.prepare("SELECT * FROM flow_nodes WHERE node_id = ?").get(node.nodeId)?.collapsed, 1);
			assert.deepEqual({ ...exported.prepare("SELECT group_id, flow_id, parent_group_id, title, color, x, y, width, height FROM flow_groups").get() }, { group_id: "group-export", flow_id: flow.flow.flowId, parent_group_id: null, title: "Exported group", color: "#5577aa", x: 120, y: -100, width: 600, height: 520 });
			assert.deepEqual({ ...exported.prepare("SELECT node_id, group_id FROM flow_group_nodes").get() }, { node_id: node.nodeId, group_id: "group-export" });
			assert.deepEqual(exported.prepare("SELECT * FROM flow_edges ORDER BY edge_id").all(), (await getSessionDatabase()).prepare("SELECT * FROM flow_edges WHERE flow_id = ? ORDER BY edge_id").all(flow.flow.flowId));
			assert.equal(exported.prepare("SELECT format_version FROM daedalus_flow_export_metadata").get()?.format_version, 3);
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
		const legacyExport = join(importProfile, "legacy-flow.sqlite");
		await writeFile(legacyExport, await readFile(manifestPath));
		await assert.rejects(importFlowFromSqlite(legacyExport), /Unsupported Flow archive format/i);
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

test("cancelling Flow archive transfer preserves the prior export and rolls back imported media", async () => {
	const profile = await mkdtemp(join(tmpdir(), "flow-cancel-source-"));
	const importProfile = await mkdtemp(join(tmpdir(), "flow-cancel-target-"));
	const previous = process.env.USERPROFILE;
	try {
		process.env.USERPROFILE = profile;
		await resetSessionDatabaseForTests(join(profile, "sessions.sqlite"));
		const flow = await createFlowDocument({ title: "Cancel", starterGraph: {} });
		await saveFlowArtifact({ flowId: flow.flow.flowId, nodeId: flow.nodes[0]!.nodeId, bytes: Buffer.alloc(16 * 1024 * 1024, 1), mimeType: "image/png" });
		const destination = join(profile, "cancel.daedalus-flow");
		await exportFlowToSqlite(flow.flow.flowId, destination);
		const original = await readFile(destination);
		const exportController = new AbortController();
		let exportChecks = 0;
		const exportThrow = exportController.signal.throwIfAborted.bind(exportController.signal);
		Object.defineProperty(exportController.signal, "throwIfAborted", { value: (): void => { if (++exportChecks === 10) exportController.abort(); exportThrow(); } });
		await assert.rejects(exportFlowToSqlite(flow.flow.flowId, destination, { signal: exportController.signal }), { name: "AbortError" });
		assert.deepEqual(await readFile(destination), original);
		assert.equal((await readdir(profile)).some(name => name.endsWith(".staging") || name.endsWith(".manifest")), false);

		await resetSessionDatabaseForTests();
		process.env.USERPROFILE = importProfile;
		await resetSessionDatabaseForTests(join(importProfile, "sessions.sqlite"));
		const importController = new AbortController();
		let importChecks = 0;
		const importThrow = importController.signal.throwIfAborted.bind(importController.signal);
		Object.defineProperty(importController.signal, "throwIfAborted", { value: (): void => { if (++importChecks === 8) importController.abort(); importThrow(); } });
		await assert.rejects(importFlowFromSqlite(destination, { signal: importController.signal }), { name: "AbortError" });
		assert.equal((await getSessionDatabase()).prepare("SELECT 1 FROM flow_documents WHERE flow_id=?").get(flow.flow.flowId), undefined);
		const artifactRoot = getDaedalusPath("flow.artifacts.root");
		assert.deepEqual(await readdir(artifactRoot), []);
	} finally {
		await resetSessionDatabaseForTests();
		if (previous === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previous;
		await rm(profile, { recursive: true, force: true });
		await rm(importProfile, { recursive: true, force: true });
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
		const selection = { entryNodeIds: [node.nodeId], targetNodeIds: [output.nodeId] };
		assert.deepEqual((await preflightFlowRun({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, selection, requireOutputTargets: true })).blockers, []);
		const savedInput = await readFile(join(getDaedalusPath("flow.artifacts.root"), ref.storagePath));
		await writeFile(join(getDaedalusPath("flow.artifacts.root"), ref.storagePath), Buffer.alloc(savedInput.length, 0));
		assert.equal((await preflightFlowRun({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, selection, requireOutputTargets: true })).blockers[0]?.code, "flow_artifact_checksum_mismatch");
		await writeFile(join(getDaedalusPath("flow.artifacts.root"), ref.storagePath), savedInput);
		const destination = join(profile, "shared-flow.daedalus-flow");
		assert.equal((await exportFlowToSqlite(snapshot.flow.flowId, destination)).embeddedFileCount, 1);
		await resetSessionDatabaseForTests();
		process.env.USERPROFILE = importedProfile;
		await resetSessionDatabaseForTests(join(importedProfile, "sessions.sqlite"));
		await importFlowFromSqlite(destination);
		const restored = await getFlowDocument(snapshot.flow.flowId);
		assert.deepEqual(restored.nodes.find((item) => item.nodeId === node.nodeId)?.config.defaultValue, ref);
		assert.deepEqual((await getFlowArtifact(ref.artifactId)).ref, ref);
		const run = await startFlowRunDocument({ flowId: snapshot.flow.flowId, revision: restored.flow.graphRevision, ...selection, mcpHost: {} as McpHost });
		assert.equal(run.status, "completed", JSON.stringify(run.nodes));
		assert.equal(run.nodes.some((item) => item.typeId === "builtin/llm"), false);
		assert.deepEqual(run.nodes.find((item) => item.nodeId === output.nodeId)?.output, { result: ref });
		const archive = await open(destination, "r+");
		try {
			const manifestBytes = await readFlowArchiveHeader(archive, (await archive.stat()).size);
			await archive.write(Buffer.from("corrupt"), 0, 7, FLOW_ARCHIVE_HEADER_BYTES + manifestBytes);
		} finally { await archive.close(); }
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

test("artifact audit reports damage and cleanup requires a reviewed run plan", async () => {
	const profile = await mkdtemp(join(tmpdir(), "flow-artifact-audit-"));
	const previous = process.env.USERPROFILE;
	process.env.USERPROFILE = profile;
	try {
		const flow = await createFlowDocument({ title: "Storage", starterGraph: {} });
		const nodeId = flow.nodes[0]!.nodeId;
		const run = await createFlowRunDocument(flow.flow.flowId, flow.flow.graphRevision, [nodeId]);
		await updateFlowRunDocument(flow.flow.flowId, run.runId, { status: "completed", finishedAt: new Date().toISOString() });
		const historical = await saveFlowArtifact({ flowId: flow.flow.flowId, runId: run.runId, nodeId, bytes: Buffer.from("historical"), mimeType: "application/octet-stream" });
		const input = await saveFlowArtifact({ flowId: flow.flow.flowId, nodeId, bytes: Buffer.from("shared-input"), mimeType: "application/octet-stream" });
		assert.equal((await flowArtifactUsage(flow.flow.flowId)).byteSize, historical.byteSize + input.byteSize);
		const preview = await cleanupFlowArtifacts({ flowId: flow.flow.flowId, runIds: [run.runId], dryRun: true });
		assert.deepEqual(preview.artifacts.map(artifact => artifact.artifactId), [historical.artifactId]);
		assert.equal((await getFlowArtifact(historical.artifactId)).ref.artifactId, historical.artifactId);
		await assert.rejects(cleanupFlowArtifacts({ flowId: flow.flow.flowId, runIds: [run.runId], dryRun: false, expectedArtifactIds: [] }), /preview changed/i);
		const removed = await cleanupFlowArtifacts({ flowId: flow.flow.flowId, runIds: [run.runId], dryRun: false, expectedArtifactIds: [historical.artifactId] });
		assert.equal(removed.removed, 1);
		await assert.rejects(getFlowArtifact(historical.artifactId), /not found/i);
		assert.equal((await getFlowArtifact(input.artifactId)).ref.artifactId, input.artifactId);
		await writeFile(`${join(getDaedalusPath("flow.artifacts.root"), input.storagePath)}.interrupted.staging`, "partial");
		assert.equal((await auditFlowArtifacts(flow.flow.flowId)).stagingFiles, 1);
		await writeFile(join(getDaedalusPath("flow.artifacts.root"), input.storagePath), "shared-outpt");
		assert.deepEqual((await auditFlowArtifacts(flow.flow.flowId)).issues.map(issue => issue.code), ["checksum_mismatch"]);
	} finally {
		await resetSessionDatabaseForTests();
		if (previous === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previous;
		await rm(profile, { recursive: true, force: true });
	}
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
