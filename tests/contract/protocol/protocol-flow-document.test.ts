import test from "node:test";
import assert from "node:assert/strict";
import { clientRequestSchema } from "../../../src/protocol/schema.js";

test("Flow graph requests validate", (): void => {
	const methods = [
		{ method: "flow.create", params: { title: "Graph", workspaceId: "workspace-a" } },
		{ method: "flow.get", params: { flowId: "flow-a" } },
		{ method: "flow.node.create", params: { flowId: "flow-a", revision: 1, type: "prompt", x: 0, y: 0, config: { text: "hello" } } },
		{ method: "flow.node.types.list", params: { flowId: "flow-a" } },
		{ method: "flow.node.createConnected", params: { flowId: "flow-a", revision: 1, type: "template", x: 240, y: 0, connection: { direction: "from_existing", existingNodeId: "node-a", existingPort: "output", newPort: "input", dataType: "text" } } },
		{ method: "flow.node.update", params: { flowId: "flow-a", nodeId: "node-a", revision: 1, patch: { config: { text: "updated" } } } },
		{ method: "flow.edge.create", params: { flowId: "flow-a", revision: 2, sourceNodeId: "node-a", sourcePort: "text", targetNodeId: "node-b", targetPort: "prompt", dataType: "text" } },
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

test("Flow graph rejects unsupported node types and malformed edges", (): void => {
	assert.equal(clientRequestSchema.safeParse({ type: "request", id: "request-1", method: "flow.node.create", params: { flowId: "flow-a", revision: 1, type: "script", x: 0, y: 0 } }).success, false);
	assert.equal(clientRequestSchema.safeParse({ type: "request", id: "request-2", method: "flow.edge.create", params: { flowId: "flow-a", revision: 1, sourceNodeId: "node-a", sourcePort: "text", targetNodeId: "node-b", targetPort: "prompt", dataType: "binary" } }).success, false);
});


