import assert from "node:assert/strict";
import test from "node:test";
import {
	GODOT_DOCUMENTATION_MCP_TOOL_NAMES,
	registerGodotDocumentationTools
} from "../../../src/mcp/godot-documentation/registration.js";

type FakeMcpServer = {
	toolNames: string[];
	registerTool(name: string, ..._rest: unknown[]): void;
};

test("Godot Documentation MCP registration manifest matches its standalone server", (): void => {
	const server: FakeMcpServer = {
		toolNames: [],
		registerTool(name: string): void {
			this.toolNames.push(name);
		}
	};

	registerGodotDocumentationTools(server as never);
	assert.deepEqual(server.toolNames, [...GODOT_DOCUMENTATION_MCP_TOOL_NAMES]);
});
