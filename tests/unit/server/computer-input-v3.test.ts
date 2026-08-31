import assert from "node:assert/strict";
import { test } from "node:test";
import { computerActionSchema } from "../../../src/protocol/computer-observation.js";
import { redactTraceValue } from "../../../src/trace/trace-redactor.js";
import { COMPUTER_TOOL_DEFINITIONS } from "../../../src/tools/computer-tools.js";

test("UIA actions are explicit bounded node operations, not arbitrary patterns or handles", () => {
  for (const action of [
    { type: "text", text: "fixture" }, { type: "key", key: "Tab" },
    { type: "uia_invoke", nodeId: "node" }, { type: "uia_toggle", nodeId: "node" }, { type: "uia_select", nodeId: "node" },
    { type: "uia_set_value", nodeId: "node", value: "" },
    { type: "uia_scroll", nodeId: "node", axis: "horizontal", amount: "large_decrement" },
    { type: "uia_expand_collapse", nodeId: "node", state: "collapsed" },
  ]) assert.deepEqual(computerActionSchema.parse(action), action);
  for (const action of [
    { type: "click", x: 10, y: 10, count: 1 }, { type: "click", x: 10, y: 10, count: 2 },
    { type: "scroll", x: 10, y: 10, axis: "vertical", amount: -1 },
    { type: "uia_invoke", nodeId: "node", hwnd: 1 }, { type: "uia_set_focus", nodeId: "node" },
    { type: "uia_scroll", nodeId: "node", axis: "vertical", amount: 1 },
    { type: "uia_set_value", nodeId: "node", value: "x".repeat(4097) },
  ]) assert.equal(computerActionSchema.safeParse(action).success, false);
});
test("UIA replacement text is redacted in root, nested and provider JSON arguments", () => {
  const args = { observationId: "frame", action: { type: "uia_set_value", nodeId: "node", value: "private fixture text" } };
  for (const input of [args, { args }, { function: { name: "mcp_computer_action", arguments: JSON.stringify(args) } }]) {
    const result = redactTraceValue(input);
    assert.ok(!JSON.stringify(result.value).includes("private fixture text"));
    assert.ok(result.redactedFields.some(field => field.endsWith("action.value")));
  }
  assert.equal(args.action.value, "private fixture text");
});
test("tool only advertises UIA and keyboard, with no coordinate input or fallback", () => {
  const description = COMPUTER_TOOL_DEFINITIONS.find(tool => tool.type === "function" && tool.function.name === "mcp_computer_action");
  assert.ok(description?.type === "function");
  assert.match(description.function.description!, /Only UIA and the restricted keyboard channel/);
  assert.match(description.function.description!, /are unavailable/);
  assert.match(description.function.description!, /No system-mouse fallback/);
  const schema = JSON.stringify(description.function.parameters);
  assert.ok(!schema.includes('"const":"click"'));
  assert.ok(!schema.includes('"const":"scroll"'));
});
