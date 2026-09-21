import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, readdir, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getSessionDatabase, resetSessionDatabaseForTests } from "../../../src/session/session-database.js";
import { createFlowDocument, createFlowNodeDocument, createFlowEdgeDocument, getFlowRunDocument, listFlowApprovalsDocument } from "../../../src/session/flow-document-store.js";
import { startFlowRunDocument, resolveFlowRunApproval } from "../../../src/server/flow-runner.js";
import { registerMediaGenerationAdapter, unregisterMediaGenerationAdapter } from "../../../src/providers/media-generation.js";
import { listFlowBatchItems } from "../../../src/session/flow-batch-store.js";
import { createMockPng } from "../../../src/providers/mock-image.js";
import { upsertRuntimeWorkspace, deleteWorkspace } from "../../../src/workspace/registry.js";
import { saveFlowImages } from "../../../src/tools/flow-image-save.js";
import { installPlugin, updateActivePluginProfile, updatePluginTrustStatus, removePlugin } from "../../../src/plugins/manager.js";
import { ensurePluginRuntime, stopAllPluginRuntimes } from "../../../src/plugins/runtime/manager.js";
import { getSandboxAvailability } from "../../../src/mcp/terminal/sandbox-runner.js";
import type { McpHost } from "../../../src/mcp/mcp-host.js";
import { ImageGenerationError } from "../../../src/providers/image-generation.js";

const pluginSandbox = getSandboxAvailability();
// 插件 Worker 必须运行在 OS sandbox 中，CI runner 不具备该能力时保留为环境跳过，而不是把安全边界误报成业务回归
const pluginRuntimeTest = pluginSandbox.available ? test : test.skip;
const pluginRuntimeSkipReason: string | false = pluginSandbox.available
	? false
	: `OS sandbox is unavailable in this test environment: ${pluginSandbox.error}`;

async function fixture(operation: (directory: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "flow-recovery-"));
	const profile = process.env.USERPROFILE;
	process.env.USERPROFILE = directory;
	await resetSessionDatabaseForTests(join(directory, "sessions.sqlite"));
	try { await operation(directory); }
	finally { await stopAllPluginRuntimes(); await resetSessionDatabaseForTests(); if (profile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = profile; await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
}

async function graph(provider: string, workspaceId?: string, tail = "builtin/media-output") {
	let snapshot = await createFlowDocument({ title: "Recovery", ...(workspaceId ? { workspaceId } : {}) });
	const ids: string[] = [];
	for (const [typeId, config] of [["builtin/parameter-sets", { rows: [{ id: "a", prompt: "first" }] }], ["builtin/batch-text-to-image", { provider, model: "fixture" }], [tail, {}]] as Array<[string, Record<string, unknown>]>) {
		const before = new Set(snapshot.nodes.map(node => node.nodeId));
		snapshot = await createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, typeId, config, x: 0, y: 0 });
		ids.push(snapshot.nodes.find(node => !before.has(node.nodeId))!.nodeId);
	}
	for (const [i, sourcePort, targetPort, dataType] of [[0, "rows", "rows", "json"], [1, "images", tail === "builtin/save-images" ? "images" : "input", "image"]] as const)
		snapshot = await createFlowEdgeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, sourceNodeId: ids[i]!, sourcePort, targetNodeId: ids[i+1]!, targetPort, dataType });
	return { snapshot, ids, start: (forceNodeIds?: string[], runId?: string) => startFlowRunDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, mcpHost: {} as McpHost, ...(forceNodeIds ? { forceNodeIds } : {}), ...(runId ? { runId } : {}) }) };
}

test("unknown paid submission is retained; only an explicit force resubmits it", async () => fixture(async () => {
	let calls = 0;
	registerMediaGenerationAdapter({ provider: "fixture-uncertain", supports: ["imageGeneration"], generate: async () => { calls++; throw new Error("connection lost after sending request"); } });
	try {
		const flow = await graph("fixture-uncertain");
		const first = await flow.start();
		assert.equal((await listFlowBatchItems(first.runId, flow.ids[1]!))[0]?.status, "uncertain");
		await flow.start([flow.ids[0]!]);
		assert.equal(calls, 1, "forcing upstream must not resubmit an uncertain paid item");
		await flow.start([flow.ids[1]!]);
		assert.equal(calls, 2);
	} finally { unregisterMediaGenerationAdapter("fixture-uncertain"); }
}));

test("an unsupported request fails before submission and remains eligible for ordinary retry", async () => fixture(async () => {
	let calls = 0;
	registerMediaGenerationAdapter({ provider: "fixture-unsupported", supports: ["imageGeneration"], generate: async () => {
		calls++;
		throw new ImageGenerationError("image_generation_not_supported", "Unsupported model capability");
	} });
	try {
		const flow = await graph("fixture-unsupported");
		const first = await flow.start();
		assert.equal((await listFlowBatchItems(first.runId, flow.ids[1]!))[0]?.status, "failed");
		await flow.start();
		assert.equal(calls, 2);
	} finally { unregisterMediaGenerationAdapter("fixture-unsupported"); }
}));

test("restart resumes a known Provider Job ID without creating another request", async () => fixture(async directory => {
	let creates = 0; let failQuery = true;
	registerMediaGenerationAdapter({ provider: "fixture-recovery", supports: ["imageGeneration"], pollIntervalMs: 1,
		generate: async () => { throw new Error("must use tasks"); },
		createTask: async () => { creates++; return { providerJobId: "job-1", status: "running" }; },
		getTask: async id => { assert.equal(id, "job-1"); if (failQuery) throw new Error("temporary query outage"); return { providerJobId: id, status: "completed", result: { status: "completed", provider: "fixture-recovery", model: "fixture", artifacts: [{ bytes: createMockPng([20,40,80]), mimeType: "image/png" }] } }; },
	});
	try {
		const flow = await graph("fixture-recovery"); const first = await flow.start();
		const db = await getSessionDatabase();
		db.prepare("UPDATE flow_runs SET status='running',finished_at=NULL WHERE run_id=?").run(first.runId);
		db.prepare("UPDATE flow_node_runs SET status='running' WHERE run_id=? AND node_id=?").run(first.runId, flow.ids[1]!);
		db.prepare("UPDATE flow_node_runs SET status='queued' WHERE run_id=? AND node_id=?").run(first.runId, flow.ids[2]!);
		db.prepare("UPDATE flow_batch_items SET status='running',payload_json=json_set(payload_json,'$.status','running') WHERE run_id=?").run(first.runId);
		await resetSessionDatabaseForTests(join(directory, "sessions.sqlite"));
		assert.equal((await getFlowRunDocument(flow.snapshot.flow.flowId, first.runId)).status, "queued");
		failQuery = false;
		const resumed = await flow.start(undefined, first.runId);
		assert.equal(resumed.status, "completed", JSON.stringify(resumed.nodes));
		assert.equal(creates, 1);
		assert.equal(resumed.nodes.find(node => node.nodeId === flow.ids[1])?.batchItems?.a?.providerJobId, "job-1");
	} finally { unregisterMediaGenerationAdapter("fixture-recovery"); }
}));

test("saving images requires approval, stays within the workspace and does not duplicate a retry", async () => fixture(async directory => {
	const workspaceId = "flow-save-test";
	upsertRuntimeWorkspace({ id: workspaceId, name: "Save", kind: "workspace", rootPath: directory, icon: 0, color: 0, sourceFolders: [{ id: "primary", path: directory, capabilities: { godot: false, git: false } }], primarySourceFolderId: "primary" });
	try {
		const flow = await graph("mock", workspaceId, "builtin/save-images");
		const first = await flow.start();
		assert.equal(first.status, "waiting", JSON.stringify(first.nodes));
		const [approval] = await listFlowApprovalsDocument(first.flowId, first.runId);
		assert.ok(approval);
		const completed = await resolveFlowRunApproval({ flowId: first.flowId, runId: first.runId, approvalId: approval.approvalId, decision: "approve", mcpHost: {} as McpHost });
		assert.equal(completed.status, "completed", JSON.stringify(completed.nodes));
		const files = await readdir(join(directory, "outputs"));
		assert.equal(files.length, 1);
		assert.ok((await readFile(join(directory, "outputs", files[0]!))).length > 20);
		const item = (await listFlowBatchItems(first.runId, flow.ids[1]!))[0]!;
		const artifactId = (item.output[0] as { artifactId: string }).artifactId;
		const args = { flowId: first.flowId, saveId: "a".repeat(64), items: [{ artifactId, relativePath: "outputs/retry.png" }] };
		await saveFlowImages(args, workspaceId, `flow:${first.flowId}`);
		await saveFlowImages(args, workspaceId, `flow:${first.flowId}`);
		assert.equal((await readdir(join(directory, "outputs"))).length, 2);
		const stable = { artifactId, relativePath: "outputs/stable.png", itemKey: "b".repeat(64) };
		const partial = await saveFlowImages({ ...args, items: [stable, { artifactId, relativePath: "../outside.png", itemKey: "c".repeat(64) }] }, workspaceId, `flow:${first.flowId}`);
		assert.equal((partial.saved as unknown[]).length, 1);
		assert.equal((partial.failed as unknown[]).length, 1);
		await saveFlowImages({ ...args, items: [{ artifactId, relativePath: "outputs/repaired.png", itemKey: "c".repeat(64) }, stable] }, workspaceId, `flow:${first.flowId}`);
		assert.deepEqual((await readdir(join(directory, "outputs"))).filter(file => file.startsWith("stable")), ["stable.png"]);
		assert.equal(((await saveFlowImages({ ...args, items: [{ artifactId, relativePath: "../outside.png" }] }, workspaceId, `flow:${first.flowId}`)).failed as unknown[]).length, 1);
		await assert.rejects(saveFlowImages(args, workspaceId, "chat"));
	} finally { deleteWorkspace(workspaceId); }
}));

pluginRuntimeTest("installable grayscale plugin executes through the media proxy and disappears when disabled", { skip: pluginRuntimeSkipReason }, async () => fixture(async () => {
	const installed = await installPlugin({ type: "local", path: resolve("examples/flow-grayscale") });
	try {
		await updatePluginTrustStatus(installed.id, installed.fingerprint, "trusted");
		await updateActivePluginProfile([installed.id]);
		await ensurePluginRuntime(installed.id, { sessionId: "flow-plugin-test" });
		let snapshot = await createFlowDocument({ title: "Plugin" });
		const ids: string[] = [];
		for (const [typeId, config] of [["builtin/text-to-image", { provider: "mock", model: "mock", prompt: "red" }], ["flow-grayscale/grayscale", {}], ["builtin/media-output", {}]] as Array<[string, Record<string, unknown>]>) {
			const previous = new Set(snapshot.nodes.map(node => node.nodeId));
			snapshot = await createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, typeId, config, x: 0, y: 0 });
			ids.push(snapshot.nodes.find(node => !previous.has(node.nodeId))!.nodeId);
		}
		for (const i of [0,1]) snapshot = await createFlowEdgeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, sourceNodeId: ids[i]!, sourcePort: "image", targetNodeId: ids[i+1]!, targetPort: i === 0 ? "image" : "input", dataType: "image" });
		const run = await startFlowRunDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, mcpHost: {} as McpHost });
		assert.equal(run.status, "completed", JSON.stringify(run.nodes));
		await updateActivePluginProfile([]);
		await stopAllPluginRuntimes();
		await assert.rejects(startFlowRunDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, mcpHost: {} as McpHost }), /unavailable|unknown|missing/iu);
	} finally { await stopAllPluginRuntimes(); await removePlugin(installed.id); }
}));

test("batch → resize → composite → preview/save retains successful files when failed rows recover", async () => fixture(async directory => {
	const workspaceId = "flow-pipeline-test", provider = "fixture-pipeline";
	upsertRuntimeWorkspace({ id: workspaceId, name: "Pipeline", kind: "workspace", rootPath: directory, icon: 0, color: 0, sourceFolders: [{ id: "primary", path: directory, capabilities: { godot: false, git: false } }], primarySourceFolderId: "primary" });
	await writeFile(join(directory, "overlay.png"), createMockPng([0, 200, 40, 128], 4, 4));
	let fail = true; const calls: string[] = [];
	registerMediaGenerationAdapter({ provider, supports: ["imageGeneration"], generate: async request => {
		calls.push(request.prompt);
		if (fail && request.prompt === "second") throw Object.assign(new Error("fixture failed row"), { status: 400 });
		return { status: "completed", provider, model: "fixture", artifacts: [{ bytes: createMockPng([request.prompt === "first" ? 30 : 150, 40, 90]), mimeType: "image/png" }] };
	} });
	try {
		let snapshot = await createFlowDocument({ title: "Pipeline", workspaceId });
		const ids: string[] = [];
		for (const [typeId, config] of [
			["builtin/parameter-sets", { rows: [{ id: "a", prompt: "first" }, { id: "b", prompt: "second" }] }],
			["builtin/batch-text-to-image", { provider, model: "fixture" }],
			["builtin/image-resize", { width: 16, height: 16 }], ["builtin/image-input", { path: "overlay.png" }],
			["builtin/image-composite", { opacity: 0.5 }], ["builtin/media-output", {}], ["builtin/save-images", {}],
		] as Array<[string, Record<string, unknown>]>) {
			const before = new Set(snapshot.nodes.map(node => node.nodeId));
			snapshot = await createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, typeId, config, x: 0, y: 0 });
			ids.push(snapshot.nodes.find(node => !before.has(node.nodeId))!.nodeId);
		}
		for (const [a, sourcePort, b, targetPort, dataType] of [[0,"rows",1,"rows","json"], [1,"images",2,"image","image"], [2,"images",4,"image","image"], [3,"image",4,"overlay","image"], [4,"images",5,"input","image"], [4,"images",6,"images","image"]] as const)
			snapshot = await createFlowEdgeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, sourceNodeId: ids[a]!, sourcePort, targetNodeId: ids[b]!, targetPort, dataType });
		for (const retry of [false, true]) {
			fail = !retry;
			const waiting = await startFlowRunDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, mcpHost: {} as McpHost });
			assert.equal(waiting.status, "waiting", JSON.stringify(waiting.nodes));
			const output = waiting.nodes.find(node => node.nodeId === ids[5])!.output as { result: unknown[] };
			assert.equal(output.result.length, retry ? 2 : 1);
			const [approval] = await listFlowApprovalsDocument(waiting.flowId, waiting.runId);
			const completed = await resolveFlowRunApproval({ flowId: waiting.flowId, runId: waiting.runId, approvalId: approval!.approvalId, decision: "approve", mcpHost: {} as McpHost });
			assert.equal(completed.status, retry ? "completed" : "partial_failure", JSON.stringify(completed.nodes));
			assert.equal((await readdir(join(directory, "outputs"))).length, retry ? 2 : 1);
		}
		assert.deepEqual(calls, ["first", "second", "second"]);
		assert.equal((await getSessionDatabase()).prepare("SELECT count(*) AS n FROM sessions").get()?.n, 0);
	} finally { unregisterMediaGenerationAdapter(provider); deleteWorkspace(workspaceId); }
}));

for (const mode of ["unauthorized", "wrong-output", "missing-capability"] as const) pluginRuntimeTest(`plugin media boundary rejects ${mode}`, { skip: pluginRuntimeSkipReason }, async () => fixture(async directory => {
	const pluginPath = join(directory, "plugin");
	await cp(resolve("examples/flow-grayscale"), pluginPath, { recursive: true });
	const body = mode === "wrong-output" ? 'return { image: "invalid" };' : `return { image: await host.processImage(${mode === "unauthorized" ? '"flow-artifact-unauthorized"' : 'inputs.image.artifactId'}, { kind: "grayscale" }) };`;
	await writeFile(join(pluginPath, "index.js"), `import { definition } from "./definition.js"; export function register(api) { api.flowNodes.register(definition, async ({inputs, host}) => { ${body} }); }`);
	if (mode === "missing-capability") {
		const manifest = JSON.parse(await readFile(join(pluginPath, "package.json"), "utf8"));
		manifest.daedalus.plugin.capabilities = ["flowNodes", "flowTypedValues"];
		await writeFile(join(pluginPath, "package.json"), JSON.stringify(manifest));
	}
	const installed = await installPlugin({ type: "local", path: pluginPath });
	try {
		await updatePluginTrustStatus(installed.id, installed.fingerprint, "trusted");
		await updateActivePluginProfile([installed.id]);
		await ensurePluginRuntime(installed.id, { sessionId: "flow-plugin-boundary" });
		let snapshot = await createFlowDocument({ title: "Boundary" });
		snapshot = await createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, typeId: "builtin/text-to-image", config: { provider: "mock", model: "mock", prompt: "test" }, x: 0, y: 0 });
		const source = snapshot.nodes[0]!;
		snapshot = await createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, typeId: "flow-grayscale/grayscale", x: 0, y: 0 });
		const target = snapshot.nodes.find(node => node.nodeId !== source.nodeId)!;
		snapshot = await createFlowEdgeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, sourceNodeId: source.nodeId, sourcePort: "image", targetNodeId: target.nodeId, targetPort: "image", dataType: "image" });
		const run = await startFlowRunDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, mcpHost: {} as McpHost });
		assert.equal(run.status, "failed");
		assert.match(run.nodes.find(node => node.nodeId === target.nodeId)!.error ?? "", mode === "unauthorized" ? /unauthorized/i : mode === "wrong-output" ? /invalid value/i : /capability|unavailable|not allowed|not declared/i);
	} finally { await stopAllPluginRuntimes(); await removePlugin(installed.id); }
}));
