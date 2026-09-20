import { flowColorSchema } from "../protocol/flow-value-types.js";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isSea } from "node:sea";
import { z } from "zod";

export const IMAGE_ENGINE_FINGERPRINT = "sharp:0.35.4/image-contract:1";

const dimension = z.number().int().min(1).max(16000);
const coordinate = z.number().int().min(0).max(16000);
const format = z.enum(["png", "jpeg", "webp"]);
export const imageOperationSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("resize"), width: dimension, height: dimension, fit: z.enum(["contain", "cover", "fill"]).default("contain"), background: z.union([flowColorSchema, z.string().regex(/^#(?:[a-f\d]{6}|[a-f\d]{8})$/iu)]).default("#00000000") }).strict(),
	z.object({ kind: z.literal("crop"), x: coordinate, y: coordinate, width: dimension, height: dimension }).strict(),
	z.object({ kind: z.literal("rotate"), angle: z.number().min(-360).max(360), flip: z.boolean().default(false), flop: z.boolean().default(false) }).strict(),
	z.object({ kind: z.literal("composite"), x: coordinate, y: coordinate, opacity: z.number().min(0).max(1).default(1) }).strict(),
	z.object({ kind: z.literal("convert"), format, quality: z.number().int().min(1).max(100).default(90) }).strict(),
	z.object({ kind: z.literal("grayscale") }).strict(),
	z.object({ kind: z.literal("normalize") }).strict(),
]);
export type ImageOperation = z.input<typeof imageOperationSchema>;
export type ProcessedImage = { bytes: Buffer; mimeType: string; width: number; height: number; engine: string };
let active = 0;
const pending = new Set<() => void>();
async function acquire(signal: AbortSignal): Promise<() => void> {
	while (active >= 2) {
		signal.throwIfAborted();
		await new Promise<void>((resolve, reject) => {
			const wake = (): void => { pending.delete(wake); signal.removeEventListener("abort", abort); resolve(); };
			const abort = (): void => { pending.delete(wake); reject(signal.reason); };
			pending.add(wake); signal.addEventListener("abort", abort, { once: true });
		});
	}
	signal.throwIfAborted(); active++;
	return (): void => { active--; pending.values().next().value?.(); };
}

export async function processImage(bytes: Buffer, operation: ImageOperation, signal: AbortSignal, overlay?: Buffer): Promise<ProcessedImage> {
	const parsed = imageOperationSchema.parse(operation);
	if (bytes.length === 0 || bytes.length > 64 * 1024 * 1024 || (overlay?.length ?? 0) > 64 * 1024 * 1024) throw new Error("image_size_limit");
	if ("width" in parsed && parsed.width * parsed.height > 16_000_000) throw new Error("image_pixel_limit");
	const release = await acquire(signal);
	try {
		return await new Promise<ProcessedImage>((resolve, reject) => {
			const root = isSea() ? join(dirname(process.execPath), "media") : dirname(fileURLToPath(import.meta.url));
			const executable = isSea() ? join(root, process.platform === "win32" ? "node.exe" : "node") : process.execPath;
			const moduleRoot = isSea() ? join(root, "node_modules") : join(root, "../../node_modules");
			const env = Object.fromEntries(["SystemRoot", "WINDIR", "PATH", "TEMP", "TMP", "HOME"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
			const child = spawn(executable, ["--permission", "--allow-addons", `--allow-fs-read=${root}`, `--allow-fs-read=${moduleRoot}`, join(root, "image-worker.cjs")], { stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced", windowsHide: true, env: { ...env, NODE_OPTIONS: "", UV_THREADPOOL_SIZE: "1" } });
			let done = false;
			const finish = (error?: Error, value?: ProcessedImage): void => {
				if (done) return; done = true; clearTimeout(timer); signal.removeEventListener("abort", abort); child.kill();
				if (error !== undefined) reject(error); else resolve(value!);
			};
			const abort = (): void => finish(new Error("image_processing_cancelled"));
			const timer = setTimeout(() => finish(new Error("image_processing_timeout")), 60_000);
			signal.addEventListener("abort", abort, { once: true });
			child.on("error", error => finish(error));
			child.on("exit", () => finish(new Error("image_processing_worker_exited")));
			child.on("message", (message: unknown) => {
				const result = message as ProcessedImage & { ok: boolean; error?: string };
				if (!result.ok) finish(new Error(result.error ?? "image_processing_failed"));
				else if (!Buffer.isBuffer(result.bytes) || result.bytes.length > 64 * 1024 * 1024 || result.width * result.height > 16_000_000) finish(new Error("image_processing_invalid_output"));
				else finish(undefined, result);
			});
			if (signal.aborted) abort(); else child.send({ bytes, overlay, operation: parsed }, error => { if (error) finish(error); });
		});
	} finally { release(); }
}
