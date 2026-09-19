import { createHash } from "node:crypto";
import type { ProviderId } from "../protocol/types.js";
import { createDashScopeMediaGenerationAdapter } from "./dashscope-media-generation.js";
import { generateImageWithArtifactSink, type ImageGenerationArtifactSink } from "./image-generation.js";

export type MediaGenerationKind = "imageGeneration" | "imageEdit" | "videoGeneration" | "videoEdit";

export type MediaGenerationRequest = {
	kind: MediaGenerationKind;
	provider: ProviderId;
	model: string;
	prompt: string;
	negativePrompt?: string | undefined;
	width?: number | undefined;
	height?: number | undefined;
	durationMs?: number | undefined;
	fps?: number | undefined;
	aspectRatio?: string | undefined;
	style?: string | undefined;
	seed?: number | undefined;
	count?: number | undefined;
	outputFormat?: string | undefined;
	sourceImages?: readonly { mimeType: string; bytes: Buffer }[] | undefined;
};

export type MediaGenerationBinaryArtifact = {
	bytes: Buffer;
	mimeType: string;
	width?: number | undefined;
	height?: number | undefined;
	durationMs?: number | undefined;
	fps?: number | undefined;
	metadata?: Record<string, unknown> | undefined;
};

export type MediaGenerationResult = {
	status: "completed";
	provider: ProviderId;
	model: string;
	artifacts: MediaGenerationBinaryArtifact[];
	providerJobId?: string | undefined;
};

export type MediaGenerationTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type MediaGenerationTask = {
	providerJobId: string;
	status: MediaGenerationTaskStatus;
	progress?: number | undefined;
	result?: MediaGenerationResult | undefined;
	error?: string | undefined;
};

export type MediaGenerationAdapter = {
	provider: ProviderId;
	supports: readonly MediaGenerationKind[];
	generate: (request: MediaGenerationRequest, signal: AbortSignal, onProgress?: ((progress: number) => void) | undefined) => Promise<MediaGenerationResult>;
	createTask?: ((request: MediaGenerationRequest, signal: AbortSignal) => Promise<MediaGenerationTask>) | undefined;
	getTask?: ((providerJobId: string, signal: AbortSignal) => Promise<MediaGenerationTask>) | undefined;
	cancelTask?: ((providerJobId: string, signal: AbortSignal) => Promise<void>) | undefined;
	pollIntervalMs?: number | undefined;
};

const adapters = new Map<ProviderId, MediaGenerationAdapter>();

export function registerMediaGenerationAdapter(adapter: MediaGenerationAdapter): void {
	if (adapters.has(adapter.provider)) throw Object.assign(new Error(`Media adapter is already registered: ${adapter.provider}`), { code: "media_adapter_conflict" });
	adapters.set(adapter.provider, adapter);
}

export function unregisterMediaGenerationAdapter(provider: ProviderId): void {
	adapters.delete(provider);
}

export function listMediaGenerationAdapters(): MediaGenerationAdapter[] {
	return [...adapters.values()];
}

function createMockArtifact(request: MediaGenerationRequest): MediaGenerationBinaryArtifact {
	const digest = createHash("sha256").update(`${request.provider}/${request.model}:${request.prompt}`).digest("hex").slice(0, 16);
	if (request.kind === "videoGeneration" || request.kind === "videoEdit") {
		return { bytes: Buffer.from(`DAEDALUS-MOCK-VIDEO:${digest}`, "utf8"), mimeType: "video/mp4", width: request.width, height: request.height, durationMs: request.durationMs, fps: request.fps, metadata: { mock: true } };
	}
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="100%" height="100%" fill="#20232a"/><text x="24" y="256" fill="#fff" font-size="24">${digest}</text></svg>`;
	return { bytes: Buffer.from(svg, "utf8"), mimeType: "image/svg+xml", width: 512, height: 512, metadata: { mock: true } };
}

async function waitForAdapterTask(adapter: MediaGenerationAdapter, request: MediaGenerationRequest, signal: AbortSignal, onProgress?: ((progress: number) => void) | undefined, onProviderJobId?: ((providerJobId: string) => Promise<void> | void) | undefined): Promise<MediaGenerationResult> {
	if (adapter.createTask === undefined || adapter.getTask === undefined) return adapter.generate(request, signal, onProgress);
	let task = await adapter.createTask(request, signal);
	await onProviderJobId?.(task.providerJobId);
	onProgress?.(task.progress ?? 0);
	try {
		while (task.status === "queued" || task.status === "running") {
			if (signal.aborted) {
				await adapter.cancelTask?.(task.providerJobId, signal);
				throw new Error("Media generation cancelled.");
			}
			await new Promise<void>((resolve, reject): void => {
				let timer: ReturnType<typeof setTimeout>;
				const abort = (): void => {
					clearTimeout(timer);
					signal.removeEventListener("abort", abort);
					reject(new Error("Media generation cancelled."));
				};
				const complete = (): void => {
					signal.removeEventListener("abort", abort);
					resolve();
				};
				timer = setTimeout(complete, adapter.pollIntervalMs ?? 500);
				signal.addEventListener("abort", abort, { once: true });
			});
			task = await adapter.getTask(task.providerJobId, signal);
			onProgress?.(task.progress ?? 0);
		}
		if (task.status === "cancelled") throw new Error("Media generation cancelled.");
		if (task.status === "failed") throw new Error(task.error ?? "Media generation failed.");
		if (task.result === undefined) throw new Error("Media provider completed without a result.");
		return { ...task.result, providerJobId: task.result.providerJobId ?? task.providerJobId };
	} catch (error: unknown) {
		if (signal.aborted) await adapter.cancelTask?.(task.providerJobId, signal).catch((): void => undefined);
		throw error;
	}
}

const mockAdapter: MediaGenerationAdapter = {
	provider: "mock",
	supports: ["imageGeneration", "imageEdit", "videoGeneration", "videoEdit"],
	async generate(request, signal, onProgress): Promise<MediaGenerationResult> {
		if (signal.aborted) throw new Error("Media generation cancelled.");
		onProgress?.(0.25);
		await Promise.resolve();
		if (signal.aborted) throw new Error("Media generation cancelled.");
		onProgress?.(1);
		return { status: "completed", provider: request.provider, model: request.model, artifacts: Array.from({ length: Math.max(1, Math.min(4, request.count ?? 1)) }, () => createMockArtifact(request)) };
	},
};
registerMediaGenerationAdapter(mockAdapter);
registerMediaGenerationAdapter(createDashScopeMediaGenerationAdapter());

export async function generateMedia(request: MediaGenerationRequest, signal: AbortSignal, sink?: ImageGenerationArtifactSink, onProgress?: ((progress: number) => void) | undefined, onProviderJobId?: ((providerJobId: string) => Promise<void> | void) | undefined): Promise<MediaGenerationResult> {
	const adapter = adapters.get(request.provider);
	if (adapter !== undefined) {
		if (!adapter.supports.includes(request.kind)) throw Object.assign(new Error(`Provider ${request.provider} does not support ${request.kind}.`), { code: "media_generation_not_supported" });
		return waitForAdapterTask(adapter, request, signal, onProgress, onProviderJobId);
	}
	if (request.kind !== "imageGeneration" && request.kind !== "imageEdit") throw Object.assign(new Error(`Provider ${request.provider} has no video generation adapter.`), { code: "media_generation_not_supported" });
	if (sink === undefined) throw new Error("Image generation requires an artifact sink.");
	if (request.sourceImages !== undefined && request.sourceImages.length > 0) throw Object.assign(new Error(`Provider ${request.provider} image editing is not adapted for Flow artifacts yet.`), { code: "media_generation_not_supported" });
	const captured: MediaGenerationBinaryArtifact[] = [];
	const result = await generateImageWithArtifactSink({
		sessionId: "flow-media",
		provider: request.provider,
		model: request.model,
		prompt: request.prompt,
		negativePrompt: request.negativePrompt,
		count: request.count,
		aspectRatio: request.aspectRatio,
		style: request.style,
		seed: request.seed,
		outputFormat: request.outputFormat === "jpeg" || request.outputFormat === "webp" ? request.outputFormat : "png",
	}, {
		...sink,
		async save(input): Promise<Awaited<ReturnType<ImageGenerationArtifactSink["save"]>>> {
			captured.push({ bytes: input.bytes, mimeType: input.mimeType, metadata: { revisedPrompt: input.revisedPrompt } });
			return sink.save(input);
		},
	}, signal);
	onProgress?.(1);
	return { status: result.status, provider: result.provider, model: result.model, artifacts: captured };
}
