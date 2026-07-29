import assert from "node:assert/strict";
import test from "node:test";
import { clientRequestEnvelopeSchema, clientRequestSchema } from "../../../src/protocol/schema.js";
import { isUnsupportedProtocolEnvelope } from "../../../src/server/websocket-server.js";

test("v3 envelope is required at the WebSocket boundary", (): void => {
	assert.equal(isUnsupportedProtocolEnvelope({
		type: "request",
		id: "missing",
		method: "ping",
		params: {}
	}), true);
	assert.equal(isUnsupportedProtocolEnvelope({
		type: "request",
		id: "v2",
		method: "ping",
		protocolVersion: 2,
		params: {}
	}), true);
	assert.equal(isUnsupportedProtocolEnvelope({
		type: "request",
		id: "v3",
		method: "ping",
		protocolVersion: 3,
		params: {}
	}), false);
});

test("v3 client hello explicitly declares its protocol version", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "hello-missing",
		method: "client.hello"
	}).success, false);
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "hello-v3",
		method: "client.hello",
		params: {
			protocolVersion: 3,
			godotExecutablePath: "D:/Godot/Godot.exe"
		}
	}).success, true);
});

test("v3 envelope schema rejects older transport versions", (): void => {
	assert.equal(clientRequestEnvelopeSchema.safeParse({
		protocolVersion: 2,
		type: "request",
		id: "ping-v2",
		method: "ping"
	}).success, false);
	assert.equal(clientRequestEnvelopeSchema.safeParse({
		protocolVersion: 3,
		type: "request",
		id: "ping-v3",
		method: "ping"
	}).success, true);
});

