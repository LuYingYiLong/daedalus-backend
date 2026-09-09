import type WebSocket from "ws";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientRequest } from "../../protocol/types.js";
import type { ClientSession } from "../client-session.js";
import { sendJson } from "../send-json.js";

type SubagentOperationContext = {
	socket: WebSocket;
	session: ClientSession;
	mcpHost: McpHost;
};

type SubagentRequestMethod =
	| "agent.subgraph.get"
	| "agent.subgraph.list"
	| "agent.subgraph.cancel"
	| "agent.subgraph.retry"
	| "agent.subgraph.merge.preview"
	| "agent.subgraph.merge.apply";

type SubagentOperationInput<TMethod extends SubagentRequestMethod> = SubagentOperationContext
	& Extract<ClientRequest, { method: TMethod }>["params"];

type SubagentOperation<TInput> = (input: TInput) => Promise<unknown> | unknown;

export type SubagentRequestOperations = {
	getSubagentGraph: SubagentOperation<SubagentOperationInput<"agent.subgraph.get">>;
	listSubagentGraphs: SubagentOperation<SubagentOperationInput<"agent.subgraph.list">>;
	cancelSubagentGraph: SubagentOperation<SubagentOperationInput<"agent.subgraph.cancel">>;
	retrySubagentNode: SubagentOperation<SubagentOperationInput<"agent.subgraph.retry">>;
	previewSubagentNodeMerge: SubagentOperation<SubagentOperationInput<"agent.subgraph.merge.preview">>;
	applySubagentNodeMerge: SubagentOperation<SubagentOperationInput<"agent.subgraph.merge.apply">>;
};

let operationsPromise: Promise<SubagentRequestOperations> | undefined;

async function loadSubagentOperations(): Promise<SubagentRequestOperations> {
	if (operationsPromise === undefined) {
		operationsPromise = import("../subagent-runtime.js").then((runtime): SubagentRequestOperations => ({
			getSubagentGraph: runtime.getSubagentGraph,
			listSubagentGraphs: runtime.listSubagentGraphs,
			cancelSubagentGraph: runtime.cancelSubagentGraph,
			retrySubagentNode: runtime.retrySubagentNode,
			previewSubagentNodeMerge: runtime.previewSubagentNodeMerge,
			applySubagentNodeMerge: runtime.applySubagentNodeMerge
		}));
	}
	return await operationsPromise;
}

function sendError(socket: WebSocket, request: ClientRequest, code: string, message: string): void {
	sendJson(socket, {
		type: "response",
		id: request.id,
		ok: false,
		error: { code, message }
	});
}

function errorCode(error: unknown): string {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code ?? "subgraph_error")
		: "subgraph_error";
}

export function createSubagentRequestHandler(
	providedOperations?: SubagentRequestOperations
): (socket: WebSocket, request: ClientRequest, session: ClientSession, mcpHost: McpHost) => Promise<void> {
	return async (socket: WebSocket, request: ClientRequest, session: ClientSession, mcpHost: McpHost): Promise<void> => {
		try {
			if (
				request.method === "agent.subgraph.list"
				&& (session.sessionId === undefined || session.sessionId !== request.params.sessionId)
			) {
				throw Object.assign(new Error("The requested Subagent graph session is not active."), {
					code: "subgraph_session_mismatch"
				});
			}

			const context: SubagentOperationContext = { socket, session, mcpHost };
			const operations: SubagentRequestOperations = providedOperations ?? await loadSubagentOperations();
			let result: unknown;

			switch (request.method) {
			case "agent.subgraph.get":
				result = await operations.getSubagentGraph({ ...context, ...request.params });
				break;
			case "agent.subgraph.list":
				result = await operations.listSubagentGraphs({ ...context, ...request.params });
				break;
			case "agent.subgraph.cancel":
				result = await operations.cancelSubagentGraph({ ...context, ...request.params });
				break;
			case "agent.subgraph.retry":
				result = await operations.retrySubagentNode({ ...context, ...request.params });
				break;
			case "agent.subgraph.merge.preview":
				result = await operations.previewSubagentNodeMerge({ ...context, ...request.params });
				break;
			case "agent.subgraph.merge.apply":
				result = await operations.applySubagentNodeMerge({ ...context, ...request.params });
				break;
			default:
				throw Object.assign(new Error(`Unsupported Subagent request method: ${request.method}`), {
					code: "subgraph_method_unsupported"
				});
			}

			sendJson(socket, { type: "response", id: request.id, ok: true, result });
		} catch (error: unknown) {
			sendError(
				socket,
				request,
				errorCode(error),
				error instanceof Error ? error.message : String(error)
			);
		}
	};
}

export const handleSubagentRequest = createSubagentRequestHandler();
