import { z } from "zod";
import { FLOW_VALUE_TYPES, flowColorSchema, flowSizeSchema, type FlowValueType } from "../protocol/flow-value-types.js";
import type { FlowNodeParameterDefinition, FlowNodeOutputDefinition } from "../protocol/types.js";
import type { registerBuiltin } from "./flow-node-registry.js";

export const batchRowSchema = z.object({
	id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/u), prompt: z.string().min(1).max(32000), negativePrompt: z.string().max(8000).default(""),
	seed: z.number().int().min(0).max(2147483647).optional(), width: z.number().int().min(1).max(16000).default(1024), height: z.number().int().min(1).max(16000).default(1024), count: z.number().int().min(1).max(4).default(1),
}).strict();
export const batchRowsSchema = z.array(batchRowSchema).min(1).max(50).superRefine((rows, ctx) => {
	if (new Set(rows.map(row => row.id)).size !== rows.length) ctx.addIssue({ code: "custom", message: "Duplicate batch row ID." });
	if (rows.reduce((sum, row) => sum + row.count, 0) > 100) ctx.addIssue({ code: "custom", message: "Batch exceeds 100 images." });
	if (rows.some(row => row.width * row.height > 16_000_000)) ctx.addIssue({ code: "custom", message: "Image exceeds 16 million pixels." });
});
const fixed = (id: string, label: string = id): FlowNodeParameterDefinition => ({ id, label, mode: "fixed", configField: id });
const input = (id: string, types: readonly FlowValueType[], cardinality: "one" | "many" | "one-or-many" = "one"): Extract<FlowNodeParameterDefinition, { mode: "connection" }> => ({ id, label: id, mode: "connection", dataTypes: [...types], cardinality, required: true, multiple: false, defaultConnect: true });
const hybrid = (id: string, type: FlowValueType): FlowNodeParameterDefinition => ({ id, label: id, mode: "hybrid", configField: id, dataTypes: [type], required: true, multiple: false, defaultConnect: false, hideControlWhenConnected: true });
const output = (id: string, types: readonly FlowValueType[], cardinality: "one" | "many" | "one-or-many" = "one"): FlowNodeOutputDefinition => ({ id, label: id, dataTypes: [...types], cardinality, defaultConnect: true });
const positive = z.number().int().min(1).max(16000);
const coord = z.number().int().min(0).max(16000);

export function registerComposableDefinitions(register: typeof registerBuiltin): void {
	for (const [type, value, schema] of [
		["number", 0, z.number()], ["boolean", false, z.boolean()],
		["color", { r: 1, g: 1, b: 1, a: 1 }, flowColorSchema], ["size", { width: 1024, height: 1024 }, flowSizeSchema],
	] as const) register(type, "parameters", type, { value }, [fixed("value")], [output("value", [type])], z.object({ value: schema }).strict(), { fieldControls: { value: type } });
	register("text-replace", "basic", "Text Replace", { text: "", search: "", replacement: "" }, [hybrid("text", "text"), fixed("search"), fixed("replacement")], [output("text", ["text"])], z.object({ text: z.string(), search: z.string(), replacement: z.string() }).strict());
	register("to-text", "basic", "To Text", {}, [input("value", FLOW_VALUE_TYPES)], [output("text", ["text"])], z.object({}).strict());
	register("image-input", "media-input", "Image Input", { path: "" }, [fixed("path")], [output("image", ["image"]), output("size", ["size"])], z.object({ path: z.string().max(4000) }).strict(), { workspaceRequired: true, cachePolicy: "never", fieldControls: { path: "workspace-file" } });
	const image = input("image", ["image"], "one-or-many");
	const result = [output("images", ["image"], "many")];
	register("image-resize", "media-processing", "Image Resize", { width: 1024, height: 1024, fit: "contain", background: { r: 0, g: 0, b: 0, a: 0 } }, [image, { ...input("size", ["size"]), required: false, defaultConnect: false }, hybrid("width", "number"), hybrid("height", "number"), fixed("fit"), hybrid("background", "color")], result, z.object({ width: positive, height: positive, fit: z.enum(["contain", "cover", "fill"]), background: flowColorSchema }).strict(), { fieldControls: { background: "color" } });
	register("image-crop", "media-processing", "Image Crop", { x: 0, y: 0, width: 512, height: 512 }, [image, ...["x", "y", "width", "height"].map(id => hybrid(id, "number"))], result, z.object({ x: coord, y: coord, width: positive, height: positive }).strict());
	register("image-rotate", "media-processing", "Image Rotate", { angle: 0, flip: false, flop: false }, [image, hybrid("angle", "number"), hybrid("flip", "boolean"), hybrid("flop", "boolean")], result, z.object({ angle: z.number().min(-360).max(360), flip: z.boolean(), flop: z.boolean() }).strict());
	register("image-composite", "media-processing", "Image Composite", { x: 0, y: 0, opacity: 1 }, [image, input("overlay", ["image"]), hybrid("x", "number"), hybrid("y", "number"), hybrid("opacity", "number")], result, z.object({ x: coord, y: coord, opacity: z.number().min(0).max(1) }).strict());
	register("image-convert", "media-processing", "Image Convert", { format: "png", quality: 90 }, [image, fixed("format"), fixed("quality")], result, z.object({ format: z.enum(["png", "jpeg", "webp"]), quality: z.number().int().min(1).max(100) }).strict());
	register("save-images", "workspace-media", "Save Images", { directory: "outputs", fileName: "{runId}-{index}" }, [input("images", ["image"], "one-or-many"), fixed("directory"), fixed("fileName")], [], z.object({ directory: z.string().max(2000), fileName: z.string().min(1).max(240) }).strict(), { workspaceRequired: true, sideEffecting: true, cachePolicy: "never", terminal: true });
	register("save-videos", "workspace-media", "Save Videos", { directory: "outputs", fileName: "{runId}-{index}" }, [input("videos", ["video"], "one-or-many"), fixed("directory"), fixed("fileName")], [], z.object({ directory: z.string().max(2000), fileName: z.string().min(1).max(240) }).strict(), { workspaceRequired: true, sideEffecting: true, cachePolicy: "never", terminal: true });
	const elementType = z.enum(FLOW_VALUE_TYPES);
	register("list", "collections", "Build List", { elementType: "text", values: [] }, [fixed("elementType"), fixed("values")], [output("items", ["text"], "many")], z.object({ elementType, values: z.array(z.unknown()).max(100) }).strict(), { fieldControls: { values: "typed-list" } });
	register("list-item", "collections", "List Item", { elementType: "image", index: 0 }, [fixed("elementType"), input("items", ["image"], "many"), hybrid("index", "number")], [output("value", ["image"])], z.object({ elementType, index: z.number().int().min(0).max(99) }).strict());
	register("list-merge", "collections", "Merge Lists", { elementType: "image" }, [fixed("elementType"), input("a", ["image"], "many"), input("b", ["image"], "many")], [output("items", ["image"], "many")], z.object({ elementType }).strict());
	register("parameter-sets", "collections", "Parameter Sets", { rows: [{ id: "row-1", prompt: "", negativePrompt: "", width: 1024, height: 1024, count: 1 }] }, [fixed("rows")], [output("rows", ["json"], "many")], z.object({ rows: z.array(batchRowSchema.extend({ prompt: z.string().max(32000) })).max(50) }).strict(), { fieldControls: { rows: "parameter-sets" } });
	for (const name of ["batch-text-to-image", "batch-image-to-image"]) {
		register(name, "media-generation", name === "batch-text-to-image" ? "Batch Text to Image" : "Batch Image to Image", { provider: "", model: "", outputFormat: "png" }, [input("rows", ["json"], "many"), ...(name === "batch-image-to-image" ? [input("image", ["image"])] : []), fixed("provider"), fixed("model"), fixed("outputFormat")], [output("images", ["image"], "many"), output("report", ["json"])], z.object({ provider: z.string(), model: z.string(), outputFormat: z.enum(["png", "jpeg", "webp"]) }).strict(), { batch: true, modelCapability: name === "batch-image-to-image" ? "imageEdit" : "imageGeneration", cachePolicy: "never", fieldControls: { provider: "provider", model: "model" } });
	}
}
