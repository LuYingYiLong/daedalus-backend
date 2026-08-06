import assert from "node:assert/strict";
import test from "node:test";
import {
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
