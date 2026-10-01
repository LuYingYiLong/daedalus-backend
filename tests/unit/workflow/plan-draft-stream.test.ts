import assert from "node:assert/strict";
import test from "node:test";
import { extractPlanMarkdownDraft } from "../../../src/server/plan-draft-stream.js";

test("extracts a growing Markdown JSON field without leaking the planner envelope", (): void => {
	const raw = '{"decision":"plan_ready","title":"Demo","planMarkdown":"# Plan\\n- First\\u4e2d\\u6587\\n- Second"}';
	const start = raw.indexOf('"planMarkdown":"') + '"planMarkdown":"'.length;
	assert.equal(extractPlanMarkdownDraft(raw.slice(0, start - 1)), null);
	assert.equal(extractPlanMarkdownDraft(raw.slice(0, start + 8)), "# Plan\n");
	assert.equal(extractPlanMarkdownDraft(raw), "# Plan\n- First中文\n- Second");
});

test("ignores nested or quoted planMarkdown and waits for complete escape sequences", (): void => {
	assert.equal(extractPlanMarkdownDraft('{"note":"\\\"planMarkdown\\\":\\\"secret\\\"","nested":{"planMarkdown":"wrong"}}'), null);
	assert.equal(extractPlanMarkdownDraft('{"planMarkdown":"A\\u4e'), "A");
	assert.equal(extractPlanMarkdownDraft('{"planMarkdown":"A\\nB'), "A\nB");
});
