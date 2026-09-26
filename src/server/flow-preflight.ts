import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { listProviderModels } from "../providers/provider-models.js";
import { loadProviderConfigWithSecret } from "../providers/provider-config-store.js";
import { isProviderId } from "../providers/provider-registry.js";
import { auditFlowArtifacts } from "../session/flow-artifact-store.js";
import { findWorkspace } from "../workspace/registry.js";
import { prepareFlowRunDocument, type FlowRunSelection } from "./flow-runner.js";
import { getFlowNodeTypeDefinition } from "./flow-node-registry.js";

export type FlowPreflightIssue = { code: string; nodeId: string | null; message: string };
export type FlowPreflightResult = { flowId: string; revision: number; blockers: FlowPreflightIssue[]; warnings: FlowPreflightIssue[]; plannedRequests: number | null };

function collectArtifactIds(value: unknown, ids: Map<string, string>, nodeId: string): void {
	if (Array.isArray(value)) { for (const item of value) collectArtifactIds(item, ids, nodeId); return; }
	if (value === null || typeof value !== "object") return;
	const record = value as Record<string, unknown>;
	if (typeof record.artifactId === "string") ids.set(record.artifactId, nodeId);
	else for (const item of Object.values(record)) collectArtifactIds(item, ids, nodeId);
}

export async function preflightFlowRun(input: { flowId: string; revision: number; selection?: FlowRunSelection; requireOutputTargets?: boolean }): Promise<FlowPreflightResult> {
	const blockers: FlowPreflightIssue[] = [];
	const warnings: FlowPreflightIssue[] = [];
	const result: FlowPreflightResult = { flowId: input.flowId, revision: input.revision, blockers, warnings, plannedRequests: 0 };
	let plan: Awaited<ReturnType<typeof prepareFlowRunDocument>>;
	try { plan = await prepareFlowRunDocument(input); }
	catch (error: unknown) {
		blockers.push({ code: String((error as { code?: unknown }).code ?? "flow_preflight_invalid"), nodeId: typeof (error as { nodeId?: unknown }).nodeId === "string" ? String((error as { nodeId: string }).nodeId) : null, message: error instanceof Error ? error.message : String(error) });
		return result;
	}
	const artifactNodeIds = new Map<string, string>();
	for (const [nodeId, value] of Object.entries(plan.inputValues)) collectArtifactIds(value, artifactNodeIds, nodeId);
	for (const node of plan.nodes) collectArtifactIds(node.config, artifactNodeIds, node.nodeId);
	if (artifactNodeIds.size > 0) {
		const health = await auditFlowArtifacts(input.flowId, new Set(artifactNodeIds.keys()));
		for (const issue of health.issues) blockers.push({ code: `flow_artifact_${issue.code}`, nodeId: artifactNodeIds.get(issue.artifactId) ?? null, message: `Flow artifact ${issue.artifactId} is ${issue.code}.` });
	}
	for (const node of plan.nodes) {
		const capability = getFlowNodeTypeDefinition(node.typeId).modelCapability;
		if (capability !== undefined || node.typeId === "builtin/llm") {
			const provider = typeof node.config.provider === "string" ? node.config.provider : "";
			const model = typeof node.config.model === "string" ? node.config.model : "";
			if (plan.edges.some(edge => edge.targetNodeId === node.nodeId && (edge.targetPort === "provider" || edge.targetPort === "model"))) {
				warnings.push({ code: "flow_model_resolved_at_runtime", nodeId: node.nodeId, message: "Connected provider or model will be validated when this node runs." });
				result.plannedRequests = null;
				continue;
			}
			if (!provider || !model) { blockers.push({ code: "flow_model_required", nodeId: node.nodeId, message: "Choose a provider and model." }); continue; }
			if (provider !== "mock" && !isProviderId(provider)) { blockers.push({ code: "flow_provider_unknown", nodeId: node.nodeId, message: `Unknown provider: ${provider}.` }); continue; }
			if (provider !== "mock") {
				const config = await loadProviderConfigWithSecret(provider);
				if (!config?.apiKey) blockers.push({ code: "flow_provider_credentials_missing", nodeId: node.nodeId, message: `Provider ${provider} has no API key configured.` });
				const selected = (await listProviderModels(provider, undefined, undefined)).models.find(candidate => candidate.id === model);
				if (!selected) blockers.push({ code: "flow_model_unknown", nodeId: node.nodeId, message: `Model ${provider}/${model} is unavailable.` });
				else if (capability && selected.capabilities[capability] !== true) blockers.push({ code: "flow_model_capability_invalid", nodeId: node.nodeId, message: `Model ${provider}/${model} does not support ${capability}.` });
			}
			if (result.plannedRequests !== null && node.typeId !== "builtin/batch-text-to-image" && node.typeId !== "builtin/batch-image-to-image") result.plannedRequests += 1;
		}
		if (node.typeId === "builtin/batch-text-to-image" || node.typeId === "builtin/batch-image-to-image") {
			const rowEdges = plan.edges.filter(edge => edge.targetNodeId === node.nodeId && edge.targetPort === "rows");
			const rowSources = rowEdges.map(edge => plan.nodes.find(candidate => candidate.nodeId === edge.sourceNodeId));
			if (rowSources.length === 1 && rowSources[0]?.typeId === "builtin/parameter-sets" && Array.isArray(rowSources[0].config.rows)) {
				if (result.plannedRequests !== null) result.plannedRequests += rowSources[0].config.rows.length;
			} else {
				result.plannedRequests = null;
				warnings.push({ code: "flow_batch_request_count_dynamic", nodeId: node.nodeId, message: "Batch request count is resolved from input rows when the node runs." });
			}
		}
		if (node.typeId === "builtin/file-input") {
			if (plan.edges.some(edge => edge.targetNodeId === node.nodeId && edge.targetPort === "path")) {
				warnings.push({ code: "flow_file_path_resolved_at_runtime", nodeId: node.nodeId, message: "Connected file path will be checked when this node runs." });
				continue;
			}
			const workspace = plan.flow.workspaceId ? findWorkspace(plan.flow.workspaceId) : undefined;
			const relativePath = typeof node.config.path === "string" ? node.config.path : "";
			if (!workspace || !relativePath || path.isAbsolute(relativePath)) { blockers.push({ code: "flow_file_path_invalid", nodeId: node.nodeId, message: "File Input requires a workspace-relative path." }); continue; }
			try {
				const root = await realpath(workspace.rootPath);
				const source = await realpath(path.resolve(root, relativePath));
				const inside = path.relative(root, source);
				if (inside.startsWith("..") || path.isAbsolute(inside) || !(await stat(source)).isFile()) throw new Error("File is outside the workspace or is not a regular file.");
			} catch { blockers.push({ code: "flow_file_unavailable", nodeId: node.nodeId, message: "The workspace file cannot be read safely." }); }
		}
	}
	return result;
}
