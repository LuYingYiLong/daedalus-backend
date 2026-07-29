import assert from "node:assert/strict";
import test from "node:test";
import {
	isPluginProtocolSupported,
	MAX_PLUGIN_PROTOCOL_VERSION,
	MIN_PLUGIN_PROTOCOL_VERSION
} from "../../../src/server/plugin-compatibility.js";

test("accepts only the v3 Godot plugin protocol", () => {
	assert.equal(MIN_PLUGIN_PROTOCOL_VERSION, 3);
	assert.equal(MAX_PLUGIN_PROTOCOL_VERSION, 3);
	assert.equal(isPluginProtocolSupported(undefined), false);
	assert.equal(isPluginProtocolSupported(3), true);
});

test("rejects Godot plugin protocols outside the advertised range", () => {
	assert.equal(isPluginProtocolSupported(0), false);
	assert.equal(isPluginProtocolSupported(1), false);
	assert.equal(isPluginProtocolSupported(2), false);
	assert.equal(isPluginProtocolSupported(4), false);
});
