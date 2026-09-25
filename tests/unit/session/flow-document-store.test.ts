import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { McpHost } from "../../../src/mcp/mcp-host.js";
import type { FlowDocumentNode } from "../../../src/protocol/types.js";
import { registerFlowNodeExecutor, unregisterPluginFlowNodeExecutors } from "../../../src/server/flow-node-executor-registry.js";
import { startFlowRunDocument } from "../../../src/server/flow-runner.js";
import {
	listFlowNodeTypeDefinitions,
	normalizeFlowNodeConfig,
	registerFlowNodeDefinition,
	resolveFlowNodePorts,
	unregisterPluginFlowNodeDefinitions,
} from "../../../src/server/flow-node-registry.js";
import {
	createConnectedFlowNodeDocument,
	commitFlowOperationsDocument,
	createFlowDocument,
	createFlowEdgeDocument,
	createFlowNodeDocument,
	createFlowRunDocument,
	getFlowDocument,
	moveFlowWorkspaceDocument,
	updateFlowRunDocument,
	updateFlowNodeRunDocument,
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
	const definitions = listFlowNodeTypeDefinitions(true);
	assert.deepEqual(definitions.map((definition): string => definition.typeId), ["builtin/batch-image-to-image", "builtin/batch-text-to-image", "builtin/boolean", "builtin/color", "builtin/image-composite", "builtin/image-convert", "builtin/image-crop", "builtin/image-input", "builtin/image-resize", "builtin/image-rotate", "builtin/list", "builtin/list-item", "builtin/list-merge", "builtin/number", "builtin/parameter-sets", "builtin/save-images", "builtin/save-videos", "builtin/size", "builtin/text-replace", "builtin/to-text", "builtin/command", "builtin/condition", "builtin/file-input", "builtin/flow-input", "builtin/image-to-image", "builtin/image-to-video", "builtin/json-extract", "builtin/llm", "builtin/media-output", "builtin/merge", "builtin/note", "builtin/output", "builtin/system-prompt", "builtin/template", "builtin/text", "builtin/text-to-image", "builtin/text-to-video", "builtin/tool", "builtin/user-prompt"].sort((a,b) => a.localeCompare(b)));
	const llmProperties = definitions.find((definition): boolean => definition.typeId === "builtin/llm")?.configSchema.properties as Record<string, Record<string, unknown>>;
	assert.equal(llmProperties.provider?.["x-daedalus-control"], "provider");
	assert.equal(llmProperties.model?.["x-daedalus-control"], "model");
	assert.equal(llmProperties.reasoningEffort?.["x-daedalus-control"], "reasoning-effort");
	const fileInputProperties = definitions.find((definition): boolean => definition.typeId === "builtin/file-input")?.configSchema.properties as Record<string, Record<string, unknown>>;
	assert.equal(fileInputProperties.path?.["x-daedalus-control"], "workspace-file");
	assert.equal(fileInputProperties.path?.["x-daedalus-preview"], undefined);
	const imageInputProperties = definitions.find((definition): boolean => definition.typeId === "builtin/image-input")?.configSchema.properties as Record<string, Record<string, unknown>>;
	assert.equal(imageInputProperties.path?.["x-daedalus-control"], "workspace-file");
	assert.equal(imageInputProperties.path?.["x-daedalus-file-kind"], "image");
	assert.equal(imageInputProperties.path?.["x-daedalus-preview"], "image");
	for (const typeId of ["builtin/text-to-video", "builtin/image-to-video"]) {
		const properties = definitions.find((definition): boolean => definition.typeId === typeId)?.configSchema.properties as Record<string, Record<string, unknown>>;
		assert.equal(properties.durationMs?.["x-daedalus-unit"], "ms");
		assert.equal(properties.width?.["x-daedalus-unit"], "px");
		assert.equal(properties.height?.["x-daedalus-unit"], "px");
		assert.equal(properties.fps?.["x-daedalus-unit"], "fps");
	}
	const saveVideos = definitions.find((definition): boolean => definition.typeId === "builtin/save-videos")!;
	assert.equal(saveVideos.category, "workspace-media");
	const saveVideosInput = saveVideos.parameters.find((parameter): boolean => parameter.id === "videos");
	assert.equal(saveVideosInput?.mode, "connection");
	if (saveVideosInput?.mode === "connection") assert.deepEqual(saveVideosInput.dataTypes, ["video"]);
	const llm = definitions.find((definition): boolean => definition.typeId === "builtin/llm")!;
	assert.equal(definitions.find((definition): boolean => definition.typeId === "builtin/text")?.category, "parameters");
	for (const [typeId, ids] of [
		["builtin/text-to-image", ["prompt", "negativePrompt", "seed", "count"]],
		["builtin/image-to-image", ["prompt", "negativePrompt", "seed", "count"]],
		["builtin/text-to-video", ["prompt", "negativePrompt", "width", "height", "durationMs", "fps", "seed", "count"]],
		["builtin/image-to-video", ["prompt", "negativePrompt", "width", "height", "durationMs", "fps", "seed", "count"]],
	] as const) {
		const definition = definitions.find((candidate): boolean => candidate.typeId === typeId)!;
		for (const id of ids) assert.equal(definition.parameters.find((parameter): boolean => parameter.id === id)?.mode, "hybrid", `${typeId}.${id} should accept a connected value`);
		assert.equal(definition.parameters.find((parameter): boolean => parameter.id === "provider")?.mode, "fixed");
		assert.equal(definition.parameters.find((parameter): boolean => parameter.id === "model")?.mode, "fixed");
	}
	assert.deepEqual(llm.parameters.map((parameter) => ({ id: parameter.id, mode: parameter.mode })), [
		{ id: "user-prompt", mode: "hybrid" },
		{ id: "system-prompt", mode: "hybrid" },
		{ id: "provider", mode: "fixed" },
		{ id: "model", mode: "fixed" },
		{ id: "reasoningEffort", mode: "fixed" },
	]);
	assert.deepEqual(llm.outputs.map((output): string => output.id), ["output"]);
	assert.equal("ports" in llm, false);
	const llmPorts = resolveFlowNodePorts({ typeId: "builtin/llm", config: llm.defaultConfig, ports: [] });
	assert.deepEqual(llmPorts.map((port): [string, string] => [port.direction, port.id]), [
		["input", "user-prompt"],
		["input", "system-prompt"],
		["output", "output"],
	]);
	assert.throws((): Record<string, unknown> => normalizeFlowNodeConfig("builtin/command", { commandLine: "echo ok", unexpected: true }), /unrecognized/i);
	assert.equal(normalizeFlowNodeConfig("builtin/command", { commandLine: "echo ok" }).timeoutMs, 30_000);
	assert.deepEqual(normalizeFlowNodeConfig("builtin/flow-input", { label: "Input", dataType: "text", defaultValue: "", required: false }), { label: "Input", dataType: "text", defaultValue: "" });
});

test("Flow creation can atomically seed User and System Prompt nodes into LLM and Output", async (): Promise<void> => withDatabase(async (): Promise<void> => {
	const created = await createFlowDocument({
		title: "Starter",
		workspaceId: "workspace-a",
		approvalMode: "auto-safe",
		starterGraph: {
			provider: "deepseek",
			model: "deepseek-chat",
			reasoningEffort: "high",
		},
	});
	assert.equal(created.flow.workspaceId, "workspace-a");
	assert.equal(created.flow.approvalMode, "auto-safe");
	assert.equal(created.nodes.length, 5);
	assert.equal(created.edges.length, 4);
	const flowInput = created.nodes.find((node): boolean => node.typeId === "builtin/flow-input")!;
	const userPrompt = created.nodes.find((node): boolean => node.typeId === "builtin/user-prompt")!;
	const systemPrompt = created.nodes.find((node): boolean => node.typeId === "builtin/system-prompt")!;
	const llm = created.nodes.find((node): boolean => node.typeId === "builtin/llm")!;
	const output = created.nodes.find((node): boolean => node.typeId === "builtin/output")!;
	assert.deepEqual(llm.config, {
		provider: "deepseek",
		model: "deepseek-chat",
		reasoningEffort: "high",
		userPrompt: "",
		systemPrompt: "",
	});
	assert.equal(userPrompt.y, -120);
	assert.equal(systemPrompt.y, 120);
	const expectedEdges: Array<[string, string, string, string]> = [
		[flowInput.nodeId, "output", userPrompt.nodeId, "input"],
		[userPrompt.nodeId, "output", llm.nodeId, "user-prompt"],
		[systemPrompt.nodeId, "output", llm.nodeId, "system-prompt"],
		[llm.nodeId, "output", output.nodeId, "input"],
	];
	assert.deepEqual(
		created.edges
			.map((edge): [string, string, string, string] => [edge.sourceNodeId, edge.sourcePort, edge.targetNodeId, edge.targetPort])
			.sort((left, right): number => left[0].localeCompare(right[0])),
		expectedEdges.sort((left, right): number => left[0].localeCompare(right[0])),
	);
}));

test("Flow workspace moves persist ownership and reject stale revisions", async (): Promise<void> => withDatabase(async (): Promise<void> => {
	const created = await createFlowDocument({ title: "Move me", workspaceId: "workspace-a" });
	const moved = await moveFlowWorkspaceDocument(created.flow.flowId, "workspace-b", created.flow.revision);
	assert.equal(moved.workspaceId, "workspace-b");
	assert.equal(moved.revision, created.flow.revision + 1);
	await assert.rejects(
		moveFlowWorkspaceDocument(created.flow.flowId, null, created.flow.revision),
		{ code: "flow_revision_conflict" },
	);
	const unbound = await moveFlowWorkspaceDocument(created.flow.flowId, null, moved.revision);
	assert.equal(unbound.workspaceId, null);
}));

test("Flow graph and layout revisions advance independently", async (): Promise<void> => withDatabase(async (): Promise<void> => {
	const created = await createFlowDocument({ title: "Revisions" });
	const withNode = await createFlowNodeDocument({ flowId: created.flow.flowId, revision: created.flow.graphRevision, typeId: "builtin/text", x: 10, y: 20, config: { text: "hello" } });
	assert.equal(withNode.flow.graphRevision, created.flow.graphRevision + 1);
	assert.equal(withNode.flow.layoutRevision, created.flow.layoutRevision);
	const moved = await updateFlowNodeDocument({ flowId: created.flow.flowId, nodeId: withNode.nodes[0]!.nodeId, revision: withNode.flow.layoutRevision, patch: { x: 80, y: 90 } });
	assert.equal(moved.flow.graphRevision, withNode.flow.graphRevision);
	assert.equal(moved.flow.layoutRevision, withNode.flow.layoutRevision + 1);
	const viewport = await updateFlowViewportDocument({ flowId: created.flow.flowId, revision: moved.flow.layoutRevision, viewport: { x: 20, y: 30, zoom: 1.2 } });
	assert.equal(viewport.graphRevision, moved.flow.graphRevision);
	assert.equal(viewport.layoutRevision, moved.flow.layoutRevision + 1);
}));

test("Flow patch batches are idempotent and layout operations use last-write-wins", async (): Promise<void> => withDatabase(async (): Promise<void> => {
	const created = await createFlowDocument({ title: "Patch log" });
	const createNode = {
		mutationId: "mutation-create",
		kind: "node.create" as const,
		baseGraphRevision: created.flow.graphRevision,
		payload: { nodeId: "node-patch", typeId: "builtin/text", x: 0, y: 0, config: { text: "hello" } },
	};
	const viewport = {
		mutationId: "mutation-viewport",
		kind: "viewport.update" as const,
		baseLayoutRevision: created.flow.layoutRevision,
		payload: { x: 10, y: 20, zoom: 1.25 },
	};
	const first = await commitFlowOperationsDocument({ flowId: created.flow.flowId, clientId: "studio-test", operations: [createNode, viewport] });
	assert.equal(first.graphRevision, created.flow.graphRevision + 1);
	assert.equal(first.layoutRevision, created.flow.layoutRevision + 1);
	const replayed = await commitFlowOperationsDocument({ flowId: created.flow.flowId, clientId: "studio-test", operations: [createNode, viewport] });
	assert.equal(replayed.graphRevision, first.graphRevision);
	assert.equal(replayed.layoutRevision, first.layoutRevision);

	const moves = Array.from({ length: 100 }, (_, index) => ({
		mutationId: `mutation-move-${index}`,
		kind: "node.move" as const,
		baseLayoutRevision: created.flow.layoutRevision,
		payload: { nodeId: "node-patch", x: index, y: index * 2 },
	}));
	const moved = await commitFlowOperationsDocument({ flowId: created.flow.flowId, clientId: "studio-test", operations: moves });
	assert.equal(moved.layoutRevision, first.layoutRevision + 1);
	const snapshot = await getFlowDocument(created.flow.flowId);
	assert.deepEqual({ x: snapshot.nodes[0]!.x, y: snapshot.nodes[0]!.y }, { x: 99, y: 198 });
	const delayedReplay = await commitFlowOperationsDocument({ flowId: created.flow.flowId, clientId: "studio-test", operations: [createNode, viewport] });
	assert.equal(delayedReplay.graphRevision, first.graphRevision);
	assert.equal(delayedReplay.layoutRevision, first.layoutRevision);
	await assert.rejects(commitFlowOperationsDocument({
		flowId: created.flow.flowId,
		clientId: "studio-test",
		operations: [{ ...createNode, payload: { ...createNode.payload, title: "reused mutation" } }],
	}), { code: "flow_mutation_conflict" });
	await assert.rejects(commitFlowOperationsDocument({
		flowId: created.flow.flowId,
		clientId: "another-client",
		operations: [createNode],
	}), { code: "flow_mutation_conflict" });
	await assert.rejects(commitFlowOperationsDocument({
		flowId: created.flow.flowId,
		clientId: "studio-test",
		operations: [{ mutationId: "mutation-stale", kind: "node.update", baseGraphRevision: created.flow.graphRevision, payload: { nodeId: "node-patch", title: "stale" } }],
	}), { code: "flow_revision_conflict" });
}));

test("Flow groups persist nested membership and dissolve one level without deleting nodes", async (): Promise<void> => withDatabase(async (): Promise<void> => {
	let snapshot = await createFlowDocument({ title: "Nested groups" });
	snapshot = await createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, typeId: "builtin/text", x: 40, y: 80, config: { text: "one" } });
	const firstNodeId = snapshot.nodes[0]!.nodeId;
	snapshot = await createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, typeId: "builtin/text", x: 420, y: 160, config: { text: "two" } });
	const secondNodeId = snapshot.nodes.find((node): boolean => node.nodeId !== firstNodeId)!.nodeId;
	const outerId = "group-outer";
	const innerId = "group-inner";
	const ack = await commitFlowOperationsDocument({
		flowId: snapshot.flow.flowId,
		clientId: "studio-groups",
		operations: [
			{ mutationId: "group-outer-create", kind: "group.create", payload: { groupId: outerId, title: "Outer", color: "#5577aa", parentGroupId: null, x: 0, y: 0, width: 800, height: 500 } },
			{ mutationId: "group-outer-members", kind: "group.reparent", payload: { nodes: [{ nodeId: firstNodeId, groupId: outerId }, { nodeId: secondNodeId, groupId: outerId }], groups: [] } },
			{ mutationId: "group-inner-create", kind: "group.create", payload: { groupId: innerId, title: "Inner", color: "#44aa88", parentGroupId: outerId, x: 20, y: 20, width: 340, height: 260 } },
			{ mutationId: "group-inner-members", kind: "group.reparent", payload: { nodes: [{ nodeId: firstNodeId, groupId: innerId }], groups: [] } },
		],
	});
	assert.equal(ack.graphRevision, snapshot.flow.graphRevision);
	assert.equal(ack.layoutRevision, snapshot.flow.layoutRevision + 1);
	let grouped = await getFlowDocument(snapshot.flow.flowId);
	assert.deepEqual(grouped.groups.find((group): boolean => group.groupId === outerId)?.nodeIds, [secondNodeId]);
	assert.deepEqual(grouped.groups.find((group): boolean => group.groupId === innerId)?.nodeIds, [firstNodeId]);
	assert.equal(grouped.groups.find((group): boolean => group.groupId === innerId)?.parentGroupId, outerId);
	await commitFlowOperationsDocument({
		flowId: snapshot.flow.flowId,
		clientId: "studio-groups",
		operations: [
			{ mutationId: "group-inner-rename", kind: "group.rename", payload: { groupId: innerId, title: "Renamed inner" } },
			{ mutationId: "group-inner-move", kind: "group.move", payload: { groupId: innerId, x: 60, y: 90 } },
		],
	});
	grouped = await getFlowDocument(snapshot.flow.flowId);
	assert.equal(grouped.groups.find((group): boolean => group.groupId === innerId)?.title, "Renamed inner");
	assert.deepEqual(
		{ x: grouped.groups.find((group): boolean => group.groupId === innerId)?.x, y: grouped.groups.find((group): boolean => group.groupId === innerId)?.y },
		{ x: 60, y: 90 },
	);
	await assert.rejects(commitFlowOperationsDocument({
		flowId: snapshot.flow.flowId,
		clientId: "studio-groups",
		operations: [{ mutationId: "group-cycle", kind: "group.reparent", payload: { nodes: [], groups: [{ groupId: outerId, parentGroupId: innerId }] } }],
	}), { code: "flow_group_cycle" });
	await commitFlowOperationsDocument({
		flowId: snapshot.flow.flowId,
		clientId: "studio-groups",
		operations: [{ mutationId: "group-inner-dissolve", kind: "group.dissolve", payload: { groupId: innerId } }],
	});
	grouped = await getFlowDocument(snapshot.flow.flowId);
	assert.equal(grouped.groups.some((group): boolean => group.groupId === innerId), false);
	assert.deepEqual(grouped.groups.find((group): boolean => group.groupId === outerId)?.nodeIds.sort(), [firstNodeId, secondNodeId].sort());
	await commitFlowOperationsDocument({
		flowId: snapshot.flow.flowId,
		clientId: "studio-groups",
		operations: [{ mutationId: "group-outer-dissolve", kind: "group.dissolve", payload: { groupId: outerId } }],
	});
	const dissolved = await getFlowDocument(snapshot.flow.flowId);
	assert.equal(dissolved.groups.length, 0);
	assert.equal(dissolved.nodes.length, snapshot.nodes.length);
}));

test("createConnected is atomic and replaces a single-input edge", async (): Promise<void> => withDatabase(async (): Promise<void> => {
	let snapshot = await createFlowDocument({ title: "Atomic" });
	snapshot = await createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, typeId: "builtin/text", x: 0, y: 0, config: { text: "first" } });
	const firstNodeId = snapshot.nodes[0]!.nodeId;
	const connected = await createConnectedFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, typeId: "builtin/output", x: 300, y: 0, connection: { direction: "from_existing", existingNodeId: firstNodeId, existingPort: "output", newPort: "input", dataType: "text" } });
	assert.equal(connected.snapshot.nodes.length, 2);
	assert.equal(connected.snapshot.edges.length, 1);
	await assert.rejects(createConnectedFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: connected.snapshot.flow.graphRevision, typeId: "builtin/note", x: 500, y: 0, connection: { direction: "from_existing", existingNodeId: firstNodeId, existingPort: "output", newPort: "input", dataType: "text" } }), { code: "flow_port_incompatible" });
	assert.equal((await getFlowDocument(snapshot.flow.flowId)).nodes.length, 2);
	let next = await createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: connected.snapshot.flow.graphRevision, typeId: "builtin/text", x: 0, y: 200, config: { text: "second" } });
	const secondNodeId = next.nodes.find((node): boolean => node.nodeId !== firstNodeId && node.typeId === "builtin/text")!.nodeId;
	next = await createFlowEdgeDocument({ flowId: snapshot.flow.flowId, revision: next.flow.graphRevision, sourceNodeId: secondNodeId, sourcePort: "output", targetNodeId: connected.nodeId, targetPort: "input", dataType: "text" });
	assert.equal(next.edges.length, 1);
	assert.equal(next.edges[0]!.sourceNodeId, secondNodeId);
}));

test("Flow patch can reconnect an edge with one atomic delete-create batch", async (): Promise<void> => withDatabase(async (): Promise<void> => {
	let snapshot = await createFlowDocument({
		title: "Reconnect",
		starterGraph: { provider: "deepseek", model: "deepseek-chat", reasoningEffort: "high" },
	});
	snapshot = await createFlowNodeDocument({
		flowId: snapshot.flow.flowId,
		revision: snapshot.flow.graphRevision,
		typeId: "builtin/text",
		x: 0,
		y: 240,
		config: { text: "replacement" },
	});
	const source = snapshot.nodes.find((node): boolean => node.typeId === "builtin/text")!;
	const output = snapshot.nodes.find((node): boolean => node.typeId === "builtin/output")!;
	const edge = snapshot.edges.find((candidate): boolean => candidate.targetNodeId === output.nodeId)!;
	const committed = await commitFlowOperationsDocument({
		flowId: snapshot.flow.flowId,
		clientId: "studio-reconnect",
		operations: [
			{
				mutationId: "mutation-reconnect-delete",
				kind: "edge.delete",
				baseGraphRevision: snapshot.flow.graphRevision,
				payload: { edgeId: edge.edgeId },
			},
			{
				mutationId: "mutation-reconnect-create",
				kind: "edge.create",
				baseGraphRevision: snapshot.flow.graphRevision,
				payload: {
					edgeId: edge.edgeId,
					sourceNodeId: source.nodeId,
					sourcePort: "output",
					targetNodeId: output.nodeId,
					targetPort: "input",
					dataType: "text",
				},
			},
		],
	});
	assert.equal(committed.graphRevision, snapshot.flow.graphRevision + 1);
	const reloaded = await getFlowDocument(snapshot.flow.flowId);
	const reconnected = reloaded.edges.find((candidate): boolean => candidate.edgeId === edge.edgeId)!;
	assert.equal(reconnected.sourceNodeId, source.nodeId);
	assert.equal(reconnected.targetNodeId, output.nodeId);
}));

test("Flow runner passes values by port and caches pure nodes", async (): Promise<void> => withDatabase(async (): Promise<void> => {
	let snapshot = await createFlowDocument({ title: "Run" });
	snapshot = await createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, typeId: "builtin/text", x: 0, y: 0, config: { text: "hello" } });
	const textNode = snapshot.nodes[0]!;
	snapshot = await createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, typeId: "builtin/template", x: 320, y: 0, config: { template: "{{input}} world", inputs: [{ id: "input", label: "Input", dataType: "text" }] } });
	const templateNode = snapshot.nodes.find((node): boolean => node.typeId === "builtin/template")!;
	snapshot = await createFlowEdgeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, sourceNodeId: textNode.nodeId, sourcePort: "output", targetNodeId: templateNode.nodeId, targetPort: "input", dataType: "text" });
	const nodeStates: Array<{ nodeId: string; output: unknown }> = [];
	const first = await startFlowRunDocument({
		flowId: snapshot.flow.flowId,
		revision: snapshot.flow.graphRevision,
		mcpHost: {} as McpHost,
		onNodeState: (run, nodeId): void => {
			nodeStates.push({ nodeId, output: run.nodes.find((node): boolean => node.nodeId === nodeId)?.output });
		},
	});
	assert.equal(first.status, "completed");
	assert.deepEqual(first.nodes.find((node): boolean => node.nodeId === templateNode.nodeId)?.output, { output: "hello world" });
	assert.deepEqual(nodeStates.findLast((state): boolean => state.nodeId === templateNode.nodeId)?.output, { output: "hello world" });
	const cachedNodeStates: Array<{ nodeId: string; status: string | undefined }> = [];
	const second = await startFlowRunDocument({
		flowId: snapshot.flow.flowId,
		revision: snapshot.flow.graphRevision,
		mcpHost: {} as McpHost,
		onNodeState: (run, nodeId): void => {
			cachedNodeStates.push({ nodeId, status: run.nodes.find((node): boolean => node.nodeId === nodeId)?.status });
		},
	});
	assert.equal(second.nodes.find((node): boolean => node.nodeId === templateNode.nodeId)?.status, "cached");
	assert.equal(cachedNodeStates.findLast((state): boolean => state.nodeId === templateNode.nodeId)?.status, "cached");
	const repeated = await startFlowRunDocument({
		flowId: snapshot.flow.flowId,
		revision: snapshot.flow.graphRevision,
		mcpHost: {} as McpHost,
		forceNodeIds: [textNode.nodeId],
	});
	assert.equal(repeated.status, "completed");
	assert.equal(repeated.nodes.find((node): boolean => node.nodeId === textNode.nodeId)?.status, "completed");
	assert.equal(repeated.nodes.find((node): boolean => node.nodeId === templateNode.nodeId)?.status, "completed");
	const cachedAfterForce = await startFlowRunDocument({
		flowId: snapshot.flow.flowId,
		revision: snapshot.flow.graphRevision,
		mcpHost: {} as McpHost,
	});
	assert.equal(cachedAfterForce.nodes.find((node): boolean => node.nodeId === textNode.nodeId)?.status, "cached");
	assert.equal(cachedAfterForce.nodes.find((node): boolean => node.nodeId === templateNode.nodeId)?.status, "cached");
	const rerunSelected = await startFlowRunDocument({
		flowId: snapshot.flow.flowId,
		revision: snapshot.flow.graphRevision,
		mcpHost: {} as McpHost,
		forceAllSelected: true,
	});
	assert.equal(rerunSelected.nodes.find((node): boolean => node.nodeId === textNode.nodeId)?.status, "completed");
	assert.equal(rerunSelected.nodes.find((node): boolean => node.nodeId === templateNode.nodeId)?.status, "completed");
	const cachedAfterSelectedRerun = await startFlowRunDocument({
		flowId: snapshot.flow.flowId,
		revision: snapshot.flow.graphRevision,
		mcpHost: {} as McpHost,
	});
	assert.equal(cachedAfterSelectedRerun.nodes.find((node): boolean => node.nodeId === textNode.nodeId)?.status, "cached");
	assert.equal(cachedAfterSelectedRerun.nodes.find((node): boolean => node.nodeId === templateNode.nodeId)?.status, "cached");
	}));

test("Flow runner starts same-name entries together and excludes unrelated entry branches", async (): Promise<void> => withDatabase(async (): Promise<void> => {
	let snapshot = await createFlowDocument({ title: "Entry run" });
	const addEntryBranch = async (label: string, value: string, y: number): Promise<{ input: FlowDocumentNode; output: FlowDocumentNode }> => {
		snapshot = await createFlowNodeDocument({
			flowId: snapshot.flow.flowId,
			revision: snapshot.flow.graphRevision,
			typeId: "builtin/flow-input",
			x: 0,
			y,
			config: { label, dataType: "text", defaultValue: value },
		});
		const input = snapshot.nodes.find((node): boolean => node.typeId === "builtin/flow-input" && node.config.defaultValue === value)!;
		snapshot = await createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, typeId: "builtin/output", x: 320, y, config: { format: "text" } });
		const output = snapshot.nodes.find((node): boolean => node.typeId === "builtin/output" && !snapshot.edges.some((edge): boolean => edge.targetNodeId === node.nodeId))!;
		snapshot = await createFlowEdgeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, sourceNodeId: input.nodeId, sourcePort: "output", targetNodeId: output.nodeId, targetPort: "input", dataType: "text" });
		return { input, output };
	};
	const first = await addEntryBranch("Generate", "alpha", 0);
	const second = await addEntryBranch("Generate", "beta", 200);
	const unrelated = await addEntryBranch("Preview", "ignored", 400);

	const run = await startFlowRunDocument({
		flowId: snapshot.flow.flowId,
		revision: snapshot.flow.graphRevision,
		entryNodeIds: [first.input.nodeId, second.input.nodeId],
		mcpHost: {} as McpHost,
	});
	assert.equal(run.status, "completed");
	assert.deepEqual(run.entryNodeIds, [first.input.nodeId, second.input.nodeId]);
	assert.deepEqual(new Set(run.targetNodeIds), new Set([first.output.nodeId, second.output.nodeId]));
	assert.equal(run.nodes.some((node): boolean => node.nodeId === unrelated.input.nodeId || node.nodeId === unrelated.output.nodeId), false);
	assert.deepEqual(run.nodes.find((node): boolean => node.nodeId === first.output.nodeId)?.output, { result: "alpha" });
	assert.deepEqual(run.nodes.find((node): boolean => node.nodeId === second.output.nodeId)?.output, { result: "beta" });
	const rerun = await startFlowRunDocument({
		flowId: snapshot.flow.flowId,
		revision: snapshot.flow.graphRevision,
		entryNodeIds: [first.input.nodeId, second.input.nodeId],
		forceAllSelected: true,
		mcpHost: {} as McpHost,
	});
	assert.equal(rerun.nodes.some((node): boolean => node.nodeId === unrelated.input.nodeId || node.nodeId === unrelated.output.nodeId), false);
	assert.equal(rerun.nodes.find((node): boolean => node.nodeId === first.output.nodeId)?.status, "completed");
	assert.equal(rerun.nodes.find((node): boolean => node.nodeId === second.output.nodeId)?.status, "completed");
}));

test("hybrid parameters use local fallback only while disconnected", async (): Promise<void> => {
	const pluginId = "fixture-hybrid-parameter";
	registerFlowNodeDefinition({
		typeId: `${pluginId}/echo`,
		pluginId,
		pluginVersion: "1.0.0",
		pluginFingerprint: "sha256:fixture-hybrid-parameter",
		configVersion: 1,
		category: "test",
		workspaceRequired: false,
		sideEffecting: false,
		executable: true,
		cachePolicy: "always",
		defaultTitle: "Hybrid echo",
		defaultConfig: { fallback: "local" },
		configSchema: {
			type: "object",
			properties: { fallback: { type: "string" } },
			required: ["fallback"],
			additionalProperties: false,
		},
		summaryFields: ["fallback"],
		ui: { kind: "schema" },
		parameters: [{
			id: "input",
			label: "Value",
			mode: "hybrid",
			configField: "fallback",
			dataTypes: ["text"],
			required: true,
			multiple: false,
			defaultConnect: true,
			hideControlWhenConnected: true,
		}],
		outputs: [{ id: "output", label: "Value", dataTypes: ["text"], defaultConnect: true }],
		parseConfig(value): Record<string, unknown> {
			if (typeof value.fallback !== "string") throw new Error("fallback must be a string");
			return { fallback: value.fallback };
		},
	});
	registerFlowNodeExecutor(`${pluginId}/echo`, pluginId, async ({ inputs }) => ({ output: inputs.input }));
	try {
		await withDatabase(async (): Promise<void> => {
			let snapshot = await createFlowDocument({ title: "Hybrid" });
			snapshot = await createFlowNodeDocument({
				flowId: snapshot.flow.flowId,
				revision: snapshot.flow.graphRevision,
				typeId: `${pluginId}/echo`,
				x: 320,
				y: 0,
				config: { fallback: "local" },
			});
			const hybridNode = snapshot.nodes[0]!;
			const localRun = await startFlowRunDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, mcpHost: {} as McpHost });
			assert.deepEqual(localRun.nodes.find((node): boolean => node.nodeId === hybridNode.nodeId)?.output, { output: "local" });

			snapshot = await createFlowNodeDocument({
				flowId: snapshot.flow.flowId,
				revision: snapshot.flow.graphRevision,
				typeId: "builtin/text",
				x: 0,
				y: 0,
				config: { text: "connected" },
			});
			const textNode = snapshot.nodes.find((node): boolean => node.typeId === "builtin/text")!;
			snapshot = await createFlowEdgeDocument({
				flowId: snapshot.flow.flowId,
				revision: snapshot.flow.graphRevision,
				sourceNodeId: textNode.nodeId,
				sourcePort: "output",
				targetNodeId: hybridNode.nodeId,
				targetPort: "input",
				dataType: "text",
			});
			const connectedRun = await startFlowRunDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, mcpHost: {} as McpHost });
			assert.deepEqual(connectedRun.nodes.find((node): boolean => node.nodeId === hybridNode.nodeId)?.output, { output: "connected" });

			snapshot = await updateFlowNodeDocument({
				flowId: snapshot.flow.flowId,
				nodeId: hybridNode.nodeId,
				revision: snapshot.flow.graphRevision,
				patch: { config: { fallback: "ignored while connected" } },
			});
			const cachedRun = await startFlowRunDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, mcpHost: {} as McpHost });
			assert.equal(cachedRun.nodes.find((node): boolean => node.nodeId === hybridNode.nodeId)?.status, "cached");
			assert.deepEqual(cachedRun.nodes.find((node): boolean => node.nodeId === hybridNode.nodeId)?.output, { output: "connected" });
		});
	} finally {
		unregisterPluginFlowNodeExecutors(pluginId);
		unregisterPluginFlowNodeDefinitions(pluginId);
	}
});

test("an active run locks semantic edits but keeps layout editable", async (): Promise<void> => withDatabase(async (): Promise<void> => {
	let snapshot = await createFlowDocument({ title: "Locked graph" });
	snapshot = await createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, typeId: "builtin/text", x: 0, y: 0, config: { text: "hello" } });
	const node = snapshot.nodes[0]!;
	const run = await createFlowRunDocument(snapshot.flow.flowId, snapshot.flow.graphRevision, [node.nodeId]);
	await assert.rejects(createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, typeId: "builtin/note", x: 10, y: 10 }), { code: "flow_graph_locked" });
	await assert.rejects(moveFlowWorkspaceDocument(snapshot.flow.flowId, "workspace-b", snapshot.flow.revision), { code: "flow_run_active" });
	const moved = await updateFlowNodeDocument({ flowId: snapshot.flow.flowId, nodeId: node.nodeId, revision: snapshot.flow.layoutRevision, patch: { x: 80, y: 90 } });
	assert.equal(moved.nodes[0]!.x, 80);
	assert.equal(moved.flow.graphRevision, snapshot.flow.graphRevision);
	await updateFlowRunDocument(snapshot.flow.flowId, run.runId, { status: "completed", finishedAt: new Date().toISOString() });
	const editable = await createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, typeId: "builtin/note", x: 10, y: 10 });
	assert.equal(editable.nodes.length, 2);
}));

test("Flow snapshots retain each node's latest successful output across isolated runs", async (): Promise<void> => withDatabase(async (): Promise<void> => {
	let snapshot = await createFlowDocument({ title: "Retained node results" });
	snapshot = await createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, typeId: "builtin/text", x: 0, y: 0, config: { text: "first branch" } });
	const firstNode = snapshot.nodes[0]!;
	snapshot = await createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, typeId: "builtin/text", x: 0, y: 200, config: { text: "second branch" } });
	const secondNode = snapshot.nodes.find((node): boolean => node.nodeId !== firstNode.nodeId)!;
	const firstRun = await createFlowRunDocument(snapshot.flow.flowId, snapshot.flow.graphRevision, [firstNode.nodeId]);
	const firstOutput = { output: { artifactId: "artifact-first" } };
	await updateFlowNodeRunDocument(snapshot.flow.flowId, firstRun.runId, firstNode.nodeId, {
		status: "completed",
		inputFingerprint: "fingerprint-first",
		output: firstOutput,
		startedAt: new Date().toISOString(),
		finishedAt: new Date().toISOString(),
	});
	await updateFlowRunDocument(snapshot.flow.flowId, firstRun.runId, { status: "completed", finishedAt: new Date().toISOString() });
	const secondRun = await createFlowRunDocument(snapshot.flow.flowId, snapshot.flow.graphRevision, [secondNode.nodeId]);
	const runningSnapshot = await getFlowDocument(snapshot.flow.flowId);
	assert.equal(runningSnapshot.runs[0]?.runId, secondRun.runId);
	assert.deepEqual(runningSnapshot.latestNodeResults?.find((node): boolean => node.nodeId === firstNode.nodeId)?.output, firstOutput);
	assert.equal(runningSnapshot.latestNodeResults?.some((node): boolean => node.nodeId === secondNode.nodeId), false);

	await updateFlowNodeRunDocument(snapshot.flow.flowId, secondRun.runId, secondNode.nodeId, {
		status: "completed",
		inputFingerprint: "fingerprint-second",
		output: { output: "second branch output" },
		startedAt: new Date().toISOString(),
		finishedAt: new Date().toISOString(),
	});
	await updateFlowRunDocument(snapshot.flow.flowId, secondRun.runId, { status: "completed", finishedAt: new Date().toISOString() });
	const thirdRun = await createFlowRunDocument(snapshot.flow.flowId, snapshot.flow.graphRevision, [firstNode.nodeId]);
	await updateFlowNodeRunDocument(snapshot.flow.flowId, thirdRun.runId, firstNode.nodeId, {
		status: "failed",
		error: "regeneration failed",
		finishedAt: new Date().toISOString(),
	});
	const failedSnapshot = await getFlowDocument(snapshot.flow.flowId);
	assert.equal(failedSnapshot.runs[0]?.nodes.find((node): boolean => node.nodeId === firstNode.nodeId)?.status, "failed");
	assert.deepEqual(failedSnapshot.latestNodeResults?.find((node): boolean => node.nodeId === firstNode.nodeId)?.output, firstOutput);
	assert.deepEqual(failedSnapshot.latestNodeResults?.find((node): boolean => node.nodeId === secondNode.nodeId)?.output, { output: "second branch output" });
}));

test("Merge keeps configured input order and Condition activates one output branch", async (): Promise<void> => withDatabase(async (): Promise<void> => {
	let snapshot = await createFlowDocument({ title: "Branching" });
	snapshot = await createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, typeId: "builtin/text", x: 0, y: 0, config: { text: "first" } });
	const first = snapshot.nodes[0]!;
	snapshot = await createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, typeId: "builtin/text", x: 0, y: 160, config: { text: "second" } });
	const second = snapshot.nodes.find((node): boolean => node.nodeId !== first.nodeId)!;
	snapshot = await createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, typeId: "builtin/merge", x: 300, y: 80, config: { mode: "concat", separator: "|", inputs: [{ id: "input-1", label: "First", dataType: "text" }, { id: "input-2", label: "Second", dataType: "text" }] } });
	const merge = snapshot.nodes.find((node): boolean => node.typeId === "builtin/merge")!;
	snapshot = await createFlowEdgeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, sourceNodeId: first.nodeId, sourcePort: "output", targetNodeId: merge.nodeId, targetPort: "input-2", dataType: "text" });
	snapshot = await createFlowEdgeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, sourceNodeId: second.nodeId, sourcePort: "output", targetNodeId: merge.nodeId, targetPort: "input-1", dataType: "text" });
	snapshot = await createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, typeId: "builtin/condition", x: 620, y: 80, config: { pointer: "/", operator: "equals", value: "second|first" } });
	const condition = snapshot.nodes.find((node): boolean => node.typeId === "builtin/condition")!;
	snapshot = await createFlowEdgeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, sourceNodeId: merge.nodeId, sourcePort: "output", targetNodeId: condition.nodeId, targetPort: "input", dataType: "text" });
	snapshot = await createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, typeId: "builtin/output", x: 940, y: 0, config: { format: "text" } });
	const trueOutput = snapshot.nodes.find((node): boolean => node.typeId === "builtin/output")!;
	snapshot = await createFlowEdgeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, sourceNodeId: condition.nodeId, sourcePort: "true", targetNodeId: trueOutput.nodeId, targetPort: "input", dataType: "text" });
	snapshot = await createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, typeId: "builtin/output", x: 940, y: 180, config: { format: "text" } });
	const falseOutput = snapshot.nodes.find((node): boolean => node.typeId === "builtin/output" && node.nodeId !== trueOutput.nodeId)!;
	snapshot = await createFlowEdgeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, sourceNodeId: condition.nodeId, sourcePort: "false", targetNodeId: falseOutput.nodeId, targetPort: "input", dataType: "text" });
	const run = await startFlowRunDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, mcpHost: {} as McpHost });
	assert.equal(run.status, "completed");
	assert.deepEqual(run.nodes.find((node): boolean => node.nodeId === merge.nodeId)?.output, { output: "second|first" });
	assert.deepEqual(run.nodes.find((node): boolean => node.nodeId === trueOutput.nodeId)?.output, { result: "second|first" });
	assert.equal(run.nodes.find((node): boolean => node.nodeId === falseOutput.nodeId)?.status, "skipped");
}));

test("Flow schema migration resets legacy Flow data without touching the session database", async (): Promise<void> => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "daedalus-document-flow-migration-"));
	const databasePath = path.join(directory, "sessions.sqlite");
	const db = new DatabaseSync(databasePath);
	db.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE flow_documents (flow_id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_id TEXT, pinned INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1, viewport_json TEXT NOT NULL, archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
		CREATE TABLE flow_nodes (node_id TEXT PRIMARY KEY, flow_id TEXT NOT NULL REFERENCES flow_documents(flow_id) ON DELETE CASCADE, type TEXT NOT NULL CHECK(type IN ('prompt', 'llm', 'output', 'note')), title TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL, width REAL NOT NULL, height REAL NOT NULL, config_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'idle', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
		CREATE TABLE flow_edges (edge_id TEXT PRIMARY KEY, flow_id TEXT NOT NULL REFERENCES flow_documents(flow_id) ON DELETE CASCADE, source_node_id TEXT NOT NULL REFERENCES flow_nodes(node_id) ON DELETE CASCADE, source_port TEXT NOT NULL, target_node_id TEXT NOT NULL REFERENCES flow_nodes(node_id) ON DELETE CASCADE, target_port TEXT NOT NULL, data_type TEXT NOT NULL CHECK(data_type IN ('text', 'json', 'image', 'video', 'audio', 'frames', 'artifact')), UNIQUE(flow_id, target_node_id, target_port));
		INSERT INTO flow_documents VALUES ('flow-old', 'Existing', NULL, 0, 7, '{"x":0,"y":0,"zoom":1}', NULL, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
		INSERT INTO flow_nodes VALUES ('node-prompt', 'flow-old', 'prompt', 'Prompt', 0, 0, 300, 180, '{"text":"hello"}', 'idle', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
		INSERT INTO flow_nodes VALUES ('node-output', 'flow-old', 'output', 'Output', 320, 0, 300, 180, '{"format":"text"}', 'idle', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
		INSERT INTO flow_edges VALUES ('edge-old', 'flow-old', 'node-prompt', 'output', 'node-output', 'input', 'text');
	`);
	db.close();
	await resetSessionDatabaseForTests(databasePath);
	try {
		await assert.rejects(getFlowDocument("flow-old"), { code: "flow_not_found" });
		const created = await createFlowDocument({ title: "New schema" });
		const added = await createFlowNodeDocument({ flowId: created.flow.flowId, revision: created.flow.graphRevision, typeId: "builtin/command", x: 640, y: 0, config: { commandLine: "echo ok" } });
		assert.equal(added.nodes.some((node): boolean => node.typeId === "builtin/command"), true);
	} finally {
		await resetSessionDatabaseForTests();
		await fs.rm(directory, { recursive: true, force: true });
	}
});
