import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { clientRequestEnvelopeSchema } from "../../../src/protocol/schema.js";
import { createClientSession } from "../../../src/server/client-session.js";
import {
	registerClientConnection,
	unregisterClientConnection,
	updateClientConnection,
} from "../../../src/server/client-connections.js";
import {
	getStudioGodotRuntimeControl,
	StudioGodotRuntime,
} from "../../../src/server/studio-godot-runtime.js";

type FakeSocket = WebSocket & { sent: Array<{ event: string; data: { callId: string } }> };

function createSocket(): FakeSocket {
	const sent: FakeSocket["sent"] = [];
	return {
		readyState: WebSocket.OPEN,
		sent,
		send(value: string): void {
			sent.push(JSON.parse(value) as FakeSocket["sent"][number]);
		},
	} as unknown as FakeSocket;
}

function registerStudio(socket: FakeSocket): void {
	const session = createClientSession(undefined);
	session.sessionId = "session-runtime";
	registerClientConnection(socket, session);
	updateClientConnection(socket, {
		clientType: "studio",
		capabilities: { godotRuntimeTest: true },
	});
}

function registerClient(socket: FakeSocket, clientType: "studio" | "studio_remote"): void {
	const session = createClientSession(undefined);
	session.sessionId = "session-runtime";
	registerClientConnection(socket, session);
	updateClientConnection(socket, {
		clientType,
		capabilities: {},
	});
}

test("Runtime Test start result RPC is strictly protocol validated", (): void => {
	assert.equal(clientRequestEnvelopeSchema.safeParse({
		protocolVersion: 3,
		type: "request",
		id: "runtime-start-result",
		method: "godot.runtimeTest.start.result",
		params: {
			callId: "godot-runtime-start-00000000-0000-4000-8000-000000000000",
			ok: true,
			result: { online: true },
		},
	}).success, true);
	assert.equal(clientRequestEnvelopeSchema.safeParse({
		protocolVersion: 3,
		type: "request",
		id: "runtime-start-result-invalid",
		method: "godot.runtimeTest.start.result",
		params: { callId: "call", ok: true },
	}).success, false);
});

test("visible Runtime Test launch requires the negotiated local Studio capability", (): void => {
	const studio = createSocket();
	const capableStudio = createSocket();
	const remote = createSocket();
	registerClient(studio, "studio");
	registerStudio(capableStudio);
	registerClient(remote, "studio_remote");
	try {
		assert.equal(getStudioGodotRuntimeControl(studio, "session-runtime", "workspace-runtime"), undefined);
		assert.notEqual(getStudioGodotRuntimeControl(capableStudio, "session-runtime", "workspace-runtime"), undefined);
		assert.equal(getStudioGodotRuntimeControl(remote, "session-runtime", "workspace-runtime"), undefined);
	} finally {
		unregisterClientConnection(studio);
		unregisterClientConnection(capableStudio);
		unregisterClientConnection(remote);
	}
});

test("visible Runtime Test start is bound to its Studio connection and tool identity", async (): Promise<void> => {
	const runtime = new StudioGodotRuntime();
	const owner = createSocket();
	const other = createSocket();
	registerStudio(owner);
	registerStudio(other);
	try {
		const control = runtime.createControl(owner, "session-runtime", "workspace-runtime");
		const pending = control.start({}, { requestId: "request-one", toolCallId: "tool-one" });
		const request = owner.sent[0];
		assert.equal(request?.event, "godot.runtimeTest.start.request");
		assert.throws((): void => runtime.handleResult(other, {
			callId: request!.data.callId,
			ok: true,
			result: { online: true },
		}), /different Studio connection/u);
		runtime.handleResult(owner, {
			callId: request!.data.callId,
			ok: true,
			result: { online: true, visibleWindow: true },
		});
		assert.deepEqual(await pending, { online: true, visibleWindow: true });
		assert.deepEqual(
			await control.start({}, { requestId: "request-one", toolCallId: "tool-one" }),
			{ online: true, visibleWindow: true },
		);
		assert.equal(owner.sent.length, 1);
	} finally {
		runtime.detachSocket(owner);
		runtime.detachSocket(other);
		unregisterClientConnection(owner);
		unregisterClientConnection(other);
	}
});

test("cancelling a visible Runtime Test start notifies Studio and rejects the tool", async (): Promise<void> => {
	const runtime = new StudioGodotRuntime();
	const owner = createSocket();
	registerStudio(owner);
	try {
		const controller = new AbortController();
		const pending = runtime.createControl(owner, "session-runtime", "workspace-runtime").start(
			{},
			{ requestId: "request-cancel", toolCallId: "tool-cancel" },
			controller.signal,
		);
		controller.abort();
		await assert.rejects(pending, /cancelled/u);
		assert.equal(owner.sent.at(-1)?.event, "godot.runtimeTest.start.cancel");
	} finally {
		runtime.detachSocket(owner);
		unregisterClientConnection(owner);
	}
});
