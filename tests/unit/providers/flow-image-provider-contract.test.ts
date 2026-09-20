import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateMedia } from "../../../src/providers/media-generation.js";
import { saveProviderConfig } from "../../../src/providers/provider-config-store.js";
import { createMockPng } from "../../../src/providers/mock-image.js";
import { installReadOnlySecretStore, resetSecretStoreDriver } from "../../helpers/secret-store.js";
import type { ImageGenerationArtifactSink } from "../../../src/providers/image-generation.js";

test("Flow image generation/editing uses the real adapter request contracts with an isolated HTTP fixture", async () => {
	const directory = await mkdtemp(join(tmpdir(), "flow-image-contract-"));
	const previous = process.env.USERPROFILE; process.env.USERPROFILE = directory;
	const image = createMockPng([30, 80, 120]);
	const requests: Array<{ url: string; body: string }> = [];
	let throttled = false;
	const server = createServer(async (request, response) => {
		if (request.url === "/result.png") { response.writeHead(200, { "content-type": "image/png" }); response.end(image); return; }
		let body = ""; for await (const part of request) body += String(part);
		requests.push({ url: request.url!, body });
		if (throttled) { response.writeHead(429, { "content-type": "application/json", "retry-after": "2" }); response.end(JSON.stringify({ error: { message: "fixture limit" }, code: "Throttling", message: "fixture limit" })); return; }
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify(request.url!.includes("multimodal") ? { output: { choices: [{ message: { content: [{ image: `http://${request.headers.host}/result.png` }] } }] } } : { data: [{ b64_json: image.toString("base64") }] }));
	});
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	const address = server.address(); assert.ok(address && typeof address !== "string");
	const baseUrl = `http://127.0.0.1:${address.port}`;
	const sink: ImageGenerationArtifactSink = { save: async input => ({ imageId: "captured", sessionId: "flow-only", mimeType: input.mimeType, byteSize: input.bytes.length, provider: input.provider, model: input.model, prompt: input.prompt, createdAt: new Date().toISOString(), fileName: "unused", storagePath: "" }) };
	installReadOnlySecretStore(async () => "fixture-key");
	try {
		for (const provider of ["dashscope", "openai"] as const) {
			const model = provider === "dashscope" ? "qwen-image-2.0-pro" : "gpt-image-1";
			await saveProviderConfig({ provider, model, apiKey: "fixture-key", baseUrl: `${baseUrl}${provider === "dashscope" ? "/compatible-mode" : ""}/v1` });
			for (const kind of ["imageGeneration", "imageEdit"] as const) {
				const result = await generateMedia({ kind, provider, model, prompt: "blue sky", negativePrompt: "noise", seed: 42, width: 1024, height: 1024, count: 1, ...(kind === "imageEdit" ? { sourceImages: [{ mimeType: "image/png", bytes: image }] } : {}) }, AbortSignal.timeout(10_000), sink);
				assert.deepEqual(result.artifacts[0]?.bytes, image);
				const sent = requests.at(-1)!;
				if (provider === "dashscope") {
					assert.equal(sent.url, "/api/v1/services/aigc/multimodal-generation/generation");
					const body = JSON.parse(sent.body);
					assert.equal(body.parameters.size, "1024*1024"); assert.equal(body.parameters.seed, 42); assert.equal(body.parameters.negative_prompt, "noise");
					assert.equal(body.input.messages[0].content.some((part: { image?: string }) => part.image?.startsWith("data:image/png;base64,")), kind === "imageEdit");
				} else {
					assert.equal(sent.url, kind === "imageEdit" ? "/v1/images/edits" : "/v1/images/generations");
					if (kind === "imageEdit") assert.match(sent.body, /filename="source-0.png"/);
				}
			}
			throttled = true; const count = requests.length;
			await assert.rejects(generateMedia({ kind: "imageGeneration", provider, model, prompt: "test" }, AbortSignal.timeout(10_000), sink), (error: unknown) => {
				const failure = error as { status: number; headers: Headers }; assert.equal(failure.status, 429); assert.equal(failure.headers.get("retry-after"), "2"); return true;
			});
			assert.equal(requests.length, count + 1, "The SDK must not silently resubmit paid requests"); throttled = false;
		}
	} finally {
		server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); resetSecretStoreDriver();
		if (previous === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previous;
		await rm(directory, { recursive: true, force: true });
	}
});
