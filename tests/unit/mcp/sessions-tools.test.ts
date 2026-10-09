import assert from "node:assert/strict";
import test from "node:test";
import { buildGlobalMcpServerConfigs, SESSIONS_MCP_SERVER_ID } from "../../../src/mcp/mcp-config.js";
import { McpSession } from "../../../src/mcp/mcp-session.js";

test("internal sessions MCP advertises bounded read-only Chat tools", { timeout: 20_000 }, async (): Promise<void> => {
	const config = buildGlobalMcpServerConfigs().find((entry) => entry.id === SESSIONS_MCP_SERVER_ID);
	assert.ok(config);
	assert.equal(config.transport, "stdio");
	const session = new McpSession(config);
	try {
		await session.connect();
		const listed = await session.listTools();
		assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ["read_session", "search_sessions"]);
		const invalid = await session.callTool("read_session", { sessionId: "flow-not-a-chat" });
		assert.equal(invalid.isError, true);
	} finally {
		await session.close();
	}
});
