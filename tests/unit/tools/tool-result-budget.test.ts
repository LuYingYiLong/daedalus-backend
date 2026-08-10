import assert from "node:assert/strict";
import test from "node:test";
import {
	compactToolResultEntries,
	createToolResultLimitFallback,
	createToolResultLimitReason,
	fitToolResultContent
} from "../../../src/providers/tool-result-budget.js";
import { getInitialToolResultCharLimit } from "../../../src/providers/agent-tool-budget.js";

test("tool result budget keeps small content unchanged", (): void => {
	const result = fitToolResultContent("short result", 100, 5000);

	assert.equal(result.content, "short result");
	assert.equal(result.chars, "short result".length);
	assert.equal(result.truncated, false);
	assert.equal(result.limitReached, false);
	assert.equal(result.reason, null);
});

test("tool result budget truncates content before cumulative limit", (): void => {
	const result = fitToolResultContent("x".repeat(9000), 3500, 6000);

	assert.equal(result.truncated, true);
	assert.equal(result.limitReached, true);
	assert.ok(result.content.length <= 500);
	assert.match(result.content, /工具结果已按累计预算截断/u);
	assert.equal(result.reason, createToolResultLimitReason(3500 + result.chars, 6000));
});

test("tool result budget uses a placeholder when no useful budget remains", (): void => {
	const result = fitToolResultContent("x".repeat(9000), 3900, 4000);

	assert.equal(result.truncated, true);
	assert.equal(result.limitReached, true);
	assert.match(result.content, /工具结果未展开/u);
	assert.equal(result.reason, createToolResultLimitReason(3900 + result.chars, 4000));
});

test("tool result limit fallback returns a usable final response", (): void => {
	const fallback = createToolResultLimitFallback("工具结果总量达到 48001 字符，上限为 48000 字符");

	assert.match(fallback, /读取范围已达到安全上限/u);
	assert.match(fallback, /工具结果总量达到 48001 字符/u);
});

test("tool context compaction preserves recent raw results and stable result identities", (): void => {
	const entries: Array<{ id: string; content: string }> = Array.from(
		{ length: 6 },
		(_value: unknown, index: number): { id: string; content: string } => ({
			id: `call-${index + 1}`,
			content: `${index + 1}: ${"x".repeat(2_000)}`
		})
	);

	const compacted = compactToolResultEntries(
		entries,
		(entry: { id: string; content: string }): string => entry.content,
		(entry: { id: string; content: string }, content: string): { id: string; content: string } => ({ ...entry, content })
	);

	assert.equal(compacted.compactedCount, 4);
	assert.deepEqual(compacted.entries.map((entry: { id: string; content: string }): string => entry.id), entries.map((entry: { id: string; content: string }): string => entry.id));
	assert.match(compacted.entries[0]!.content, /^\[\[daedalus_tool_context_compacted\]\]/u);
	assert.ok(compacted.entries[0]!.content.length <= 320);
	assert.equal(compacted.entries[4]!.content, entries[4]!.content);
	assert.equal(compacted.entries[5]!.content, entries[5]!.content);
});

test("tool context compaction does not rewrite a short recent-only result set", (): void => {
	const entries: Array<{ id: string; content: string }> = [
		{ id: "call-1", content: "one" },
		{ id: "call-2", content: "two" },
		{ id: "call-3", content: "three" }
	];
	const compacted = compactToolResultEntries(
		entries,
		(entry: { id: string; content: string }): string => entry.content,
		(entry: { id: string; content: string }, content: string): { id: string; content: string } => ({ ...entry, content })
	);

	assert.equal(compacted.compactedCount, 0);
	assert.deepEqual(compacted.entries, entries);
	assert.equal(compacted.totalChars, 11);
});

test("one oversized chat read cannot consume the entire final-answer budget", (): void => {
	const result = fitToolResultContent("x".repeat(40_000), 4_000, 48_000);

	assert.equal(result.truncated, true);
	assert.ok(result.chars <= 12_000);
	assert.equal(result.limitReached, false);
	assert.equal(result.reason, null);
});

test("chat output uses the bounded initial tool-result budget", (): void => {
	assert.equal(
		getInitialToolResultCharLimit({ message: "总结版本日志", options: { outputTarget: "chat" } }),
		48000
	);
	assert.equal(
		getInitialToolResultCharLimit({ message: "修改文件", options: { outputTarget: "workspace" } }),
		128000
	);
	assert.equal(getInitialToolResultCharLimit({ message: "旧客户端" }), 128000);
});
