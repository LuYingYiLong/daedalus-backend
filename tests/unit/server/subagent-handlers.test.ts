import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import type { McpHost } from "../../../src/mcp/mcp-host.js";
import type { ClientRequest } from "../../../src/protocol/types.js";
import type { ClientSession } from "../../../src/server/client-session.js";
import {
	createSubagentRequestHandler,
	type SubagentRequestOperations
} from "../../../src/server/handlers/subagent-handlers.js";
import {
	REQUEST_HANDLER_METHODS,
	REQUEST_HANDLERS
} from "../../../src/server/request-dispatcher.js";

type SentResponse = {
	id: string;
	ok: boolean;
	result?: unknown;
	error?: { code: string; message: string };
};

function createSocket(messages: SentResponse[]): WebSocket {
	return {
		readyState: WebSocket.OPEN,
		send: (value: string): void => {
			messages.push(JSON.parse(value) as SentResponse);
		}
	} as unknown as WebSocket;
}

function createOperations(
	overrides: Partial<SubagentRequestOperations> = {}
): { operations: SubagentRequestOperations; calls: Array<{ operation: string; input: Record<string, unknown> }> } {
	const calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
	const record = (operation: string, input: object): Record<string, unknown> => {
		calls.push({ operation, input: input as Record<string, unknown> });
		return { operation };
	};
	return {
		calls,
		operations: {
			getSubagentGraph: (input) => record("get", input),
			listSubagentGraphs: (input) => record("list", input),
			cancelSubagentGraph: (input) => record("cancel", input),
			retrySubagentNode: (input) => record("retry", input),
			previewSubagentNodeMerge: (input) => record("merge.preview", input),
			applySubagentNodeMerge: (input) => record("merge.apply", input),
			...overrides
		}
	};
}

test("Subagent RPC handler routes all operations with request and runtime context", async (): Promise<void> => {
	const messages: SentResponse[] = [];
	const socket: WebSocket = createSocket(messages);
	const session = { sessionId: "session-one" } as ClientSession;
	const mcpHost = {} as McpHost;
	const { operations, calls } = createOperations();
	const handler = createSubagentRequestHandler(operations);
	const requests: ClientRequest[] = [
		{ type: "request", id: "get", method: "agent.subgraph.get", params: { graphId: "graph-one" } },
		{ type: "request", id: "list", method: "agent.subgraph.list", params: { sessionId: "session-one", status: "running", limit: 20, cursor: "cursor-one" } },
		{ type: "request", id: "cancel", method: "agent.subgraph.cancel", params: { graphId: "graph-one", nodeId: "node-one", reason: "stop" } },
		{ type: "request", id: "retry", method: "agent.subgraph.retry", params: { graphId: "graph-one", nodeId: "node-one" } },
		{ type: "request", id: "preview", method: "agent.subgraph.merge.preview", params: { graphId: "graph-one", nodeId: "node-one" } },
		{ type: "request", id: "apply", method: "agent.subgraph.merge.apply", params: { graphId: "graph-one", nodeId: "node-one", fingerprint: "a".repeat(64) } }
	];

	for (const request of requests) {
		await handler(socket, request, session, mcpHost);
	}

	assert.deepEqual(calls.map((call) => call.operation), ["get", "list", "cancel", "retry", "merge.preview", "merge.apply"]);
	for (const call of calls) {
		assert.equal(call.input.socket, socket);
		assert.equal(call.input.session, session);
		assert.equal(call.input.mcpHost, mcpHost);
	}
	assert.equal(calls[1]?.input.sessionId, "session-one");
	assert.equal(calls[1]?.input.status, "running");
	assert.equal(calls[2]?.input.reason, "stop");
	assert.equal(calls[5]?.input.fingerprint, "a".repeat(64));
	assert.deepEqual(messages.map((message) => ({ id: message.id, ok: message.ok, result: message.result })), [
		{ id: "get", ok: true, result: { operation: "get" } },
		{ id: "list", ok: true, result: { operation: "list" } },
		{ id: "cancel", ok: true, result: { operation: "cancel" } },
		{ id: "retry", ok: true, result: { operation: "retry" } },
		{ id: "preview", ok: true, result: { operation: "merge.preview" } },
		{ id: "apply", ok: true, result: { operation: "merge.apply" } }
	]);
});

test("Subagent list rejects a graph session outside the active session", async (): Promise<void> => {
	const messages: SentResponse[] = [];
	const { operations, calls } = createOperations();
	const handler = createSubagentRequestHandler(operations);

	await handler(
		createSocket(messages),
		{ type: "request", id: "list", method: "agent.subgraph.list", params: { sessionId: "other-session" } },
		{ sessionId: "session-one" } as ClientSession,
		{} as McpHost
	);

	assert.equal(calls.length, 0);
	assert.deepEqual(messages[0], {
		protocolVersion: 3,
		type: "response",
		id: "list",
		ok: false,
		error: {
			code: "subgraph_session_mismatch",
			message: "The requested Subagent graph session is not active."
		}
	});
});

test("Subagent RPC handler preserves runtime error codes", async (): Promise<void> => {
	const messages: SentResponse[] = [];
	const { operations } = createOperations({
		getSubagentGraph: async (): Promise<never> => {
			throw Object.assign(new Error("Unknown Subagent graph."), { code: "subgraph_not_found" });
		}
	});
	const handler = createSubagentRequestHandler(operations);

	await handler(
		createSocket(messages),
		{ type: "request", id: "get", method: "agent.subgraph.get", params: { graphId: "missing" } },
		{ sessionId: "session-one" } as ClientSession,
		{} as McpHost
	);

	assert.equal(messages[0]?.ok, false);
	assert.deepEqual(messages[0]?.error, {
		code: "subgraph_not_found",
		message: "Unknown Subagent graph."
	});
});

test("dispatcher registers every Subagent RPC on the Subagent handler", (): void => {
	const methods = [
		"agent.subgraph.get",
		"agent.subgraph.list",
		"agent.subgraph.cancel",
		"agent.subgraph.retry",
		"agent.subgraph.merge.preview",
		"agent.subgraph.merge.apply"
	] as const;

	for (const method of methods) {
		assert.equal(REQUEST_HANDLER_METHODS.includes(method), true);
		assert.equal(typeof REQUEST_HANDLERS.get(method), "function");
	}
	assert.equal(new Set(methods.map((method) => REQUEST_HANDLERS.get(method))).size, 1);
});
