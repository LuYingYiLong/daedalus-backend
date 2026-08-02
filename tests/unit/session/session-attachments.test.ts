import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { aiChatParamsSchema } from "../../../src/protocol/schema.js";

const PNG_BYTES: Buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
const WEBP_BYTES: Buffer = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);

async function withTempAppData(run: () => Promise<void>): Promise<void> {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const appDataDir: string = await mkdtemp(join(tmpdir(), "daedalus-session-attachments-"));
	process.env.USERPROFILE = appDataDir;
	try {
		await run();
	} finally {
		const { resetSessionDatabaseForTests } = await import("../../../src/session/session-database.js");
		await resetSessionDatabaseForTests();
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		await rm(appDataDir, { recursive: true, force: true });
	}
}

test("schema accepts session-backed image additional context", (): void => {
	const result = aiChatParamsSchema.safeParse({
		message: "描述这张剪贴板图",
		additionalContext: [{
			id: "image-test",
			kind: "image",
			title: "Clipboard image",
			source: "manual",
			data: {
				mimeType: "image/png",
				attachmentId: "image-test",
				byteSize: 5,
				width: 16,
				height: 12,
				sourcePath: "D:/Pictures/reference.png"
			}
		}]
	});

	assert.equal(result.success, true);
});

test("text attachments are saved under the session and hydrate into prompt context", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		const sessionStore = await import("../../../src/session/session-store.js");
		const attachments = await import("../../../src/session/session-attachments.js");
		const additionalContext = await import("../../../src/server/additional-context.js");
		const metadata = await sessionStore.createSession("Text attachment test");
		const content: string = "First line\nSecond line\n".repeat(20);
		const context = await attachments.saveTextAttachment({
			sessionId: metadata.id,
			content,
			title: "Pasted notes.txt"
		});

		assert.equal(context.kind, "text_attachment");
		assert.equal(context.title, "Pasted notes.txt");
		const attachmentId: string = String((context.data as Record<string, unknown>).attachmentId);
		assert.match(attachmentId, /^text-/);
		assert.equal((await attachments.readTextAttachmentContent(metadata.id, attachmentId)).content, content);

		const hydrated = await attachments.hydrateAttachmentContexts(metadata.id, {
			message: "Review these notes",
			additionalContext: [context]
		});
		const data: Record<string, unknown> = hydrated.additionalContext?.[0]?.data as Record<string, unknown>;
		assert.equal(data.content, content);
		assert.match(additionalContext.createAdditionalContextPromptSection(hydrated.additionalContext), /First line/u);

		const stored = additionalContext.cloneAdditionalContextItems(hydrated.additionalContext);
		assert.equal((stored?.[0]?.data as Record<string, unknown>).content, undefined);
	});
});

test("startup cleanup removes unsent composer attachments but preserves message snapshots", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		const sessionStore = await import("../../../src/session/session-store.js");
		const attachments = await import("../../../src/session/session-attachments.js");
		const metadata = await sessionStore.createSession("Attachment cleanup");
		const unsent = await attachments.saveTextAttachment({ sessionId: metadata.id, content: "draft only" });
		const sent = await attachments.saveTextAttachment({ sessionId: metadata.id, content: "sent context" });

		await sessionStore.appendMessage(metadata.id, {
			role: "user",
			content: "Use the attached note",
			requestId: "request-sent",
			additionalContext: [sent]
		});
		assert.equal(await attachments.cleanupUnsentSessionAttachments(), 1);
		const unsentId = String((unsent.data as Record<string, unknown>).attachmentId);
		const sentId = String((sent.data as Record<string, unknown>).attachmentId);
		await assert.rejects(attachments.readTextAttachmentContent(metadata.id, unsentId));
		assert.equal((await attachments.readTextAttachmentContent(metadata.id, sentId)).content, "sent context");
	});
});

test("image attachments are saved under the session and hydrate to dataUrl", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		const sessionStore = await import("../../../src/session/session-store.js");
		const attachments = await import("../../../src/session/session-attachments.js");
		const metadata = await sessionStore.createSession("Attachment test");
		const dataUrl: string = "data:image/png;base64,aGVsbG8=";

		const context = await attachments.saveImageAttachment({
			sessionId: metadata.id,
			mimeType: "image/png",
			dataUrl,
			byteSize: 5,
			width: 32,
			height: 24,
			title: "Clipboard image test",
			sourcePath: "D:/Pictures/reference.png"
		});

		assert.equal(context.kind, "image");
		assert.equal(context.source, "manual");
		assert.equal((context.data as Record<string, unknown>).attachmentId !== undefined, true);
		assert.equal((context.data as Record<string, unknown>).dataUrl, undefined);
		assert.equal(typeof (context.data as Record<string, unknown>).thumbnailDataUrl, "string");
		assert.equal((context.data as Record<string, unknown>).sourcePath, "D:/Pictures/reference.png");

		const attachmentId: string = String((context.data as Record<string, unknown>).attachmentId);
		const { getSessionDatabase } = await import("../../../src/session/session-database.js");
		const db = await getSessionDatabase();
		const row = db.prepare("SELECT metadata_json FROM attachments WHERE session_id = ? AND attachment_id = ?")
			.get(metadata.id, attachmentId) as { metadata_json: string };
		const rawMetadata: string = row.metadata_json;
		assert.equal(rawMetadata.includes("aGVsbG8="), false);
		assert.equal(rawMetadata.includes("D:/Pictures/reference.png"), true);

		const hydrated = await attachments.hydrateImageAttachmentContexts(metadata.id, {
			message: "描述图片",
			additionalContext: [context]
		});
		assert.equal((hydrated.additionalContext?.[0]?.data as Record<string, unknown>).dataUrl, dataUrl);
	});
});

test("timeline result hydrates session-backed image thumbnails without persisting base64", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		const sessionStore = await import("../../../src/session/session-store.js");
		const attachments = await import("../../../src/session/session-attachments.js");
		const sessionPreview = await import("../../../src/server/session-preview.js");
		const metadata = await sessionStore.createSession("Timeline attachment test");
		const context = await attachments.saveImageAttachment({
			sessionId: metadata.id,
			mimeType: "image/png",
			dataUrl: "data:image/png;base64,aGVsbG8=",
			byteSize: 5,
			width: 32,
			height: 24,
			title: "Clipboard image test"
		});
		const storedContext = {
			...context,
			data: {
				...(context.data as Record<string, unknown>),
				thumbnailDataUrl: undefined
			}
		};
		delete (storedContext.data as Record<string, unknown>).thumbnailDataUrl;

		await sessionStore.saveSession(metadata.id, [{
			role: "user",
			content: "看图",
			requestId: "request-image",
			additionalContext: [storedContext]
		}, {
			role: "assistant",
			content: "好的",
			requestId: "request-image"
		}]);

		const opened = await sessionStore.openSession(metadata.id);
		const rawMessages: string = JSON.stringify(opened.messages);
		assert.equal(rawMessages.includes("aGVsbG8="), false);

		const page = await sessionStore.openSessionRecentTimeline(metadata.id, 10);
		const result = await sessionPreview.createTimelinePageResult(page, 10);
		const blocks = result.timelineBlocks as Array<Record<string, unknown>>;
		const userBlock = blocks.find((block: Record<string, unknown>): boolean => block.type === "user");
		const additionalContext = userBlock?.additionalContext as Array<Record<string, unknown>>;
		const imageData = additionalContext[0]?.data as Record<string, unknown>;
		assert.equal(imageData.thumbnailDataUrl, "data:image/png;base64,aGVsbG8=");
	});
});

test("generated image artifacts are saved under the session and read through dataUrl", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		const sessionStore = await import("../../../src/session/session-store.js");
		const attachments = await import("../../../src/session/session-attachments.js");
		const metadata = await sessionStore.createSession("Generated image test");
		const bytes: Buffer = PNG_BYTES;

		const artifact = await attachments.saveGeneratedImageArtifact({
			sessionId: metadata.id,
			bytes,
			mimeType: "image/png",
			provider: "openai",
			model: "gpt-image-1",
			prompt: "生成一张蓝色机器人图标",
			revisedPrompt: "A blue robot app icon"
		});

		assert.match(artifact.imageId, /^generated-image-/);
		assert.equal(artifact.sessionId, metadata.id);
		assert.equal(artifact.byteSize, bytes.byteLength);
		assert.equal(artifact.provider, "openai");
		assert.equal(artifact.model, "gpt-image-1");
		assert.equal(artifact.storagePath, `attachments/images/${artifact.imageId}.png`);

		const imagesDir: string = join(sessionStore.getSessionDir(metadata.id), "attachments", "images");
		const files: string[] = await readdir(imagesDir);
		assert.equal(files.includes(`${artifact.imageId}.png`), true);
		assert.equal(files.includes(`${artifact.imageId}.json`), false);

		const { getSessionDatabase } = await import("../../../src/session/session-database.js");
		const db = await getSessionDatabase();
		const row = db.prepare("SELECT metadata_json FROM attachments WHERE session_id = ? AND attachment_id = ?")
			.get(metadata.id, artifact.imageId) as { metadata_json: string };
		const rawMetadata: string = row.metadata_json;
		assert.equal(rawMetadata.includes(bytes.toString("base64")), false);
		assert.equal(rawMetadata.includes("A blue robot app icon"), true);

		const hydrated = await attachments.readGeneratedImageDataUrl(metadata.id, artifact.imageId);
		assert.equal(hydrated.imageId, artifact.imageId);
		assert.equal(hydrated.mimeType, "image/png");
		assert.equal(hydrated.dataUrl, `data:image/png;base64,${bytes.toString("base64")}`);
		assert.equal(hydrated.metadata.prompt, "生成一张蓝色机器人图标");
		assert.equal(attachments.getGeneratedImageArtifactLocalPath(artifact), join(imagesDir, `${artifact.imageId}.png`));
	});
});

test("generated image artifacts use the byte signature instead of incorrect provider MIME metadata", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		const sessionStore = await import("../../../src/session/session-store.js");
		const attachments = await import("../../../src/session/session-attachments.js");
		const metadata = await sessionStore.createSession("Generated JPEG normalization");
		const jpegBytes: Buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
		const artifact = await attachments.saveGeneratedImageArtifact({
			sessionId: metadata.id,
			bytes: jpegBytes,
			mimeType: "image/png",
			provider: "openai",
			model: "compatible-image-model",
			prompt: "texture"
		});

		assert.equal(artifact.mimeType, "image/jpeg");
		assert.equal(artifact.fileName, `${artifact.imageId}.jpg`);
		assert.deepEqual((await attachments.readGeneratedImageArtifact(metadata.id, artifact.imageId)).bytes, jpegBytes);
	});
});

test("image generation source refs resolve session attachments and generated images", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		const sessionStore = await import("../../../src/session/session-store.js");
		const attachments = await import("../../../src/session/session-attachments.js");
		const imageGeneration = await import("../../../src/providers/image-generation.js");
		const metadata = await sessionStore.createSession("Image source refs test");
		const attachmentDataUrl: string = "data:image/png;base64,c291cmNlLWF0dGFjaG1lbnQ=";
		const attachmentContext = await attachments.saveImageAttachment({
			sessionId: metadata.id,
			mimeType: "image/png",
			dataUrl: attachmentDataUrl,
			byteSize: Buffer.byteLength("source-attachment"),
			title: "Source image"
		});
		const generatedBytes: Buffer = WEBP_BYTES;
		const generated = await attachments.saveGeneratedImageArtifact({
			sessionId: metadata.id,
			bytes: generatedBytes,
			mimeType: "image/webp",
			provider: "openai",
			model: "gpt-image-1",
			prompt: "source"
		});

		const attachmentId: string = String((attachmentContext.data as Record<string, unknown>).attachmentId);
		const sources = await imageGeneration.resolveImageGenerationSourceImages(metadata.id, [
			{ type: "attachment", id: attachmentId },
			{ type: "generated", id: generated.imageId }
		]);

		assert.equal(sources.length, 2);
		assert.deepEqual(sources[0], {
			type: "attachment",
			id: attachmentId,
			mimeType: "image/png",
			dataUrl: attachmentDataUrl
		});
		assert.deepEqual(sources[1], {
			type: "generated",
			id: generated.imageId,
			mimeType: "image/webp",
			dataUrl: `data:image/webp;base64,${generatedBytes.toString("base64")}`
		});
	});
});

test("storage clone strips transient image data for session-backed attachments", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		const { cloneAdditionalContextItems } = await import("../../../src/server/additional-context.js");
		const cloned = cloneAdditionalContextItems([{
			id: "image-test",
			kind: "image",
			title: "Clipboard image",
			source: "manual",
			data: {
				mimeType: "image/png",
				attachmentId: "image-test",
				dataUrl: "data:image/png;base64,aGVsbG8=",
				thumbnailDataUrl: "data:image/png;base64,aGVsbG8=",
				byteSize: 5
			}
		}]);

		const data: Record<string, unknown> = cloned?.[0]?.data as Record<string, unknown>;
		assert.equal(data.attachmentId, "image-test");
		assert.equal(data.dataUrl, undefined);
		assert.equal(data.thumbnailDataUrl, undefined);
	});
});
