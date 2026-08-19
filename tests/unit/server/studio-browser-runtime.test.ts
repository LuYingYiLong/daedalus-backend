import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { clientRequestEnvelopeSchema } from "../../../src/protocol/schema.js";
import { StudioBrowserRuntime } from "../../../src/server/studio-browser-runtime.js";

type FakeSocket = WebSocket & { sent: unknown[] };

function createSocket(): FakeSocket {
	const sent: unknown[] = [];
	return {
		readyState: WebSocket.OPEN,
		sent,
		send(value: string): void { sent.push(JSON.parse(value) as unknown); }
	} as unknown as FakeSocket;
}

test("browser capability and result RPC payloads are protocol validated", (): void => {
	assert.equal(clientRequestEnvelopeSchema.safeParse({
		protocolVersion: 3,
		type: "request",
		id: "capability",
		method: "client.capabilities.update",
		params: { capabilities: { browserTools: true } }
	}).success, true);
	assert.equal(clientRequestEnvelopeSchema.safeParse({
		protocolVersion: 3,
		type: "request",
		id: "result",
		method: "browser.tool.result",
		params: { callId: "call", ok: true, result: { title: "Example" } }
	}).success, true);
});

test("browser runtime binds results to the requesting Studio socket", async (): Promise<void> => {
	const runtime = new StudioBrowserRuntime();
	const owner = createSocket();
	const other = createSocket();
	const pending = runtime.createControl(owner, "session-a").execute("mcp_browser_observe", {});
	const request = owner.sent[0] as { data: { callId: string }; event: string };
	assert.equal(request.event, "browser.tool.request");
	assert.throws((): void => runtime.handleResult(other, {
		callId: request.data.callId,
		ok: true,
		result: {}
	}), /different Studio connection/u);
	runtime.handleResult(owner, {
		callId: request.data.callId,
		ok: true,
		result: { title: "Example" }
	});
	assert.deepEqual(await pending, { title: "Example" });
});

test("browser runtime rejects pending calls when Studio disconnects", async (): Promise<void> => {
	const runtime = new StudioBrowserRuntime();
	const owner = createSocket();
	const pending = runtime.createControl(owner, "session-a").execute("mcp_browser_observe", {});
	runtime.detachSocket(owner);
	await assert.rejects(pending, /disconnected/u);
});
