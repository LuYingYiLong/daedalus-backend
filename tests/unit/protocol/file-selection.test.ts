import test from "node:test";
import assert from "node:assert/strict";
import { additionalContextItemSchema } from "../../../src/protocol/schema.js";

function createFileSelection(): Record<string, unknown> {
	return {
		id: "file-selection-1",
		kind: "file_selection",
		title: "player.gd",
		pinned: false,
		source: "manual",
		resourcePath: "res://scripts/player.gd",
		data: {
			selectedText: "func _ready() -> void:\n\tpass",
			annotation: "Check this lifecycle hook",
			lineStart: 10,
			lineEnd: 11,
			columnStart: 1,
			columnEnd: 6,
			workspaceId: "workspace-1",
			sourceFolderId: "primary",
			relativePath: "scripts/player.gd"
		}
	};
}

test("file selection context accepts a bounded unpinned source range", () => {
	const result = additionalContextItemSchema.safeParse(createFileSelection());
	assert.equal(result.success, true);
});

test("file selection context rejects pinning, oversized text, and reversed ranges", () => {
	const pinned = createFileSelection();
	pinned.pinned = true;
	assert.equal(additionalContextItemSchema.safeParse(pinned).success, false);

	const oversized = createFileSelection();
	(oversized.data as Record<string, unknown>).selectedText = "x".repeat(8001);
	assert.equal(additionalContextItemSchema.safeParse(oversized).success, false);

	const reversed = createFileSelection();
	(reversed.data as Record<string, unknown>).lineStart = 12;
	(reversed.data as Record<string, unknown>).lineEnd = 11;
	assert.equal(additionalContextItemSchema.safeParse(reversed).success, false);
});
