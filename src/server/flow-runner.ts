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
	updateFlowRunDocument,
} from "../session/flow-document-store.js";

type PortOutputs = Record<string, unknown>;
type NodeInputs = Record<string, unknown>;

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

function fingerprint(node: FlowDocumentNode, inputs: NodeInputs, inbound: readonly FlowDocumentEdge[]): string {
	return createHash("sha256").update(JSON.stringify({
		type: node.type,
		config: node.config,
		inputs,
		ports: inbound.map((edge): string[] => [edge.sourcePort, edge.targetPort, edge.dataType]),
		provider: node.config.provider,
		model: node.config.model,
		reasoningEffort: node.config.reasoningEffort,
	})).digest("hex");
}

function collectInputs(node: FlowDocumentNode, edges: readonly FlowDocumentEdge[], outputs: ReadonlyMap<string, PortOutputs>): { inputs: NodeInputs; inactive: boolean } {
	const inputs: NodeInputs = {};
	let inactive = false;
	for (const edge of edges.filter((candidate): boolean => candidate.targetNodeId === node.nodeId).sort((left, right): number => left.targetPort.localeCompare(right.targetPort))) {
		const sourceOutputs = outputs.get(edge.sourceNodeId);
		if (sourceOutputs === undefined || !Object.prototype.hasOwnProperty.call(sourceOutputs, edge.sourcePort)) {
			inactive = true;
			continue;
		}
		inputs[edge.targetPort] = sourceOutputs[edge.sourcePort];
	}
	return { inputs, inactive };
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
		message: Object.values(inputs).map(asText).join("\n\n"),
		mode: "ask",
		options: { stream: false, ...(typeof node.config.reasoningEffort === "string" && node.config.reasoningEffort.length > 0 ? { reasoningEffort: node.config.reasoningEffort } : {}) },
	};
	const systemPrompt = typeof node.config.systemPrompt === "string" && node.config.systemPrompt.length > 0 ? node.config.systemPrompt : "You are a helpful assistant.";
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
	const proxyNode: FlowDocumentNode = { ...params.node, type: "tool", config: { toolName: "mcp_terminal_run_command", args, bindings: [] } };
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

async function executeNode(params: { node: FlowDocumentNode; inputs: NodeInputs; flow: FlowDocument; runId: string; gateway: ApprovalGateway; mcpHost: McpHost; signal: AbortSignal }): Promise<PortOutputs> {
	const { node, inputs } = params;
	if (node.type === "prompt" || node.type === "text") return { output: typeof node.config.text === "string" ? node.config.text : "" };
	if (node.type === "template") {
		let rendered = typeof node.config.template === "string" ? node.config.template : "";
		for (const [key, value] of Object.entries(inputs)) rendered = rendered.replaceAll(`{{${key}}}`, asText(value));
		return { output: rendered };
	}
	if (node.type === "merge") {
		const configuredOrder = Array.isArray(node.config.inputs)
			? node.config.inputs.flatMap((candidate): string[] => candidate !== null && typeof candidate === "object" && typeof (candidate as Record<string, unknown>).id === "string" ? [String((candidate as Record<string, unknown>).id)] : [])
			: [];
		const rank = new Map(configuredOrder.map((id, index): [string, number] => [id, index]));
		const entries = Object.entries(inputs).sort(([left], [right]): number => (rank.get(left) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right) ?? Number.MAX_SAFE_INTEGER) || left.localeCompare(right));
		if (node.config.mode === "array") return { output: entries.map(([, value]): unknown => value) };
		if (node.config.mode === "object") return { output: Object.fromEntries(entries) };
		return { output: entries.map(([, value]): string => asText(value)).join(typeof node.config.separator === "string" ? node.config.separator : "\n") };
	}
	if (node.type === "json_extract") {
		const value = typeof inputs.input === "string" ? JSON.parse(inputs.input) as unknown : inputs.input;
		return { output: readJsonPointer(value, typeof node.config.pointer === "string" ? node.config.pointer : "/") };
	}
	if (node.type === "condition") return { [compareCondition(node, inputs.input) ? "true" : "false"]: inputs.input };
	if (node.type === "file_input") return readFileNode(node, params.flow);
	if (node.type === "llm") return { output: await runLlm(node, inputs, params.signal) };
	if (node.type === "tool") return executeToolNode(params);
	if (node.type === "command") return executeCommandNode(params);
	if (node.type === "output") return { result: inputs.input };
	return {};
}

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
	if (node.type === "command") return false;
	if (node.type !== "tool") return node.type !== "note";
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
	onRunState?: (run: Awaited<ReturnType<typeof getFlowRunDocument>>) => void;
	onNodeState?: (run: Awaited<ReturnType<typeof getFlowRunDocument>>, nodeId: string) => void;
}): Promise<Awaited<ReturnType<typeof getFlowRunDocument>>> {
	const activeRunId = activeRunsByFlow.get(params.flowId);
	if (activeRunId !== undefined && activeRunId !== params.runId) throw Object.assign(new Error("Another Flow run is active."), { code: "flow_busy", activeRunId });
	const graph = await readFlowGraphForScheduler(params.flowId);
	if (graph.flow.graphRevision !== params.revision) throw Object.assign(new Error("The Flow changed before execution started."), { code: "flow_revision_conflict" });
	const executable = graph.nodes.filter((node): boolean => node.type !== "note");
	const run = params.runId === undefined ? await createFlowRunDocument(params.flowId, params.revision, graph.nodes.map((node): string => node.nodeId)) : await getFlowRunDocument(params.flowId, params.runId);
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
	for (const note of graph.nodes.filter((node): boolean => node.type === "note")) {
		if (!skipped.has(note.nodeId)) await updateFlowNodeRunDocument(params.flowId, run.runId, note.nodeId, { status: "skipped", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
		skipped.add(note.nodeId);
	}
	try {
		while (completed.size + failed.size + skipped.size + waiting.size < graph.nodes.length) {
			if (controller.signal.aborted) throw new Error("Flow run cancelled.");
			const pending = executable.filter((node): boolean => !completed.has(node.nodeId) && !failed.has(node.nodeId) && !skipped.has(node.nodeId) && !waiting.has(node.nodeId));
			const ready = pending.filter((node): boolean => graph.edges.filter((edge): boolean => edge.targetNodeId === node.nodeId).every((edge): boolean => completed.has(edge.sourceNodeId) || failed.has(edge.sourceNodeId) || skipped.has(edge.sourceNodeId)));
			if (ready.length === 0) break;
			for (const node of ready.filter((candidate): boolean => graph.edges.some((edge): boolean => edge.targetNodeId === candidate.nodeId && (failed.has(edge.sourceNodeId) || skipped.has(edge.sourceNodeId))))) {
				await updateFlowNodeRunDocument(params.flowId, run.runId, node.nodeId, { status: "skipped", finishedAt: new Date().toISOString() }); skipped.add(node.nodeId);
			}
			for (let offset = 0; offset < ready.length; offset += 4) {
				await Promise.all(ready.slice(offset, offset + 4).filter((node): boolean => !skipped.has(node.nodeId)).map(async (node): Promise<void> => {
					const inbound = graph.edges.filter((edge): boolean => edge.targetNodeId === node.nodeId);
					const collected = collectInputs(node, graph.edges, outputs);
					if (collected.inactive) { await updateFlowNodeRunDocument(params.flowId, run.runId, node.nodeId, { status: "skipped", finishedAt: new Date().toISOString() }); skipped.add(node.nodeId); return; }
					const fingerprintKey = fingerprint(node, collected.inputs, inbound);
					if (!force.has(node.nodeId) && canUseCache(node, graph.flow)) {
						const cached = await findCachedFlowNodeOutput(params.flowId, node.nodeId, fingerprintKey);
						if (cached !== null && typeof cached === "object") { outputs.set(node.nodeId, cached as PortOutputs); await updateFlowNodeRunDocument(params.flowId, run.runId, node.nodeId, { status: "cached", inputFingerprint: fingerprintKey, output: cached, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }); completed.add(node.nodeId); return; }
					}
					const startedAt = new Date().toISOString();
					await updateFlowNodeRunDocument(params.flowId, run.runId, node.nodeId, { status: "running", inputFingerprint: fingerprintKey, startedAt });
					params.onNodeState?.(await getFlowRunDocument(params.flowId, run.runId), node.nodeId);
					try {
						const output = await executeNode({ node, inputs: collected.inputs, flow: graph.flow, runId: run.runId, gateway, mcpHost: params.mcpHost, signal: controller.signal });
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
