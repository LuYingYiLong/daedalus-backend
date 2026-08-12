import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { GODOT_DIAGNOSTICS_SERVER_ID } from "../../../src/mcp/godot/bridges/diagnostics-bridge.js";
import { GodotEditorBridge } from "../../../src/mcp/godot/bridges/editor-bridge.js";
import { McpHost } from "../../../src/mcp/mcp-host.js";
import { withMcpRequestContext } from "../../../src/mcp/request-context.js";
import { createClientSession } from "../../../src/server/client-session.js";
import { beginSessionRun, bindConnectionToSessionRuntime, finishSessionRun, getActiveSessionRunController, getClientConnection, getConnectionSession, registerClientConnection, registerSessionRunController, subscribeSocketToSession, unregisterClientConnection, updateClientConnection } from "../../../src/server/client-connections.js";
import { handleClientRequest } from "../../../src/server/handlers/client-handlers.js";
import { createGodotRuntimeStatus } from "../../../src/server/godot-runtime-status.js";
import { sendSessionEvent } from "../../../src/server/session-events.js";
import { clearDynamicMcpToolsForWorkspace, getDynamicMcpToolMapping, getDynamicMcpToolNames, replaceDynamicMcpToolsForWorkspace } from "../../../src/tools/dynamic-mcp-tools.js";
import { createRuntimeWorkspace, upsertRuntimeWorkspace } from "../../../src/workspace/registry.js";

type SocketMock = WebSocket & { sent: Array<Record<string, unknown>> };

function createSocket(): SocketMock {
	const sent: Array<Record<string, unknown>> = [];
	return {
		readyState: WebSocket.OPEN,
		sent,
		send(message: string): void {
			sent.push(JSON.parse(message) as Record<string, unknown>);
		},
		close(): void {
			// Handshake rejection is asserted through the response payload.
		}
	} as SocketMock;
}

test("Editor Bridge v4 hello replaces the persisted default with the project workspace", async (): Promise<void> => {
	const socket = createSocket();
	const diagnosticsWorkspace = createRuntimeWorkspace("D:/DaedalusDiagnosticsWorkspace");
	const session = createClientSession(diagnosticsWorkspace);
	registerClientConnection(socket, session);
	let ensuredWorkspaceId: string | undefined;
	const host = {
		async ensureWorkspace(workspace: { id: string }): Promise<void> {
			ensuredWorkspaceId = workspace.id;
		}
	} as McpHost;

	try {
		await handleClientRequest(socket, {
			type: "request",
			id: "hello-project",
			method: "client.hello",
			params: {
				protocolVersion: 3,
				clientType: "godot_editor_bridge",
				clientName: "Daedalus Editor Bridge",
				bridgeVersion: "2.0.0",
				bridgeProtocolVersion: 4,
				godotVersion: "4.0.4",
				workspaceRoot: "D:/GodotProjects/example",
				editorInstanceId: "editor-example",
				capabilities: { editorTools: true }
			}
		}, session, host);

		assert.equal(session.activeWorkspace?.name, "example");
		assert.equal(session.activeWorkspace?.id, ensuredWorkspaceId);
		assert.equal(session.godotProjectPath, session.activeWorkspace?.rootPath);
		assert.equal(getClientConnection(socket)?.workspaceId, session.activeWorkspace?.id);
		assert.equal(getClientConnection(socket)?.workspaceRoot, session.activeWorkspace?.rootPath);
		assert.equal(socket.sent.at(-1)?.ok, true);
	} finally {
		unregisterClientConnection(socket);
	}
});

test("legacy Godot plugin hello is rejected before workspace registration", async (): Promise<void> => {
	const socket = createSocket();
	const session = createClientSession(undefined);
	registerClientConnection(socket, session);
	let workspaceEnsured: boolean = false;
	const host = {
		async ensureWorkspace(): Promise<void> {
			workspaceEnsured = true;
		}
	} as unknown as McpHost;

	try {
		await handleClientRequest(socket, {
			type: "request",
			id: "legacy-hello",
			method: "client.hello",
			params: {
				protocolVersion: 3,
				clientType: "godot_plugin",
				pluginProtocolVersion: 3,
				workspaceRoot: "D:/GodotProjects/legacy"
			}
		}, session, host);
		assert.equal(workspaceEnsured, false);
		assert.equal(session.activeWorkspace, undefined);
		assert.equal(socket.sent.at(-1)?.ok, false);
		assert.equal((socket.sent.at(-1)?.error as Record<string, unknown>).code, "bridge_protocol_unsupported");
		assert.equal(getClientConnection(socket)?.bridgeHandshakeAccepted, false);
	} finally {
		unregisterClientConnection(socket);
	}
});

test("Editor Bridge hello replies only after its workspace MCP initialization completes", async (): Promise<void> => {
	const socket = createSocket();
	const session = createClientSession(undefined);
	registerClientConnection(socket, session);
	let ensureEntered: boolean = false;
	let releaseInitialization: (() => void) | undefined;
	const initialization = new Promise<void>((resolve: () => void): void => {
		releaseInitialization = resolve;
	});
	const host = {
		async ensureWorkspace(): Promise<void> {
			ensureEntered = true;
			await initialization;
		}
	} as unknown as McpHost;

	try {
		const hello = handleClientRequest(socket, {
			type: "request",
			id: "hello-awaits-workspace",
			method: "client.hello",
			params: {
				protocolVersion: 3,
				clientType: "godot_editor_bridge",
				bridgeVersion: "2.0.0",
				bridgeProtocolVersion: 4,
				godotVersion: "4.0.4",
				workspaceRoot: "D:/GodotProjects/example",
				editorInstanceId: "editor-example"
			}
		}, session, host);
		assert.equal(ensureEntered, true);
		assert.equal(socket.sent.length, 0);

		releaseInitialization?.();
		await hello;
		assert.equal(socket.sent.at(-1)?.ok, true);
	} finally {
		unregisterClientConnection(socket);
	}
});

test("studio connection does not replace Godot editor tool target", async (): Promise<void> => {
	const bridge = new GodotEditorBridge();
	const godotSocket = createSocket();
	const studioSocket = createSocket();
	bridge.updateInstanceContext(godotSocket, "workspace-a", "editor-a", {
		activeScenePath: "res://main.tscn"
	}, "Godot A");

	updateClientConnection(registerSocket(studioSocket), {
		clientType: "studio",
		clientName: "Daedalus Studio",
		capabilities: { sessionSubscribe: true, approval: true, inlineDiffView: true }
	});

	const toolPromise = withMcpRequestContext({
		workspaceId: "workspace-a",
		editorInstanceId: "editor-a"
	}, async (): Promise<unknown> => bridge.callTool("apply_scene_patch", {
		operations: [{ type: "set_property" }]
	}));
	const requested = godotSocket.sent.find((message: Record<string, unknown>): boolean => message.event === "editor.tool.requested");
	assert.ok(requested);
	assert.equal(studioSocket.sent.some((message: Record<string, unknown>): boolean => message.event === "editor.tool.requested"), false);
	const data = requested.data as Record<string, unknown>;
	assert.equal(data.editorInstanceId, "editor-a");
	assert.equal(bridge.handleToolResult(String(data.callId), true, { ok: true }, undefined), true);
	const result = await toolPromise;
	assert.deepEqual(result, {
		content: [{
			type: "text",
			text: JSON.stringify({ ok: true, result: { ok: true } }, null, 2)
		}]
	});
});

test("multiple Godot editors require an explicit session editor binding", async (): Promise<void> => {
	const bridge = new GodotEditorBridge();
	const socketA = createSocket();
	const socketB = createSocket();
	bridge.updateInstanceContext(socketA, "workspace-a", "editor-a", {}, "Godot A");
	bridge.updateInstanceContext(socketB, "workspace-a", "editor-b", {}, "Godot B");

	await assert.rejects(
		withMcpRequestContext({ workspaceId: "workspace-a" }, async (): Promise<unknown> => {
			return await bridge.callTool("apply_scene_patch", { operations: [{ type: "set_property" }] });
		}),
		/editor_target_required/
	);

	const toolPromise = withMcpRequestContext({
		workspaceId: "workspace-a",
		editorInstanceId: "editor-b"
	}, async (): Promise<unknown> => bridge.callTool("apply_scene_patch", {
		operations: [{ type: "set_property" }]
	}));
	const requested = socketB.sent.find((message: Record<string, unknown>): boolean => message.event === "editor.tool.requested");
	assert.ok(requested);
	assert.equal(socketA.sent.some((message: Record<string, unknown>): boolean => message.event === "editor.tool.requested"), false);
	const data = requested.data as Record<string, unknown>;
	assert.equal(bridge.handleToolResult(String(data.callId), true, { ok: true }, undefined), true);
	await toolPromise;
});

test("editor tool requests use explicit workspace and editor binding without request context", async (): Promise<void> => {
	const bridge = new GodotEditorBridge();
	const socketA = createSocket();
	const socketB = createSocket();
	bridge.updateInstanceContext(socketA, "workspace-a", "editor-a", {}, "Godot A");
	bridge.updateInstanceContext(socketB, "workspace-b", "editor-b", {}, "Godot B");

	const toolPromise = bridge.callTool("capture_scene_view", { view: "auto" }, "workspace-b", "editor-b");
	const requested = socketB.sent.find((message: Record<string, unknown>): boolean => message.event === "editor.tool.requested");
	assert.ok(requested);
	assert.equal(socketA.sent.some((message: Record<string, unknown>): boolean => message.event === "editor.tool.requested"), false);
	assert.equal(requested.protocolVersion, 3);
	assert.equal(requested.type, "event");
	assert.match(String(requested.eventId), /^event-/u);
	assert.equal(requested.sessionId, "");
	assert.equal(typeof requested.sequence, "number");
	assert.equal(Number.isSafeInteger(requested.sequence), true);
	assert.equal(typeof requested.createdAt, "string");
	const data = requested.data as Record<string, unknown>;
	assert.equal(requested.requestId, data.callId);
	assert.equal(requested.runId, data.callId);
	assert.equal(data.workspaceId, "workspace-b");
	assert.equal(data.editorInstanceId, "editor-b");
	assert.equal(bridge.handleToolResult(String(data.callId), true, { ok: true }, undefined), true);
	await toolPromise;
});

test("filesystem refresh broadcasts to online Godot editors in the workspace", async (): Promise<void> => {
	const bridge = new GodotEditorBridge();
	const socketA = createSocket();
	const socketB = createSocket();
	const socketOther = createSocket();
	bridge.updateInstanceContext(socketA, "workspace-a", "editor-a", {}, "Godot A");
	bridge.updateInstanceContext(socketB, "workspace-a", "editor-b", {}, "Godot B");
	bridge.updateInstanceContext(socketOther, "workspace-b", "editor-other", {}, "Godot Other");

	const refreshPromise = withMcpRequestContext({ workspaceId: "workspace-a" }, async (): Promise<unknown[] | null> => {
		return await bridge.refreshFilesystem(["project.godot"]);
	});
	const requestedA = socketA.sent.find((message: Record<string, unknown>): boolean => message.event === "editor.tool.requested");
	const requestedB = socketB.sent.find((message: Record<string, unknown>): boolean => message.event === "editor.tool.requested");
	assert.ok(requestedA);
	assert.ok(requestedB);
	assert.equal(socketOther.sent.some((message: Record<string, unknown>): boolean => message.event === "editor.tool.requested"), false);

	const dataA = requestedA.data as Record<string, unknown>;
	const dataB = requestedB.data as Record<string, unknown>;
	assert.equal(dataA.toolName, "refresh_filesystem");
	assert.equal(dataB.toolName, "refresh_filesystem");
	assert.deepEqual((dataA.args as Record<string, unknown>).changedPaths, ["project.godot"]);
	assert.deepEqual((dataB.args as Record<string, unknown>).changedPaths, ["project.godot"]);
	assert.equal(bridge.handleToolResult(String(dataA.callId), true, { ok: true, editor: "a" }, undefined), true);
	assert.equal(bridge.handleToolResult(String(dataB.callId), true, { ok: true, editor: "b" }, undefined), true);

	assert.deepEqual(await refreshPromise, [
		{ ok: true, editor: "a" },
		{ ok: true, editor: "b" }
	]);
});

test("diagnostics bridge uses request workspace context without global active workspace", async (): Promise<void> => {
	const host = new McpHost();
	const workspace = upsertRuntimeWorkspace(createRuntimeWorkspace("D:/DaedalusDiagnosticsWorkspace"));

	const statusResource = await withMcpRequestContext({ workspaceId: workspace.id }, async (): Promise<unknown> => {
		return await host.readResource(GODOT_DIAGNOSTICS_SERVER_ID, "godot-diagnostics://status");
	});
	assert.equal(typeof statusResource, "object");
	assert.notEqual(statusResource, null);
	const contents = (statusResource as { contents: Array<{ text: string }> }).contents;
	const status = JSON.parse(contents[0]!.text) as Record<string, unknown>;
	assert.equal(status.workspaceId, workspace.id);
	assert.equal(status.workspaceRoot, workspace.rootPath);
});

test("connected server ids keep Godot editor scoped to the requested workspace", (): void => {
	const host = new McpHost();
	const socket = createSocket();
	host.getEditorBridge().updateInstanceContext(socket, "workspace-b", "editor-b", {}, "Godot B");

	assert.deepEqual(host.getConnectedServerIds("workspace-a"), []);
	assert.deepEqual(host.getConnectedServerIds("workspace-b"), ["godot_editor"]);
});

test("scene view capture is exposed only to editor clients that advertise support", (): void => {
	const bridge = new GodotEditorBridge();
	const socket = createSocket();
	bridge.updateInstanceContext(socket, "workspace-a", "editor-a", {
		capabilities: { sceneViewCapture: true }
	}, "Godot A");
	assert.equal(bridge.supportsTool("capture_scene_view"), true);
	assert.equal(bridge.listTools().tools.some((tool: { name: string }): boolean => tool.name === "capture_scene_view"), true);

	const legacyBridge = new GodotEditorBridge();
	legacyBridge.updateInstanceContext(createSocket(), "workspace-a", "editor-legacy", {}, "Godot Legacy");
	assert.equal(legacyBridge.supportsTool("capture_scene_view"), false);
	assert.equal(legacyBridge.listTools().tools.some((tool: { name: string }): boolean => tool.name === "capture_scene_view"), false);
});

test("Godot runtime status reports editor and diagnostics workspace mismatches", (): void => {
	const host = new McpHost();
	const workspaceA = upsertRuntimeWorkspace(createRuntimeWorkspace("D:/DaedalusRuntimeWorkspaceA"));
	const workspaceB = upsertRuntimeWorkspace(createRuntimeWorkspace("D:/DaedalusRuntimeWorkspaceB"));
	const socket = createSocket();
	host.getEditorBridge().updateInstanceContext(socket, workspaceB.id, "editor-b", {}, "Godot B");
	host.getDiagnosticsBridge().setWorkspace(workspaceB);

	const session = createClientSession(workspaceA);
	session.editorInstanceId = "editor-a";
	const status = createGodotRuntimeStatus(session, host);
	const warnings = status.warnings as Array<{ code: string }>;

	assert.equal(status.sessionWorkspaceId, workspaceA.id);
	assert.equal((status.editor as Record<string, unknown>).onlineForSession, false);
	assert.equal((status.diagnostics as Record<string, unknown>).workspaceMatchesSession, false);
	assert.ok(warnings.some((warning: { code: string }): boolean => warning.code === "editor_instance_missing"));
	assert.ok(warnings.some((warning: { code: string }): boolean => warning.code === "bound_editor_offline"));
	assert.ok(warnings.some((warning: { code: string }): boolean => warning.code === "diagnostics_workspace_mismatch"));
});

test("session events broadcast to subscribed frontend sockets once", (): void => {
	const originSocket = createSocket();
	const studioSocket = createSocket();
	const originSession = createClientSession(undefined);
	const studioSession = createClientSession(undefined);
	originSession.sessionId = "session-multi-client";
	studioSession.sessionId = "session-multi-client";
	registerClientConnection(originSocket, originSession);
	registerClientConnection(studioSocket, studioSession);
	subscribeSocketToSession(originSocket, "session-multi-client");
	subscribeSocketToSession(studioSocket, "session-multi-client");

	sendSessionEvent(originSocket, "request-1", originSession, "client.connected", {
		text: "done"
	});

	assert.equal(originSocket.sent.filter((message: Record<string, unknown>): boolean => message.event === "client.connected").length, 1);
	assert.equal(studioSocket.sent.filter((message: Record<string, unknown>): boolean => message.event === "client.connected").length, 1);
});

test("session terminal errors are emitted once per request and message", (): void => {
	const originSocket = createSocket();
	const studioSocket = createSocket();
	const originSession = createClientSession(undefined);
	const studioSession = createClientSession(undefined);
	originSession.sessionId = "session-terminal-error";
	studioSession.sessionId = "session-terminal-error";
	registerClientConnection(originSocket, originSession);
	registerClientConnection(studioSocket, studioSession);
	subscribeSocketToSession(originSocket, "session-terminal-error");
	subscribeSocketToSession(studioSocket, "session-terminal-error");

	sendSessionEvent(originSocket, "request-error", originSession, "agent.run.error", {
		runId: "workflow-a",
		code: "agent_run_error",
		message: "oldText not found in file"
	});
	sendSessionEvent(originSocket, "request-error", originSession, "agent.run.error", {
		runId: "request-error",
		code: "provider_error",
		message: "oldText not found in file"
	});

	assert.equal(originSocket.sent.filter((message: Record<string, unknown>): boolean => message.event === "agent.run.state").length, 1);
	assert.equal(studioSocket.sent.filter((message: Record<string, unknown>): boolean => message.event === "agent.run.state").length, 1);
	assert.equal(originSocket.sent.some((message: Record<string, unknown>): boolean => message.event === "agent.run.error"), false);
	assert.equal(
		originSocket.sent.find((message: Record<string, unknown>): boolean => message.event === "agent.run.state")?.protocolVersion,
		3
	);
	assert.equal(
		(originSocket.sent.find((message: Record<string, unknown>): boolean => message.event === "agent.run.state")?.data as { stage?: string }).stage,
		"failed"
	);
});

test("session terminal cancellations are emitted once per request", (): void => {
	const originSocket = createSocket();
	const studioSocket = createSocket();
	const originSession = createClientSession(undefined);
	const studioSession = createClientSession(undefined);
	originSession.sessionId = "session-terminal-cancel";
	studioSession.sessionId = "session-terminal-cancel";
	registerClientConnection(originSocket, originSession);
	registerClientConnection(studioSocket, studioSession);
	subscribeSocketToSession(originSocket, "session-terminal-cancel");
	subscribeSocketToSession(studioSocket, "session-terminal-cancel");

	sendSessionEvent(originSocket, "request-cancel", originSession, "agent.run.cancelled", {
		runId: "request-cancel",
		requestId: "request-cancel",
		reason: "cancelled"
	});
	sendSessionEvent(originSocket, "request-cancel", originSession, "agent.run.cancelled", {
		runId: "request-cancel",
		requestId: "request-cancel",
		reason: "cancelled"
	});

	assert.equal(originSocket.sent.filter((message: Record<string, unknown>): boolean => message.event === "agent.run.state").length, 1);
	assert.equal(studioSocket.sent.filter((message: Record<string, unknown>): boolean => message.event === "agent.run.state").length, 1);
	assert.equal(originSocket.sent.some((message: Record<string, unknown>): boolean => message.event === "agent.run.cancelled"), false);
	assert.equal(
		originSocket.sent.find((message: Record<string, unknown>): boolean => message.event === "agent.run.state")?.protocolVersion,
		3
	);
	assert.equal(
		(originSocket.sent.find((message: Record<string, unknown>): boolean => message.event === "agent.run.state")?.data as { stage?: string }).stage,
		"cancelled"
	);
});

test("opening the same session binds frontend connections to one runtime", (): void => {
	const firstSocket = createSocket();
	const secondSocket = createSocket();
	const firstRuntime = createClientSession(undefined);
	const secondCandidate = createClientSession(undefined);
	firstRuntime.sessionId = "session-shared-runtime";
	secondCandidate.sessionId = "session-shared-runtime";
	registerClientConnection(firstSocket, firstRuntime);
	registerClientConnection(secondSocket, secondCandidate);

	const boundFirst = bindConnectionToSessionRuntime(firstSocket, "session-shared-runtime", firstRuntime);
	const boundSecond = bindConnectionToSessionRuntime(secondSocket, "session-shared-runtime", secondCandidate);
	boundFirst.messages.push({ role: "user", content: "shared" });

	assert.equal(boundFirst, boundSecond);
	assert.equal(getConnectionSession(secondSocket)?.messages[0]?.content, "shared");
});

test("session run lock is shared across frontend connections", (): void => {
	assert.deepEqual(beginSessionRun("session-run-lock", "request-a"), { ok: true });
	assert.deepEqual(beginSessionRun("session-run-lock", "request-b"), {
		ok: false,
		activeRequestId: "request-a"
	});
	finishSessionRun("session-run-lock", "request-b");
	assert.deepEqual(beginSessionRun("session-run-lock", "request-c"), {
		ok: false,
		activeRequestId: "request-a"
	});
	finishSessionRun("session-run-lock", "request-a");
	assert.deepEqual(beginSessionRun("session-run-lock", "request-d"), { ok: true });
	finishSessionRun("session-run-lock", "request-d");
});

test("session run controller follows the active session run", (): void => {
	const controller = new AbortController();
	assert.deepEqual(beginSessionRun("session-run-controller", "request-a"), { ok: true });
	registerSessionRunController("session-run-controller", "request-a", controller);

	assert.equal(getActiveSessionRunController("session-run-controller", "request-a")?.controller, controller);
	assert.equal(getActiveSessionRunController("session-run-controller")?.requestId, "request-a");
	assert.equal(getActiveSessionRunController("session-run-controller", "request-b"), undefined);

	finishSessionRun("session-run-controller", "request-a");
	assert.equal(getActiveSessionRunController("session-run-controller"), undefined);
});

test("custom MCP dynamic tools are scoped by workspace context", async (): Promise<void> => {
	replaceDynamicMcpToolsForWorkspace("workspace-a", [{
		serverId: "custom-a",
		serverName: "Shared Tools",
		toolName: "echo"
	}]);
	replaceDynamicMcpToolsForWorkspace("workspace-b", [{
		serverId: "custom-b",
		serverName: "Shared Tools",
		toolName: "echo"
	}]);

	try {
		const workspaceAToolNames: string[] = getDynamicMcpToolNames("workspace-a");
		const workspaceBToolNames: string[] = getDynamicMcpToolNames("workspace-b");
		assert.equal(workspaceAToolNames.length, 1);
		assert.equal(workspaceBToolNames.length, 1);
		assert.notEqual(workspaceAToolNames[0], workspaceBToolNames[0]);

		const workspaceAMapping = getDynamicMcpToolMapping(workspaceAToolNames[0]!, "workspace-a");
		const workspaceBMapping = getDynamicMcpToolMapping(workspaceBToolNames[0]!, "workspace-b");
		assert.deepEqual(workspaceAMapping, { serverId: "custom-a", toolName: "echo" });
		assert.deepEqual(workspaceBMapping, { serverId: "custom-b", toolName: "echo" });

		const hiddenAcrossWorkspace = getDynamicMcpToolMapping(workspaceAToolNames[0]!, "workspace-b");
		assert.equal(hiddenAcrossWorkspace, undefined);
	} finally {
		clearDynamicMcpToolsForWorkspace("workspace-a");
		clearDynamicMcpToolsForWorkspace("workspace-b");
	}
});

function registerSocket(socket: SocketMock): WebSocket {
	registerClientConnection(socket, createClientSession(undefined));
	return socket;
}
