import type { McpHost } from "../mcp/mcp-host.js";
import type { FlowDocument, FlowDocumentNode, FlowNodeTypeId } from "../protocol/types.js";
import type { ApprovalGateway } from "../tools/approval-gateway.js";

export type FlowNodeInputs = Record<string, unknown>;
export type FlowNodeOutputs = Record<string, unknown>;
export type FlowNodeExecutionContext = {
	node: FlowDocumentNode;
	inputs: FlowNodeInputs;
	runInputs: Readonly<Record<string, unknown>>;
	flow: FlowDocument;
	runId: string;
	gateway: ApprovalGateway;
	mcpHost: McpHost;
	signal: AbortSignal;
};
export type FlowNodeExecutor = (context: FlowNodeExecutionContext) => Promise<FlowNodeOutputs>;

type RegisteredExecutor = { pluginId: string; execute: FlowNodeExecutor };
const executors = new Map<FlowNodeTypeId, RegisteredExecutor>();

export function registerFlowNodeExecutor(typeId: FlowNodeTypeId, pluginId: string, execute: FlowNodeExecutor): void {
	if (executors.has(typeId)) throw Object.assign(new Error(`Flow node executor is already registered: ${typeId}`), { code: "flow_node_executor_conflict" });
	executors.set(typeId, { pluginId, execute });
}

export function unregisterPluginFlowNodeExecutors(pluginId: string): void {
	for (const [typeId, executor] of executors) if (executor.pluginId === pluginId) executors.delete(typeId);
}

export function hasFlowNodeExecutor(typeId: FlowNodeTypeId): boolean {
	return executors.has(typeId);
}

export async function executeRegisteredFlowNode(context: FlowNodeExecutionContext): Promise<FlowNodeOutputs> {
	const executor = executors.get(context.node.typeId);
	if (executor === undefined) throw Object.assign(new Error(`Flow node executor is unavailable: ${context.node.typeId}`), { code: "flow_node_executor_unavailable" });
	return executor.execute(context);
}
