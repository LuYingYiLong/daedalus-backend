import assert from "node:assert/strict";
import test from "node:test";
import { getToolDefinitionsForNames } from "../../../src/tools/builtin-tool-definitions.js";

function getProperties(toolName: string): Record<string, unknown> {
	const tool = getToolDefinitionsForNames([toolName]).find((candidate) =>
		candidate.type === "function" && candidate.function.name === toolName
	);
	assert.notEqual(tool, undefined);
	assert.equal(tool?.type, "function");
	const parameters = tool?.function.parameters;
	assert.equal(typeof parameters, "object");
	assert.notEqual(parameters, null);
	const properties = (parameters as { properties?: unknown }).properties;
	assert.equal(typeof properties, "object");
	assert.notEqual(properties, null);
	return properties as Record<string, unknown>;
}

test("terminal tools expose sourceFolderId to the model", (): void => {
	for (const toolName of [
		"mcp_terminal_run_command",
		"mcp_terminal_run_safe_preset",
		"mcp_terminal_run_write_preset",
		"mcp_terminal_run_godot_scene_script"
	]) {
		const sourceFolderId = getProperties(toolName).sourceFolderId;
		assert.equal(typeof sourceFolderId, "object");
		assert.match(String((sourceFolderId as { description?: unknown }).description), /多源工作区/u);
	}
});
