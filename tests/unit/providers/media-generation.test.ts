import assert from "node:assert/strict";
import test from "node:test";
import { generateMedia, listMediaGenerationAdapters } from "../../../src/providers/media-generation.js";

test("mock media adapter exposes image and video lifecycle results", async (): Promise<void> => {
	assert.equal(listMediaGenerationAdapters().some((adapter): boolean => adapter.provider === "mock"), true);
	const controller = new AbortController();
	const image = await generateMedia({
		kind: "imageGeneration",
		provider: "mock",
		model: "mock-image",
		prompt: "a blue square",
		count: 2,
	}, controller.signal);
	assert.equal(image.status, "completed");
	assert.equal(image.artifacts.length, 2);
	assert.equal(image.artifacts[0]?.mimeType, "image/svg+xml");

	const video = await generateMedia({
		kind: "videoGeneration",
		provider: "mock",
		model: "mock-video",
		prompt: "a moving blue square",
		durationMs: 1_000,
		fps: 24,
	}, controller.signal);
	assert.equal(video.status, "completed");
	assert.equal(video.artifacts[0]?.mimeType, "video/mp4");
});
