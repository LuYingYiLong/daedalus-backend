import assert from "node:assert/strict";
import { test } from "node:test";
import { clearPluginRegistrations, getPluginTool, listPluginMcpTools, listPluginSkills, registerPluginMcp, registerPluginSkill, registerPluginTool } from "../../../src/plugins/runtime/registries.js";
import { encodeWorkerMessage, parseWorkerEvent } from "../../../src/plugins/runtime/worker-protocol.js";

test("native plugin registrations use stable namespaces and can be cleared", (): void => {
	const pluginId = "fixture-runtime-plugin";
	registerPluginTool(pluginId, { name: "read_status", title: "Read status", description: "Read status", inputSchema: { type: "object" }, risk: "read", workflow: true, global: false });
	registerPluginSkill(pluginId, { slug: "status", name: "Status", description: "Status instructions", body: "Use the status tool.", allowedTools: [] });
	registerPluginMcp(pluginId, { serverId: "fixture", serverName: "Fixture", tools: [{ name: "ping", inputSchema: { type: "object" }, risk: "read" }], resources: [] });
	try {
		const tool = getPluginTool("mcp_plugin_fixture_runtime_plugin_read_status");
		assert.equal(tool?.mapping.serverId, "plugin:fixture-runtime-plugin");
		assert.equal(listPluginSkills().some((skill): boolean => skill.ref === "plugin:fixture-runtime-plugin:status"), true);
		assert.equal(listPluginMcpTools().find((tool): boolean => tool.pluginId === pluginId)?.name, "ping");
	} finally {
		clearPluginRegistrations(pluginId);
	}
	assert.equal(getPluginTool("mcp_plugin_fixture_runtime_plugin_read_status"), undefined);
});

test("worker protocol accepts JSON line events and rejects malformed envelopes", (): void => {
	const encoded = encodeWorkerMessage({ type: "shutdown" });
	assert.equal(encoded.endsWith("\n"), true);
	assert.equal(parseWorkerEvent(JSON.stringify({ type: "ready", protocolVersion: 1 })).type, "ready");
	assert.throws(() => parseWorkerEvent(JSON.stringify({ value: true })), /Invalid plugin worker event/);
});
