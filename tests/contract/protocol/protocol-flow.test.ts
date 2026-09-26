import assert from "node:assert/strict";
import test from "node:test";
import { clientRequestSchema } from "../../../src/protocol/schema.js";

test("Flow RPC payloads are strict and exclude the removed conversation branch model", (): void => {
	const valid = [
		{ method: "flow.create", params: { title: "Flow", workspaceId: "workspace-a" } },
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
		{ method: "flow.rename", params: { flowId: "flow-a", title: "Renamed", revision: 1 } },
		{ method: "flow.archive", params: { flowId: "flow-a", revision: 1 } },
		{ method: "flow.import.fromSession", params: { sourceSessionId: "session-a", title: "Flow" } },
		{ method: "flow.import", params: { sourcePath: "C:\\exports\\flow.daedalus-flow" } },
		{ method: "flow.export", params: { flowId: "flow-a", destinationPath: "C:\\exports\\flow.daedalus-flow", operationId: "99ef6040-2769-4c2d-a4ba-a34fc34d63cf" } },
		{ method: "flow.transfer.cancel", params: { operationId: "99ef6040-2769-4c2d-a4ba-a34fc34d63cf" } },
		{ method: "flow.run.preflight", params: { flowId: "flow-a", revision: 3 } },
		{ method: "flow.run.report", params: { flowId: "flow-a", runId: "run-a" } },
		{ method: "flow.run.retry", params: { flowId: "flow-a", runId: "run-a", confirmPossibleDuplicateCharge: true } },
		{ method: "flow.artifact.usage", params: { flowId: "flow-a" } },
		{ method: "flow.artifact.health", params: { flowId: "flow-a" } },
		{ method: "flow.artifact.preview", params: { flowId: "flow-a", artifactId: "flow-artifact-a" } },
		{ method: "flow.artifact.cleanup", params: { flowId: "flow-a", runIds: ["run-a"], dryRun: true } },
		{ method: "flow.artifact.export", params: { flowId: "flow-a", artifactIds: ["flow-artifact-a"], destinationPath: "C:\\exports\\image.png", directory: false } },
		{ method: "flow.export.toSession", params: { flowId: "flow-a", outputNodeId: "node-a", title: "Chat" } },
	] as const;
	for (const request of valid) {
		assert.equal(clientRequestSchema.safeParse({ type: "request", id: `test-${request.method}`, ...request }).success, true, request.method);
	}
	for (const method of ["flow.create.fromSession", "flow.node.get", "flow.branch.create", "flow.branch.copyToChat", "flow.layout.update"]) {
		assert.equal(clientRequestSchema.safeParse({ type: "request", id: `removed-${method}`, method, params: {} }).success, false, method);
	}
	assert.equal(clientRequestSchema.safeParse({ type: "request", id: "empty-flow-import", method: "flow.import", params: { sourcePath: "" } }).success, false);
	assert.equal(clientRequestSchema.safeParse({ type: "request", id: "bad-transfer-id", method: "flow.transfer.cancel", params: { operationId: "../escape" } }).success, false);
	assert.equal(clientRequestSchema.safeParse({ type: "request", id: "bad-artifact-export", method: "flow.artifact.export", params: { flowId: "flow-a", artifactIds: [], destinationPath: "C:\\exports", directory: true } }).success, false);
	assert.equal(clientRequestSchema.safeParse({ type: "request", id: "unscoped-preview", method: "flow.artifact.preview", params: { artifactId: "flow-artifact-a" } }).success, false);
	assert.equal(clientRequestSchema.safeParse({ type: "request", id: "unplanned-cleanup", method: "flow.artifact.cleanup", params: { flowId: "flow-a", runIds: ["run-a"], dryRun: false } }).success, false);
});
