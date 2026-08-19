import type {
	ChatCompletionContentPart,
	ChatCompletionMessageParam,
	ChatCompletionUserMessageParam
} from "openai/resources/chat/completions";
import type { AdditionalContextItem, AiChatParams, ChatMessage, ProviderId } from "../protocol/types.js";
import {
	MAX_IMAGE_ATTACHMENTS,
	MAX_IMAGE_BYTES,
	MAX_TOTAL_IMAGE_BYTES,
	SUPPORTED_IMAGE_MIME_TYPES
} from "../protocol/image-attachments.js";
import { getProviderModelsCache } from "./provider-config-store.js";
import { mergeProviderModelsWithCatalog, type ProviderModelInfo } from "./provider-registry.js";

export class ProviderImageInputError extends Error {
	readonly code: "invalid_image_attachment" | "too_many_image_attachments" | "model_does_not_support_images";

	constructor(code: ProviderImageInputError["code"], message: string) {
		super(message);
		this.name = "ProviderImageInputError";
		this.code = code;
	}
}

export type ProviderImageAttachment = {
	title: string;
	mimeType: string;
	dataUrl: string;
	byteSize: number;
	width?: number | undefined;
	height?: number | undefined;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPositiveInteger(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return undefined;
	}
	return Math.floor(value);
}

function validateDataUrl(mimeType: string, dataUrl: string): void {
	const prefix = `data:${mimeType};base64,`;
	if (!dataUrl.startsWith(prefix)) {
		throw new ProviderImageInputError("invalid_image_attachment", "Image data URL must match its mimeType.");
	}

	const base64Text: string = dataUrl.slice(prefix.length);
	if (base64Text.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64Text)) {
		throw new ProviderImageInputError("invalid_image_attachment", "Image data URL must contain valid base64 data.");
	}
}

function parseImageAttachment(item: AdditionalContextItem): ProviderImageAttachment {
	const data: unknown = item.data;
	if (!isObjectRecord(data)) {
		throw new ProviderImageInputError("invalid_image_attachment", "Image context must contain data.");
	}

	const mimeType: unknown = data.mimeType;
	if (typeof mimeType !== "string" || !SUPPORTED_IMAGE_MIME_TYPES.includes(mimeType)) {
		throw new ProviderImageInputError("invalid_image_attachment", "Unsupported image mimeType.");
	}

	const dataUrl: unknown = data.dataUrl;
	if (typeof dataUrl !== "string" || dataUrl.length === 0) {
		throw new ProviderImageInputError("invalid_image_attachment", "Image context must contain dataUrl.");
	}
	validateDataUrl(mimeType, dataUrl);

	const byteSize: number | undefined = readPositiveInteger(data.byteSize);
	if (byteSize === undefined) {
		throw new ProviderImageInputError("invalid_image_attachment", "Image context must contain byteSize.");
	}
	if (byteSize > MAX_IMAGE_BYTES) {
		throw new ProviderImageInputError("invalid_image_attachment", `Image is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MiB.`);
	}

	return {
		title: item.title,
		mimeType,
		dataUrl,
		byteSize,
		width: readPositiveInteger(data.width),
		height: readPositiveInteger(data.height)
	};
}

export function getImageAttachments(items: readonly AdditionalContextItem[] | undefined): ProviderImageAttachment[] {
	if (items === undefined || items.length === 0) {
		return [];
	}

	const images: ProviderImageAttachment[] = items
		.filter((item: AdditionalContextItem): boolean => item.kind === "image")
		.map(parseImageAttachment);

	if (images.length > MAX_IMAGE_ATTACHMENTS) {
		throw new ProviderImageInputError("too_many_image_attachments", `A message can include at most ${MAX_IMAGE_ATTACHMENTS} images.`);
	}

	const totalBytes: number = images.reduce((sum: number, image: ProviderImageAttachment): number => sum + image.byteSize, 0);
	if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
		throw new ProviderImageInputError("invalid_image_attachment", `Total image attachment size is larger than ${MAX_TOTAL_IMAGE_BYTES / 1024 / 1024} MiB.`);
	}

	return images;
}

export function hasImageAttachments(params: AiChatParams): boolean {
	return (params.additionalContext ?? []).some((item: AdditionalContextItem): boolean => item.kind === "image");
}

export function getProviderUserText(params: AiChatParams): string {
	return params.message.trim().length > 0
		? params.message
		: "Use the attached context to respond to the user's request.";
}

export function createCurrentUserMessage(params: AiChatParams): ChatCompletionUserMessageParam {
	const images: ProviderImageAttachment[] = getImageAttachments(params.additionalContext);
	const userText: string = getProviderUserText(params);
	if (images.length === 0) {
		return {
			role: "user",
			content: userText
		};
	}

	const parts: ChatCompletionContentPart[] = images.map((image: ProviderImageAttachment): ChatCompletionContentPart => ({
		type: "image_url",
		image_url: {
			url: image.dataUrl
		}
	}));
	parts.push({
		type: "text",
		text: userText
	});

	return {
		role: "user",
		content: parts
	};
}

export function createProviderMessages(params: AiChatParams, history: ChatMessage[], systemPrompt: string): ChatCompletionMessageParam[] {
	return [
		{
			role: "system",
			content: systemPrompt
		},
		...history.map((message: ChatMessage): ChatCompletionMessageParam => ({
			role: message.role,
			content: message.content
		})),
		createCurrentUserMessage(params)
	];
}

export async function modelSupportsImageInput(provider: ProviderId, modelId: string): Promise<boolean> {
	const cache = await getProviderModelsCache(provider);
	const effectiveModel: ProviderModelInfo | undefined = mergeProviderModelsWithCatalog(
		provider,
		cache?.models ?? [],
		{ includeExcluded: true }
	)
		.find((model: ProviderModelInfo): boolean => model.id === modelId);
	return effectiveModel?.capabilities.imageInput === true;
}
