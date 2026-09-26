import { mediaAdapterFingerprint } from "../providers/media-generation.js";
import { createHash, randomInt } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { batchRowsSchema } from "./flow-composable-definitions.js";
import type { FlowNodeExecutionContext, FlowNodeExecutor } from "./flow-node-executor-registry.js";
import { findFlowBatchItem, putFlowBatchItem, type FlowBatchItemRun } from "../session/flow-batch-store.js";
import { getFlowArtifact } from "../session/flow-artifact-store.js";

export async function executeFlowBatch(context: FlowNodeExecutionContext, executeMedia: FlowNodeExecutor): Promise<Record<string, unknown>> {
	const rows = batchRowsSchema.parse(context.inputs.rows);
	const report: FlowBatchItemRun[] = new Array(rows.length);
	let next = 0; let finished = 0;
	const persist = async (item: FlowBatchItemRun): Promise<void> => { await putFlowBatchItem(item); context.onBatchItem?.(item); };
	const workers = await Promise.allSettled(Array.from({ length: Math.min(4, rows.length) }, async () => {
		while (next < rows.length) {
			const ordinal = next++; const row = rows[ordinal]!;
			const requestFingerprint = createHash("sha256").update(JSON.stringify({ config: context.node.config, row, image: (context.inputs.image as { sha256?: string } | undefined)?.sha256, adapter: mediaAdapterFingerprint(String(context.node.config.provider)), version: context.node.pluginFingerprint })).digest("hex");
			const previous = context.force === true ? null : await findFlowBatchItem(context.flow.flowId, context.node.nodeId, row.id, requestFingerprint);
			const params = { ...row, seed: row.seed ?? (previous?.params.seed as number | undefined) ?? randomInt(2147483647) };
			const fingerprint = createHash("sha256").update(JSON.stringify({ requestFingerprint, params })).digest("hex");
			const item: FlowBatchItemRun = { flowId: context.flow.flowId, runId: context.runId, nodeId: context.node.nodeId, itemId: row.id, ordinal, requestFingerprint, fingerprint, params, status: "queued", providerJobId: previous?.providerJobId ?? null, output: [], error: null, attempts: previous?.attempts ?? 0 };
			report[ordinal] = item;
			try {
				if (previous?.status === "completed") {
					try {
						for (const ref of previous.output) { const artifact = await getFlowArtifact(String((ref as { artifactId: string }).artifactId)); if (artifact.ref.flowId !== context.flow.flowId) throw new Error("flow_artifact_scope_invalid"); }
						item.output = previous.output; item.status = "completed"; await persist(item); continue;
					} catch { /* 已清理的产物不能命中缓存 */ }
				}
			if (previous !== null && ["submitting", "uncertain"].includes(previous.status) && !previous.providerJobId && context.confirmPossibleDuplicateCharge !== true) {
					item.status = "uncertain"; throw new Error("media_submission_uncertain: explicitly force a new generation to avoid duplicate billing");
				}
				context.signal.throwIfAborted();
				for (let attempt = 0; ; attempt++) {
					item.status = item.providerJobId ? "running" : "submitting"; item.attempts++; await persist(item);
					try {
						const output = await executeMedia({ ...context, node: { ...context.node, typeId: context.node.typeId === "builtin/batch-image-to-image" ? "builtin/image-to-image" : "builtin/text-to-image", config: { ...context.node.config, ...params, rowIndex: ordinal + 1 } }, inputs: { prompt: row.prompt, ...(context.inputs.image === undefined ? {} : { image: context.inputs.image }) }, resumeProviderJobId: item.providerJobId ?? undefined, onProviderJobId: async id => { item.providerJobId = id; item.status = "running"; await persist(item); }, onProgress: undefined });
						item.output = Array.isArray(output.images) ? output.images : [output.image]; item.status = "completed"; break;
					} catch (error) {
						const status = (error as { status?: number }).status;
						if (status !== 429 || attempt >= 2 || item.providerJobId) throw error;
						const header = (error as { headers?: { get?: (name: string) => string | null } }).headers?.get?.("retry-after");
						const retry = header && !Number.isFinite(Number(header)) ? Math.max(0, (Date.parse(header) - Date.now()) / 1000) : Number(header);
						await delay(Math.min(120_000, (Number.isFinite(retry) && retry > 0 ? retry : 2 ** attempt) * 1000), undefined, { signal: context.signal });
					}
				}
			} catch (error) {
				if (item.status !== "uncertain") item.status = item.status === "submitting" && !item.providerJobId && typeof (error as { status?: unknown }).status !== "number" ? "uncertain" : context.signal.aborted ? "cancelled" : "failed";
				item.error = error instanceof Error ? error.message : String(error);
				if ((error as { providerTaskTerminal?: boolean }).providerTaskTerminal) item.providerJobId = null;
			} finally { await persist(item); finished++; context.onProgress?.(finished / rows.length); }
		}
	}));
	const interrupted = workers.find((worker): worker is PromiseRejectedResult => worker.status === "rejected");
	if (interrupted) throw interrupted.reason;
	context.signal.throwIfAborted();
	const failed = report.filter(item => item.status !== "completed");
	if (failed.length === report.length) throw new Error(`All ${failed.length} batch items failed: ${failed[0]?.error}`);
	if (failed.length > 0) context.onPartialFailure?.(failed.length);
	return { images: report.flatMap(item => item.output), report: { items: report, failed: failed.length, completed: report.length - failed.length } };
}
