import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { GodotRuntimeTestBridge } from "../../../src/mcp/godot/bridges/runtime-test-bridge.js";
import { withMcpRequestContext } from "../../../src/mcp/request-context.js";

type SocketFixture = WebSocket & {
	sent: Array<Record<string, unknown>>;
	closed: boolean;
};

function createSocket(): SocketFixture {
	const sent: Array<Record<string, unknown>> = [];
	const socket = {
		readyState: WebSocket.OPEN,
		sent,
		closed: false,
		send(value: string): void {
			sent.push(JSON.parse(value) as Record<string, unknown>);
		},
		close(): void {
			socket.closed = true;
		},
	} as unknown as SocketFixture;
	return socket;
}

test("Godot runtime test sessions bind token, workspace, instance, and tool result", async (): Promise<void> => {
	const bridge = new GodotRuntimeTestBridge();
	const owner = createSocket();
	const runtime = createSocket();
	const created = bridge.createSession(owner, "workspace:source", "C:/fixture/godot-project", "workspace");

	assert.throws((): void => {
		bridge.validateHello({
			testSessionId: created.testSessionId,
			testSessionToken: "wrong-token",
			runtimeInstanceId: "runtime-one",
			workspaceRoot: "C:/fixture/godot-project",
		});
	}, /runtime_test_token_invalid/u);

	bridge.attachRuntime(runtime, {
		testSessionId: created.testSessionId,
		testSessionToken: created.token,
		runtimeInstanceId: "runtime-one",
		workspaceRoot: "C:/fixture/godot-project",
	});
	bridge.heartbeat(runtime, {
		testSessionId: created.testSessionId,
		runtimeInstanceId: "runtime-one",
		treeRevision: 3,
		scenePath: "res://test.tscn",
	});

	const pending = bridge.callTool("observe", {}, "workspace:source");
	const event = runtime.sent.at(-1)!;
	const data = event.data as Record<string, unknown>;
	assert.equal(event.event, "godot.runtime.tool.requested");
	assert.equal(data.toolName, "observe");
	assert.equal(bridge.handleToolResult(runtime, {
		callId: String(data.callId),
		testSessionId: created.testSessionId,
		runtimeInstanceId: "runtime-one",
		ok: true,
		result: { ok: true, observationId: "observation-one", nodes: [] },
	}), true);
	const result = await pending;
	assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /observation-one/u);
	assert.equal(bridge.isActiveSession(created.testSessionId), true);
	assert.equal(bridge.isActiveSession(created.testSessionId, "workspace"), true);
	assert.equal(bridge.isActiveSession(created.testSessionId, "another-workspace"), false);

	assert.equal(bridge.stopSession(owner, created.testSessionId), true);
	assert.equal(bridge.isActiveSession(created.testSessionId), false);
	assert.equal(runtime.closed, true);
});

test("Godot runtime tools reject unknown actions and stale instance selection before forwarding", async (): Promise<void> => {
	const bridge = new GodotRuntimeTestBridge();
	const owner = createSocket();
	const runtime = createSocket();
	const created = bridge.createSession(owner, "workspace:source", "C:/fixture/godot-project");
	bridge.attachRuntime(runtime, {
		testSessionId: created.testSessionId,
		testSessionToken: created.token,
		runtimeInstanceId: "runtime-one",
		workspaceRoot: "C:/fixture/godot-project",
	});
	bridge.heartbeat(runtime, {
		testSessionId: created.testSessionId,
		runtimeInstanceId: "runtime-one",
		treeRevision: 1,
	});

	await assert.rejects(
		bridge.callTool("action", {
			testSessionId: created.testSessionId,
			runtimeInstanceId: "runtime-one",
			observationId: "observation-one",
			nodeId: "node-one",
			actionId: "action-one",
			action: { type: "arbitrary_script", source: "queue_free()" },
		}, "workspace:source"),
		/runtime_action_unsupported/u,
	);
	await assert.rejects(
		bridge.callTool("observe", {
			testSessionId: created.testSessionId,
			runtimeInstanceId: "runtime-two",
		}, "workspace:source"),
		/runtime_test_instance_mismatch/u,
	);
	bridge.stopSession(owner, created.testSessionId);
});

test("Godot runtime tool cancellation preserves the originating run identity", async (): Promise<void> => {
	const bridge = new GodotRuntimeTestBridge();
	const owner = createSocket();
	const runtime = createSocket();
	const created = bridge.createSession(owner, "workspace:source", "C:/fixture/godot-project");
	bridge.attachRuntime(runtime, {
		testSessionId: created.testSessionId,
		testSessionToken: created.token,
		runtimeInstanceId: "runtime-one",
		workspaceRoot: "C:/fixture/godot-project",
	});
	bridge.heartbeat(runtime, {
		testSessionId: created.testSessionId,
		runtimeInstanceId: "runtime-one",
		treeRevision: 1,
	});

	const abortController = new AbortController();
	const pending = withMcpRequestContext({
		sessionId: "session-one",
		requestId: "request-one",
		runId: "run-one",
		toolCallId: "tool-call-one",
	}, async () => await bridge.callTool("wait", {
		testSessionId: created.testSessionId,
		runtimeInstanceId: "runtime-one",
		observationId: "observation-one",
		nodeId: "node-one",
		assertion: { property: "visibleInTree", equals: true },
	}, "workspace:source", abortController.signal));
	const requestEvent = runtime.sent.at(-1)!;
	assert.equal(requestEvent.event, "godot.runtime.tool.requested");
	assert.equal(requestEvent.sessionId, "session-one");
	assert.equal(requestEvent.requestId, "request-one");
	assert.equal(requestEvent.runId, "run-one");
	assert.equal((requestEvent.data as Record<string, unknown>).toolCallId, "tool-call-one");

	abortController.abort();
	await assert.rejects(pending, /runtime_tool_cancelled/u);
	const cancelledEvent = runtime.sent.at(-1)!;
	assert.equal(cancelledEvent.event, "godot.runtime.tool.cancelled");
	assert.equal(cancelledEvent.sessionId, "session-one");
	assert.equal(cancelledEvent.requestId, "request-one");
	assert.equal(cancelledEvent.runId, "run-one");
	assert.equal((cancelledEvent.data as Record<string, unknown>).toolCallId, "tool-call-one");
	assert.equal((cancelledEvent.data as Record<string, unknown>).reason, "runtime_tool_cancelled");
	bridge.stopSession(owner, created.testSessionId);
});

test("Godot runtime screenshots remain bound to one observation and are cleared by a new observation", async (): Promise<void> => {
	const bridge = new GodotRuntimeTestBridge();
	const owner = createSocket();
	const runtime = createSocket();
	const created = bridge.createSession(owner, "workspace:source", "C:/fixture/godot-project");
	bridge.attachRuntime(runtime, {
		testSessionId: created.testSessionId,
		testSessionToken: created.token,
		runtimeInstanceId: "runtime-one",
		workspaceRoot: "C:/fixture/godot-project",
	});
	bridge.heartbeat(runtime, {
		testSessionId: created.testSessionId,
		runtimeInstanceId: "runtime-one",
		treeRevision: 1,
	});

	const screenshotPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
	const screenshotPending = bridge.callTool("screenshot", {
		testSessionId: created.testSessionId,
		runtimeInstanceId: "runtime-one",
		observationId: "observation-one",
	}, "workspace:source");
	const screenshotEvent = runtime.sent.at(-1)!;
	const screenshotData = screenshotEvent.data as Record<string, unknown>;
	bridge.handleToolResult(runtime, {
		callId: String(screenshotData.callId),
		testSessionId: created.testSessionId,
		runtimeInstanceId: "runtime-one",
		ok: true,
		result: {
			ok: true,
			observationId: "observation-one",
			mimeType: "image/png",
			width: 1,
			height: 1,
			byteLength: screenshotPng.byteLength,
			data: screenshotPng.toString("base64"),
		},
	});
	const screenshotResult = await screenshotPending;
	assert.equal(screenshotResult.content[1]?.type, "image");
	const reference = bridge.getScreenshotReference(created.testSessionId, "runtime-one", "observation-one");
	assert.equal(reference.source.kind, "godot_runtime");
	assert.deepEqual(bridge.readScreenshot(created.testSessionId, "runtime-one", "observation-one"), screenshotPng);

	const observePending = bridge.callTool("observe", {}, "workspace:source");
	const observeEvent = runtime.sent.at(-1)!;
	const observeData = observeEvent.data as Record<string, unknown>;
	bridge.handleToolResult(runtime, {
		callId: String(observeData.callId),
		testSessionId: created.testSessionId,
		runtimeInstanceId: "runtime-one",
		ok: true,
		result: { ok: true, observationId: "observation-two", nodes: [] },
	});
	await observePending;
	assert.throws(
		(): Buffer => bridge.readScreenshot(created.testSessionId, "runtime-one", "observation-one"),
		/runtime_screenshot_stale/u,
	);
	bridge.stopSession(owner, created.testSessionId);
});
