import assert from "node:assert/strict";
import test from "node:test";
import { clientRequestSchema } from "../../../src/protocol/schema.js";

test("Flow RPC payloads are strict and cover every v1 operation", (): void => {
	const valid = [
		{ method: "flow.create", params: { title: "Flow", workspaceId: "workspace-a" } },
		{ method: "flow.create.fromSession", params: { sourceSessionId: "session-a", title: "Flow" } },
		{ method: "flow.list", params: { archived: false } },
		{ method: "flow.tree.order.get", params: {} },
		{
			method: "flow.tree.order.update",
			params: {
				pinnedFlowIds: ["flow-a"],
				recentFlowIds: [],
				flowIdsByWorkspace: {},
				expandedSectionKeys: ["pinned", "projects", "recent"],
				expandedWorkspaceIds: [],
			},
		},
		{ method: "flow.get", params: { flowId: "flow-a" } },
		{ method: "flow.node.get", params: { flowId: "flow-a", nodeId: "user:request-a" } },
		{ method: "flow.rename", params: { flowId: "flow-a", title: "Renamed", revision: 1 } },
		{ method: "flow.archive", params: { flowId: "flow-a", revision: 1 } },
		{ method: "flow.branch.create", params: { flowId: "flow-a", parentBranchId: "branch-a", sourceNodeId: "assistant:request-a" } },
		{ method: "flow.branch.copyToChat", params: { flowId: "flow-a", branchId: "branch-a", title: "Chat" } },
		{ method: "flow.layout.update", params: { flowId: "flow-a", revision: 1, positions: [{ nodeId: "user:request-a", x: 1, y: 2 }] } },
	] as const;
	for (const request of valid) {
		assert.equal(clientRequestSchema.safeParse({ type: "request", id: `test-${request.method}`, ...request }).success, true, request.method);
	}
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "invalid-layout",
		method: "flow.layout.update",
		params: { flowId: "flow-a", revision: 1, positions: [], unexpected: true },
	}).success, false);
});
