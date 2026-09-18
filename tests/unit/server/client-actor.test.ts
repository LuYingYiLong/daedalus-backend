import assert from "node:assert/strict";
import test from "node:test";
import type WebSocket from "ws";
import type { ClientSession } from "../../../src/server/client-session.js";
import {
	broadcastGlobalEvent,
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

test("global events remain unique and ordered when emitted in the same millisecond", (): void => {
	const messages: string[] = [];
	const socket = {
		readyState: 1,
		send: (message: string): void => { messages.push(message); },
	} as unknown as WebSocket;
	const originalNow = Date.now;
	Date.now = (): number => 1_700_000_000_000;
	registerClientConnection(socket, {} as ClientSession);
	try {
		broadcastGlobalEvent("run-1", "flow.node.state", { status: "cached" });
		broadcastGlobalEvent("run-1", "flow.run.state", { status: "completed" });
		const events = messages.map((message): { eventId: string; sequence: number } => JSON.parse(message) as { eventId: string; sequence: number });
		assert.equal(events.length, 2);
		assert.notEqual(events[0]?.eventId, events[1]?.eventId);
		assert.ok(events[1]!.sequence > events[0]!.sequence);
	} finally {
		unregisterClientConnection(socket);
		Date.now = originalNow;
	}
});
