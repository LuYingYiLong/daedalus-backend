import assert from "node:assert/strict";
import test from "node:test";
import { createMcpProcessEnvironment } from "../../../src/mcp/mcp-session.js";

test("custom stdio MCP processes do not inherit backend secrets", (): void => {
	const environment = createMcpProcessEnvironment(
		{ MCP_EXPLICIT_SECRET: "configured", PATH: "custom-path" },
		{
			PATH: "system-path",
			HOME: "/home/test",
			OPENAI_API_KEY: "backend-secret",
			DAEDALUS_AUTH_TOKEN: "backend-auth"
		},
		"linux"
	);
	assert.equal(environment.PATH, "custom-path");
	assert.equal(environment.HOME, "/home/test");
	assert.equal(environment.MCP_EXPLICIT_SECRET, "configured");
	assert.equal(environment.OPENAI_API_KEY, undefined);
	assert.equal(environment.DAEDALUS_AUTH_TOKEN, undefined);
});
