import type { AdditionalContextItem, AiChatParams } from "../protocol/types.js";
import { chatWithProvider, resolveChatModel, type ProviderChatOptions } from "./deepseek-client.js";
import { getImageAttachments, hasImageAttachments, modelSupportsImageInput, ProviderImageInputError } from "./provider-image-content.js";
import { resolveProviderTaskModelOptions, type ResolvedProviderTaskModel } from "./task-model-routing.js";
import { getProviderDisplayName } from "./provider-registry.js";
import { logger } from "../logger.js";
import { withProviderUsageContext } from "../usage/provider-recorder.js";

const IMAGE_RECOGNITION_MAX_CHARS: number = 2400;

export type ImageRecognitionPreprocessResult = {
	params: AiChatParams;
	recognized: boolean;
	model?: {
		provider: string;
		model: string;
	} | undefined;
	observation?: string | undefined;
};

export type ImageRecognitionProgress = {
	status: "message" | "success" | "error";
	title: string;
	details: string;
	code: string;
};

function clipTextByChars(value: string, maxChars: number): string {
	return value.length <= maxChars ? value : value.slice(0, maxChars);
}

function removeImageContext(items: readonly AdditionalContextItem[] | undefined): AdditionalContextItem[] | undefined {
	if (items === undefined) {
		return undefined;
	}

	const filtered: AdditionalContextItem[] = items.filter((item: AdditionalContextItem): boolean => item.kind !== "image");
	return filtered.length > 0 ? filtered : undefined;
}

function createImageObservationContext(observation: string, model: ResolvedProviderTaskModel): AdditionalContextItem {
	return {
		id: `image-recognition-${Date.now()}`,
		kind: "file",
		title: "Image recognition result",
		subtitle: `${getProviderDisplayName(model.provider)} / ${model.model}`,
		source: "manual",
		summary: observation,
		data: {
			provider: model.provider,
			model: model.model,
			text: observation
		}
	};
}

function createRecognitionPrompt(params: AiChatParams): AiChatParams {
	return {
		message: [
			"请识别并解释用户附加图片中的关键信息，尤其是错误日志、代码、界面状态、文件路径、报错行列和可见上下文。",
			"输出应是给后续文本模型阅读的结构化中文观察，不要编造图片中看不到的信息。",
			"如果图片包含错误日志，请摘录关键错误、可能原因和需要用户/后续模型关注的线索。",
			"",
			"用户原始问题：",
			params.message
		].join("\n"),
		additionalContext: params.additionalContext,
		options: {
			temperature: 0.1,
			maxTokens: IMAGE_RECOGNITION_MAX_CHARS
		}
	};
}

export async function preprocessImageAttachmentsForTextModel(
	params: AiChatParams,
	currentOptions: ProviderChatOptions,
	abortSignal?: AbortSignal | undefined,
	onProgress?: ((progress: ImageRecognitionProgress) => void) | undefined
): Promise<ImageRecognitionPreprocessResult> {
	if (!hasImageAttachments(params)) {
		return { params, recognized: false };
	}

	getImageAttachments(params.additionalContext);
	const currentModelId: string = resolveChatModel(currentOptions);
	if (await modelSupportsImageInput(currentOptions.provider, currentModelId)) {
		return { params, recognized: false };
	}

	const resolvedImageModel: ResolvedProviderTaskModel = await resolveProviderTaskModelOptions("imageRecognition", currentOptions);
	const imageModel: ResolvedProviderTaskModel = {
		...resolvedImageModel,
		options: withProviderUsageContext(resolvedImageModel.options, {
			operation: "image_recognition"
		})
	};
	if (imageModel.source === "current") {
		throw new ProviderImageInputError(
			"model_does_not_support_images",
			`${getProviderDisplayName(currentOptions.provider)} model ${currentModelId} does not support image input. Configure an image recognition model in backend settings.`
		);
	}
	if (!await modelSupportsImageInput(imageModel.provider, imageModel.model)) {
		throw new ProviderImageInputError(
			"model_does_not_support_images",
			`${getProviderDisplayName(imageModel.provider)} model ${imageModel.model} does not support image input. Choose an image-capable recognition model.`
		);
	}

	const imageCount: number = getImageAttachments(params.additionalContext).length;
	onProgress?.({
		status: "message",
		title: "识别图片",
		details: `使用 ${getProviderDisplayName(imageModel.provider)} / ${imageModel.model} 识别 ${imageCount} 张图片。`,
		code: "image.recognition.started"
	});
	try {
		const observation: string = clipTextByChars(
			await chatWithProvider(createRecognitionPrompt(params), imageModel.options, [], "你是图像内容识别助手，只输出图片观察结果。", abortSignal),
			IMAGE_RECOGNITION_MAX_CHARS
		);
		onProgress?.({
			status: "success",
			title: "图片识别完成",
			details: clipTextByChars(observation, 500),
			code: "image.recognition.completed"
		});
		logger.info("ai", "image_recognition_completed", {
			provider: imageModel.provider,
			model: imageModel.model,
			imageCount,
			observationChars: observation.length
		});

		const nextContext: AdditionalContextItem[] = [
			...(removeImageContext(params.additionalContext) ?? []),
			createImageObservationContext(observation, imageModel)
		];
		return {
			params: {
				...params,
				additionalContext: nextContext
			},
			recognized: true,
			model: {
				provider: imageModel.provider,
				model: imageModel.model
			},
			observation
		};
	} catch (error: unknown) {
		onProgress?.({
			status: "error",
			title: "图片识别失败",
			details: error instanceof Error ? error.message : "Image recognition failed",
			code: "image.recognition.failed"
		});
		throw error;
	}
}
