import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { processImage, type ImageOperation } from "../media/image-processing.js";
import { assertFlowPortValue, type FlowValueType } from "../protocol/flow-value-types.js";
import { getFlowArtifact, saveFlowArtifact } from "../session/flow-artifact-store.js";
import { findWorkspace } from "../workspace/registry.js";
import type { FlowApprovedResult, FlowNodeExecutor, FlowNodeExecutionContext, registerFlowNodeExecutor } from "./flow-node-executor-registry.js";
import { executeFlowBatch } from "./flow-batch-executor.js";

export async function readScopedFlowImage(context: Pick<FlowNodeExecutionContext, "flow">, value: unknown): Promise<Awaited<ReturnType<typeof getFlowArtifact>>> {
	assertFlowPortValue({ id: "image", dataTypes: ["image"] }, value);
	const artifact = await getFlowArtifact((value as { artifactId: string }).artifactId);
	if (artifact.ref.flowId !== context.flow.flowId || artifact.ref.sha256 !== (value as { sha256: string }).sha256) throw new Error("flow_artifact_scope_invalid");
	return artifact;
}

export async function readScopedFlowVideo(context: Pick<FlowNodeExecutionContext, "flow">, value: unknown): Promise<Awaited<ReturnType<typeof getFlowArtifact>>> {
	assertFlowPortValue({ id: "video", dataTypes: ["video"] }, value);
	const artifact = await getFlowArtifact((value as { artifactId: string }).artifactId);
	if (artifact.ref.flowId !== context.flow.flowId || artifact.ref.sha256 !== (value as { sha256: string }).sha256) throw new Error("flow_artifact_scope_invalid");
	return artifact;
}

export async function transformFlowImage(context: FlowNodeExecutionContext, value: unknown, operation: ImageOperation, overlay?: unknown): Promise<unknown> {
	const artifact = await readScopedFlowImage(context, value);
	const layer = overlay === undefined ? undefined : await readScopedFlowImage(context, overlay);
	const image = await processImage(artifact.bytes, operation, context.signal, layer?.bytes);
	return saveFlowArtifact({ flowId: context.flow.flowId, runId: context.runId, nodeId: context.node.nodeId, ...image, metadata: { ...artifact.ref.metadata, engine: image.engine, sourceHash: artifact.ref.sha256 } });
}

export function registerComposableExecutors(register: typeof registerFlowNodeExecutor, media: FlowNodeExecutor, tool: FlowNodeExecutor): void {
	const add = (name: string, execute: FlowNodeExecutor, approvedResult?: (value: unknown) => FlowApprovedResult): void => register(`builtin/${name}`, "builtin", execute, approvedResult);
	for (const name of ["number", "boolean", "color", "size"]) add(name, async ({ node }) => ({ value: node.config.value }));
	add("provider", async ({ node }) => ({ provider: node.config.provider }));
	add("model", async ({ node }) => ({ model: node.config.model }));
	add("text-replace", async ({ node, inputs }) => ({ text: String(inputs.text ?? node.config.text).replaceAll(String(node.config.search), String(node.config.replacement)) }));
	add("to-text", async ({ inputs }) => ({ text: typeof inputs.value === "string" ? inputs.value : JSON.stringify(inputs.value) }));
	add("list", async ({ node }) => {
		const values = node.config.values;
		assertFlowPortValue({ id: "items", dataTypes: [node.config.elementType as FlowValueType], cardinality: "many" }, values);
		return { items: values };
	});
	add("list-item", async ({ node, inputs }) => {
		const items = inputs.items as unknown[]; const index = Number(inputs.index ?? node.config.index);
		if (!Number.isInteger(index) || index < 0 || index >= items.length) throw new Error("flow_list_index_out_of_range");
		return { value: items[index] };
	});
	add("list-merge", async ({ inputs }) => {
		const items = [...inputs.a as unknown[], ...inputs.b as unknown[]];
		if (items.length > 100) throw new Error("flow_list_limit");
		return { items };
	});
	add("save-images", async context => {
		const refs = Array.isArray(context.inputs.images) ? context.inputs.images : [context.inputs.images];
		const items = [];
		for (const [index, ref] of refs.entries()) {
			const artifact = await readScopedFlowImage(context, ref);
			const pattern = String(context.node.config.fileName);
			if (/[\\/:]/u.test(pattern) || /\{(?!runId\}|index\}|row\}|seed\})/u.test(pattern)) throw new Error("flow_image_filename_invalid");
			const name = pattern.replaceAll("{runId}", context.runId).replaceAll("{index}", String(index + 1)).replaceAll("{row}", String(artifact.ref.metadata.rowIndex ?? index + 1)).replaceAll("{seed}", String(artifact.ref.metadata.seed ?? "unknown"));
			const extension = artifact.ref.mimeType === "image/jpeg" ? "jpg" : artifact.ref.mimeType.split("/")[1];
			const itemKey = createHash("sha256").update(JSON.stringify([artifact.ref.sha256, artifact.ref.metadata.itemId ?? artifact.ref.artifactId, artifact.ref.metadata.imageIndex ?? 0])).digest("hex");
			items.push({ itemKey, artifactId: artifact.ref.artifactId, relativePath: `${context.node.config.directory}/${name}.${extension}` });
		}
		const saveId = createHash("sha256").update(JSON.stringify({ node: context.node.nodeId, config: context.node.config })).digest("hex");
		const result = await tool({ ...context, node: { ...context.node, config: { toolName: "mcp_image_import_flow_images", args: { flowId: context.flow.flowId, saveId, items }, bindings: [] } } });
		const resolved = imageSaveResult(result.result);
		if (resolved.partialFailures) context.onPartialFailure?.(resolved.partialFailures);
		return resolved.output;
	}, imageSaveResult);
	add("save-videos", async context => {
		const refs = Array.isArray(context.inputs.videos) ? context.inputs.videos : [context.inputs.videos];
		const items = [];
		for (const [index, ref] of refs.entries()) {
			const artifact = await readScopedFlowVideo(context, ref);
			const pattern = String(context.node.config.fileName);
			if (/[\\/:]/u.test(pattern) || /\{(?!runId\}|index\}|row\}|seed\})/u.test(pattern)) throw new Error("flow_video_filename_invalid");
			const name = pattern.replaceAll("{runId}", context.runId).replaceAll("{index}", String(index + 1)).replaceAll("{row}", String(artifact.ref.metadata.rowIndex ?? index + 1)).replaceAll("{seed}", String(artifact.ref.metadata.seed ?? "unknown"));
			const extension = artifact.ref.mimeType === "video/quicktime" ? "mov" : artifact.ref.mimeType.split("/")[1];
			const itemKey = createHash("sha256").update(JSON.stringify([artifact.ref.sha256, artifact.ref.metadata.itemId ?? artifact.ref.artifactId, artifact.ref.metadata.videoIndex ?? 0])).digest("hex");
			items.push({ itemKey, artifactId: artifact.ref.artifactId, relativePath: `${context.node.config.directory}/${name}.${extension}` });
		}
		const saveId = createHash("sha256").update(JSON.stringify({ node: context.node.nodeId, config: context.node.config })).digest("hex");
		const result = await tool({ ...context, node: { ...context.node, config: { toolName: "mcp_video_import_flow_videos", args: { flowId: context.flow.flowId, saveId, items }, bindings: [] } } });
		const resolved = videoSaveResult(result.result);
		if (resolved.partialFailures) context.onPartialFailure?.(resolved.partialFailures);
		return resolved.output;
	}, videoSaveResult);
	add("parameter-sets", async ({ node }) => ({ rows: node.config.rows }));
	add("image-input", async context => {
		const workspace = context.flow.workspaceId === null ? null : findWorkspace(context.flow.workspaceId);
		if (!workspace) throw new Error("flow_workspace_required");
		const relative = String(context.node.config.path);
		if (path.isAbsolute(relative) || relative.split(/[\\/]/u).includes("..")) throw new Error("flow_image_path_invalid");
		const root = await realpath(workspace.rootPath); const target = await realpath(path.resolve(root, relative));
		const relation = path.relative(root, target);
		if (relation.startsWith("..") || path.isAbsolute(relation)) throw new Error("flow_image_path_invalid");
		if ((await stat(target)).size > 64 * 1024 * 1024) throw new Error("image_size_limit");
		const image = await processImage(await readFile(target), { kind: "normalize" }, context.signal);
		const ref = await saveFlowArtifact({ flowId: context.flow.flowId, runId: context.runId, nodeId: context.node.nodeId, ...image });
		return { image: ref, size: { width: image.width, height: image.height } };
	});
	for (const kind of ["resize", "crop", "rotate", "composite", "convert"] as const) add(`image-${kind}`, async context => {
		const config = { ...context.node.config };
		for (const [key, value] of Object.entries(context.inputs)) if (key !== "image" && key !== "overlay" && key !== "size") config[key] = value;
		if (context.inputs.size) Object.assign(config, context.inputs.size);
		const values = Array.isArray(context.inputs.image) ? context.inputs.image : [context.inputs.image];
		const images: unknown[] = [];
		for (const value of values) images.push(await transformFlowImage(context, value, { ...config, kind } as ImageOperation, context.inputs.overlay));
		return { images };
	});
	add("batch-text-to-image", context => executeFlowBatch(context, media));
	add("batch-image-to-image", context => executeFlowBatch(context, media));
}

function imageSaveResult(value: unknown): FlowApprovedResult {
 const report = value as { saved?: unknown[]; failed?: Array<{ error: string }> };
 if (!Array.isArray(report?.saved)) throw new Error("flow_image_save_invalid_result");
 if (report.failed?.length && !report.saved.length) throw new Error(report.failed.map(item => item.error).join("; "));
 return { output: { result: value }, partialFailures: report.failed?.length ?? 0 };
}

function videoSaveResult(value: unknown): FlowApprovedResult {
	const report = value as { saved?: unknown[]; failed?: Array<{ error: string }> };
	if (!Array.isArray(report?.saved)) throw new Error("flow_video_save_invalid_result");
	if (report.failed?.length && !report.saved.length) throw new Error(report.failed.map(item => item.error).join("; "));
	return { output: { result: value }, partialFailures: report.failed?.length ?? 0 };
}
