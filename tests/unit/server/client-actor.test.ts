import assert from "node:assert/strict";
import test from "node:test";
import type WebSocket from "ws";
import type { ClientSession } from "../../../src/server/client-session.js";
import {
	getClientActorSummary,
	isStudioSessionClientType,
	registerClientConnection,
	unregisterClientConnection,
	updateClientConnection,
} from "../../../src/server/client-connections.js";

test("studio_remote is a Studio session subscriber but remains a distinct client type", (): void => {
	assert.equal(isStudioSessionClientType("studio"), true);
	assert.equal(isStudioSessionClientType("studio_remote"), true);
	assert.equal(isStudioSessionClientType("studio_scheduler"), false);
});

test("decision actors come from the authenticated connection rather than RPC params", (): void => {
	const socket = {} as WebSocket;
	registerClientConnection(socket, {} as ClientSession);
	try {
		const connection = updateClientConnection(socket, {
			clientType: "studio_remote",
			clientName: "Pixel 9",
			capabilities: { remoteControl: true, approval: true },
		});
		assert.deepEqual(getClientActorSummary(socket), {
			clientType: "studio_remote",
			clientName: "Pixel 9",
			connectionId: connection.connectionId,
		});
	} finally {
		unregisterClientConnection(socket);
	}
});
