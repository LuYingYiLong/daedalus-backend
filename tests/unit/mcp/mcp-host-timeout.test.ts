import assert from "node:assert/strict";
import test from "node:test";
import { resolveTerminalMcpRequestTimeoutMs } from "../../../src/mcp/mcp-host.js";

test("terminal MCP wait requests outlive their command timeout", (): void => {
	assert.equal(resolveTerminalMcpRequestTimeoutMs("run_command", { timeoutMs: 90_000 }), 120_000);
	assert.equal(resolveTerminalMcpRequestTimeoutMs("run_safe_preset", {}), 60_000);
	assert.equal(resolveTerminalMcpRequestTimeoutMs("run_safe_preset", {
		presetName: "godot.check_only"
	}), 1_830_000);
});

test("terminal background jobs keep the normal short MCP request timeout", (): void => {
	assert.equal(resolveTerminalMcpRequestTimeoutMs("run_command", {
		executionMode: "job",
		timeoutMs: 1_800_000
	}), undefined);
});

test("non-terminal tools do not receive a terminal request timeout", (): void => {
	assert.equal(resolveTerminalMcpRequestTimeoutMs("read_text_file", { timeoutMs: 90_000 }), undefined);
});
