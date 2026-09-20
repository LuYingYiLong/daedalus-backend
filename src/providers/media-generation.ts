import { createMockPng } from "./mock-image.js";
import { withMediaRequestLimit } from "./media-request-limiter.js";
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
	version?: string;
	provider: ProviderId;
	supports: readonly MediaGenerationKind[];
	generate: (request: MediaGenerationRequest, signal: AbortSignal, onProgress?: ((progress: number) => void) | undefined) => Promise<MediaGenerationResult>;
	createTask?: ((request: MediaGenerationRequest, signal: AbortSignal) => Promise<MediaGenerationTask>) | undefined;
	getTask?: ((providerJobId: string, signal: AbortSignal) => Promise<MediaGenerationTask>) | undefined;
	cancelTask?: ((providerJobId: string, signal: AbortSignal) => Promise<void>) | undefined;
	pollIntervalMs?: number | undefined;
};

const adapters = new Map<ProviderId, MediaGenerationAdapter>();
export function mediaAdapterFingerprint(provider: string): string { return `${provider}:${adapters.get(provider)?.version ?? "1"}:media-contract-2`; }


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
	return { bytes: createMockPng([parseInt(digest.slice(0,2),16),parseInt(digest.slice(2,4),16),parseInt(digest.slice(4,6),16)]), mimeType: "image/png", width: 32, height: 32, metadata: { mock: true } };
}

async function waitForAdapterTask(adapter: MediaGenerationAdapter, request: MediaGenerationRequest, signal: AbortSignal, onProgress?: ((progress: number) => void) | undefined, onProviderJobId?: ((providerJobId: string) => Promise<void> | void) | undefined, resumeProviderJobId?: string): Promise<MediaGenerationResult> {
	if (adapter.createTask === undefined || adapter.getTask === undefined) {
		if (resumeProviderJobId !== undefined) throw new Error("media_task_recovery_unsupported");
		return adapter.generate(request, signal, onProgress);
	}
	let task = resumeProviderJobId === undefined ? await adapter.createTask(request, signal) : await adapter.getTask(resumeProviderJobId, signal);
	await onProviderJobId?.(task.providerJobId);
	onProgress?.(task.progress ?? 0);
	try {
		while (task.status === "queued" || task.status === "running") {
			if (signal.aborted) {
				await adapter.cancelTask?.(task.providerJobId, AbortSignal.timeout(10000));
				throw Object.assign(new Error("Media generation cancelled."), { providerTaskTerminal: true });
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
		if (task.status === "cancelled") throw Object.assign(new Error("Media generation cancelled."), { providerTaskTerminal: true });
		if (task.status === "failed") throw Object.assign(new Error(task.error ?? "Media generation failed."), { providerTaskTerminal: true });
		if (task.result === undefined) throw new Error("Media provider completed without a result.");
		return { ...task.result, providerJobId: task.result.providerJobId ?? task.providerJobId };
	} catch (error: unknown) {
		if (signal.aborted) await adapter.cancelTask?.(task.providerJobId, AbortSignal.timeout(10000)).catch((): void => undefined);
		throw error;
	}
}

const mockAdapter: MediaGenerationAdapter = {
	provider: "mock",
	supports: ["imageGeneration", "imageEdit", "videoGeneration", "videoEdit"],
	async generate(request, signal, onProgress): Promise<MediaGenerationResult> {
		if (signal.aborted) throw Object.assign(new Error("Media generation cancelled."), { providerTaskTerminal: true });
		onProgress?.(0.25);
		await Promise.resolve();
		if (signal.aborted) throw Object.assign(new Error("Media generation cancelled."), { providerTaskTerminal: true });
		onProgress?.(1);
		return { status: "completed", provider: request.provider, model: request.model, artifacts: Array.from({ length: Math.max(1, Math.min(4, request.count ?? 1)) }, () => createMockArtifact(request)) };
	},
};
registerMediaGenerationAdapter(mockAdapter);
registerMediaGenerationAdapter(createDashScopeMediaGenerationAdapter());

export async function generateMedia(request: MediaGenerationRequest, signal: AbortSignal, sink?: ImageGenerationArtifactSink, onProgress?: ((progress: number) => void) | undefined, onProviderJobId?: ((providerJobId: string) => Promise<void> | void) | undefined, resumeProviderJobId?: string): Promise<MediaGenerationResult> {
	signal = AbortSignal.any([signal, AbortSignal.timeout(request.kind.startsWith("video") ? 60 * 60_000 : 15 * 60_000)]);
	const adapter = adapters.get(request.provider);
	if (adapter?.supports.includes(request.kind)) {
		return withMediaRequestLimit(request.provider, signal, () => waitForAdapterTask(adapter, request, signal, onProgress, onProviderJobId, resumeProviderJobId));
	}
	if (resumeProviderJobId !== undefined) throw new Error("media_task_recovery_unsupported");
	if (request.kind !== "imageGeneration" && request.kind !== "imageEdit") throw Object.assign(new Error(`Provider ${request.provider} has no video generation adapter.`), { code: "media_generation_not_supported" });
	if (sink === undefined) throw new Error("Image generation requires an artifact sink.");
	const captured: MediaGenerationBinaryArtifact[] = [];
	const result = await withMediaRequestLimit(request.provider, signal, () => generateImageWithArtifactSink({
		sessionId: "flow-media",
		provider: request.provider,
		model: request.model,
		prompt: request.prompt,
		negativePrompt: request.negativePrompt,
		count: request.count,
		width: request.width,
		height: request.height,
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
	}, signal, request.sourceImages));
	onProgress?.(1);
	return { status: result.status, provider: result.provider, model: result.model, artifacts: captured };
}
