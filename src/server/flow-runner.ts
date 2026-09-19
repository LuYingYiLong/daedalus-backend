import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { ChatCompletionMessageToolCall } from "openai/resources/chat/completions";
import { chatWithProvider, type ProviderChatOptions } from "../providers/deepseek-client.js";
import { normalizeConfiguredProviderBaseUrl } from "../providers/provider-base-url.js";
import { loadProviderConfigWithSecret } from "../providers/provider-config-store.js";
import { getProviderAdapterFamily, getProviderDefaultModel, getProviderEndpointTypeForModel } from "../providers/provider-registry.js";
import { resolveModelProfile } from "../tokens/model-profiles.js";
import type { AiChatParams, FlowDocument, FlowDocumentEdge, FlowDocumentNode, FlowDocumentRun } from "../protocol/types.js";
import type { McpHost } from "../mcp/mcp-host.js";
import { findWorkspace } from "../workspace/registry.js";
import { ApprovalGateway } from "../tools/approval-gateway.js";
import { createWorkspaceToolCatalog } from "../tools/tool-catalog.js";
import { dispatchToolCalls, ToolApprovalRequiredError } from "../tools/tool-dispatcher.js";
import { generateMedia } from "../providers/media-generation.js";
import { deleteFlowArtifact, getFlowArtifact, saveFlowArtifact } from "../session/flow-artifact-store.js";
import {
	cancelPendingFlowApprovalsDocument,
	createFlowApprovalDocument,
	createFlowRunDocument,
	findCachedFlowNodeOutput,
	getFlowRunDocument,
	getPendingFlowApprovalDocument,
	readFlowGraphForScheduler,
	resolveFlowApprovalDocument,
	updateFlowNodeRunDocument,
	updateFlowNodeProviderJobIdDocument,
	updateFlowRunDocument,
} from "../session/flow-document-store.js";
import { findFlowNodeTypeDefinition, getFlowNodeTypeDefinition, resolveFlowNodeParameters } from "./flow-node-registry.js";
import {
	executeRegisteredFlowNode,
	registerFlowNodeExecutor,
	type FlowNodeExecutionContext,
} from "./flow-node-executor-registry.js";

type PortOutputs = Record<string, unknown>;
type NodeInputs = Record<string, unknown>;
export type FlowRunSelection = {
	entryNodeIds?: readonly string[];
	targetNodeIds?: readonly string[];
	inputValues?: Readonly<Record<string, unknown>>;
};
export type PreparedFlowRun = {
	flow: FlowDocument;
	nodes: FlowDocumentNode[];
	edges: FlowDocumentEdge[];
	entryNodeIds: string[];
	targetNodeIds: string[];
	inputValues: Record<string, unknown>;
};

const activeControllers = new Map<string, AbortController>();
const activeRunsByFlow = new Map<string, string>();
const gatewaysByRun = new Map<string, ApprovalGateway>();
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export function getActiveFlowRunIdDocument(flowId: string): string | null {
	return activeRunsByFlow.get(flowId) ?? null;
}

export async function stopFlowRunDocument(flowId: string, runId: string): Promise<boolean> {
	const key = `${flowId}:${runId}`;
	activeControllers.get(key)?.abort();
	const run = await getFlowRunDocument(flowId, runId).catch((): null => null);
	if (run === null || !["queued", "running", "waiting"].includes(run.status)) return false;
	await cancelPendingFlowApprovalsDocument(flowId, runId);
	await updateFlowRunDocument(flowId, runId, { status: "cancelled", error: "Flow run cancelled.", finishedAt: new Date().toISOString() });
	activeControllers.delete(key);
	gatewaysByRun.delete(key);
	if (activeRunsByFlow.get(flowId) === runId) activeRunsByFlow.delete(flowId);
	return true;
}

function fingerprint(node: FlowDocumentNode, inputs: NodeInputs, inbound: readonly FlowDocumentEdge[], runtimeInput: unknown): string {
	const effectiveConfig = structuredClone(node.config);
	const connectedInputIds = new Set(inbound.map((edge): string => edge.targetPort));
	for (const parameter of resolveFlowNodeParameters(node)) {
		if (parameter.mode === "hybrid" && connectedInputIds.has(parameter.id)) delete effectiveConfig[parameter.configField];
	}
	return createHash("sha256").update(JSON.stringify({
		typeId: node.typeId,
		pluginVersion: node.pluginVersion,
		pluginFingerprint: node.pluginFingerprint,
		config: effectiveConfig,
		inputs,
		runtimeInput,
		ports: inbound.map((edge): string[] => [edge.sourcePort, edge.targetPort, edge.dataType]),
		provider: node.config.provider,
		model: node.config.model,
		reasoningEffort: node.config.reasoningEffort,
	})).digest("hex");
}

function selectedNodeIdsForTargets(
	nodes: readonly FlowDocumentNode[],
	edges: readonly FlowDocumentEdge[],
	targetNodeIds: readonly string[],
): Set<string> {
	if (targetNodeIds.length === 0) return new Set(nodes.map((node): string => node.nodeId));
	const selected = new Set(targetNodeIds);
	const queue = [...targetNodeIds];
	while (queue.length > 0) {
		const targetNodeId = queue.shift()!;
		for (const edge of edges.filter((candidate): boolean => candidate.targetNodeId === targetNodeId)) {
			if (selected.has(edge.sourceNodeId)) continue;
			selected.add(edge.sourceNodeId);
			queue.push(edge.sourceNodeId);
		}
	}
	return selected;
}

function reachableNodeIdsFromEntries(
	edges: readonly FlowDocumentEdge[],
	entryNodeIds: readonly string[],
): Set<string> {
	const reachable = new Set(entryNodeIds);
	const queue = [...entryNodeIds];
	while (queue.length > 0) {
		const sourceNodeId = queue.shift()!;
		for (const edge of edges.filter((candidate): boolean => candidate.sourceNodeId === sourceNodeId)) {
			if (reachable.has(edge.targetNodeId)) continue;
			reachable.add(edge.targetNodeId);
			queue.push(edge.targetNodeId);
		}
	}
	return reachable;
}

function normalizeRunInput(node: FlowDocumentNode, supplied: unknown, suppliedValue: boolean): unknown {
	const fallback = typeof node.config.defaultValue === "string" ? node.config.defaultValue : "";
	const value = suppliedValue ? supplied : fallback;
	const label = typeof node.config.label === "string" ? node.config.label : node.title;
	if (node.config.dataType === "json") {
		if (typeof value === "string") {
			if (value.trim().length === 0) return null;
			try { return JSON.parse(value) as unknown; } catch {
				throw Object.assign(new Error(`Flow input must contain valid JSON: ${label}.`), { code: "flow_input_json_invalid", nodeId: node.nodeId });
			}
		}
		if (value === undefined || value === null) return null;
		return structuredClone(value);
	}
	if (typeof value !== "string")
		throw Object.assign(new Error(`Flow input must be text: ${label}.`), { code: "flow_input_type_invalid", nodeId: node.nodeId });
	return value;
}

export async function prepareFlowRunDocument(params: {
	flowId: string;
	revision: number;
	selection?: FlowRunSelection;
	requireOutputTargets?: boolean;
}): Promise<PreparedFlowRun> {
	const graph = await readFlowGraphForScheduler(params.flowId);
	if (graph.flow.graphRevision !== params.revision)
		throw Object.assign(new Error("The Flow changed before execution started."), { code: "flow_revision_conflict" });
	const flowInputNodes = graph.nodes.filter((node): boolean => node.typeId === "builtin/flow-input");
	const entryNodeIds = [...new Set(params.selection?.entryNodeIds ?? [])];
	for (const entryNodeId of entryNodeIds) {
		if (!flowInputNodes.some((node): boolean => node.nodeId === entryNodeId))
			throw Object.assign(new Error(`Flow run entry must be a Flow Input node: ${entryNodeId}.`), { code: "flow_input_entry_invalid", nodeId: entryNodeId });
	}
	const reachableFromSelectedEntries = reachableNodeIdsFromEntries(graph.edges, entryNodeIds);
	const outputNodes = graph.nodes.filter((node): boolean => node.typeId === "builtin/output" || node.typeId === "builtin/media-output");
	const requestedTargetIds = params.selection?.targetNodeIds;
	const targetNodeIds = requestedTargetIds === undefined
		? outputNodes.filter((node): boolean => entryNodeIds.length === 0 || reachableFromSelectedEntries.has(node.nodeId)).map((node): string => node.nodeId)
		: [...new Set(requestedTargetIds)];
	if (params.requireOutputTargets === true && targetNodeIds.length === 0)
		throw Object.assign(new Error("Add an Output node before running this Flow."), { code: "flow_output_target_required" });
	for (const targetNodeId of targetNodeIds) {
		const target = graph.nodes.find((node): boolean => node.nodeId === targetNodeId);
		if (target === undefined || (target.typeId !== "builtin/output" && target.typeId !== "builtin/media-output"))
			throw Object.assign(new Error(`Flow run target must be an Output node: ${targetNodeId}.`), { code: "flow_output_target_invalid", nodeId: targetNodeId });
		if (entryNodeIds.length > 0 && !reachableFromSelectedEntries.has(targetNodeId))
			throw Object.assign(new Error(`Output is not reachable from the selected Flow Input: ${targetNodeId}.`), { code: "flow_output_target_unreachable", nodeId: targetNodeId });
	}
	const selectedIds = selectedNodeIdsForTargets(graph.nodes, graph.edges, targetNodeIds);
	if (entryNodeIds.length > 0) {
		const selectedEntries = new Set(entryNodeIds);
		const unselectedEntryNodeIds = flowInputNodes.filter((node): boolean => !selectedEntries.has(node.nodeId)).map((node): string => node.nodeId);
		const reachableFromUnselectedEntries = reachableNodeIdsFromEntries(graph.edges, unselectedEntryNodeIds);
		for (const nodeId of [...selectedIds]) {
			if (unselectedEntryNodeIds.includes(nodeId) || reachableFromUnselectedEntries.has(nodeId) && !reachableFromSelectedEntries.has(nodeId)) selectedIds.delete(nodeId);
		}
	}
	const nodes = graph.nodes.filter((node): boolean => selectedIds.has(node.nodeId));
	const edges = graph.edges.filter((edge): boolean => selectedIds.has(edge.sourceNodeId) && selectedIds.has(edge.targetNodeId));
	const unavailableTypes = [...new Set(nodes.filter((node): boolean => {
		const definition = findFlowNodeTypeDefinition(node.typeId);
		return definition === undefined
			|| definition.pluginVersion !== node.pluginVersion
			|| definition.pluginFingerprint !== node.pluginFingerprint
			|| definition.configVersion !== node.configVersion;
	}).map((node): string => node.typeId))];
	if (unavailableTypes.length > 0)
		throw Object.assign(new Error(`Flow contains unavailable node types: ${unavailableTypes.join(", ")}.`), { code: "flow_node_type_unavailable", typeIds: unavailableTypes });
	const suppliedInputs = params.selection?.inputValues ?? {};
	const inputValues: Record<string, unknown> = {};
	for (const node of nodes.filter((candidate): boolean => candidate.typeId === "builtin/flow-input")) {
		const supplied = Object.prototype.hasOwnProperty.call(suppliedInputs, node.nodeId);
		inputValues[node.nodeId] = normalizeRunInput(node, suppliedInputs[node.nodeId], supplied);
	}
	return { flow: graph.flow, nodes, edges, entryNodeIds, targetNodeIds, inputValues };
}

function collectInputs(
	node: FlowDocumentNode,
	edges: readonly FlowDocumentEdge[],
	outputs: ReadonlyMap<string, PortOutputs>,
): { inputs: NodeInputs; inactive: boolean; missing: string[] } {
	const inputs: NodeInputs = {};
	let inactive = false;
	const inbound = edges
		.filter((candidate): boolean => candidate.targetNodeId === node.nodeId)
		.sort((left, right): number => left.targetPort.localeCompare(right.targetPort) || left.edgeId.localeCompare(right.edgeId));
	const connectedInputIds = new Set(inbound.map((edge): string => edge.targetPort));
	const parameters = resolveFlowNodeParameters(node);
	for (const edge of inbound) {
		const sourceOutputs = outputs.get(edge.sourceNodeId);
		if (sourceOutputs === undefined || !Object.prototype.hasOwnProperty.call(sourceOutputs, edge.sourcePort)) {
			inactive = true;
			continue;
		}
		const parameter = parameters.find((candidate): boolean => candidate.id === edge.targetPort);
		if (parameter?.mode !== "fixed" && parameter?.multiple === true) {
			const values = Array.isArray(inputs[edge.targetPort]) ? inputs[edge.targetPort] as unknown[] : [];
			inputs[edge.targetPort] = [...values, sourceOutputs[edge.sourcePort]];
		} else inputs[edge.targetPort] = sourceOutputs[edge.sourcePort];
	}
	for (const parameter of parameters) {
		if (parameter.mode !== "hybrid" || connectedInputIds.has(parameter.id)) continue;
		if (Object.prototype.hasOwnProperty.call(node.config, parameter.configField))
			inputs[parameter.id] = node.config[parameter.configField];
	}
	const missing = parameters.flatMap((parameter): string[] =>
		parameter.mode !== "fixed" && parameter.required && !Object.prototype.hasOwnProperty.call(inputs, parameter.id)
			? [parameter.label]
			: [],
	);
	return { inputs, inactive, missing };
}

function asText(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value);
}

function decodePointerToken(value: string): string {
	return value.replace(/~1/gu, "/").replace(/~0/gu, "~");
}

function readJsonPointer(value: unknown, pointer: string): unknown {
	if (pointer === "" || pointer === "/") return value;
	let current = value;
	for (const token of pointer.split("/").slice(1).map(decodePointerToken)) {
		if (current === null || typeof current !== "object" || !(token in current)) throw new Error(`JSON Pointer not found: ${pointer}`);
		current = (current as Record<string, unknown>)[token];
	}
	return current;
}

async function runLlm(node: FlowDocumentNode, inputs: NodeInputs, signal: AbortSignal): Promise<string> {
	const provider = typeof node.config.provider === "string" && node.config.provider.length > 0 ? node.config.provider : "deepseek";
	const config = await loadProviderConfigWithSecret(provider);
	if (config?.apiKey === undefined) throw new Error(`Provider ${provider} API key is not configured.`);
	const model = typeof node.config.model === "string" && node.config.model.length > 0 ? node.config.model : config.model ?? getProviderDefaultModel(provider);
	const endpointType = getProviderEndpointTypeForModel(provider, model);
	const normalizedBaseUrl = normalizeConfiguredProviderBaseUrl(config.baseUrl);
	const options: ProviderChatOptions = {
		provider,
		apiKey: config.apiKey,
		model,
		endpointType,
		adapterFamily: getProviderAdapterFamily(provider, endpointType),
		modelProfile: resolveModelProfile(provider, model),
		...(normalizedBaseUrl === undefined ? {} : { baseUrl: normalizedBaseUrl }),
		...(config.requestOverrides === undefined ? {} : { requestOverrides: config.requestOverrides }),
	};
	const params: AiChatParams = {
		message: asText(inputs["user-prompt"] ?? ""),
		mode: "ask",
		options: { stream: false, ...(typeof node.config.reasoningEffort === "string" && node.config.reasoningEffort.length > 0 ? { reasoningEffort: node.config.reasoningEffort } : {}) },
	};
	const systemPromptValue = inputs["system-prompt"];
	const systemPrompt = typeof systemPromptValue === "string" && systemPromptValue.length > 0
		? systemPromptValue
		: "You are a helpful assistant.";
	return chatWithProvider(params, options, [], systemPrompt, signal);
}

function compareCondition(node: FlowDocumentNode, input: unknown): boolean {
	let actual: unknown;
	try {
		actual = readJsonPointer(input, typeof node.config.pointer === "string" ? node.config.pointer : "/");
	} catch (error: unknown) {
		if (node.config.operator === "exists") return false;
		throw error;
	}
	const expected = node.config.value;
	switch (node.config.operator) {
		case "not_equals": return actual !== expected;
		case "contains": return typeof actual === "string" ? actual.includes(String(expected ?? "")) : Array.isArray(actual) && actual.includes(expected);
		case "matches": return typeof actual === "string" && new RegExp(String(expected ?? ""), "u").test(actual);
		case "gt": return Number(actual) > Number(expected);
		case "gte": return Number(actual) >= Number(expected);
		case "lt": return Number(actual) < Number(expected);
		case "lte": return Number(actual) <= Number(expected);
		case "exists": return actual !== undefined && actual !== null;
		default: return actual === expected;
	}
}

function setObjectPath(target: Record<string, unknown>, pointer: string, value: unknown): void {
	const tokens = pointer.startsWith("/") ? pointer.split("/").slice(1).map(decodePointerToken) : pointer.split(".").filter(Boolean);
	if (tokens.length === 0) throw new Error(`Invalid argument path: ${pointer}`);
	let current = target;
	for (const token of tokens.slice(0, -1)) {
		const next = current[token];
		if (next === null || typeof next !== "object" || Array.isArray(next)) current[token] = {};
		current = current[token] as Record<string, unknown>;
	}
	current[tokens.at(-1)!] = value;
}

function parseToolContent(content: string): unknown {
	try { return JSON.parse(content) as unknown; } catch { return content; }
}

async function executeMediaNode(params: { node: FlowDocumentNode; inputs: NodeInputs; flow: FlowDocument; runId: string; signal: AbortSignal; onProgress?: ((progress: number) => void) | undefined; onProviderJobId?: ((providerJobId: string) => Promise<void> | void) | undefined }): Promise<PortOutputs> {
	const provider = typeof params.node.config.provider === "string" ? params.node.config.provider.trim() : "";
	const model = typeof params.node.config.model === "string" ? params.node.config.model.trim() : "";
	if (provider.length === 0 || model.length === 0) throw Object.assign(new Error("Media node requires a provider and model."), { code: "media_model_required" });
	const kind = params.node.typeId === "builtin/text-to-video" || params.node.typeId === "builtin/image-to-video" ? "videoGeneration" : params.node.typeId === "builtin/image-to-image" ? "imageEdit" : "imageGeneration";
	const sourceRefs: Array<{ artifactId: string }> = [];
	const collectSourceRefs = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) collectSourceRefs(item);
			return;
		}
		if (value !== null && typeof value === "object" && typeof (value as Record<string, unknown>).artifactId === "string") {
			sourceRefs.push({ artifactId: String((value as Record<string, unknown>).artifactId) });
		}
	};
	collectSourceRefs(params.inputs.image);
	const sourceImages = sourceRefs.length === 0
		? undefined
		: await Promise.all(sourceRefs.map(async (ref): Promise<{ mimeType: string; bytes: Buffer }> => {
			const artifact = await getFlowArtifact(ref.artifactId);
			return { mimeType: artifact.ref.mimeType, bytes: artifact.bytes };
		}));
	const result = await generateMedia({
		kind,
		provider,
		model,
		prompt: typeof params.inputs.prompt === "string" ? params.inputs.prompt : typeof params.node.config.prompt === "string" ? params.node.config.prompt : "",
		negativePrompt: typeof params.node.config.negativePrompt === "string" ? params.node.config.negativePrompt : undefined,
		width: typeof params.node.config.width === "number" ? params.node.config.width : undefined,
		height: typeof params.node.config.height === "number" ? params.node.config.height : undefined,
		durationMs: typeof params.node.config.durationMs === "number" ? params.node.config.durationMs : undefined,
		fps: typeof params.node.config.fps === "number" ? params.node.config.fps : undefined,
		aspectRatio: typeof params.node.config.aspectRatio === "string" ? params.node.config.aspectRatio : undefined,
		style: typeof params.node.config.style === "string" ? params.node.config.style : undefined,
		seed: typeof params.node.config.seed === "number" ? params.node.config.seed : undefined,
		count: typeof params.node.config.count === "number" ? params.node.config.count : undefined,
		outputFormat: typeof params.node.config.outputFormat === "string" ? params.node.config.outputFormat : undefined,
		sourceImages,
	}, params.signal, {
		async save(input) {
			return { imageId: `flow-capture-${input.model}-${input.bytes.byteLength}`, sessionId: "flow-media", mimeType: input.mimeType, byteSize: input.bytes.byteLength, provider: input.provider, model: input.model, prompt: input.prompt, createdAt: new Date().toISOString(), fileName: "flow-capture", storagePath: "" };
		},
	}, params.onProgress, params.onProviderJobId);
	const binaries = result.artifacts;
	const refs = [];
	try {
		for (const artifact of binaries) refs.push(await saveFlowArtifact({ flowId: params.flow.flowId, runId: params.runId, nodeId: params.node.nodeId, bytes: artifact.bytes, mimeType: artifact.mimeType, ...(artifact.width === undefined ? {} : { width: artifact.width }), ...(artifact.height === undefined ? {} : { height: artifact.height }), ...(artifact.durationMs === undefined ? {} : { durationMs: artifact.durationMs }), ...(artifact.fps === undefined ? {} : { fps: artifact.fps }), metadata: artifact.metadata }));
	} catch (error: unknown) {
		await Promise.allSettled(refs.map((ref): Promise<void> => deleteFlowArtifact(ref.artifactId)));
		throw error;
	}
	return { [kind.startsWith("video") ? "video" : "image"]: refs.length === 1 ? refs[0] : refs };
}

async function executeToolNode(params: { node: FlowDocumentNode; inputs: NodeInputs; flow: FlowDocument; runId: string; gateway: ApprovalGateway; mcpHost: McpHost; signal: AbortSignal }): Promise<PortOutputs> {
	const toolName = typeof params.node.config.toolName === "string" ? params.node.config.toolName : "";
	const context = { workspaceId: params.flow.workspaceId ?? undefined, requestId: params.runId, sessionId: `flow:${params.flow.flowId}`, clientType: "studio" as const, hookContext: { model: "flow", approvalMode: params.flow.approvalMode, chatMode: "agent" as const } };
	const catalog = createWorkspaceToolCatalog(context);
	if (catalog.getEntry(toolName) === undefined) throw new Error(`Tool is unavailable in this Flow workspace: ${toolName}`);
	const args = structuredClone((params.node.config.args ?? {}) as Record<string, unknown>);
	for (const candidate of Array.isArray(params.node.config.bindings) ? params.node.config.bindings : []) {
		if (candidate === null || typeof candidate !== "object") continue;
		const binding = candidate as Record<string, unknown>;
		if (typeof binding.argumentPath !== "string" || typeof binding.inputPort !== "string") continue;
		let value = params.inputs[binding.inputPort];
		if (typeof binding.valuePath === "string" && binding.valuePath.length > 0) value = readJsonPointer(value, binding.valuePath);
		setObjectPath(args, binding.argumentPath, value);
	}
	const call: ChatCompletionMessageToolCall = { id: `flow-${params.runId}-${params.node.nodeId}`, type: "function", function: { name: toolName, arguments: JSON.stringify(args) } };
	const [result] = await dispatchToolCalls(params.mcpHost, [call], 1, params.gateway, undefined, undefined, context, params.signal);
	const rawContent = result?.content ?? "";
	const content = typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent);
	return { result: parseToolContent(content), text: content };
}

async function executeCommandNode(params: { node: FlowDocumentNode; inputs: NodeInputs; flow: FlowDocument; runId: string; gateway: ApprovalGateway; mcpHost: McpHost; signal: AbortSignal }): Promise<PortOutputs> {
	const args: Record<string, unknown> = {
		commandLine: params.node.config.commandLine,
		executionMode: "wait",
		timeoutMs: params.node.config.timeoutMs,
		reason: `Run Flow command node ${params.node.title}`,
		...(typeof params.node.config.cwd === "string" && params.node.config.cwd.length > 0 ? { cwd: params.node.config.cwd } : {}),
		...(params.node.config.env !== null && typeof params.node.config.env === "object" ? { env: params.node.config.env } : {}),
		...(typeof params.inputs.stdin === "string" ? { stdin: params.inputs.stdin } : {}),
	};
	const proxyNode: FlowDocumentNode = { ...params.node, typeId: "builtin/tool", pluginId: "builtin", pluginVersion: "1.0.0", pluginFingerprint: "builtin@1.0.0", configVersion: 1, config: { toolName: "mcp_terminal_run_command", args, bindings: [] } };
	const output = await executeToolNode({ ...params, node: proxyNode });
	const record = output.result !== null && typeof output.result === "object" ? output.result as Record<string, unknown> : {};
	return { result: output.result, stdout: typeof record.stdout === "string" ? record.stdout : output.text, stderr: typeof record.stderr === "string" ? record.stderr : "" };
}

async function readFileNode(node: FlowDocumentNode, flow: FlowDocument): Promise<PortOutputs> {
	if (flow.workspaceId === null) throw new Error("File Input requires a Flow workspace.");
	const workspace = findWorkspace(flow.workspaceId);
	if (workspace === undefined) throw new Error(`Workspace not found: ${flow.workspaceId}`);
	const relativePath = typeof node.config.path === "string" ? node.config.path : "";
	if (relativePath.length === 0 || path.isAbsolute(relativePath)) throw new Error("File Input path must be workspace-relative.");
	const root = await realpath(path.resolve(workspace.rootPath));
	const absolute = await realpath(path.resolve(root, relativePath));
	const relative = path.relative(root, absolute);
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("File Input path is outside the Flow workspace.");
	const info = await stat(absolute);
	if (!info.isFile()) throw new Error("File Input path is not a file.");
	if (info.size > MAX_FILE_BYTES) throw new Error(`File Input exceeds ${MAX_FILE_BYTES} bytes.`);
	if (node.config.mode === "artifact") return { output: { relativePath: relative.replaceAll("\\", "/"), size: info.size } };
	const content = await readFile(absolute, "utf8");
	return { output: node.config.mode === "json" ? JSON.parse(content) as unknown : content };
}

function registerBuiltinExecutors(): void {
	const register = (typeId: string, execute: (context: FlowNodeExecutionContext) => Promise<PortOutputs>): void => registerFlowNodeExecutor(typeId, "builtin", execute);
	register("builtin/user-prompt", async ({ node, inputs }): Promise<PortOutputs> => ({ output: asText(inputs.input ?? node.config.text ?? "") }));
	register("builtin/system-prompt", async ({ node }): Promise<PortOutputs> => ({ output: typeof node.config.text === "string" ? node.config.text : "" }));
	register("builtin/text", async ({ node }): Promise<PortOutputs> => ({ output: typeof node.config.text === "string" ? node.config.text : "" }));
	register("builtin/template", async ({ node, inputs }): Promise<PortOutputs> => {
		let rendered = typeof node.config.template === "string" ? node.config.template : "";
		for (const [key, value] of Object.entries(inputs)) rendered = rendered.replaceAll(`{{${key}}}`, asText(value));
		return { output: rendered };
	});
	register("builtin/merge", async ({ node, inputs }): Promise<PortOutputs> => {
		const configuredOrder = Array.isArray(node.config.inputs)
			? node.config.inputs.flatMap((candidate): string[] => candidate !== null && typeof candidate === "object" && typeof (candidate as Record<string, unknown>).id === "string" ? [String((candidate as Record<string, unknown>).id)] : [])
			: [];
		const rank = new Map(configuredOrder.map((id, index): [string, number] => [id, index]));
		const entries = Object.entries(inputs).sort(([left], [right]): number => (rank.get(left) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right) ?? Number.MAX_SAFE_INTEGER) || left.localeCompare(right));
		if (node.config.mode === "array") return { output: entries.map(([, value]): unknown => value) };
		if (node.config.mode === "object") return { output: Object.fromEntries(entries) };
		return { output: entries.map(([, value]): string => asText(value)).join(typeof node.config.separator === "string" ? node.config.separator : "\n") };
	});
	register("builtin/json-extract", async ({ node, inputs }): Promise<PortOutputs> => {
		const value = typeof inputs.input === "string" ? JSON.parse(inputs.input) as unknown : inputs.input;
		return { output: readJsonPointer(value, typeof node.config.pointer === "string" ? node.config.pointer : "/") };
	});
	register("builtin/condition", async ({ node, inputs }): Promise<PortOutputs> => ({ [compareCondition(node, inputs.input) ? "true" : "false"]: inputs.input }));
	register("builtin/file-input", async ({ node, flow }): Promise<PortOutputs> => readFileNode(node, flow));
	register("builtin/flow-input", async ({ node, runInputs }): Promise<PortOutputs> => ({ output: runInputs[node.nodeId] }));
	register("builtin/llm", async ({ node, inputs, signal }): Promise<PortOutputs> => ({ output: await runLlm(node, inputs, signal) }));
	register("builtin/tool", executeToolNode);
	register("builtin/command", executeCommandNode);
	register("builtin/output", async ({ inputs }): Promise<PortOutputs> => ({ result: inputs.input }));
	register("builtin/text-to-image", async (context): Promise<PortOutputs> => executeMediaNode(context));
	register("builtin/image-to-image", async (context): Promise<PortOutputs> => executeMediaNode(context));
	register("builtin/text-to-video", async (context): Promise<PortOutputs> => executeMediaNode(context));
	register("builtin/image-to-video", async (context): Promise<PortOutputs> => executeMediaNode(context));
	register("builtin/media-output", async ({ inputs }): Promise<PortOutputs> => ({ result: inputs.input }));
}

registerBuiltinExecutors();

function forceWithDescendants(forceNodeIds: readonly string[], edges: readonly FlowDocumentEdge[]): Set<string> {
	const result = new Set(forceNodeIds);
	const queue = [...forceNodeIds];
	while (queue.length > 0) {
		const source = queue.shift()!;
		for (const edge of edges.filter((candidate): boolean => candidate.sourceNodeId === source)) {
			if (!result.has(edge.targetNodeId)) { result.add(edge.targetNodeId); queue.push(edge.targetNodeId); }
		}
	}
	return result;
}

function canUseCache(node: FlowDocumentNode, flow: FlowDocument): boolean {
	const definition = getFlowNodeTypeDefinition(node.typeId);
	if (definition.cachePolicy === "never") return false;
	if (definition.cachePolicy === "always") return true;
	if (node.typeId !== "builtin/tool") return false;
	const toolName = typeof node.config.toolName === "string" ? node.config.toolName : "";
	const risk = createWorkspaceToolCatalog({ workspaceId: flow.workspaceId ?? undefined, clientType: "studio" }).getPolicy(toolName)?.risk;
	return risk === "read" || risk === "verify";
}

export async function startFlowRunDocument(params: {
	flowId: string;
	revision: number;
	mcpHost: McpHost;
	runId?: string;
	forceNodeIds?: readonly string[];
	entryNodeIds?: readonly string[];
	targetNodeIds?: readonly string[];
	inputValues?: Readonly<Record<string, unknown>>;
	onRunState?: (run: Awaited<ReturnType<typeof getFlowRunDocument>>) => void;
	onNodeState?: (run: Awaited<ReturnType<typeof getFlowRunDocument>>, nodeId: string) => void;
	onNodeProgress?: (runId: string, nodeId: string, progress: number) => void;
}): Promise<Awaited<ReturnType<typeof getFlowRunDocument>>> {
	const activeRunId = activeRunsByFlow.get(params.flowId);
	if (activeRunId !== undefined && activeRunId !== params.runId) throw Object.assign(new Error("Another Flow run is active."), { code: "flow_busy", activeRunId });
	const existingRun = params.runId === undefined ? null : await getFlowRunDocument(params.flowId, params.runId);
	const plan = await prepareFlowRunDocument({
		flowId: params.flowId,
		revision: params.revision,
		selection: {
			...((existingRun?.entryNodeIds ?? params.entryNodeIds) === undefined
				? {}
				: { entryNodeIds: existingRun?.entryNodeIds ?? params.entryNodeIds! }),
			...((existingRun?.targetNodeIds ?? params.targetNodeIds) === undefined
				? {}
				: { targetNodeIds: existingRun?.targetNodeIds ?? params.targetNodeIds! }),
			...((existingRun?.inputValues ?? params.inputValues) === undefined
				? {}
				: { inputValues: existingRun?.inputValues ?? params.inputValues! }),
		},
	});
	const run = existingRun ?? await createFlowRunDocument(
		params.flowId,
		params.revision,
		plan.nodes.map((node): string => node.nodeId),
		{ entryNodeIds: plan.entryNodeIds, targetNodeIds: plan.targetNodeIds, inputValues: plan.inputValues },
	);
	const graph = { flow: plan.flow, nodes: plan.nodes, edges: plan.edges };
	const executable = graph.nodes.filter((node): boolean => getFlowNodeTypeDefinition(node.typeId).executable);
	const key = `${params.flowId}:${run.runId}`;
	const controller = activeControllers.get(key) ?? new AbortController();
	const gateway = gatewaysByRun.get(key) ?? new ApprovalGateway(graph.flow.approvalMode);
	activeControllers.set(key, controller);
	gatewaysByRun.set(key, gateway);
	activeRunsByFlow.set(params.flowId, run.runId);
	const outputs = new Map<string, PortOutputs>();
	const completed = new Set<string>();
	const failed = new Set<string>();
	const skipped = new Set<string>();
	const waiting = new Set<string>();
	for (const state of run.nodes) {
		if ((state.status === "completed" || state.status === "cached") && state.output !== null && typeof state.output === "object") { completed.add(state.nodeId); outputs.set(state.nodeId, state.output as PortOutputs); }
		else if (state.status === "failed") failed.add(state.nodeId);
		else if (state.status === "skipped") skipped.add(state.nodeId);
		else if (state.status === "waiting") waiting.add(state.nodeId);
	}
	const force = forceWithDescendants(params.forceNodeIds ?? [], graph.edges);
	for (const note of graph.nodes.filter((node): boolean => !getFlowNodeTypeDefinition(node.typeId).executable)) {
		if (!skipped.has(note.nodeId)) await updateFlowNodeRunDocument(params.flowId, run.runId, note.nodeId, { status: "skipped", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
		skipped.add(note.nodeId);
		params.onNodeState?.(await getFlowRunDocument(params.flowId, run.runId), note.nodeId);
	}
	try {
		while (completed.size + failed.size + skipped.size + waiting.size < graph.nodes.length) {
			if (controller.signal.aborted) throw new Error("Flow run cancelled.");
			const pending = executable.filter((node): boolean => !completed.has(node.nodeId) && !failed.has(node.nodeId) && !skipped.has(node.nodeId) && !waiting.has(node.nodeId));
			const ready = pending.filter((node): boolean => graph.edges.filter((edge): boolean => edge.targetNodeId === node.nodeId).every((edge): boolean => completed.has(edge.sourceNodeId) || failed.has(edge.sourceNodeId) || skipped.has(edge.sourceNodeId)));
			if (ready.length === 0) break;
			for (const node of ready.filter((candidate): boolean => graph.edges.some((edge): boolean => edge.targetNodeId === candidate.nodeId && (failed.has(edge.sourceNodeId) || skipped.has(edge.sourceNodeId))))) {
				await updateFlowNodeRunDocument(params.flowId, run.runId, node.nodeId, { status: "skipped", finishedAt: new Date().toISOString() }); skipped.add(node.nodeId);
				params.onNodeState?.(await getFlowRunDocument(params.flowId, run.runId), node.nodeId);
			}
			for (let offset = 0; offset < ready.length; offset += 4) {
				await Promise.all(ready.slice(offset, offset + 4).filter((node): boolean => !skipped.has(node.nodeId)).map(async (node): Promise<void> => {
					const inbound = graph.edges.filter((edge): boolean => edge.targetNodeId === node.nodeId);
					const collected = collectInputs(node, graph.edges, outputs);
					if (collected.inactive) {
						await updateFlowNodeRunDocument(params.flowId, run.runId, node.nodeId, { status: "skipped", finishedAt: new Date().toISOString() });
						skipped.add(node.nodeId);
						params.onNodeState?.(await getFlowRunDocument(params.flowId, run.runId), node.nodeId);
						return;
					}
					if (collected.missing.length > 0) {
						const timestamp = new Date().toISOString();
						await updateFlowNodeRunDocument(params.flowId, run.runId, node.nodeId, {
							status: "failed",
							error: `Missing required parameter(s): ${collected.missing.join(", ")}.`,
							startedAt: timestamp,
							finishedAt: timestamp,
						});
						failed.add(node.nodeId);
						params.onNodeState?.(await getFlowRunDocument(params.flowId, run.runId), node.nodeId);
						return;
					}
					const runtimeInput = node.typeId === "builtin/flow-input" ? run.inputValues[node.nodeId] : undefined;
					const fingerprintKey = fingerprint(node, collected.inputs, inbound, runtimeInput);
					if (!force.has(node.nodeId) && canUseCache(node, graph.flow)) {
						const cached = await findCachedFlowNodeOutput(params.flowId, node.nodeId, fingerprintKey);
						if (cached !== null && typeof cached === "object") {
							outputs.set(node.nodeId, cached as PortOutputs);
							await updateFlowNodeRunDocument(params.flowId, run.runId, node.nodeId, { status: "cached", inputFingerprint: fingerprintKey, output: cached, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
							completed.add(node.nodeId);
							params.onNodeState?.(await getFlowRunDocument(params.flowId, run.runId), node.nodeId);
							return;
						}
					}
					const startedAt = new Date().toISOString();
					await updateFlowNodeRunDocument(params.flowId, run.runId, node.nodeId, { status: "running", inputFingerprint: fingerprintKey, startedAt });
					params.onNodeState?.(await getFlowRunDocument(params.flowId, run.runId), node.nodeId);
					try {
						const output = await executeRegisteredFlowNode({ node, inputs: collected.inputs, runInputs: run.inputValues, flow: graph.flow, runId: run.runId, gateway, mcpHost: params.mcpHost, signal: controller.signal, onProgress: (progress): void => params.onNodeProgress?.(run.runId, node.nodeId, progress), onProviderJobId: (providerJobId): Promise<void> => updateFlowNodeProviderJobIdDocument(params.flowId, run.runId, node.nodeId, providerJobId) });
						outputs.set(node.nodeId, output);
						await updateFlowNodeRunDocument(params.flowId, run.runId, node.nodeId, { status: "completed", inputFingerprint: fingerprintKey, output, startedAt, finishedAt: new Date().toISOString() }); completed.add(node.nodeId);
					} catch (nodeError: unknown) {
						if (nodeError instanceof ToolApprovalRequiredError) { await createFlowApprovalDocument({ flowId: params.flowId, runId: run.runId, nodeId: node.nodeId, pending: nodeError.pendingApproval }); await updateFlowNodeRunDocument(params.flowId, run.runId, node.nodeId, { status: "waiting", inputFingerprint: fingerprintKey, startedAt }); waiting.add(node.nodeId); }
						else { if (controller.signal.aborted) throw nodeError; failed.add(node.nodeId); await updateFlowNodeRunDocument(params.flowId, run.runId, node.nodeId, { status: "failed", inputFingerprint: fingerprintKey, error: nodeError instanceof Error ? nodeError.message : String(nodeError), startedAt, finishedAt: new Date().toISOString() }); }
					}
					params.onNodeState?.(await getFlowRunDocument(params.flowId, run.runId), node.nodeId);
				}));
			}
		}
		if (waiting.size > 0) { const waitingRun = await updateFlowRunDocument(params.flowId, run.runId, { status: "waiting" }); params.onRunState?.(waitingRun); return waitingRun; }
		const finished = await updateFlowRunDocument(params.flowId, run.runId, { status: failed.size > 0 ? "failed" : "completed", ...(failed.size > 0 ? { error: `${failed.size} node(s) failed.` } : {}), finishedAt: new Date().toISOString() }); params.onRunState?.(finished); return finished;
	} catch (error: unknown) {
		const failedRun = await updateFlowRunDocument(params.flowId, run.runId, { status: controller.signal.aborted ? "cancelled" : "failed", error: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() }); params.onRunState?.(failedRun); return failedRun;
	} finally {
		const current = await getFlowRunDocument(params.flowId, run.runId);
		if (current.status !== "waiting") { activeControllers.delete(key); gatewaysByRun.delete(key); if (activeRunsByFlow.get(params.flowId) === run.runId) activeRunsByFlow.delete(params.flowId); }
	}
}

export async function resolveFlowRunApproval(params: { flowId: string; runId: string; approvalId: string; decision: "approve" | "reject"; consentText?: string | undefined; mcpHost: McpHost }): Promise<FlowDocumentRun> {
	const stored = await getPendingFlowApprovalDocument(params.flowId, params.runId, params.approvalId);
	if (stored.pending.requiredConsent !== undefined && params.decision === "approve" && params.consentText !== stored.pending.requiredConsent.expectedText) throw Object.assign(new Error("The required approval phrase did not match."), { code: "approval_consent_mismatch" });
	const key = `${params.flowId}:${params.runId}`;
	const graph = await readFlowGraphForScheduler(params.flowId);
	const gateway = gatewaysByRun.get(key) ?? new ApprovalGateway(graph.flow.approvalMode);
	gatewaysByRun.set(key, gateway);
	gateway.upsertPending(stored.pending);
	const currentNodeRun = (await getFlowRunDocument(params.flowId, params.runId)).nodes.find((node): boolean => node.nodeId === stored.approval.nodeId);
	if (params.decision === "reject") {
		gateway.reject(params.approvalId);
		await resolveFlowApprovalDocument(params.flowId, params.runId, params.approvalId, "rejected");
		await updateFlowNodeRunDocument(params.flowId, params.runId, stored.approval.nodeId, { status: "failed", inputFingerprint: currentNodeRun?.inputFingerprint ?? null, error: "The Flow tool action was rejected.", finishedAt: new Date().toISOString() });
	} else {
		const result = await gateway.approve(params.approvalId, params.mcpHost);
		await resolveFlowApprovalDocument(params.flowId, params.runId, params.approvalId, "approved");
		await updateFlowNodeRunDocument(params.flowId, params.runId, stored.approval.nodeId, { status: "completed", inputFingerprint: currentNodeRun?.inputFingerprint ?? null, output: { result: parseToolContent(result.content), text: result.content }, finishedAt: new Date().toISOString() });
	}
	return startFlowRunDocument({ flowId: params.flowId, revision: graph.flow.graphRevision, runId: params.runId, mcpHost: params.mcpHost });
}
