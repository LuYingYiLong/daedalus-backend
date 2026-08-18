import test from "node:test";
import assert from "node:assert/strict";
import { additionalContextItemSchema } from "../../../src/protocol/schema.js";

function createWebElementContext(): Record<string, unknown> {
	return {
		id: "web-element-1",
		kind: "web_element",
		title: "Submit",
		source: "manual",
		data: {
			url: "https://example.com/form",
			pageTitle: "Example form",
			selector: "#submit",
			tagName: "BUTTON",
			role: "button",
			accessibleName: "Submit",
			selectedText: "Submit",
			attributes: { id: "submit", type: "submit" },
			annotation: "Check what this action submits"
		}
	};
}

test("web element context accepts bounded HTTP page metadata", () => {
	assert.equal(additionalContextItemSchema.safeParse(createWebElementContext()).success, true);
});

test("web element context rejects pinning, unsafe URLs, and oversized content", () => {
	const pinned = createWebElementContext();
	pinned.pinned = true;
	assert.equal(additionalContextItemSchema.safeParse(pinned).success, false);

	const unsafe = createWebElementContext();
	(unsafe.data as Record<string, unknown>).url = "javascript:alert(1)";
	assert.equal(additionalContextItemSchema.safeParse(unsafe).success, false);

	const oversized = createWebElementContext();
	(oversized.data as Record<string, unknown>).selectedText = "x".repeat(8001);
	assert.equal(additionalContextItemSchema.safeParse(oversized).success, false);
});
