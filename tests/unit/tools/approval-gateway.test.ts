import assert from "node:assert/strict";
import test from "node:test";
import type { McpHost } from "../../../src/mcp/mcp-host.js";
import { ApprovalGateway } from "../../../src/tools/approval-gateway.js";

test("an accepted approval is consumed even when tool execution fails", async (): Promise<void> => {
	const gateway = new ApprovalGateway("manual");
	const pending = gateway.requestApproval(
		"mcp_workspace_read_text_file",
		{ relativePath: "README.md" },
		"tool-call-1",
		"test approval",
		"workspace-test"
	);
	const mcpHost = {
		callTool: async (): Promise<never> => {
			throw new Error("MCP request timed out");
		}
	} as unknown as McpHost;

	await assert.rejects(gateway.approve(pending.approvalId, mcpHost));
	assert.equal(gateway.getPending(pending.approvalId), undefined);
	assert.equal(gateway.listPending().length, 0);
});
