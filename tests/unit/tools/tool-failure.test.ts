import assert from "node:assert/strict";
import test from "node:test";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
	createToolFailure,
	parseStructuredToolFailure,
	serializeToolFailure,
	StructuredToolError
} from "../../../src/tools/tool-failure.js";

test("structured business failures preserve exact source-scoped artifacts", (): void => {
	const failure = createToolFailure(new StructuredToolError({
		code: "signal_node_not_found",
		category: "business",
		message: "Signal source node Player does not exist.",
		retryable: true,
		artifactRefs: ["scenes/Main.tscn"],
		artifactFileRefs: [{ workspaceId: "game", sourceFolderId: "godot", relativePath: "scenes/Main.tscn" }],
		sourceFolderId: "godot",
		details: { nodePath: "Player" }
	}));

	assert.equal(failure.code, "signal_node_not_found");
	assert.equal(failure.category, "business");
	assert.deepEqual(failure.artifactFileRefs, [{ workspaceId: "game", sourceFolderId: "godot", relativePath: "scenes/Main.tscn" }]);
});

test("unknown tool exceptions remain tool-scoped business failures", (): void => {
	const failure = createToolFailure(new Error("class_name DamageNumber"), {
		artifactRefs: ["scripts/damage_number.gd"]
	});

	assert.equal(failure.code, "tool_execution_failed");
	assert.equal(failure.category, "business");
	assert.equal(failure.message, "class_name DamageNumber");
	assert.equal(failure.retryable, true);
});

test("MCP request timeout uses the structured JSON-RPC code as an environment failure", (): void => {
	const failure = createToolFailure(new McpError(ErrorCode.RequestTimeout, "Request timed out"), {
		artifactRefs: ["scripts/verify.gd"],
		sourceFolderId: "godot"
	});

	assert.equal(failure.code, "mcp_request_timeout");
	assert.equal(failure.category, "environment");
	assert.equal(failure.retryable, true);
	assert.deepEqual(failure.artifactRefs, ["scripts/verify.gd"]);
	assert.equal(failure.details?.mcpErrorCode, ErrorCode.RequestTimeout);
});

test("serialized environment failures round-trip without text classification", (): void => {
	const content = serializeToolFailure({
		code: "godot_runtime_unavailable",
		category: "environment",
		message: "Godot executable is unavailable.",
		retryable: true,
		artifactRefs: []
	});
	const parsed = parseStructuredToolFailure(JSON.parse(content));

	assert.equal(parsed?.code, "godot_runtime_unavailable");
	assert.equal(parsed?.category, "environment");
	assert.equal(parsed?.message, "Godot executable is unavailable.");
});
