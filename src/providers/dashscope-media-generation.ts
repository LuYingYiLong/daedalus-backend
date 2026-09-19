import { resolveDashScopeApiBaseUrl } from "./provider-base-url.js";
import { getCatalogModel } from "./provider-registry.js";
import { resolveProviderModelOptions } from "./task-model-routing.js";
import type {
	MediaGenerationAdapter,
	MediaGenerationBinaryArtifact,
	MediaGenerationRequest,
	MediaGenerationResult,
	MediaGenerationTask,
} from "./media-generation.js";

type DashScopeTaskContext = {
	apiBaseUrl: string;
	apiKey: string;
	model: string;
	request: MediaGenerationRequest;
};

type DashScopeTaskResponse = {
	code?: string | undefined;
	message?: string | undefined;
	request_id?: string | undefined;
	output?: {
		task_id?: string | undefined;
		task_status?: string | undefined;
		code?: string | undefined;
		message?: string | undefined;
		video_url?: string | undefined;
		progress?: number | undefined;
		results?: Array<{ url?: string | undefined; video_url?: string | undefined }> | undefined;
	} | undefined;
};

const MAX_VIDEO_BYTES: number = 512 * 1024 * 1024;
const taskContexts: Map<string, DashScopeTaskContext> = new Map();

function createDataUrl(source: { mimeType: string; bytes: Buffer }): string {
	return `data:${source.mimeType};base64,${source.bytes.toString("base64")}`;
}

function toResolution(request: MediaGenerationRequest): "720P" | "1080P" {
	return Math.max(request.width ?? 1280, request.height ?? 720) > 1280 ? "1080P" : "720P";
}

function toRatio(request: MediaGenerationRequest): string {
	if (request.aspectRatio !== undefined && request.aspectRatio.trim().length > 0) {
		return request.aspectRatio.trim();
	}
	const width: number = request.width ?? 1280;
	const height: number = request.height ?? 720;
	if (width === height) return "1:1";
	return width > height ? "16:9" : "9:16";
}

function toDurationSeconds(request: MediaGenerationRequest): number {
	return Math.max(2, Math.min(request.model.startsWith("wan3.0-") ? 30 : 15, Math.round((request.durationMs ?? 5_000) / 1_000)));
}

function createTaskBody(request: MediaGenerationRequest): Record<string, unknown> {
	const input: Record<string, unknown> = { prompt: request.prompt };
	if (request.negativePrompt !== undefined && request.negativePrompt.trim().length > 0) {
		input.negative_prompt = request.negativePrompt.trim();
	}
	if (request.sourceImages !== undefined && request.sourceImages.length > 0) {
		input.media = request.sourceImages.slice(0, 2).map((source, index): Record<string, string> => ({
			type: index === 0 ? "first_frame" : "last_frame",
			url: createDataUrl(source),
		}));
	}
	const parameters: Record<string, unknown> = {
		resolution: toResolution(request),
		duration: toDurationSeconds(request),
		prompt_extend: true,
		watermark: false,
	};
	if (request.sourceImages === undefined || request.sourceImages.length === 0 || request.model.startsWith("wan3.0-")) {
		parameters.ratio = toRatio(request);
	}
	if (request.seed !== undefined) parameters.seed = request.seed;
	return { model: request.model, input, parameters };
}

async function parseTaskResponse(response: Response, operation: string): Promise<DashScopeTaskResponse> {
	const text: string = await response.text();
	let parsed: DashScopeTaskResponse;
	try {
		parsed = JSON.parse(text) as DashScopeTaskResponse;
	} catch {
		throw Object.assign(new Error(`DashScope ${operation} returned invalid JSON: HTTP ${response.status}`), { code: "media_generation_failed" });
	}
	if (!response.ok || parsed.code !== undefined) {
		throw Object.assign(new Error(parsed.message ?? `DashScope ${operation} failed: HTTP ${response.status}`), { code: "media_generation_failed" });
	}
	return parsed;
}

function normalizeProgress(progress: number | undefined): number | undefined {
	if (progress === undefined || !Number.isFinite(progress)) return undefined;
	return Math.max(0, Math.min(1, progress > 1 ? progress / 100 : progress));
}

function mapTaskStatus(status: string | undefined): MediaGenerationTask["status"] {
	switch (status?.toUpperCase()) {
		case "SUCCEEDED":
			return "completed";
		case "FAILED":
		case "UNKNOWN":
			return "failed";
		case "CANCELED":
		case "CANCELLED":
			return "cancelled";
		case "RUNNING":
			return "running";
		default:
			return "queued";
	}
}

function getVideoUrl(response: DashScopeTaskResponse): string | undefined {
	const direct: string | undefined = response.output?.video_url;
	if (direct !== undefined && direct.length > 0) return direct;
	for (const result of response.output?.results ?? []) {
		const url: string | undefined = result.video_url ?? result.url;
		if (url !== undefined && url.length > 0) return url;
	}
	return undefined;
}

async function readVideoArtifact(url: string, request: MediaGenerationRequest, signal: AbortSignal): Promise<MediaGenerationBinaryArtifact> {
	const response: Response = await fetch(url, { signal });
	if (!response.ok || response.body === null) {
		throw Object.assign(new Error(`Failed to download generated video: HTTP ${response.status}`), { code: "media_generation_failed" });
	}
	const declaredLength: number = Number(response.headers.get("content-length") ?? "0");
	if (Number.isFinite(declaredLength) && declaredLength > MAX_VIDEO_BYTES) {
		throw Object.assign(new Error("Generated video exceeds the 512 MiB limit."), { code: "media_artifact_too_large" });
	}
	const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
	const chunks: Buffer[] = [];
	let byteLength = 0;
	while (true) {
		const chunk = await reader.read();
		if (chunk.done) break;
		byteLength += chunk.value.byteLength;
		if (byteLength > MAX_VIDEO_BYTES) {
			await reader.cancel();
			throw Object.assign(new Error("Generated video exceeds the 512 MiB limit."), { code: "media_artifact_too_large" });
		}
		chunks.push(Buffer.from(chunk.value));
	}
	return {
		bytes: Buffer.concat(chunks, byteLength),
		mimeType: response.headers.get("content-type")?.split(";", 1)[0] ?? "video/mp4",
		width: request.width,
		height: request.height,
		durationMs: request.durationMs,
		fps: request.fps,
		metadata: { sourceUrlExpires: true },
	};
}

async function createTask(request: MediaGenerationRequest, signal: AbortSignal): Promise<MediaGenerationTask> {
	if (request.kind !== "videoGeneration") {
		throw Object.assign(new Error("DashScope Flow currently supports video generation only."), { code: "media_generation_not_supported" });
	}
	const catalogModel = getCatalogModel("dashscope", request.model);
	if (catalogModel?.capabilities.videoGeneration !== true) {
		throw Object.assign(new Error(`DashScope model ${request.model} is not registered for video generation.`), { code: "media_generation_not_supported" });
	}
	const hasSourceImages: boolean = (request.sourceImages?.length ?? 0) > 0;
	if (hasSourceImages && catalogModel.capabilities.imageToVideo !== true) {
		throw Object.assign(new Error(`DashScope model ${request.model} is not registered for image-to-video generation.`), { code: "media_generation_not_supported" });
	}
	if (!hasSourceImages && catalogModel.capabilities.textToVideo !== true) {
		throw Object.assign(new Error(`DashScope model ${request.model} is not registered for text-to-video generation.`), { code: "media_generation_not_supported" });
	}
	const options = await resolveProviderModelOptions("dashscope", request.model);
	const apiBaseUrl: string = resolveDashScopeApiBaseUrl(options.baseUrl);
	const response: Response = await fetch(`${apiBaseUrl}/services/aigc/video-generation/video-synthesis`, {
		method: "POST",
		headers: {
			"Authorization": `Bearer ${options.apiKey}`,
			"Content-Type": "application/json",
			"X-DashScope-Async": "enable",
		},
		body: JSON.stringify(createTaskBody(request)),
		signal,
	});
	const parsed: DashScopeTaskResponse = await parseTaskResponse(response, "video task creation");
	const providerJobId: string | undefined = parsed.output?.task_id;
	if (providerJobId === undefined || providerJobId.length === 0) {
		throw Object.assign(new Error("DashScope video generation returned no task id."), { code: "media_generation_failed" });
	}
	taskContexts.set(providerJobId, { apiBaseUrl, apiKey: options.apiKey, model: request.model, request });
	return {
		providerJobId,
		status: mapTaskStatus(parsed.output?.task_status),
		progress: normalizeProgress(parsed.output?.progress),
	};
}

async function getTask(providerJobId: string, signal: AbortSignal): Promise<MediaGenerationTask> {
	const context: DashScopeTaskContext | undefined = taskContexts.get(providerJobId);
	if (context === undefined) {
		throw Object.assign(new Error(`DashScope video task context is unavailable: ${providerJobId}`), { code: "media_task_not_found" });
	}
	const response: Response = await fetch(`${context.apiBaseUrl}/tasks/${encodeURIComponent(providerJobId)}`, {
		headers: { "Authorization": `Bearer ${context.apiKey}` },
		signal,
	});
	const parsed: DashScopeTaskResponse = await parseTaskResponse(response, "video task query");
	const status: MediaGenerationTask["status"] = mapTaskStatus(parsed.output?.task_status);
	if (status === "failed" || status === "cancelled") {
		taskContexts.delete(providerJobId);
		return {
			providerJobId,
			status,
			error: parsed.output?.message ?? parsed.message ?? parsed.output?.code,
			progress: normalizeProgress(parsed.output?.progress),
		};
	}
	if (status !== "completed") {
		return { providerJobId, status, progress: normalizeProgress(parsed.output?.progress) };
	}
	const videoUrl: string | undefined = getVideoUrl(parsed);
	if (videoUrl === undefined) {
		throw Object.assign(new Error("DashScope video task completed without a video URL."), { code: "media_generation_failed" });
	}
	const artifact: MediaGenerationBinaryArtifact = await readVideoArtifact(videoUrl, context.request, signal);
	taskContexts.delete(providerJobId);
	const result: MediaGenerationResult = {
		status: "completed",
		provider: "dashscope",
		model: context.model,
		providerJobId,
		artifacts: [artifact],
	};
	return { providerJobId, status, progress: 1, result };
}

async function cancelTask(providerJobId: string, signal: AbortSignal): Promise<void> {
	const context: DashScopeTaskContext | undefined = taskContexts.get(providerJobId);
	if (context === undefined) return;
	try {
		const cancelSignal: AbortSignal = signal.aborted ? AbortSignal.timeout(10_000) : signal;
		await fetch(`${context.apiBaseUrl}/tasks/${encodeURIComponent(providerJobId)}/cancel`, {
			method: "POST",
			headers: { "Authorization": `Bearer ${context.apiKey}` },
			signal: cancelSignal,
		});
	} finally {
		taskContexts.delete(providerJobId);
	}
}

export function createDashScopeMediaGenerationAdapter(): MediaGenerationAdapter {
	return {
		provider: "dashscope",
		supports: ["videoGeneration"],
		generate: async (): Promise<MediaGenerationResult> => {
			throw Object.assign(new Error("DashScope video generation requires the asynchronous task API."), { code: "media_generation_not_supported" });
		},
		createTask,
		getTask,
		cancelTask,
		pollIntervalMs: 15_000,
	};
}
