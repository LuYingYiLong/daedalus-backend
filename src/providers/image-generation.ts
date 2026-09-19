import OpenAI from "openai";
import type { Image, ImageGenerateParamsNonStreaming, ImagesResponse } from "openai/resources/images";
import type { ProviderId } from "../protocol/types.js";
import type { GeneratedImageArtifactMetadata } from "../session/session-attachments.js";
import { deleteGeneratedImageArtifact, readGeneratedImageDataUrl, readImageAttachmentDataUrl, saveGeneratedImageArtifact } from "../session/session-attachments.js";
import { SUPPORTED_IMAGE_MIME_TYPES } from "../protocol/image-attachments.js";
import { getProviderFallbackModels } from "./provider-registry.js";
import type { ProviderChatOptions, ProviderModelInfo } from "./provider-types.js";
import { normalizeConfiguredProviderBaseUrl, resolveDashScopeApiBaseUrl, resolveProviderBaseUrl } from "./provider-base-url.js";
import { ProviderTaskModelError, resolveConfiguredProviderTaskModelOptions, resolveProviderModelOptions } from "./task-model-routing.js";

export type ImageGenerationAspectRatio = string;

export type ImageGenerationInput = {
	sessionId: string;
	provider?: ProviderId | undefined;
	model?: string | undefined;
	prompt: string;
	negativePrompt?: string | undefined;
	count?: number | undefined;
	aspectRatio?: ImageGenerationAspectRatio | undefined;
	style?: string | undefined;
	seed?: number | undefined;
	outputFormat?: "png" | "jpeg" | "webp" | undefined;
	sourceImages?: ImageGenerationSourceImageRef[] | undefined;
};

export type ImageGenerationResult = {
	status: "completed";
	prompt: string;
	provider: ProviderId;
	model: string;
	artifacts: GeneratedImageArtifactMetadata[];
	sourceImages?: ImageGenerationSourceImageRef[] | undefined;
};

export type ImageGenerationArtifactSink = {
	save: (input: {
		bytes: Buffer;
		mimeType: string;
		provider: string;
		model: string;
		prompt: string;
		revisedPrompt?: string | undefined;
	}) => Promise<GeneratedImageArtifactMetadata>;
	remove?: ((artifact: GeneratedImageArtifactMetadata) => Promise<void>) | undefined;
};

export type ImageGenerationAvailability = {
	available: boolean;
	provider: ProviderId | null;
	model: string | null;
	supportsGeneration: boolean;
	supportsEdit: boolean;
	reason: string | null;
};

export type ImageGenerationSourceImageRef = {
	type: "attachment" | "generated";
	id: string;
};

export type ImageGenerationSourceImage = ImageGenerationSourceImageRef & {
	mimeType: string;
	dataUrl: string;
};

export class ImageGenerationError extends Error {
	readonly code: "image_generation_not_configured" | "image_generation_not_supported" | "image_generation_failed";

	constructor(code: ImageGenerationError["code"], message: string) {
		super(message);
		this.name = "ImageGenerationError";
		this.code = code;
	}
}

function getPositiveInteger(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fallback;
	}
	return Math.max(min, Math.min(max, Math.floor(value)));
}

function getPrompt(value: unknown): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new ImageGenerationError("image_generation_failed", "Image generation prompt is required.");
	}
	return value.trim().slice(0, 32000);
}

type AspectRatioOption<T extends string> = {
	value: T;
	width: number;
	height: number;
};

function normalizeAspectRatio(value: unknown): ImageGenerationAspectRatio {
	if (typeof value !== "string") {
		return "1:1";
	}
	const trimmed: string = value.trim().slice(0, 32);
	const match: RegExpMatchArray | null = /^(\d{1,4})\s*[:：xX*＊]\s*(\d{1,4})$/u.exec(trimmed);
	if (match === null) {
		return "1:1";
	}
	const width: number = Number.parseInt(match[1]!, 10);
	const height: number = Number.parseInt(match[2]!, 10);
	if (width <= 0 || height <= 0) {
		return "1:1";
	}
	return `${width}:${height}`;
}

function getAspectRatioValue(aspectRatio: ImageGenerationAspectRatio): number {
	const match: RegExpMatchArray | null = /^(\d{1,4}):(\d{1,4})$/u.exec(aspectRatio);
	if (match === null) {
		return 1;
	}
	const width: number = Number.parseInt(match[1]!, 10);
	const height: number = Number.parseInt(match[2]!, 10);
	return width > 0 && height > 0 ? width / height : 1;
}

function getClosestAspectRatioValue<T extends string>(aspectRatio: ImageGenerationAspectRatio, options: readonly AspectRatioOption<T>[]): T {
	const target: number = getAspectRatioValue(aspectRatio);
	let closest: AspectRatioOption<T> = options[0]!;
	let closestDistance: number = Number.POSITIVE_INFINITY;
	for (const option of options) {
		const optionRatio: number = option.width / option.height;
		const distance: number = Math.abs(Math.log(optionRatio / target));
		if (distance < closestDistance) {
			closest = option;
			closestDistance = distance;
		}
	}
	return closest.value;
}

const OPENAI_IMAGE_SIZE_OPTIONS: readonly AspectRatioOption<NonNullable<ImageGenerateParamsNonStreaming["size"]>>[] = [
	{ value: "1024x1024", width: 1024, height: 1024 },
	{ value: "1536x1024", width: 1536, height: 1024 },
	{ value: "1024x1536", width: 1024, height: 1536 }
];

const ZHIPU_IMAGE_SIZE_OPTIONS: readonly AspectRatioOption<string>[] = [
	{ value: "1280x1280", width: 1280, height: 1280 },
	{ value: "1728x960", width: 1728, height: 960 },
	{ value: "960x1728", width: 960, height: 1728 },
	{ value: "1568x1056", width: 1568, height: 1056 },
	{ value: "1056x1568", width: 1056, height: 1568 }
];

const DASHSCOPE_IMAGE_SIZE_OPTIONS: readonly AspectRatioOption<string>[] = [
	{ value: "1024*1024", width: 1024, height: 1024 },
	{ value: "1280*720", width: 1280, height: 720 },
	{ value: "720*1280", width: 720, height: 1280 },
	{ value: "1280*960", width: 1280, height: 960 },
	{ value: "960*1280", width: 960, height: 1280 }
];

const MINIMAX_ASPECT_RATIO_OPTIONS: readonly AspectRatioOption<string>[] = [
	{ value: "1:1", width: 1, height: 1 },
	{ value: "16:9", width: 16, height: 9 },
	{ value: "9:16", width: 9, height: 16 },
	{ value: "4:3", width: 4, height: 3 },
	{ value: "3:4", width: 3, height: 4 }
];

function mapAspectRatioToOpenAIImageSize(aspectRatio: ImageGenerationAspectRatio): NonNullable<ImageGenerateParamsNonStreaming["size"]> {
	return getClosestAspectRatioValue(aspectRatio, OPENAI_IMAGE_SIZE_OPTIONS);
}

function mapAspectRatioToZhipuImageSize(aspectRatio: ImageGenerationAspectRatio): string {
	return getClosestAspectRatioValue(aspectRatio, ZHIPU_IMAGE_SIZE_OPTIONS);
}

function mapAspectRatioToDashScopeImageSize(aspectRatio: ImageGenerationAspectRatio): string {
	return getClosestAspectRatioValue(aspectRatio, DASHSCOPE_IMAGE_SIZE_OPTIONS);
}

function mapAspectRatioToMiniMaxAspectRatio(aspectRatio: ImageGenerationAspectRatio): string {
	return getClosestAspectRatioValue(aspectRatio, MINIMAX_ASPECT_RATIO_OPTIONS);
}

function isNativeImageAspectRatio(aspectRatio: ImageGenerationAspectRatio): boolean {
	return MINIMAX_ASPECT_RATIO_OPTIONS.some((option: AspectRatioOption<string>): boolean => option.value === aspectRatio);
}

function getStyle(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed: string = value.trim();
	return trimmed.length > 0 ? trimmed.slice(0, 120) : undefined;
}

function parseSourceImageType(value: unknown, id: string): ImageGenerationSourceImageRef["type"] {
	if (value === "attachment" || value === "generated") {
		return value;
	}
	return id.startsWith("generated-image-") ? "generated" : "attachment";
}

function parseSourceImages(value: unknown): ImageGenerationSourceImageRef[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		throw new ImageGenerationError("image_generation_failed", "sourceImages must be an array.");
	}

	const sourceImages: ImageGenerationSourceImageRef[] = [];
	for (const item of value.slice(0, 3)) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			throw new ImageGenerationError("image_generation_failed", "Each source image must contain type and id.");
		}
		const record: Record<string, unknown> = item as Record<string, unknown>;
		const id: unknown = record.id;
		if (typeof id !== "string" || id.trim().length === 0 || id.length > 160) {
			throw new ImageGenerationError("image_generation_failed", "Each source image id must be a non-empty string.");
		}
		sourceImages.push({
			type: parseSourceImageType(record.type, id),
			id: id.trim()
		});
	}

	return sourceImages.length > 0 ? sourceImages : undefined;
}

export function parseImageGenerationToolArgs(args: Record<string, unknown>, sessionId: string): ImageGenerationInput {
	return {
		sessionId,
		prompt: getPrompt(args.prompt),
		count: getPositiveInteger(args.count, 1, 1, 4),
		aspectRatio: normalizeAspectRatio(args.aspectRatio),
		style: getStyle(args.style),
		seed: typeof args.seed === "number" && Number.isFinite(args.seed) ? Math.floor(args.seed) : undefined,
		sourceImages: parseSourceImages(args.sourceImages)
	};
}

function modelSupportsImageGeneration(provider: ProviderId, modelId: string): boolean {
	const fallback: ProviderModelInfo | undefined = getProviderFallbackModels(provider)
		.find((model: ProviderModelInfo): boolean => model.id === modelId);
	return fallback?.capabilities.imageGeneration === true;
}

function modelSupportsImageEdit(provider: ProviderId, modelId: string): boolean {
	const fallback: ProviderModelInfo | undefined = getProviderFallbackModels(provider)
		.find((model: ProviderModelInfo): boolean => model.id === modelId);
	return fallback?.capabilities.imageEdit === true;
}

export async function resolveImageGenerationAvailability(): Promise<ImageGenerationAvailability> {
	try {
		const resolved = await resolveConfiguredProviderTaskModelOptions("imageGeneration");
		const supportsGeneration: boolean = modelSupportsImageGeneration(resolved.provider, resolved.model);
		const supportsEdit: boolean = modelSupportsImageEdit(resolved.provider, resolved.model);
		return {
			available: supportsGeneration || supportsEdit,
			provider: resolved.provider,
			model: resolved.model,
			supportsGeneration,
			supportsEdit,
			reason: supportsGeneration || supportsEdit
				? null
				: `Model ${resolved.provider}/${resolved.model} does not support image generation or editing.`
		};
	} catch (error: unknown) {
		return {
			available: false,
			provider: null,
			model: null,
			supportsGeneration: false,
			supportsEdit: false,
			reason: error instanceof Error ? error.message : "Image generation is not configured."
		};
	}
}

function createImageEditUnsupportedMessage(provider: ProviderId, modelId: string): string {
	if (provider === "zhipu") {
		return `Model ${provider}/${modelId} is configured for text-to-image only. Zhipu's official image API does not currently expose a documented image-to-image request shape.`;
	}
	return `Model ${provider}/${modelId} does not support image-to-image generation.`;
}

function parseMimeTypeFromDataUrl(dataUrl: string): string {
	const match: RegExpMatchArray | null = /^data:([^;]+);base64,/u.exec(dataUrl);
	if (match === null || !SUPPORTED_IMAGE_MIME_TYPES.includes(match[1] ?? "")) {
		throw new ImageGenerationError("image_generation_failed", "Source image dataUrl has an unsupported mimeType.");
	}
	return match[1]!;
}

export async function resolveImageGenerationSourceImages(sessionId: string, refs: readonly ImageGenerationSourceImageRef[] | undefined): Promise<ImageGenerationSourceImage[]> {
	if (refs === undefined || refs.length === 0) {
		return [];
	}

	const images: ImageGenerationSourceImage[] = [];
	for (const ref of refs.slice(0, 3)) {
		if (ref.type === "generated") {
			const generated = await readGeneratedImageDataUrl(sessionId, ref.id);
			images.push({
				type: "generated",
				id: ref.id,
				mimeType: generated.mimeType,
				dataUrl: generated.dataUrl
			});
			continue;
		}

		const dataUrl: string = await readImageAttachmentDataUrl(sessionId, ref.id);
		images.push({
			type: "attachment",
			id: ref.id,
			mimeType: parseMimeTypeFromDataUrl(dataUrl),
			dataUrl
		});
	}
	return images;
}

function createOpenAIClient(options: ProviderChatOptions): OpenAI {
	const clientOptions: ConstructorParameters<typeof OpenAI>[0] = {
		apiKey: options.apiKey
	};
	const normalizedBaseUrl: string | undefined = normalizeConfiguredProviderBaseUrl(options.baseUrl);
	if (normalizedBaseUrl !== undefined) {
		clientOptions.baseURL = normalizedBaseUrl;
	}
	return new OpenAI(clientOptions);
}

function createPrompt(input: ImageGenerationInput): string {
	const segments: string[] = [input.prompt];
	if (input.aspectRatio !== undefined && !isNativeImageAspectRatio(input.aspectRatio)) {
		segments.push(`Target aspect ratio: ${input.aspectRatio}. If the provider canvas is only approximate, preserve this composition as closely as possible.`);
	}
	if (input.style !== undefined) {
		segments.push(`Style: ${input.style}`);
	}
	if (input.negativePrompt !== undefined && input.negativePrompt.trim().length > 0) {
		segments.push(`Negative prompt: ${input.negativePrompt.trim()}`);
	}
	if (input.seed !== undefined) {
		segments.push(`Seed hint: ${input.seed}`);
	}
	return segments.join("\n");
}

type ImageGenerationRuntime = {
	abortSignal?: AbortSignal | undefined;
	savedArtifacts: GeneratedImageArtifactMetadata[];
	artifactSink?: ImageGenerationArtifactSink | undefined;
};

function throwIfImageGenerationAborted(runtime: ImageGenerationRuntime): void {
	if (runtime.abortSignal?.aborted) {
		throw new Error("Request cancelled");
	}
}

async function saveGeneratedImage(
	runtime: ImageGenerationRuntime,
	input: Parameters<typeof saveGeneratedImageArtifact>[0]
): Promise<GeneratedImageArtifactMetadata> {
	throwIfImageGenerationAborted(runtime);
	const artifact: GeneratedImageArtifactMetadata = runtime.artifactSink === undefined
		? await saveGeneratedImageArtifact(input)
		: await runtime.artifactSink.save({ bytes: input.bytes, mimeType: input.mimeType, provider: input.provider, model: input.model, prompt: input.prompt, ...(input.revisedPrompt === undefined ? {} : { revisedPrompt: input.revisedPrompt }) });
	runtime.savedArtifacts.push(artifact);
	throwIfImageGenerationAborted(runtime);
	return artifact;
}

type DownloadedGeneratedImage = {
	bytes: Buffer;
	mimeType: string;
	revisedPrompt?: string | undefined;
};

async function persistDownloadedImages(
	runtime: ImageGenerationRuntime,
	options: ProviderChatOptions,
	input: ImageGenerationInput,
	model: string,
	images: readonly DownloadedGeneratedImage[]
): Promise<GeneratedImageArtifactMetadata[]> {
	throwIfImageGenerationAborted(runtime);
	const artifacts: GeneratedImageArtifactMetadata[] = [];
	for (const image of images) {
		artifacts.push(await saveGeneratedImage(runtime, {
			sessionId: input.sessionId,
			bytes: image.bytes,
			mimeType: image.mimeType,
			provider: options.provider,
			model,
			prompt: input.prompt,
			revisedPrompt: image.revisedPrompt
		}));
	}
	return artifacts;
}

function guessMimeType(response: ImagesResponse, image: Image): string {
	if (response.output_format === "jpeg") {
		return "image/jpeg";
	}
	if (response.output_format === "webp") {
		return "image/webp";
	}
	const url: string | undefined = image.url;
	if (url !== undefined && /\.jpe?g(?:$|\?)/iu.test(url)) {
		return "image/jpeg";
	}
	if (url !== undefined && /\.webp(?:$|\?)/iu.test(url)) {
		return "image/webp";
	}
	return "image/png";
}

async function readImageBytes(response: ImagesResponse, image: Image, abortSignal?: AbortSignal | undefined): Promise<Buffer> {
	if (typeof image.b64_json === "string" && image.b64_json.length > 0) {
		return Buffer.from(image.b64_json, "base64");
	}
	if (typeof image.url === "string") {
		return readImageUrlBytes(image.url, abortSignal);
	}
	throw new ImageGenerationError("image_generation_failed", "Provider did not return image data.");
}

async function readImageUrlBytes(url: string, abortSignal?: AbortSignal | undefined): Promise<Buffer> {
	if (url.length === 0) {
		throw new ImageGenerationError("image_generation_failed", "Provider did not return image data.");
	}
	const imageResponse: Response = await fetch(url, { signal: abortSignal ?? null });
	if (!imageResponse.ok) {
		throw new ImageGenerationError("image_generation_failed", `Failed to download generated image: HTTP ${imageResponse.status}`);
	}
	return Buffer.from(await imageResponse.arrayBuffer());
}

async function generateOpenAIImages(options: ProviderChatOptions, input: ImageGenerationInput, runtime: ImageGenerationRuntime): Promise<ImageGenerationResult> {
	const model: string = options.model ?? "gpt-image-1";
	const client: OpenAI = createOpenAIClient(options);
	const response: ImagesResponse = await client.images.generate({
		model,
		prompt: createPrompt(input),
		n: input.count ?? 1,
		size: mapAspectRatioToOpenAIImageSize(input.aspectRatio ?? "1:1"),
		output_format: input.outputFormat ?? "png",
		stream: false
	}, { signal: runtime.abortSignal });
	const images: Image[] = response.data ?? [];
	if (images.length === 0) {
		throw new ImageGenerationError("image_generation_failed", "Provider returned no generated images.");
	}

	const downloaded: DownloadedGeneratedImage[] = await Promise.all(images.map(async (image: Image): Promise<DownloadedGeneratedImage> => ({
		bytes: await readImageBytes(response, image, runtime.abortSignal),
		mimeType: guessMimeType(response, image),
		revisedPrompt: image.revised_prompt ?? undefined
	})));
	const artifacts: GeneratedImageArtifactMetadata[] = await persistDownloadedImages(runtime, options, input, model, downloaded);

	return {
		status: "completed",
		prompt: input.prompt,
		provider: options.provider,
		model,
		artifacts
	};
}

type ZhipuImageGenerationResponse = {
	data?: Array<{
		url?: string | undefined;
		b64_json?: string | undefined;
		revised_prompt?: string | undefined;
	}>;
	error?: {
		code?: string | undefined;
		message?: string | undefined;
	};
};

type VolcengineImageGenerationResponse = {
	data?: Array<{
		url?: string | undefined;
		b64_json?: string | undefined;
		revised_prompt?: string | undefined;
	}> | undefined;
	output_format?: string | undefined;
	error?: {
		code?: string | undefined;
		message?: string | undefined;
	} | undefined;
};

type MiniMaxImageGenerationResponse = {
	data?: {
		image_base64?: string[] | string | undefined;
		image_urls?: string[] | string | undefined;
	} | undefined;
	base_resp?: {
		status_code?: number | undefined;
		status_msg?: string | undefined;
	} | undefined;
	error?: {
		code?: string | undefined;
		message?: string | undefined;
	} | undefined;
};

async function generateZhipuImages(options: ProviderChatOptions, input: ImageGenerationInput, runtime: ImageGenerationRuntime): Promise<ImageGenerationResult> {
	const model: string = options.model ?? "glm-image";
	const baseUrl: string = resolveProviderBaseUrl(options.provider, options.baseUrl);
	const response: Response = await fetch(`${baseUrl}/images/generations`, {
		method: "POST",
		headers: {
			"Authorization": `Bearer ${options.apiKey}`,
			"Content-Type": "application/json"
		},
		body: JSON.stringify({
			model,
			prompt: createPrompt(input),
			size: mapAspectRatioToZhipuImageSize(input.aspectRatio ?? "1:1"),
			watermark_enabled: false
		}),
		signal: runtime.abortSignal ?? null
	});
	const text: string = await response.text();
	let parsed: ZhipuImageGenerationResponse;
	try {
		parsed = JSON.parse(text) as ZhipuImageGenerationResponse;
	} catch {
		throw new ImageGenerationError("image_generation_failed", `Zhipu image generation returned invalid JSON: HTTP ${response.status}`);
	}
	if (!response.ok || parsed.error !== undefined) {
		throw new ImageGenerationError(
			"image_generation_failed",
			parsed.error?.message ?? `Zhipu image generation failed: HTTP ${response.status}`
		);
	}

	const images = parsed.data ?? [];
	if (images.length === 0) {
		throw new ImageGenerationError("image_generation_failed", "Provider returned no generated images.");
	}

	const downloaded: DownloadedGeneratedImage[] = await Promise.all(
		images.slice(0, input.count ?? 1).map(async (image): Promise<DownloadedGeneratedImage> => ({
			bytes: typeof image.b64_json === "string" && image.b64_json.length > 0
				? Buffer.from(image.b64_json, "base64")
				: await readImageUrlBytes(image.url ?? "", runtime.abortSignal),
			mimeType: image.url !== undefined && /\.jpe?g(?:$|\?)/iu.test(image.url) ? "image/jpeg" : "image/png",
			revisedPrompt: image.revised_prompt
		}))
	);
	const artifacts: GeneratedImageArtifactMetadata[] = await persistDownloadedImages(runtime, options, input, model, downloaded);

	return {
		status: "completed",
		prompt: input.prompt,
		provider: options.provider,
		model,
		artifacts
	};
}

async function generateVolcengineImages(options: ProviderChatOptions, input: ImageGenerationInput, runtime: ImageGenerationRuntime): Promise<ImageGenerationResult> {
	const model: string = options.model ?? "doubao-seedream-5-0-pro-260628";
	const baseUrl: string = resolveProviderBaseUrl(options.provider, options.baseUrl);
	const response: Response = await fetch(`${baseUrl}/images/generations`, {
		method: "POST",
		headers: {
			"Authorization": `Bearer ${options.apiKey}`,
			"Content-Type": "application/json"
		},
		body: JSON.stringify({
			model,
			prompt: createPrompt(input),
			n: input.count ?? 1,
			size: mapAspectRatioToOpenAIImageSize(input.aspectRatio ?? "1:1"),
			response_format: "url",
			watermark: false
		}),
		signal: runtime.abortSignal ?? null
	});
	const text: string = await response.text();
	let parsed: VolcengineImageGenerationResponse;
	try {
		parsed = JSON.parse(text) as VolcengineImageGenerationResponse;
	} catch {
		throw new ImageGenerationError("image_generation_failed", `Volcengine Ark image generation returned invalid JSON: HTTP ${response.status}`);
	}
	if (!response.ok || parsed.error !== undefined) {
		throw new ImageGenerationError(
			"image_generation_failed",
			parsed.error?.message ?? `Volcengine Ark image generation failed: HTTP ${response.status}`
		);
	}

	const images = parsed.data ?? [];
	if (images.length === 0) {
		throw new ImageGenerationError("image_generation_failed", "Provider returned no generated images.");
	}

	const downloaded: DownloadedGeneratedImage[] = await Promise.all(
		images.slice(0, input.count ?? 1).map(async (image): Promise<DownloadedGeneratedImage> => ({
			bytes: typeof image.b64_json === "string" && image.b64_json.length > 0
				? Buffer.from(image.b64_json, "base64")
				: await readImageUrlBytes(image.url ?? "", runtime.abortSignal),
			mimeType: parsed.output_format === "jpeg" || (image.url !== undefined && /\.jpe?g(?:$|\?)/iu.test(image.url))
				? "image/jpeg"
				: parsed.output_format === "webp" || (image.url !== undefined && /\.webp(?:$|\?)/iu.test(image.url))
					? "image/webp"
					: "image/png",
			revisedPrompt: image.revised_prompt
		}))
	);
	const artifacts: GeneratedImageArtifactMetadata[] = await persistDownloadedImages(runtime, options, input, model, downloaded);

	return {
		status: "completed",
		prompt: input.prompt,
		provider: options.provider,
		model,
		artifacts
	};
}

function normalizeMiniMaxStringList(value: string[] | string | undefined): string[] {
	if (Array.isArray(value)) {
		return value.filter((item: string): boolean => item.length > 0);
	}
	return typeof value === "string" && value.length > 0 ? [value] : [];
}

function guessMiniMaxUrlMimeType(url: string): string {
	if (/\.jpe?g(?:$|\?)/iu.test(url)) {
		return "image/jpeg";
	}
	if (/\.webp(?:$|\?)/iu.test(url)) {
		return "image/webp";
	}
	return "image/png";
}

async function generateMiniMaxImages(options: ProviderChatOptions, input: ImageGenerationInput, runtime: ImageGenerationRuntime): Promise<ImageGenerationResult> {
	const model: string = options.model ?? "image-01";
	const baseUrl: string = resolveProviderBaseUrl(options.provider, options.baseUrl);
	const response: Response = await fetch(`${baseUrl}/image_generation`, {
		method: "POST",
		headers: {
			"Authorization": `Bearer ${options.apiKey}`,
			"Content-Type": "application/json"
		},
		body: JSON.stringify({
			model,
			prompt: createPrompt(input),
			aspect_ratio: mapAspectRatioToMiniMaxAspectRatio(input.aspectRatio ?? "1:1"),
			response_format: "base64",
			n: input.count ?? 1,
			prompt_optimizer: true,
			aigc_watermark: false
		}),
		signal: runtime.abortSignal ?? null
	});
	const text: string = await response.text();
	let parsed: MiniMaxImageGenerationResponse;
	try {
		parsed = JSON.parse(text) as MiniMaxImageGenerationResponse;
	} catch {
		throw new ImageGenerationError("image_generation_failed", `MiniMax image generation returned invalid JSON: HTTP ${response.status}`);
	}
	if (!response.ok || parsed.error !== undefined || (parsed.base_resp?.status_code !== undefined && parsed.base_resp.status_code !== 0)) {
		throw new ImageGenerationError(
			"image_generation_failed",
			parsed.error?.message ?? parsed.base_resp?.status_msg ?? `MiniMax image generation failed: HTTP ${response.status}`
		);
	}

	const base64Images: string[] = normalizeMiniMaxStringList(parsed.data?.image_base64);
	const imageUrls: string[] = normalizeMiniMaxStringList(parsed.data?.image_urls);
	if (base64Images.length === 0 && imageUrls.length === 0) {
		throw new ImageGenerationError("image_generation_failed", "Provider returned no generated images.");
	}

	const targetCount: number = input.count ?? 1;
	const downloadedFromBase64: DownloadedGeneratedImage[] = base64Images
		.slice(0, targetCount)
		.map((imageBase64: string): DownloadedGeneratedImage => ({
			bytes: Buffer.from(imageBase64, "base64"),
			mimeType: "image/jpeg"
		}));
	const remainingUrls: string[] = imageUrls.slice(0, Math.max(0, targetCount - downloadedFromBase64.length));
	const downloadedFromUrls: DownloadedGeneratedImage[] = await Promise.all(
		remainingUrls.map(async (url: string): Promise<DownloadedGeneratedImage> => ({
			bytes: await readImageUrlBytes(url, runtime.abortSignal),
			mimeType: guessMiniMaxUrlMimeType(url)
		}))
	);
	const artifacts: GeneratedImageArtifactMetadata[] = await persistDownloadedImages(
		runtime,
		options,
		input,
		model,
		[...downloadedFromBase64, ...downloadedFromUrls]
	);

	return {
		status: "completed",
		prompt: input.prompt,
		provider: options.provider,
		model,
		artifacts
	};
}

type DashScopeImageContent = {
	image?: string | undefined;
	text?: string | undefined;
};

type DashScopeImageGenerationResponse = {
	output?: {
		choices?: Array<{
			message?: {
				content?: DashScopeImageContent[] | undefined;
			} | undefined;
		}>;
	} | undefined;
	usage?: {
		width?: number | undefined;
		height?: number | undefined;
	} | undefined;
	code?: string | undefined;
	message?: string | undefined;
};

function extractDashScopeImageUrls(response: DashScopeImageGenerationResponse): string[] {
	const urls: string[] = [];
	for (const choice of response.output?.choices ?? []) {
		for (const item of choice.message?.content ?? []) {
			if (typeof item.image === "string" && item.image.length > 0) {
				urls.push(item.image);
			}
		}
	}
	return urls;
}

function shouldOmitQwenImageEditOptionalParameters(model: string): boolean {
	return model === "qwen-image-edit";
}

function getDashScopeImageCount(model: string, input: ImageGenerationInput): number {
	if (
		model === "qwen-image-edit"
		|| model === "qwen-image"
		|| model.startsWith("qwen-image-max")
		|| model.startsWith("qwen-image-plus")
	) {
		return 1;
	}
	return input.count ?? 1;
}

function createDashScopeImageParameters(model: string, input: ImageGenerationInput): Record<string, unknown> {
	const parameters: Record<string, unknown> = {
		n: getDashScopeImageCount(model, input),
		negative_prompt: " ",
		watermark: false
	};
	if (!shouldOmitQwenImageEditOptionalParameters(model)) {
		parameters.prompt_extend = true;
		parameters.size = mapAspectRatioToDashScopeImageSize(input.aspectRatio ?? "1:1");
	}
	return parameters;
}

async function generateDashScopeImages(options: ProviderChatOptions, input: ImageGenerationInput, runtime: ImageGenerationRuntime): Promise<ImageGenerationResult> {
	const model: string = options.model ?? "qwen-image-2.0-pro";
	const sourceImages: ImageGenerationSourceImage[] = await resolveImageGenerationSourceImages(input.sessionId, input.sourceImages);
	const content: DashScopeImageContent[] = [
		...sourceImages.map((image: ImageGenerationSourceImage): DashScopeImageContent => ({ image: image.dataUrl })),
		{ text: createPrompt(input) }
	];
	const response: Response = await fetch(`${resolveDashScopeApiBaseUrl(options.baseUrl)}/services/aigc/multimodal-generation/generation`, {
		method: "POST",
		headers: {
			"Authorization": `Bearer ${options.apiKey}`,
			"Content-Type": "application/json"
		},
		body: JSON.stringify({
			model,
			input: {
				messages: [{
					role: "user",
					content
				}]
			},
			parameters: createDashScopeImageParameters(model, input)
		}),
		signal: runtime.abortSignal ?? null
	});
	const text: string = await response.text();
	let parsed: DashScopeImageGenerationResponse;
	try {
		parsed = JSON.parse(text) as DashScopeImageGenerationResponse;
	} catch {
		throw new ImageGenerationError("image_generation_failed", `DashScope image generation returned invalid JSON: HTTP ${response.status}`);
	}
	if (!response.ok || parsed.code !== undefined) {
		throw new ImageGenerationError(
			"image_generation_failed",
			parsed.message ?? `DashScope image generation failed: HTTP ${response.status}`
		);
	}

	const urls: string[] = extractDashScopeImageUrls(parsed);
	if (urls.length === 0) {
		throw new ImageGenerationError("image_generation_failed", "Provider returned no generated images.");
	}

	const downloaded: DownloadedGeneratedImage[] = await Promise.all(
		urls.slice(0, getDashScopeImageCount(model, input)).map(async (url: string): Promise<DownloadedGeneratedImage> => ({
			bytes: await readImageUrlBytes(url, runtime.abortSignal),
			mimeType: /\.jpe?g(?:$|\?)/iu.test(url) ? "image/jpeg" : "image/png"
		}))
	);
	const artifacts: GeneratedImageArtifactMetadata[] = await persistDownloadedImages(runtime, options, input, model, downloaded);

	return {
		status: "completed",
		prompt: input.prompt,
		provider: options.provider,
		model,
		artifacts,
		sourceImages: input.sourceImages
	};
}

export async function generateImage(input: ImageGenerationInput, abortSignal?: AbortSignal | undefined): Promise<ImageGenerationResult> {
	const runtime: ImageGenerationRuntime = { abortSignal, savedArtifacts: [] };
	try {
		throwIfImageGenerationAborted(runtime);
		const resolved = await resolveConfiguredProviderTaskModelOptions("imageGeneration");
		const options: ProviderChatOptions = resolved.options;
		const hasSourceImages: boolean = (input.sourceImages?.length ?? 0) > 0;
		const supportsImageGeneration: boolean = modelSupportsImageGeneration(options.provider, resolved.model);
		const supportsImageEdit: boolean = modelSupportsImageEdit(options.provider, resolved.model);
		if (!hasSourceImages && !supportsImageGeneration) {
			throw new ImageGenerationError(
				"image_generation_not_supported",
				supportsImageEdit
					? `Model ${options.provider}/${resolved.model} requires at least one source image.`
					: `Model ${options.provider}/${resolved.model} does not support image generation.`
			);
		}
		if (hasSourceImages) {
			if (!supportsImageEdit) {
				throw new ImageGenerationError(
					"image_generation_not_supported",
					createImageEditUnsupportedMessage(options.provider, resolved.model)
				);
			}
			if (options.provider === "dashscope") {
				return await generateDashScopeImages(options, input, runtime);
			}

			await resolveImageGenerationSourceImages(input.sessionId, input.sourceImages);
			throw new ImageGenerationError(
				"image_generation_not_supported",
				`Provider ${options.provider} is not adapted for image-to-image generation yet.`
			);
		}

		if (options.provider === "zhipu") {
			return await generateZhipuImages(options, input, runtime);
		}

		if (options.provider === "dashscope") {
			return await generateDashScopeImages(options, input, runtime);
		}

		if (options.provider === "volcengine") {
			return await generateVolcengineImages(options, input, runtime);
		}

		if (options.provider === "minimax") {
			return await generateMiniMaxImages(options, input, runtime);
		}

		if (options.provider !== "openai") {
			throw new ImageGenerationError(
				"image_generation_not_supported",
				`Provider ${options.provider} is not adapted for image generation.`
			);
		}

		return await generateOpenAIImages(options, input, runtime);
	} catch (error: unknown) {
		await Promise.allSettled(runtime.savedArtifacts.map((artifact: GeneratedImageArtifactMetadata): Promise<void> => runtime.artifactSink?.remove === undefined ? deleteGeneratedImageArtifact(artifact) : runtime.artifactSink.remove(artifact)));
		if (error instanceof ImageGenerationError) {
			throw error;
		}
		if (error instanceof ProviderTaskModelError) {
			throw new ImageGenerationError(
				error.code === "task_model_not_configured" ? "image_generation_not_configured" : "image_generation_failed",
				error.message
			);
		}
		throw new ImageGenerationError(
			"image_generation_failed",
			error instanceof Error ? error.message : "Image generation failed."
		);
	}
}

export async function generateImageWithArtifactSink(input: ImageGenerationInput, artifactSink: ImageGenerationArtifactSink, abortSignal?: AbortSignal | undefined): Promise<ImageGenerationResult> {
	const runtime: ImageGenerationRuntime = { abortSignal, savedArtifacts: [], artifactSink };
	try {
		throwIfImageGenerationAborted(runtime);
		const resolved = input.provider !== undefined && input.model !== undefined
			? { provider: input.provider, model: input.model, options: await resolveProviderModelOptions(input.provider, input.model) }
			: await resolveConfiguredProviderTaskModelOptions("imageGeneration");
		const options: ProviderChatOptions = resolved.options;
		const hasSourceImages: boolean = (input.sourceImages?.length ?? 0) > 0;
		const supportsImageGeneration: boolean = modelSupportsImageGeneration(options.provider, resolved.model);
		const supportsImageEdit: boolean = modelSupportsImageEdit(options.provider, resolved.model);
		if (!hasSourceImages && !supportsImageGeneration) throw new ImageGenerationError("image_generation_not_supported", `Model ${options.provider}/${resolved.model} does not support image generation.`);
		if (hasSourceImages) {
			if (!supportsImageEdit) throw new ImageGenerationError("image_generation_not_supported", createImageEditUnsupportedMessage(options.provider, resolved.model));
			throw new ImageGenerationError("image_generation_not_supported", `Provider ${options.provider} is not adapted for image-to-image generation yet.`);
		}
		if (options.provider === "zhipu") return await generateZhipuImages(options, input, runtime);
		if (options.provider === "dashscope") return await generateDashScopeImages(options, input, runtime);
		if (options.provider === "volcengine") return await generateVolcengineImages(options, input, runtime);
		if (options.provider === "minimax") return await generateMiniMaxImages(options, input, runtime);
		if (options.provider !== "openai") throw new ImageGenerationError("image_generation_not_supported", `Provider ${options.provider} is not adapted for image generation.`);
		return await generateOpenAIImages(options, input, runtime);
	} catch (error: unknown) {
		await Promise.allSettled(runtime.savedArtifacts.map((artifact): Promise<void> => artifactSink.remove === undefined ? Promise.resolve() : artifactSink.remove(artifact)));
		if (error instanceof ImageGenerationError) throw error;
		if (error instanceof ProviderTaskModelError) throw new ImageGenerationError(error.code === "task_model_not_configured" ? "image_generation_not_configured" : "image_generation_failed", error.message);
		throw new ImageGenerationError("image_generation_failed", error instanceof Error ? error.message : "Image generation failed.");
	}
}
