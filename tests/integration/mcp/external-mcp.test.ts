import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer, WebSocket } from "ws";
import type { ClientRequest } from "../../../src/protocol/types.js";
import { clientRequestSchema } from "../../../src/protocol/schema.js";
import type { McpHost } from "../../../src/mcp/mcp-host.js";
import {
	createExternalMcpConfig,
	getExternalMcpToolNames,
	EXTERNAL_MCP_MINIMAL_TOOL_NAMES,
	EXTERNAL_MCP_LITE_TOOL_NAMES,
	EXTERNAL_MCP_FULL_TOOL_NAMES
} from "../../../src/mcp/external/config.js";
import { ExternalMcpRpcClient } from "../../../src/mcp/external/rpc-client.js";
import { createClientSession } from "../../../src/server/client-session.js";
import { handleToolRequest } from "../../../src/server/handlers/tool-handlers.js";
import { setApprovalMode } from "../../../src/approval-settings-store.js";

function createCaptureSocket(): { socket: WebSocket; messages: Record<string, unknown>[] } {
	const messages: Record<string, unknown>[] = [];
	const socket = {
		readyState: WebSocket.OPEN,
		send(data: string): void {
			messages.push(JSON.parse(data) as Record<string, unknown>);
		}
	} as WebSocket;
	return { socket, messages };
}

function getOnlyResponse(messages: Record<string, unknown>[]): Record<string, unknown> {
	assert.equal(messages.length, 1);
	return messages[0]!;
}

test("external MCP config defaults to lite and supports CLI/env mode overrides", (): void => {
	assert.equal(createExternalMcpConfig({}, []).mode, "lite");
	assert.equal(createExternalMcpConfig({ DAEDALUS_MCP_MODE: "minimal" }, []).mode, "minimal");
	assert.equal(createExternalMcpConfig({ DAEDALUS_MCP_MODE: "minimal" }, ["--full"]).mode, "full");
	assert.equal(createExternalMcpConfig({}, ["--mode", "lite", "--backend-url", "ws://127.0.0.1:39999"]).backendUrl, "ws://127.0.0.1:39999");
	assert.throws((): void => {
		createExternalMcpConfig({ DAEDALUS_MCP_MODE: "unsafe" }, []);
	}, /Invalid external MCP mode/);
});

test("external MCP manifest grows by mode without exposing automation tools", (): void => {
	assert.deepEqual(getExternalMcpToolNames("minimal"), EXTERNAL_MCP_MINIMAL_TOOL_NAMES);
	assert.deepEqual(getExternalMcpToolNames("lite"), EXTERNAL_MCP_LITE_TOOL_NAMES);
	assert.deepEqual(getExternalMcpToolNames("full"), EXTERNAL_MCP_FULL_TOOL_NAMES);
	assert.ok(!getExternalMcpToolNames("full").includes("daedalus_approve_matching_tool" as never));
	assert.ok(!getExternalMcpToolNames("minimal").includes("daedalus_send_chat" as never));
	assert.ok(!getExternalMcpToolNames("lite").includes("daedalus_approve_plan" as never));
	assert.ok(getExternalMcpToolNames("full").includes("daedalus_approve_plan"));
});

test("external MCP RPC client sends hello, waits for events and times out predictably", async (): Promise<void> => {
	const server = new WebSocketServer({ port: 0 });
	await once(server, "listening");
	const address = server.address() as AddressInfo;
	const backendUrl = `ws://127.0.0.1:${address.port}`;
	const receivedMethods: string[] = [];
	const receivedProtocolVersions: number[] = [];
	let helloCapabilities: Record<string, unknown> | undefined;

	server.on("connection", (socket: WebSocket): void => {
		socket.on("message", (raw: Buffer): void => {
			const request = JSON.parse(raw.toString()) as { protocolVersion: number; id: string; method: string; params?: Record<string, unknown> };
			receivedMethods.push(request.method);
			receivedProtocolVersions.push(request.protocolVersion);
			if (request.method === "client.hello") {
				helloCapabilities = request.params?.capabilities as Record<string, unknown> | undefined;
			}
			if (request.method === "ai.chat") {
				socket.send(JSON.stringify({ type: "response", id: request.id, ok: true, result: { accepted: true } }));
				setTimeout((): void => {
					socket.send(JSON.stringify({
						type: "event",
						event: "plan.generated",
						requestId: request.id,
						data: { planId: "plan-external" }
					}));
				}, 10);
				return;
			}
			socket.send(JSON.stringify({ type: "response", id: request.id, ok: true, result: { method: request.method } }));
		});
	});

	const client = new ExternalMcpRpcClient(createExternalMcpConfig({
		DAEDALUS_MCP_BACKEND_URL: backendUrl
	}, []));
	try {
		const requestId: string = await client.sendRequestNoWait("ai.chat", { message: "plan", mode: "plan" });
		const event = await client.waitForEvent({
			eventName: "plan.generated",
			requestId,
			planId: "plan-external",
			timeoutMs: 1000
		});
		assert.equal(event.raw.event, "plan.generated");
		assert.ok(receivedMethods.includes("client.hello"));
		assert.ok(receivedMethods.includes("ai.chat"));
		assert.deepEqual(helloCapabilities, { externalMcp: true });
		assert.ok(receivedProtocolVersions.length > 0);
		assert.ok(receivedProtocolVersions.every((version: number): boolean => version === 3));

		await assert.rejects(
			client.waitForEvent({ eventName: "never.happens", timeoutMs: 20 }),
			/Timed out waiting for event/
		);
	} finally {
		await client.close();
		await new Promise<void>((resolve): void => server.close((): void => resolve()));
	}
});

test("tool catalog RPC is protocol-validated and filters by external MCP mode", async (): Promise<void> => {
	const parsed = clientRequestSchema.parse({
		type: "request",
		id: "catalog-1",
		method: "tool.catalog.list",
		params: { mode: "lite" }
	}) as ClientRequest;
	const { socket, messages } = createCaptureSocket();
	const session = createClientSession(undefined);

	await handleToolRequest(socket, parsed, session, {} as McpHost);

	const response = getOnlyResponse(messages);
	assert.equal(response.ok, true);
	const result = response.result as { tools: Array<{ name: string; risk: string }> };
	const names: string[] = result.tools.map((tool): string => tool.name);
	assert.ok(names.includes("mcp_godot_read_text_file"));
	assert.ok(names.includes("mcp_godot_propose_create_text_file"));
	assert.ok(!names.includes("mcp_godot_create_text_file"));
	assert.ok(result.tools.every((tool): boolean => tool.risk === "read" || tool.risk === "verify" || tool.risk === "propose"));
});

test("tool execute RPC denies unknown and mode-disallowed tools before execution", async (): Promise<void> => {
	const session = createClientSession(undefined);
	const mcpHost = {} as McpHost;

	{
		const { socket, messages } = createCaptureSocket();
		await handleToolRequest(socket, {
			type: "request",
			id: "unknown",
			method: "tool.execute",
			params: { mode: "full", toolName: "mcp_missing_tool", args: {} }
		} as ClientRequest, session, mcpHost);
		const response = getOnlyResponse(messages);
		assert.equal(response.ok, false);
		assert.deepEqual(response.error, { code: "unknown_tool", message: "Unknown tool: mcp_missing_tool" });
	}

	{
		const { socket, messages } = createCaptureSocket();
		await handleToolRequest(socket, {
			type: "request",
			id: "lite-write",
			method: "tool.execute",
			params: { mode: "lite", toolName: "mcp_godot_create_text_file", args: { relativePath: "scripts/player.gd", content: "extends Node\n" } }
		} as ClientRequest, session, mcpHost);
		const response = getOnlyResponse(messages);
		assert.equal(response.ok, false);
		assert.equal((response.error as { code: string }).code, "tool_not_allowed");
		assert.equal(session.approvalGateway.listPending().length, 0);
	}
});

test("tool execute RPC returns approval_required for manual write tools in full mode", async (): Promise<void> => {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const appDataDir: string = await mkdtemp(join(tmpdir(), "daedalus-external-mcp-approval-"));
	const { socket, messages } = createCaptureSocket();
	const session = createClientSession(undefined);

	try {
		process.env.USERPROFILE = appDataDir;
		await setApprovalMode("manual");

		await handleToolRequest(socket, {
			type: "request",
			id: "write",
			method: "tool.execute",
			params: {
				mode: "full",
				toolName: "mcp_godot_create_text_file",
				args: { relativePath: "scripts/player.gd", content: "extends Node\n" }
			}
		} as ClientRequest, session, {} as McpHost);

		const response = getOnlyResponse(messages);
		assert.equal(response.ok, true);
		const result = response.result as { status: string; approvalId: string; toolName: string };
		assert.equal(result.status, "approval_required");
		assert.equal(result.toolName, "mcp_godot_create_text_file");
		assert.match(result.approvalId, /^approval-/u);
		assert.equal(session.approvalGateway.listPending().length, 1);
	} finally {
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		await rm(appDataDir, { recursive: true, force: true });
	}
});
