import assert from "node:assert/strict";
import test from "node:test";
import {
	isBridgeProtocolSupported,
	MAX_BRIDGE_PROTOCOL_VERSION,
	MIN_BRIDGE_PROTOCOL_VERSION
} from "../../../src/server/bridge-compatibility.js";

test("Editor Bridge Protocol v4 is the only accepted bridge protocol", (): void => {
	assert.equal(MIN_BRIDGE_PROTOCOL_VERSION, 4);
	assert.equal(MAX_BRIDGE_PROTOCOL_VERSION, 4);
	assert.equal(isBridgeProtocolSupported(undefined), false);
	assert.equal(isBridgeProtocolSupported(4), true);
});

test("legacy and future bridge protocols are rejected", (): void => {
	assert.equal(isBridgeProtocolSupported(0), false);
	assert.equal(isBridgeProtocolSupported(1), false);
	assert.equal(isBridgeProtocolSupported(2), false);
	assert.equal(isBridgeProtocolSupported(3), false);
	assert.equal(isBridgeProtocolSupported(5), false);
});
