import assert from "node:assert/strict";
import test from "node:test";
import {
	isPluginProtocolSupported,
	MAX_PLUGIN_PROTOCOL_VERSION,
	MIN_PLUGIN_PROTOCOL_VERSION
} from "../../../src/server/plugin-compatibility.js";

test("accepts legacy and current Godot plugin protocols", () => {
	assert.equal(MIN_PLUGIN_PROTOCOL_VERSION, 1);
	assert.equal(MAX_PLUGIN_PROTOCOL_VERSION, 2);
	assert.equal(isPluginProtocolSupported(undefined), true);
	assert.equal(isPluginProtocolSupported(1), true);
	assert.equal(isPluginProtocolSupported(2), true);
});

test("rejects Godot plugin protocols outside the advertised range", () => {
	assert.equal(isPluginProtocolSupported(0), false);
	assert.equal(isPluginProtocolSupported(3), false);
});
