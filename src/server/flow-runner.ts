import { createHash } from "node:crypto";
import { chatWithProvider, type ProviderChatOptions } from "../providers/deepseek-client.js";
import { loadProviderConfigWithSecret } from "../providers/provider-config-store.js";
import { getProviderAdapterFamily, getProviderDefaultModel, getProviderEndpointTypeForModel } from "../providers/provider-registry.js";
import { normalizeConfiguredProviderBaseUrl } from "../providers/provider-base-url.js";
import { resolveModelProfile } from "../tokens/model-profiles.js";
import type { AiChatParams, FlowDocument, FlowDocumentEdge, FlowDocumentNode } from "../protocol/types.js";
import {
	createFlowRunDocument,
	findCachedFlowNodeOutput,
	getFlowRunDocument,
	readFlowGraphForScheduler,
	updateFlowNodeRunDocument,
	updateFlowRunDocument,
} from "../session/flow-document-store.js";

const activeControllers = new Map<string, AbortController>();
const activeRunsByFlow = new Map<string, string>();

export function getActiveFlowRunIdDocument(flowId: string): string | null {
	return activeRunsByFlow.get(flowId) ?? null;
}

export function stopFlowRunDocument(flowId: string, runId: string): boolean {
	const controller = activeControllers.get(`${flowId}:${runId}`);
	if (controller === undefined) return false;
	controller.abort();
	return true;
}

function fingerprint(node: FlowDocumentNode, inputs: unknown[], flow: FlowDocument): string {
	return createHash("sha256").update(JSON.stringify({
		type: node.type,
		config: node.config,
		inputs,
		provider: node.config.provider,
		model: node.config.model,
		reasoningEffort: node.config.reasoningEffort,
		flowRevision: flow.revision,
	})).digest("hex");
}

function nodeInputs(node: FlowDocumentNode, edges: readonly FlowDocumentEdge[], outputs: ReadonlyMap<string, unknown>): unknown[] {
	return edges
		.filter((edge): boolean => edge.targetNodeId === node.nodeId)
		.sort((left, right): number => left.targetPort.localeCompare(right.targetPort))
		.map((edge): unknown => outputs.get(edge.sourceNodeId) ?? null);
}

async function runLlm(node: FlowDocumentNode, inputs: unknown[], signal: AbortSignal): Promise<string> {
	const provider = typeof node.config.provider === "string" && node.config.provider.length > 0 ? node.config.provider : "deepseek";
	const config = await loadProviderConfigWithSecret(provider);
	if (config?.apiKey === undefined) throw new Error(`Provider ${provider} API key is not configured.`);
	const model = typeof node.config.model === "string" && node.config.model.length > 0 ? node.config.model : config.model ?? getProviderDefaultModel(provider);
	const endpointType = getProviderEndpointTypeForModel(provider, model);
	const options: ProviderChatOptions = {
		provider,
		apiKey: config.apiKey,
		model,
		endpointType,
		adapterFamily: getProviderAdapterFamily(provider, endpointType),
		modelProfile: resolveModelProfile(provider, model),
		...(normalizeConfiguredProviderBaseUrl(config.baseUrl) === undefined ? {} : { baseUrl: normalizeConfiguredProviderBaseUrl(config.baseUrl) }),
		...(config.requestOverrides === undefined ? {} : { requestOverrides: config.requestOverrides }),
	};
	const prompt = inputs.map((value): string => typeof value === "string" ? value : JSON.stringify(value)).join("\n\n");
	const params: AiChatParams = {
		message: prompt,
		mode: "ask",
		options: {
			stream: false,
			...(typeof node.config.reasoningEffort === "string" ? { reasoningEffort: node.config.reasoningEffort } : {}),
		},
	};
	return chatWithProvider(params, options, [], typeof node.config.systemPrompt === "string" ? node.config.systemPrompt : "You are a helpful assistant.", signal);
}

async function executeNode(node: FlowDocumentNode, inputs: unknown[], signal: AbortSignal): Promise<unknown> {
	if (node.type === "prompt") return typeof node.config.text === "string" ? node.config.text : "";
	if (node.type === "llm") return runLlm(node, inputs, signal);
	if (node.type === "output") return inputs.length === 1 ? inputs[0] : inputs;
	return null;
}

export async function startFlowRunDocument(params: {
	flowId: string;
	revision: number;
	runId?: string;
	forceNodeIds?: readonly string[];
	onRunState?: (run: Awaited<ReturnType<typeof getFlowRunDocument>>) => void;
	onNodeState?: (run: Awaited<ReturnType<typeof getFlowRunDocument>>, nodeId: string) => void;
}): Promise<Awaited<ReturnType<typeof getFlowRunDocument>>> {
	const activeRunId = activeRunsByFlow.get(params.flowId);
	if (activeRunId !== undefined && activeRunId !== params.runId) throw Object.assign(new Error("Another Flow run is active."), { code: "flow_busy", activeRunId });
	const graph = await readFlowGraphForScheduler(params.flowId);
	if (graph.flow.revision !== params.revision) throw Object.assign(new Error("The Flow changed before execution started."), { code: "flow_revision_conflict" });
	const executable = graph.nodes.filter((node): boolean => node.type !== "note");
	const run = params.runId === undefined
		? await createFlowRunDocument(params.flowId, params.revision, graph.nodes.map((node): string => node.nodeId))
		: await getFlowRunDocument(params.flowId, params.runId);
	const controller = new AbortController();
	activeControllers.set(`${params.flowId}:${run.runId}`, controller);
	activeRunsByFlow.set(params.flowId, run.runId);
	const outputs = new Map<string, unknown>();
	const completed = new Set<string>();
	const failed = new Set<string>();
	const skipped = new Set<string>();
	const force = new Set(params.forceNodeIds ?? []);
	const edges = graph.edges;
	for (const note of graph.nodes.filter((node): boolean => node.type === "note")) {
		await updateFlowNodeRunDocument(params.flowId, run.runId, note.nodeId, { status: "skipped", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
	}
	const emitRun = async (): Promise<Awaited<ReturnType<typeof getFlowRunDocument>>> => {
		const next = await getFlowRunDocument(params.flowId, run.runId);
		params.onRunState?.(next);
		return next;
	};
	try {
	while (completed.size + failed.size + skipped.size < executable.length) {
			if (controller.signal.aborted) throw new Error("Flow run cancelled.");
			const pending = executable.filter((node): boolean => !completed.has(node.nodeId) && !failed.has(node.nodeId) && !skipped.has(node.nodeId));
			const ready = pending.filter((node): boolean => edges.filter((edge): boolean => edge.targetNodeId === node.nodeId).every((edge): boolean => completed.has(edge.sourceNodeId) || failed.has(edge.sourceNodeId) || skipped.has(edge.sourceNodeId)));
			if (ready.length === 0) throw new Error("Flow graph cannot be scheduled.");
			for (const node of ready.filter((candidate): boolean => edges.filter((edge): boolean => edge.targetNodeId === candidate.nodeId).some((edge): boolean => failed.has(edge.sourceNodeId) || skipped.has(edge.sourceNodeId)))) {
				await updateFlowNodeRunDocument(params.flowId, run.runId, node.nodeId, { status: "skipped", finishedAt: new Date().toISOString() });
				skipped.add(node.nodeId);
			}
			const executableReady = ready.filter((candidate): boolean => !skipped.has(candidate.nodeId));
			for (let offset = 0; offset < executableReady.length; offset += 4) {
				await Promise.all(executableReady.slice(offset, offset + 4).map(async (node): Promise<void> => {
				const inputs = nodeInputs(node, edges, outputs);
				const key = fingerprint(node, inputs, graph.flow);
				if (!force.has(node.nodeId)) {
					const cached = await findCachedFlowNodeOutput(params.flowId, node.nodeId, key);
					if (cached !== null) {
						outputs.set(node.nodeId, cached);
						await updateFlowNodeRunDocument(params.flowId, run.runId, node.nodeId, { status: "cached", inputFingerprint: key, output: cached, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
						completed.add(node.nodeId);
						params.onNodeState?.(await getFlowRunDocument(params.flowId, run.runId), node.nodeId);
						return;
					}
				}
				const startedAt = new Date().toISOString();
				await updateFlowNodeRunDocument(params.flowId, run.runId, node.nodeId, { status: "running", inputFingerprint: key, startedAt });
				params.onNodeState?.(await getFlowRunDocument(params.flowId, run.runId), node.nodeId);
				try {
					const output = await executeNode(node, inputs, controller.signal);
					outputs.set(node.nodeId, output);
					await updateFlowNodeRunDocument(params.flowId, run.runId, node.nodeId, { status: "completed", inputFingerprint: key, output, startedAt, finishedAt: new Date().toISOString() });
					completed.add(node.nodeId);
				} catch (nodeError: unknown) {
					if (controller.signal.aborted) throw nodeError;
					failed.add(node.nodeId);
					await updateFlowNodeRunDocument(params.flowId, run.runId, node.nodeId, { status: "failed", inputFingerprint: key, error: nodeError instanceof Error ? nodeError.message : String(nodeError), startedAt, finishedAt: new Date().toISOString() });
				}
				params.onNodeState?.(await getFlowRunDocument(params.flowId, run.runId), node.nodeId);
				}));
			}
		}
		const completedRun = await updateFlowRunDocument(params.flowId, run.runId, { status: failed.size > 0 ? "failed" : "completed", ...(failed.size > 0 ? { error: `${failed.size} node(s) failed.` } : {}), finishedAt: new Date().toISOString() });
		params.onRunState?.(completedRun);
		return completedRun;
	} catch (error: unknown) {
		const failedRun = await updateFlowRunDocument(params.flowId, run.runId, { status: controller.signal.aborted ? "cancelled" : "failed", error: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() });
		params.onRunState?.(failedRun);
		return failedRun;
	} finally {
		activeControllers.delete(`${params.flowId}:${run.runId}`);
		if (activeRunsByFlow.get(params.flowId) === run.runId) activeRunsByFlow.delete(params.flowId);
	}
}

