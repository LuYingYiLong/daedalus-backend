import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createClientSession } from "../../../src/server/client-session.js";

async function withTempAppData(run: () => Promise<void>): Promise<void> {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	process.env.USERPROFILE = await mkdtemp(join(tmpdir(), "daedalus-scene-view-"));
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

test("scene view enrich stores the image and hides base64 when vision is unavailable", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		const sessions = await import("../../../src/session/session-store.js");
		const { createSceneViewToolResultEnricher } = await import("../../../src/server/workflow/scene-view-enricher.js");
		const metadata = await sessions.createSession("Scene view");
		const session = createClientSession(undefined);
		session.sessionId = metadata.id;
		const sceneView = createSceneViewToolResultEnricher({
			session,
			options: { provider: "deepseek", apiKey: "test-key", model: "deepseek-v4-flash" },
			phaseInstruction: "检查场景布局"
		});
		const imageBytes: Buffer = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlDkAAAAASUVORK5CYII=", "base64");

		const progressCodes: string[] = [];
		const result = await sceneView.enricher({
			toolName: "mcp_godot_editor_capture_scene_view",
			args: {},
			onProgress: (progress): void => {
				progressCodes.push(progress.code);
			},
			result: {
				content: JSON.stringify({
					ok: true,
					result: {
						ok: true,
						view: "2d",
						mimeType: "image/png",
						dataUrl: `data:image/png;base64,${imageBytes.toString("base64")}`,
						byteSize: imageBytes.byteLength,
						width: 32,
						height: 24
					}
				}),
				rawContentLength: 0,
				truncated: false,
				reused: false
			}
		});

		assert.equal(result.content.includes(imageBytes.toString("base64")), false);
		const payload = JSON.parse(result.content) as Record<string, unknown>;
		assert.equal((payload.analysis as Record<string, unknown>).status, "unavailable");
		assert.equal(sceneView.getCapturedAttachments()[0]?.source, "editor");
		assert.deepEqual(progressCodes, [
			"scene_view.capture.started",
			"scene_view.capture.completed",
			"image.inspect.delegating",
			"image.inspect.unavailable"
		]);
	});
});
