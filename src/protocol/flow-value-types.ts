import { z } from "zod";

export const FLOW_STORAGE_GENERATION = "flow-composable-1";
export const FLOW_VALUE_TYPES = ["text", "json", "image", "video", "audio", "frames", "artifact", "number", "boolean", "color", "size", "mask"] as const;
export type FlowValueType = typeof FLOW_VALUE_TYPES[number];
export type FlowCardinality = "one" | "many" | "one-or-many";
export const flowColorSchema = z.object({ r: z.number().min(0).max(1), g: z.number().min(0).max(1), b: z.number().min(0).max(1), a: z.number().min(0).max(1) }).strict();
export const flowSizeSchema = z.object({ width: z.number().int().positive().max(16000), height: z.number().int().positive().max(16000) }).strict();
const mediaRef = z.object({
	artifactId: z.string().regex(/^flow-artifact-[a-zA-Z0-9_-]+$/u), mimeType: z.string().max(160), sha256: z.string().regex(/^[a-f0-9]{64}$/u),
	flowId: z.string().optional(), runId: z.string().optional(), nodeId: z.string().optional(),
	width: z.number().int().positive().optional(), height: z.number().int().positive().optional(), byteSize: z.number().int().positive().optional(),
	durationMs: z.number().nonnegative().optional(), fps: z.number().positive().optional(),
	previewArtifactId: z.string().optional(), storagePath: z.string().optional(), createdAt: z.string().optional(), metadata: z.record(z.string(), z.json()).optional(),
}).strict();
export const FLOW_TYPE_PRESENTATION: Record<FlowValueType, { color: string; control: string }> = {
	text: { color: "#a65f2a", control: "text" }, json: { color: "#722ed1", control: "json" },
	image: { color: "#13a8a8", control: "workspace-file" }, video: { color: "#d4388f", control: "workspace-file" },
	audio: { color: "#d46b08", control: "workspace-file" }, frames: { color: "#2f54eb", control: "workspace-file" },
	artifact: { color: "#d4b106", control: "workspace-file" }, number: { color: "#9299a3", control: "number" },
	boolean: { color: "#d78dba", control: "boolean" }, color: { color: "#d4c345", control: "color" },
	size: { color: "#718ed9", control: "size" }, mask: { color: "#b9bec8", control: "workspace-file" },
};

export function acceptsFlowCardinality(source: FlowCardinality = "one", target: FlowCardinality = "one"): boolean {
	return target === "one-or-many" || source === target;
}

export function isFlowValue(type: FlowValueType, value: unknown): boolean {
	switch (type) {
		case "text": return typeof value === "string";
		case "number": return typeof value === "number" && Number.isFinite(value);
		case "boolean": return typeof value === "boolean";
		case "color": return flowColorSchema.safeParse(value).success;
		case "size": return flowSizeSchema.safeParse(value).success;
		case "json": return z.json().safeParse(value).success;
		default: {
			const result = mediaRef.safeParse(value);
			if (!result.success) return false;
			if (type === "artifact") return true;
			return result.data.mimeType.startsWith(`${type === "mask" || type === "frames" ? "image" : type}/`);
		}
	}
}

export function assertFlowPortValue(port: { id: string; dataTypes: readonly FlowValueType[]; cardinality?: FlowCardinality | undefined }, value: unknown): void {
	const cardinality = port.cardinality ?? "one";
	const values = cardinality === "many" || cardinality === "one-or-many" && Array.isArray(value) ? value : [value];
	if (!Array.isArray(values) || values.length > 100 || !values.every(item => port.dataTypes.some(type => isFlowValue(type, item))))
		throw Object.assign(new Error(`Invalid value for ${port.id} (${port.dataTypes.join("|")}, ${cardinality}).`), { code: "flow_port_value_invalid" });
}
