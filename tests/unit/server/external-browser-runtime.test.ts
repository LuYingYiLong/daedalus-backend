import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import type { ClientSession } from "../../../src/server/client-session.js";
import {
	registerClientConnection,
	updateClientConnection,
	unregisterClientConnection,
} from "../../../src/server/client-connections.js";
import {
	beginExternalBrowserTurn,
	externalBrowserControl,
	finishExternalBrowserTurn,
} from "../../../src/server/external-browser-runtime.js";
import { studioBrowserRuntime } from "../../../src/server/studio-browser-runtime.js";

test("a failed external connection never falls back to the embedded browser", async (t) => {
	const socket = {
		readyState: WebSocket.OPEN,
		send() {},
	} as unknown as WebSocket;
	const session = { sessionId: "browser-routing-fixture" } as ClientSession;
	registerClientConnection(socket, session);
	updateClientConnection(socket, {
		clientType: "studio",
		capabilities: { externalBrowser: true, browserTools: true },
	});
	let embeddedCalls = 0;
	const control = externalBrowserControl(socket, session.sessionId!, {
		execute: async () => {
			embeddedCalls++;
			return { embedded: true };
		},
	});
	const controller = new AbortController();
	t.mock.method(studioBrowserRuntime, "forwardExternal", async () => {
		throw new Error("browser_not_connected");
	});
	try {
		await beginExternalBrowserTurn(
			socket,
			session,
			"run",
			"turn",
			"Inspect https://example.test/form",
			{ provider: "moonshot", apiKey: "fixture" },
			controller,
			true,
			true,
		);
		assert.deepEqual(await control.execute("mcp_browser_observe", {}), {
			embedded: true,
		});
		await assert.rejects(
			control.execute(
				"mcp_browser_connect",
				{ url: "https://example.test/form" },
				controller.signal,
				{ requestId: "run", toolCallId: "connect" },
			),
			/browser_not_connected/,
		);
		await assert.rejects(
			control.execute(
				"mcp_browser_navigate",
				{ url: "https://example.test/form" },
				controller.signal,
			),
			/browser_external_target_required/,
		);
		assert.equal(embeddedCalls, 1);
	} finally {
		finishExternalBrowserTurn(socket, session.sessionId!, "run", true);
		unregisterClientConnection(socket);
	}
});
