import assert from "node:assert/strict";
import test from "node:test";
import { createGodotDocumentationPromptSection } from "../../../src/prompts/godot-documentation.js";
import type { GodotDocumentationSettings } from "../../../src/godot-documentation/types.js";

function createSettings(enabled: boolean): GodotDocumentationSettings {
	return {
		schemaVersion: 1,
		enabled,
		documents: {
			"godot-docs-47": {
				id: "godot-docs-47",
				branch: "4.7",
				commitSha: "0585d03bea24497cf91f0969c81a187c892371c4",
				source: "official",
				installedAt: "2026-07-30T00:00:00.000Z",
				updatedAt: "2026-07-30T00:00:00.000Z",
				documentCount: 1591,
				chunkCount: 34613,
				classCount: 1078,
				sizeBytes: 33259520
			}
		}
	};
}

test("Godot documentation prompt requires a real tool result before claiming a lookup", (): void => {
	const prompt: string = createGodotDocumentationPromptSection(createSettings(true));

	assert.match(prompt, /4\.7/);
	assert.match(prompt, /0585d03bea24/);
	assert.match(prompt, /必须通过 API `tool_calls` 调用 `mcp_godot_search_documentation`/);
	assert.match(prompt, /只有本轮收到成功的文档工具结果后/);
	assert.match(prompt, /没有工具结果、查询失败或没有命中时必须如实说明/);
	assert.match(prompt, /不要补造结果中没有的成员、签名或引擎行为/);
	assert.match(prompt, /<tools>/);
});

test("Godot documentation prompt is omitted when the feature is disabled", (): void => {
	assert.equal(createGodotDocumentationPromptSection(createSettings(false)), "");
});
