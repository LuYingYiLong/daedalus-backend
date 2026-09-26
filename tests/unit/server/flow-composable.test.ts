import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { processImage } from "../../../src/media/image-processing.js";
import { createMockPng } from "../../../src/providers/mock-image.js";
import { assertFlowPortValue, acceptsFlowCardinality } from "../../../src/protocol/flow-value-types.js";
import { createFlowDocument, createFlowNodeDocument, createFlowEdgeDocument, getFlowDocument } from "../../../src/session/flow-document-store.js";
import { getSessionDatabase, resetSessionDatabaseForTests } from "../../../src/session/session-database.js";
import { startFlowRunDocument } from "../../../src/server/flow-runner.js";
import { listFlowBatchItems } from "../../../src/session/flow-batch-store.js";
import { getFlowArtifact, listFlowGeneratedArtifacts } from "../../../src/session/flow-artifact-store.js";
import { registerMediaGenerationAdapter, unregisterMediaGenerationAdapter } from "../../../src/providers/media-generation.js";
import type { McpHost } from "../../../src/mcp/mcp-host.js";
import sharp from "sharp";

test("typed values reject non-finite numbers, malformed colors and scalar/list mismatches", () => {
	assert.throws(() => assertFlowPortValue({ id: "n", dataTypes: ["number"] }, Infinity));
	assert.throws(() => assertFlowPortValue({ id: "n", dataTypes: ["number"] }, [1]));
	assert.throws(() => assertFlowPortValue({ id: "color", dataTypes: ["color"] }, { r: 256, g: 0, b: 0, a: 1 }));
	assert.throws(() => assertFlowPortValue({ id: "images", dataTypes: ["image"], cardinality: "many" }, [{ artifactId: "bad" }]));
	assertFlowPortValue({ id: "numbers", dataTypes: ["number"], cardinality: "many" }, [1, 2]);
	assertFlowPortValue({ id: "flags", dataTypes: ["boolean"], cardinality: "many" }, [true, false]);
	assertFlowPortValue({ id: "size", dataTypes: ["size"] }, { width: 1280, height: 720 });
	assertFlowPortValue({ id: "image", dataTypes: ["image"] }, { artifactId: "flow-artifact-input", mimeType: "image/png", sha256: "a".repeat(64), runId: null });
	assert.throws(() => assertFlowPortValue({ id: "image", dataTypes: ["image"] }, { artifactId: "flow-artifact-video", mimeType: "video/mp4", sha256: "a".repeat(64) }));
	assert.equal(acceptsFlowCardinality("many", "one"), false);
	assert.equal(acceptsFlowCardinality("many", "one-or-many"), true);
	assert.throws(() => assertFlowPortValue({ id: "image", dataTypes: ["image"] }, { artifactId: "flow-artifact-x", mimeType: "image/png", sha256: "a".repeat(64), dataBase64: "pixels" }));
});

test("isolated image processor resizes, crops, rotates, composites and rejects invalid input", async () => {
	const source = createMockPng([200, 50, 20, 128], 32, 24);
	const signal = new AbortController().signal;
	const resized = await processImage(source, { kind: "resize", width: 20, height: 10, fit: "fill" }, signal);
	assert.equal(resized.width, 20); assert.equal(resized.height, 10);
	const crop = await processImage(source, { kind: "crop", x: 1, y: 1, width: 10, height: 10 }, signal);
	assert.equal(crop.width, 10);
	const rotate = await processImage(source, { kind: "rotate", angle: 90 }, signal);
	assert.equal(rotate.width, 24); assert.equal(rotate.height, 32);
	const composite = await processImage(source, { kind: "composite", x: 0, y: 0, opacity: 0.5 }, signal, createMockPng([0, 255, 0, 255], 8, 8));
	assert.equal(composite.width, 32);
	const converted = await processImage(source, { kind: "convert", format: "webp" }, signal);
	assert.equal(converted.mimeType, "image/webp");
	const pixels = await sharp(composite.bytes).ensureAlpha().raw().toBuffer();
	assert.ok(pixels[1]! > pixels[0]!, "green overlay changes the composite pixels");
	const oriented = await sharp(source).jpeg().withMetadata({ orientation: 6 }).toBuffer();
	const normalized = await processImage(oriented, { kind: "normalize" }, signal);
	assert.deepEqual([normalized.width, normalized.height], [24, 32]);
	assert.equal((await sharp(normalized.bytes).metadata()).exif, undefined);
	const acTL = Buffer.alloc(20); acTL.writeUInt32BE(8); acTL.write("acTL", 4);
	await assert.rejects(processImage(Buffer.concat([source.subarray(0, 8), acTL, source.subarray(8)]), { kind: "normalize" }, signal), /animation/);
	await assert.rejects(processImage(source, { kind: "crop", x: 30, y: 0, width: 10, height: 10 }, signal));
	await assert.rejects(processImage(Buffer.from("<svg/>"), { kind: "normalize" }, signal));
	await assert.rejects(processImage(Buffer.from("broken"), { kind: "normalize" }, signal));
	await assert.rejects(processImage(source, { kind: "resize", width: 16000, height: 16000 }, signal));
	await assert.rejects(processImage(source, { kind: "normalize" }, AbortSignal.abort()));
	const controller = new AbortController();
	const cancelled = processImage(source, { kind: "normalize" }, controller.signal);
	setTimeout(() => controller.abort(), 5);
	await assert.rejects(cancelled, /cancelled/);
	assert.equal((await processImage(source, { kind: "normalize" }, signal)).width, 32);
});

test("batch generation retains ordered successes and retries only failed rows through image processing", async () => {
	const directory = await mkdtemp(join(tmpdir(), "flow-composable-"));
	const previousProfile = process.env.USERPROFILE;
	process.env.USERPROFILE = directory;
	await resetSessionDatabaseForTests(join(directory, "sessions.sqlite"));
	let fail = true; const calls: string[] = [];
	registerMediaGenerationAdapter({ provider: "fixture-batch", supports: ["imageGeneration"], generate: async request => {
		calls.push(request.prompt);
		if (request.prompt === "second" && fail) throw Object.assign(new Error("fixture denied"), { status: 400 });
		return { status: "completed", provider: "fixture-batch", model: "fixture", artifacts: [{ bytes: createMockPng([20, 30, 40]), mimeType: "image/png", width: 32, height: 32 }] };
	} });
	try {
		let snapshot = await createFlowDocument({ title: "Batch" });
		const ids: string[] = [];
		for (const [typeId, config] of [
			["builtin/parameter-sets", { rows: [{ id: "a", prompt: "first", seed: 1 }, { id: "b", prompt: "second", seed: 2 }] }],
			["builtin/batch-text-to-image", { provider: "fixture-batch", model: "fixture" }],
			["builtin/image-resize", { width: 12, height: 8, fit: "fill" }],
			["builtin/media-output", {}],
		] as Array<[string, Record<string, unknown>]>) {
			const before = new Set(snapshot.nodes.map(node => node.nodeId));
			snapshot = await createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, typeId, x: ids.length * 360, y: 0, config });
			ids.push(snapshot.nodes.find(node => !before.has(node.nodeId))!.nodeId);
		}
		for (const [index, sourcePort, targetPort, dataType] of [[0,"rows","rows","json"],[1,"images","image","image"],[2,"images","input","image"]] as const) snapshot = await createFlowEdgeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, sourceNodeId: ids[index]!, sourcePort, targetNodeId: ids[index+1]!, targetPort, dataType });
		const first = await startFlowRunDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, mcpHost: {} as McpHost });
		assert.equal(first.status, "partial_failure", JSON.stringify(first.nodes));
		const items = await listFlowBatchItems(first.runId, ids[1]!);
		assert.deepEqual(items.map(item => item.status), ["completed", "failed"]);
		assert.equal(first.nodes.find(node => node.nodeId === ids[3])?.status, "completed");
		fail = false;
		const second = await startFlowRunDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, mcpHost: {} as McpHost });
		assert.equal(second.status, "completed", JSON.stringify(second.nodes));
		assert.deepEqual(calls, ["first", "second", "second"]);
		const output = second.nodes.find(node => node.nodeId === ids[3])!.output as { result: Array<{ artifactId: string }> };
		assert.equal(output.result.length, 2);
		assert.equal((await getFlowArtifact(output.result[0]!.artifactId)).ref.width, 12);
		assert.equal((await getFlowDocument(snapshot.flow.flowId)).nodes.length, 4);
	} finally { await resetSessionDatabaseForTests(); if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile; await rm(directory, { recursive: true, force: true }); }
});

test("AI image and video artifacts retain immutable Flow generation provenance", async () => {
	const directory = await mkdtemp(join(tmpdir(), "flow-provenance-"));
	const previousProfile = process.env.USERPROFILE;
	process.env.USERPROFILE = directory;
	await resetSessionDatabaseForTests(join(directory, "sessions.sqlite"));
	const provider = "fixture-provenance";
	const mediaRequests: Array<Record<string, unknown>> = [];
	registerMediaGenerationAdapter({
		provider,
		supports: ["imageGeneration", "videoGeneration"],
		generate: async request => {
			mediaRequests.push({ kind: request.kind, prompt: request.prompt, negativePrompt: request.negativePrompt, width: request.width, height: request.height, durationMs: request.durationMs, fps: request.fps, seed: request.seed, count: request.count });
			return {
				status: "completed",
				provider,
				model: request.model,
				artifacts: request.kind === "videoGeneration"
					? [{ bytes: Buffer.from("fixture-video"), mimeType: "video/mp4", width: 1280, height: 720, durationMs: 2_000, fps: 24 }]
					: [{ bytes: createMockPng([30, 80, 120]), mimeType: "image/png", width: 32, height: 32 }],
			};
		},
	});
	try {
		let snapshot = await createFlowDocument({ title: "Media provenance" });
		const nodes: Record<string, string> = {};
		for (const [key, typeId, config] of [
			["prompt", "builtin/text", { text: "wired image prompt" }],
			["negative", "builtin/text", { text: "wired image negative prompt" }],
			["imageCount", "builtin/number", { value: 2 }],
			["image", "builtin/text-to-image", { provider, model: "fixture-image", prompt: "fallback" }],
			["videoNegative", "builtin/text", { text: "wired video negative prompt" }],
			["videoSize", "builtin/size", { value: { width: 640, height: 360 } }],
			["video", "builtin/image-to-video", { provider, model: "fixture-video", prompt: "animate the source" }],
			["output", "builtin/media-output", {}],
		] as Array<[string, string, Record<string, unknown>]>) {
			const before = new Set(snapshot.nodes.map(node => node.nodeId));
			snapshot = await createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, typeId, x: 0, y: 0, config });
			nodes[key] = snapshot.nodes.find(node => !before.has(node.nodeId))!.nodeId;
		}
		for (const [sourceNodeId, sourcePort, targetNodeId, targetPort, dataType] of [
			[nodes.prompt!, "output", nodes.image!, "prompt", "text"],
			[nodes.negative!, "output", nodes.image!, "negativePrompt", "text"],
			[nodes.imageCount!, "value", nodes.image!, "count", "number"],
			[nodes.image!, "image", nodes.video!, "image", "image"],
			[nodes.videoNegative!, "output", nodes.video!, "negativePrompt", "text"],
			[nodes.videoSize!, "value", nodes.video!, "size", "size"],
			[nodes.video!, "video", nodes.output!, "input", "video"],
		] as const) {
			snapshot = await createFlowEdgeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, sourceNodeId, sourcePort, targetNodeId, targetPort, dataType });
		}
		const run = await startFlowRunDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, mcpHost: {} as McpHost });
		assert.equal(run.status, "completed", JSON.stringify(run.nodes));
		assert.deepEqual(mediaRequests.map(({ kind, prompt, negativePrompt, width, height, durationMs, count }) => ({ kind, prompt, negativePrompt, width, height, durationMs, count })), [
			{ kind: "imageGeneration", prompt: "wired image prompt", negativePrompt: "wired image negative prompt", width: undefined, height: undefined, durationMs: undefined, count: 2 },
			{ kind: "videoGeneration", prompt: "animate the source", negativePrompt: "wired video negative prompt", width: 640, height: 360, durationMs: 5_000, count: 1 },
		]);
		const imageOutput = run.nodes.find(node => node.nodeId === nodes.image)!.output as { image: { artifactId: string } };
		const videoOutput = run.nodes.find(node => node.nodeId === nodes.video)!.output as { video: { artifactId: string } };
		const imageArtifact = await getFlowArtifact(imageOutput.image.artifactId);
		const videoArtifact = await getFlowArtifact(videoOutput.video.artifactId);
		const imageProvenance = imageArtifact.ref.metadata.provenance as Record<string, unknown>;
		assert.equal(imageProvenance.kind, "ai-generation");
		assert.equal(imageProvenance.generationType, "imageGeneration");
		assert.equal(imageProvenance.provider, provider);
		assert.equal(imageProvenance.model, "fixture-image");
		assert.equal(imageProvenance.prompt, "wired image prompt");
		assert.deepEqual(imageProvenance.inputArtifactIds, []);
		const videoProvenance = videoArtifact.ref.metadata.provenance as Record<string, unknown>;
		assert.equal(videoProvenance.generationType, "videoGeneration");
		assert.equal(videoProvenance.prompt, "animate the source");
		assert.deepEqual(videoProvenance.inputArtifactIds, [imageOutput.image.artifactId]);
		assert.equal((videoProvenance.request as Record<string, unknown>).width, 640);
		assert.equal((videoProvenance.request as Record<string, unknown>).height, 360);
		const generated = await listFlowGeneratedArtifacts(snapshot.flow.flowId, 1);
		assert.equal(generated.total, 2);
		assert.equal(generated.artifacts.length, 1);
		assert.equal(generated.artifacts[0]!.artifactId, videoOutput.video.artifactId);
		const database = await getSessionDatabase();
		database.prepare("UPDATE flow_artifacts SET metadata_json = '{}' WHERE artifact_id = ?").run(videoOutput.video.artifactId);
		const legacyVideo = await listFlowGeneratedArtifacts(snapshot.flow.flowId, 1);
		assert.equal(legacyVideo.total, 2);
		assert.equal(legacyVideo.artifacts[0]!.artifactId, videoOutput.video.artifactId);
		const inferredProvenance = legacyVideo.artifacts[0]!.metadata.provenance as Record<string, unknown>;
		assert.equal(inferredProvenance.generationType, "videoGeneration");
		assert.equal(inferredProvenance.provider, provider);
		assert.equal(inferredProvenance.model, "fixture-video");
	} finally {
		unregisterMediaGenerationAdapter(provider);
		await resetSessionDatabaseForTests();
		if (previousProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousProfile;
		await rm(directory, { recursive: true, force: true });
	}
});

test("connected media parameters are schema-validated before calling the provider", async () => {
	const directory = await mkdtemp(join(tmpdir(), "flow-connected-parameter-validation-"));
	const previousProfile = process.env.USERPROFILE;
	process.env.USERPROFILE = directory;
	await resetSessionDatabaseForTests(join(directory, "sessions.sqlite"));
	const provider = "fixture-connected-parameter-validation";
	let calls = 0;
	registerMediaGenerationAdapter({
		provider,
		supports: ["videoGeneration"],
		generate: async request => {
			calls += 1;
			return { status: "completed", provider, model: request.model, artifacts: [{ bytes: Buffer.from("video"), mimeType: "video/mp4", width: 64, height: 64 }] };
		},
	});
	try {
		let snapshot = await createFlowDocument({ title: "Invalid connected parameter" });
		const nodes: Record<string, string> = {};
		for (const [key, typeId, config] of [
			["size", "builtin/size", { value: { width: 9_000, height: 720 } }],
			["video", "builtin/text-to-video", { provider, model: "fixture-video", prompt: "test" }],
		] as Array<[string, string, Record<string, unknown>]>) {
			const before = new Set(snapshot.nodes.map(node => node.nodeId));
			snapshot = await createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, typeId, x: 0, y: 0, config });
			nodes[key] = snapshot.nodes.find(node => !before.has(node.nodeId))!.nodeId;
		}
		snapshot = await createFlowEdgeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, sourceNodeId: nodes.size!, sourcePort: "value", targetNodeId: nodes.video!, targetPort: "size", dataType: "size" });
		const run = await startFlowRunDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, mcpHost: {} as McpHost });
		assert.equal(run.status, "failed");
		assert.equal(calls, 0, "invalid connected values must be rejected before a provider request");
		assert.match(run.nodes.find(node => node.nodeId === nodes.video)?.error ?? "", /Too big|less than or equal to/i);
	} finally {
		unregisterMediaGenerationAdapter(provider);
		await resetSessionDatabaseForTests();
		if (previousProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousProfile;
		await rm(directory, { recursive: true, force: true });
	}
});

test("connected provider and model parameters reject a mismatched catalog pair", async () => {
	const directory = await mkdtemp(join(tmpdir(), "flow-connected-model-validation-"));
	const previousProfile = process.env.USERPROFILE;
	process.env.USERPROFILE = directory;
	await resetSessionDatabaseForTests(join(directory, "sessions.sqlite"));
	try {
		let snapshot = await createFlowDocument({ title: "Connected provider/model validation" });
		const nodes: Record<string, string> = {};
		for (const [key, typeId, config] of [
			["provider", "builtin/provider", { provider: "openai" }],
			["model", "builtin/model", { provider: "dashscope", model: "wan3.0-video" }],
			["video", "builtin/text-to-video", { provider: "dashscope", model: "wan3.0-video", prompt: "test" }],
		] as Array<[string, string, Record<string, unknown>]>) {
			const before = new Set(snapshot.nodes.map(node => node.nodeId));
			snapshot = await createFlowNodeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, typeId, x: 0, y: 0, config });
			nodes[key] = snapshot.nodes.find(node => !before.has(node.nodeId))!.nodeId;
		}
		snapshot = await createFlowEdgeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, sourceNodeId: nodes.provider!, sourcePort: "provider", targetNodeId: nodes.video!, targetPort: "provider", dataType: "text" });
		snapshot = await createFlowEdgeDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, sourceNodeId: nodes.model!, sourcePort: "model", targetNodeId: nodes.video!, targetPort: "model", dataType: "text" });
		const run = await startFlowRunDocument({ flowId: snapshot.flow.flowId, revision: snapshot.flow.graphRevision, mcpHost: {} as McpHost });
		assert.equal(run.status, "failed");
		assert.match(run.nodes.find(node => node.nodeId === nodes.video)?.error ?? "", /not available for provider openai/i);
	} finally {
		await resetSessionDatabaseForTests();
		if (previousProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousProfile;
		await rm(directory, { recursive: true, force: true });
	}
});
