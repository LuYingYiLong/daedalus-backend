import { assertFlowPortValue } from "../protocol/flow-value-types.js";
import { getFlowArtifactReference } from "../session/flow-artifact-store.js";
import type { FlowBatchItemRun } from "../session/flow-batch-store.js";
import { resolveFlowNodePorts, getFlowNodeTypeDefinition, normalizeFlowNodeConfig, resolveFlowNodeParameters } from "./flow-node-registry.js";
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
	force?: boolean;
	confirmPossibleDuplicateCharge?: boolean;
	resumeProviderJobId?: string | undefined;
	onMediaSubmissionStarted?: (() => Promise<void>) | undefined;
	onMediaResultSaved?: ((output: FlowNodeOutputs) => Promise<void>) | undefined;
	onPartialFailure?: (count: number) => void;
	onBatchItem?: ((item: FlowBatchItemRun) => void) | undefined;
	onProgress?: ((progress: number) => void) | undefined;
	onProviderJobId?: ((providerJobId: string) => Promise<void> | void) | undefined;
};
export type FlowNodeExecutor = (context: FlowNodeExecutionContext) => Promise<FlowNodeOutputs>;

export type FlowApprovedResult = { output: FlowNodeOutputs; partialFailures: number };
type RegisteredExecutor = { pluginId: string; execute: FlowNodeExecutor; approvedResult?: ((value: unknown) => FlowApprovedResult) | undefined };
const executors = new Map<FlowNodeTypeId, RegisteredExecutor>();

export function registerFlowNodeExecutor(typeId: FlowNodeTypeId, pluginId: string, execute: FlowNodeExecutor, approvedResult?: (value: unknown) => FlowApprovedResult): void {
	if (executors.has(typeId)) throw Object.assign(new Error(`Flow node executor is already registered: ${typeId}`), { code: "flow_node_executor_conflict" });
	executors.set(typeId, { pluginId, execute, approvedResult });
}

export function unregisterPluginFlowNodeExecutors(pluginId: string): void {
	for (const [typeId, executor] of executors) if (executor.pluginId === pluginId) executors.delete(typeId);
}

export function hasFlowNodeExecutor(typeId: FlowNodeTypeId): boolean {
	return executors.has(typeId);
}

export async function validateFlowArtifactValues(value: unknown, flowId: string, allowedIds?: ReadonlySet<string>): Promise<void> {
	if (Array.isArray(value)) { for (const item of value) await validateFlowArtifactValues(item, flowId, allowedIds); return; }
	if (!value || typeof value !== "object") return;
	const record = value as Record<string, unknown>;
	if (typeof record.artifactId === "string" && typeof record.mimeType === "string") {
		const ref = await getFlowArtifactReference(record.artifactId);
		if (ref.flowId !== flowId || ref.sha256 !== record.sha256 || ref.mimeType !== record.mimeType || allowedIds && !allowedIds.has(ref.artifactId))
			throw new Error("flow_artifact_scope_invalid");
	} else for (const item of Object.values(record)) await validateFlowArtifactValues(item, flowId, allowedIds);
}

export async function executeRegisteredFlowNode(context: FlowNodeExecutionContext): Promise<FlowNodeOutputs> {
	const executor = executors.get(context.node.typeId);
	if (executor === undefined) throw Object.assign(new Error(`Flow node executor is unavailable: ${context.node.typeId}`), { code: "flow_node_executor_unavailable" });
	const ports = resolveFlowNodePorts(context.node);
	await validateFlowArtifactValues(context.inputs, context.flow.flowId);
	for (const port of ports.filter(port => port.direction === "input")) {
		const value = context.inputs[port.id];
		if (value === undefined) continue;
		if (port.multiple && Array.isArray(value)) for (const item of value) assertFlowPortValue(port, item); else assertFlowPortValue(port, value);
	}
	const effectiveConfig = { ...context.node.config };
	for (const parameter of resolveFlowNodeParameters(context.node)) {
		if (parameter.mode === "hybrid" && Object.prototype.hasOwnProperty.call(context.inputs, parameter.id))
			effectiveConfig[parameter.configField] = context.inputs[parameter.id];
	}
	const effectiveNode = { ...context.node, config: normalizeFlowNodeConfig(context.node.typeId, effectiveConfig) };
	if (Object.prototype.hasOwnProperty.call(context.inputs, "provider") || Object.prototype.hasOwnProperty.call(context.inputs, "model")) {
		const [{ isProviderId }, { listProviderModels }] = await Promise.all([
			import("../providers/provider-registry.js"),
			import("../providers/provider-models.js"),
		]);
		const provider = effectiveNode.config.provider;
		const model = effectiveNode.config.model;
		if (!isProviderId(provider) || typeof model !== "string" || model.length === 0)
			throw Object.assign(new Error("Connected provider and model must resolve to a configured pair."), { code: "flow_model_selection_invalid" });
		const selected = (await listProviderModels(provider, undefined, undefined)).models.find((candidate) => candidate.id === model);
		if (selected === undefined)
			throw Object.assign(new Error(`Model ${model} is not available for provider ${provider}.`), { code: "flow_model_selection_invalid" });
		const capability = getFlowNodeTypeDefinition(effectiveNode.typeId).modelCapability;
		if (capability !== undefined && selected.capabilities[capability] !== true)
			throw Object.assign(new Error(`Model ${provider}/${model} does not support ${capability}.`), { code: "flow_model_capability_invalid" });
	}
	const result = await executor.execute({ ...context, node: effectiveNode });
	for (const output of getFlowNodeTypeDefinition(context.node.typeId).outputs) {
		if (!output.optional && !Object.prototype.hasOwnProperty.call(result, output.id)) throw new Error(`Missing output port: ${output.id}`);
	}
	await validateFlowArtifactValues(result, context.flow.flowId);
	for (const [id, value] of Object.entries(result)) {
		const port = ports.find(port => port.direction === "output" && port.id === id);
		if (port) assertFlowPortValue(port, value);
		else if (!(ports.every(port => port.direction === "input") && id === "result")) throw new Error(`Undeclared output port: ${id}`);
	}
	return result;
}

export function resolveApprovedFlowResult(typeId: string, value: unknown, text: string): FlowApprovedResult {
 return executors.get(typeId)?.approvedResult?.(value) ?? { output: { result: value, text }, partialFailures: 0 };
}
