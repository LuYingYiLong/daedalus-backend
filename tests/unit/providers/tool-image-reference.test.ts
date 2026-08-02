import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	hydrateToolImageReference,
	resolveImageInspection
} from "../../../src/providers/tool-image-reference.js";
import { createRuntimeWorkspace, deleteWorkspace } from "../../../src/workspace/registry.js";
import {
	injectToolImagesIntoAnthropicMessages,
	injectToolImagesIntoChatMessages,
	injectToolImagesIntoResponseInput
} from "../../../src/providers/provider-tool-image-content.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ResponseInputItem } from "openai/resources/responses/responses";

const ONE_PIXEL_PNG: Buffer = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlDkAAAAASUVORK5CYII=",
	"base64"
);

test("workspace image inspection resolves res:// safely and revalidates its hash", async (): Promise<void> => {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-image-inspect-"));
	await writeFile(join(root, "project.godot"), "[application]\nconfig/name=\"Image test\"\n", "utf8");
	await mkdir(join(root, "assets"), { recursive: true });
	await writeFile(join(root, "assets", "pixel.png"), ONE_PIXEL_PNG);
	const workspace = createRuntimeWorkspace(root);
	const previousProjectPath: string | undefined = process.env.GODOT_PROJECT_PATH;
	process.env.GODOT_PROJECT_PATH = root;
	try {
		const inspection = await resolveImageInspection({
			source: "workspace",
			relativePath: "res://assets/pixel.png",
			question: "What color is visible?"
		}, { workspaceId: workspace.id });
		assert.equal(inspection.reference.mimeType, "image/png");
		assert.equal(inspection.reference.byteSize, ONE_PIXEL_PNG.byteLength);
		assert.equal(inspection.reference.question, "What color is visible?");
		assert.match(inspection.reference.sha256, /^[a-f0-9]{64}$/u);

		const hydrated = await hydrateToolImageReference(inspection.reference);
		assert.match(hydrated.dataUrl, /^data:image\/png;base64,/u);

		await writeFile(join(root, "assets", "pixel.png"), Buffer.concat([ONE_PIXEL_PNG, Buffer.from([0])]));
		await assert.rejects(
			hydrateToolImageReference(inspection.reference),
			/image_reference_conflict/u
		);
	} finally {
		deleteWorkspace(workspace.id);
		if (previousProjectPath === undefined) {
			delete process.env.GODOT_PROJECT_PATH;
		} else {
			process.env.GODOT_PROJECT_PATH = previousProjectPath;
		}
		await rm(root, { recursive: true, force: true });
	}
});

test("workspace image inspection accepts an ordinary multi-megabyte texture atlas", async (): Promise<void> => {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-image-inspect-atlas-"));
	await writeFile(join(root, "project.godot"), "[application]\nconfig/name=\"Atlas test\"\n", "utf8");
	await mkdir(join(root, "assets"), { recursive: true });
	const atlasBytes: Buffer = Buffer.alloc(3 * 1024 * 1024);
	ONE_PIXEL_PNG.copy(atlasBytes);
	await writeFile(join(root, "assets", "tiles_atlas.png"), atlasBytes);
	const workspace = createRuntimeWorkspace(root);
	const previousProjectPath: string | undefined = process.env.GODOT_PROJECT_PATH;
	process.env.GODOT_PROJECT_PATH = root;
	try {
		const inspection = await resolveImageInspection({
			source: "workspace",
			relativePath: "res://assets/tiles_atlas.png"
		}, { workspaceId: workspace.id });
		assert.equal(inspection.reference.byteSize, atlasBytes.byteLength);
		assert.equal(inspection.reference.mimeType, "image/png");
	} finally {
		deleteWorkspace(workspace.id);
		if (previousProjectPath === undefined) delete process.env.GODOT_PROJECT_PATH;
		else process.env.GODOT_PROJECT_PATH = previousProjectPath;
		await rm(root, { recursive: true, force: true });
	}
});

test("workspace image inspection rejects Godot internals and forged image extensions", async (): Promise<void> => {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-image-inspect-deny-"));
	await writeFile(join(root, "project.godot"), "[application]\n", "utf8");
	await mkdir(join(root, ".godot"), { recursive: true });
	await writeFile(join(root, ".godot", "hidden.png"), ONE_PIXEL_PNG);
	await writeFile(join(root, "fake.png"), "not an image", "utf8");
	const workspace = createRuntimeWorkspace(root);
	const previousProjectPath: string | undefined = process.env.GODOT_PROJECT_PATH;
	process.env.GODOT_PROJECT_PATH = root;
	try {
		await assert.rejects(
			resolveImageInspection({ source: "workspace", relativePath: "res://.godot/hidden.png" }, { workspaceId: workspace.id }),
			/\.godot/u
		);
		await assert.rejects(
			resolveImageInspection({ source: "workspace", relativePath: "res://.Godot/hidden.png" }, { workspaceId: workspace.id }),
			/\.godot/iu
		);
		await assert.rejects(
			resolveImageInspection({ source: "workspace", relativePath: "fake.png" }, { workspaceId: workspace.id }),
			/file signature/u
		);
		await assert.rejects(
			resolveImageInspection({ source: "workspace", relativePath: "https://example.com/image.png" }, { workspaceId: workspace.id }),
			/URLs/u
		);
	} finally {
		deleteWorkspace(workspace.id);
		if (previousProjectPath === undefined) {
			delete process.env.GODOT_PROJECT_PATH;
		} else {
			process.env.GODOT_PROJECT_PATH = previousProjectPath;
		}
		await rm(root, { recursive: true, force: true });
	}
});

test("provider request builders hydrate image bytes only after matching tool results", async (): Promise<void> => {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-image-provider-"));
	await writeFile(join(root, "project.godot"), "[application]\n", "utf8");
	await writeFile(join(root, "pixel.png"), ONE_PIXEL_PNG);
	const workspace = createRuntimeWorkspace(root);
	const previousProjectPath: string | undefined = process.env.GODOT_PROJECT_PATH;
	process.env.GODOT_PROJECT_PATH = root;
	try {
		const inspection = await resolveImageInspection(
			{ source: "workspace", relativePath: "res://pixel.png", question: "Inspect the pixel." },
			{ workspaceId: workspace.id }
		);
		const reference = { ...inspection.reference, toolCallId: "call-image" };
		assert.equal(JSON.stringify(reference).includes("base64"), false);

		const chatMessages: ChatCompletionMessageParam[] = await injectToolImagesIntoChatMessages([
			{ role: "assistant", content: null, tool_calls: [{ id: "call-image", type: "function", function: { name: "mcp_image_inspect", arguments: "{}" } }] },
			{ role: "tool", tool_call_id: "call-image", content: "{\"ok\":true}" }
		], [reference]);
		assert.equal(chatMessages[1]?.role, "tool");
		assert.equal(chatMessages[2]?.role, "user");
		assert.match(JSON.stringify(chatMessages[2]), /data:image\/png;base64/u);

		const responseItems = await injectToolImagesIntoResponseInput([{
			type: "function_call_output",
			call_id: "call-image",
			output: "{\"ok\":true}"
		} as ResponseInputItem], [reference]);
		assert.equal((responseItems[0] as { type?: string }).type, "function_call_output");
		assert.match(JSON.stringify(responseItems[1]), /input_image/u);

		const anthropicMessages = await injectToolImagesIntoAnthropicMessages([{
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "call-image", content: "{\"ok\":true}" }]
		}], [reference]);
		const anthropicJson: string = JSON.stringify(anthropicMessages[0]);
		assert.ok(anthropicJson.indexOf("tool_result") < anthropicJson.indexOf("\"image\""));
		assert.match(anthropicJson, /base64/u);
	} finally {
		deleteWorkspace(workspace.id);
		if (previousProjectPath === undefined) {
			delete process.env.GODOT_PROJECT_PATH;
		} else {
			process.env.GODOT_PROJECT_PATH = previousProjectPath;
		}
		await rm(root, { recursive: true, force: true });
	}
});
