import test from "node:test";
import assert from "node:assert/strict";
import { clientRequestSchema } from "../../../src/protocol/schema.js";

test("Flow graph requests validate", (): void => {
	const methods = [
		{ method: "flow.create", params: { title: "Graph", workspaceId: "workspace-a" } },
		{ method: "flow.get", params: { flowId: "flow-a" } },
		{ method: "flow.node.types.list", params: { flowId: "flow-a" } },
		{ method: "flow.patch.commit", params: { flowId: "flow-a", clientId: "studio-a", operations: [{ mutationId: "mutation-a", baseGraphRevision: 1, kind: "node.create", payload: { nodeId: "node-a", typeId: "builtin/prompt", x: 0, y: 0, config: { text: "hello" } } }] } },
		{ method: "flow.run.start", params: { flowId: "flow-a", revision: 3 } },
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


