import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChatCompletionUserMessageParam } from "openai/resources/chat/completions";
import { aiChatParamsSchema } from "../../../src/protocol/schema.js";
import { createCurrentUserMessage, getImageAttachments, getProviderUserText, ProviderImageInputError } from "../../../src/providers/provider-image-content.js";
import { preprocessImageAttachmentsForTextModel } from "../../../src/providers/image-recognition.js";
import { MAX_IMAGE_BYTES } from "../../../src/protocol/image-attachments.js";

async function withTempAppData(run: () => Promise<void>): Promise<void> {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	process.env.USERPROFILE = await mkdtemp(join(tmpdir(), "daedalus-image-routing-"));
	try {
		await run();
	} finally {
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
	}
}

const VALID_IMAGE_CONTEXT = {
	id: "img-1",
	kind: "image",
	title: "scene_tree.png",
	subtitle: "image/png",
	source: "manual",
	resourcePath: "res://tests/images/scene_tree.png",
	data: {
		mimeType: "image/png",
		dataUrl: "data:image/png;base64,aGVsbG8=",
		byteSize: 5,
		width: 32,
		height: 24
	}
} as const;

test("schema accepts image additional context", (): void => {
	const result = aiChatParamsSchema.safeParse({
		message: "描述这张图",
		additionalContext: [VALID_IMAGE_CONTEXT]
	});

	assert.equal(result.success, true);
});

test("schema accepts context-only messages and rejects truly empty requests", (): void => {
	assert.equal(aiChatParamsSchema.safeParse({
		message: "",
		additionalContext: [VALID_IMAGE_CONTEXT]
	}).success, true);
	assert.equal(aiChatParamsSchema.safeParse({ message: "" }).success, false);
});

test("provider user text supplies a neutral prompt for context-only messages", (): void => {
	assert.equal(getProviderUserText({
		message: "",
		additionalContext: [VALID_IMAGE_CONTEXT]
	}), "Use the attached context to respond to the user's request.");
	assert.equal(getProviderUserText({ message: "Keep this message" }), "Keep this message");
});

test("schema rejects invalid image mime and oversized byte size", (): void => {
	const badMime = aiChatParamsSchema.safeParse({
		message: "描述这张图",
		additionalContext: [{
			...VALID_IMAGE_CONTEXT,
			data: {
				...VALID_IMAGE_CONTEXT.data,
				mimeType: "image/bmp"
			}
		}]
	});
	assert.equal(badMime.success, false);

	const tooLarge = aiChatParamsSchema.safeParse({
		message: "描述这张图",
		additionalContext: [{
			...VALID_IMAGE_CONTEXT,
			data: {
				...VALID_IMAGE_CONTEXT.data,
				byteSize: MAX_IMAGE_BYTES + 1
			}
		}]
	});
	assert.equal(tooLarge.success, false);
});

test("image content parts are sent only in current user message", (): void => {
	const message: ChatCompletionUserMessageParam = createCurrentUserMessage({
		message: "请识别图片内容",
		additionalContext: [VALID_IMAGE_CONTEXT]
	});

	assert.equal(message.role, "user");
	assert.ok(Array.isArray(message.content));
	assert.deepEqual(message.content, [
		{
			type: "image_url",
			image_url: {
				url: VALID_IMAGE_CONTEXT.data.dataUrl
			}
		},
		{
			type: "text",
			text: "请识别图片内容"
		}
	]);
});

test("image attachment validation rejects invalid base64 and too many images", (): void => {
	assert.throws(
		() => getImageAttachments([{
			...VALID_IMAGE_CONTEXT,
			data: {
				...VALID_IMAGE_CONTEXT.data,
				dataUrl: "data:image/png;base64,不是base64"
			}
		}]),
		(error: unknown): boolean => error instanceof ProviderImageInputError && error.code === "invalid_image_attachment"
	);

	assert.throws(
		() => getImageAttachments([VALID_IMAGE_CONTEXT, VALID_IMAGE_CONTEXT, VALID_IMAGE_CONTEXT, VALID_IMAGE_CONTEXT]),
		(error: unknown): boolean => error instanceof ProviderImageInputError && error.code === "too_many_image_attachments"
	);
});

test("image preprocessing keeps direct multimodal input when current model supports images", async (): Promise<void> => {
	const result = await preprocessImageAttachmentsForTextModel(
		{
			message: "描述这张图",
			additionalContext: [VALID_IMAGE_CONTEXT]
		},
		{
			provider: "moonshot",
			apiKey: "test-key",
			model: "kimi-k2.6"
		}
	);

	assert.equal(result.recognized, false);
	assert.equal(result.params.additionalContext?.[0]?.kind, "image");
});

test("DeepSeek V4 Flash Vision Exp keeps direct image input", async (): Promise<void> => {
	const result = await preprocessImageAttachmentsForTextModel(
		{
			message: "描述这张图",
			additionalContext: [VALID_IMAGE_CONTEXT]
		},
		{
			provider: "deepseek",
			apiKey: "test-key",
			model: "deepseek-v4-flash-vision-exp"
		}
	);

	assert.equal(result.recognized, false);
	assert.equal(result.params.additionalContext?.[0]?.kind, "image");
});

test("image preprocessing requires recognition model when current model lacks image support", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		await assert.rejects(
			preprocessImageAttachmentsForTextModel(
				{
					message: "描述这张图",
					additionalContext: [VALID_IMAGE_CONTEXT]
				},
				{
					provider: "deepseek",
					apiKey: "test-key",
					model: "deepseek-v4-flash"
				}
			),
			(error: unknown): boolean => {
				assert.equal(error instanceof ProviderImageInputError, true);
				assert.equal((error as ProviderImageInputError).code, "model_does_not_support_images");
				assert.match((error as Error).message, /Enable Vision/);
				return true;
			}
		);
	});
});
