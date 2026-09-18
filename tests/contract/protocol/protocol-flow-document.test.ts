import test from "node:test";
import assert from "node:assert/strict";
import { clientRequestSchema, flowDocumentNodeStateEventDataSchema, flowDocumentRunStateEventDataSchema } from "../../../src/protocol/schema.js";

test("Flow graph requests validate", (): void => {
	const methods = [
		{ method: "flow.create", params: { title: "Graph", workspaceId: "workspace-a" } },
		{ method: "flow.get", params: { flowId: "flow-a" } },
		{ method: "flow.node.types.list", params: { flowId: "flow-a" } },
		{ method: "flow.patch.commit", params: { flowId: "flow-a", clientId: "studio-a", operations: [{ mutationId: "mutation-a", baseGraphRevision: 1, kind: "node.create", payload: { nodeId: "node-a", typeId: "builtin/user-prompt", x: 0, y: 0, config: { text: "hello" } } }] } },
		{ method: "flow.run.start", params: { flowId: "flow-a", revision: 3, entryNodeIds: ["node-input"], targetNodeIds: ["node-output"], inputValues: { "node-input": "hello" } } },
		{ method: "flow.run.stop", params: { flowId: "flow-a", runId: "run-a" } },
		{ method: "flow.settings.update", params: { flowId: "flow-a", revision: 3, approvalMode: "auto-safe" } },
		{ method: "flow.tools.list", params: { flowId: "flow-a" } },
		{ method: "flow.approval.list", params: { flowId: "flow-a", runId: "run-a" } },
		{ method: "flow.approval.resolve", params: { flowId: "flow-a", runId: "run-a", approvalId: "approval-a", decision: "approve" } },
		{ method: "flow.import.fromSession", params: { sourceSessionId: "session-a", title: "Imported" } },
		{ method: "flow.export.toSession", params: { flowId: "flow-a", outputNodeId: "node-output", title: "Chat" } },
	] as const;
	for (const [index, request] of methods.entries()) {
		const result = clientRequestSchema.safeParse({ type: "request", id: `request-${index}`, ...request });
		if (!result.success) assert.fail(result.error.message);
	}
});

test("Flow graph accepts namespaced node IDs only through batched patches", (): void => {
	assert.equal(clientRequestSchema.safeParse({ type: "request", id: "request-1", method: "flow.patch.commit", params: { flowId: "flow-a", clientId: "studio-a", operations: [{ mutationId: "mutation-a", kind: "node.create", payload: { nodeId: "node-a", typeId: "script", x: 0, y: 0 } }] } }).success, false);
	for (const method of ["flow.node.create", "flow.node.createConnected", "flow.node.update", "flow.node.delete", "flow.edge.create", "flow.edge.delete", "flow.viewport.update"]) {
		assert.equal(clientRequestSchema.safeParse({ type: "request", id: `removed-${method}`, method, params: {} }).success, false, method);
	}
});

test("Flow state events can carry complete incremental run results", (): void => {
	const nodeRun = {
		runId: "run-a",
		nodeId: "node-output",
		typeId: "builtin/output",
		pluginVersion: "1.0.0",
		pluginFingerprint: "builtin@1.0.0",
		configVersion: 1,
		status: "completed",
		inputFingerprint: "fingerprint-a",
		output: { result: "hello" },
		error: null,
		startedAt: "2026-09-18T00:00:00.000Z",
		finishedAt: "2026-09-18T00:00:01.000Z",
	} as const;
	const run = {
		runId: "run-a",
		flowId: "flow-a",
		revision: 3,
		entryNodeIds: ["node-input"],
		targetNodeIds: ["node-output"],
		inputValues: { "node-input": "hello" },
		status: "completed",
		startedAt: "2026-09-18T00:00:00.000Z",
		finishedAt: "2026-09-18T00:00:01.000Z",
		error: null,
		nodes: [nodeRun],
	} as const;
	assert.equal(flowDocumentNodeStateEventDataSchema.safeParse({ flowId: "flow-a", runId: "run-a", nodeId: "node-output", revision: 3, status: "completed", nodeRun }).success, true);
	assert.equal(flowDocumentRunStateEventDataSchema.safeParse({ flowId: "flow-a", runId: "run-a", revision: 3, status: "completed", run }).success, true);
});


