import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installReadOnlySecretStore, resetSecretStoreDriver } from "../../helpers/secret-store.js";
import { listMediaGenerationAdapters, type MediaGenerationAdapter } from "../../../src/providers/media-generation.js";
import { saveProviderConfig } from "../../../src/providers/provider-config-store.js";

const GENERATED_MP4: Buffer = Buffer.from("generated-video", "utf8");

async function readRequestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	let text = "";
	for await (const chunk of request) text += String(chunk);
	return JSON.parse(text) as Record<string, unknown>;
}

async function withDashScopeVideoServer(run: (baseUrl: string, getCreateBody: () => Record<string, unknown> | undefined) => Promise<void>): Promise<void> {
	let createBody: Record<string, unknown> | undefined;
	const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		if (request.url === "/generated.mp4") {
			response.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": GENERATED_MP4.byteLength });
			response.end(GENERATED_MP4);
			return;
		}
		assert.equal(request.headers.authorization, "Bearer dashscope-video-key");
		if (request.url === "/api/v1/services/aigc/video-generation/video-synthesis") {
			assert.equal(request.method, "POST");
			assert.equal(request.headers["x-dashscope-async"], "enable");
			createBody = await readRequestBody(request);
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ output: { task_id: "video-task-1", task_status: "PENDING" } }));
			return;
		}
		if (request.url === "/api/v1/tasks/video-task-1") {
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({
				output: {
					task_id: "video-task-1",
					task_status: "SUCCEEDED",
					video_url: `http://${request.headers.host}/generated.mp4`,
				},
			}));
			return;
		}
		response.writeHead(404);
		response.end();
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Mock server did not expose a TCP port");
	try {
		await run(`http://127.0.0.1:${address.port}`, (): Record<string, unknown> | undefined => createBody);
	} finally {
		server.close();
		await once(server, "close");
	}
}

test("DashScope media adapter creates and resolves image-to-video tasks", async (): Promise<void> => {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	process.env.USERPROFILE = await mkdtemp(join(tmpdir(), "daedalus-dashscope-video-"));
	try {
		await withDashScopeVideoServer(async (baseUrl, getCreateBody): Promise<void> => {
			installReadOnlySecretStore(async (_service: string, account: string): Promise<string | null> => {
				return account === "provider:dashscope:api_key" ? "dashscope-video-key" : null;
			});
			await saveProviderConfig({
				provider: "dashscope",
				apiKey: "dashscope-video-key",
				baseUrl: `${baseUrl}/compatible-mode/v1`,
				model: "qwen3.8-max",
			});
			const adapter: MediaGenerationAdapter | undefined = listMediaGenerationAdapters().find((item): boolean => item.provider === "dashscope");
			assert.notEqual(adapter, undefined);
			assert.notEqual(adapter?.createTask, undefined);
			assert.notEqual(adapter?.getTask, undefined);
			const controller = new AbortController();
			await assert.rejects(
				adapter!.createTask!({
					kind: "videoGeneration",
					provider: "dashscope",
					model: "wan2.7-t2v",
					prompt: "不应接受图片输入",
					sourceImages: [{ mimeType: "image/png", bytes: Buffer.from("source-image", "utf8") }],
				}, controller.signal),
				/image-to-video generation/u,
			);
			const created = await adapter!.createTask!({
				kind: "videoGeneration",
				provider: "dashscope",
				model: "wan2.7-i2v",
				prompt: "让画面中的云缓慢移动",
				negativePrompt: "抖动",
				width: 1280,
				height: 720,
				durationMs: 5_000,
				fps: 30,
				seed: 42,
				sourceImages: [{ mimeType: "image/png", bytes: Buffer.from("source-image", "utf8") }],
			}, controller.signal);
			assert.equal(created.providerJobId, "video-task-1");
			assert.equal(created.status, "queued");
			assert.deepEqual(getCreateBody(), {
				model: "wan2.7-i2v",
				input: {
					prompt: "让画面中的云缓慢移动",
					negative_prompt: "抖动",
					media: [{ type: "first_frame", url: "data:image/png;base64,c291cmNlLWltYWdl" }],
				},
				parameters: {
					resolution: "720P",
					duration: 5,
					prompt_extend: true,
					watermark: false,
					seed: 42,
				},
			});
			const completed = await adapter!.getTask!(created.providerJobId, controller.signal);
			assert.equal(completed.status, "completed");
			assert.equal(completed.result?.provider, "dashscope");
			assert.equal(completed.result?.model, "wan2.7-i2v");
			assert.equal(completed.result?.artifacts[0]?.mimeType, "video/mp4");
			assert.deepEqual(completed.result?.artifacts[0]?.bytes, GENERATED_MP4);
		});
	} finally {
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
		resetSecretStoreDriver();
	}
});
