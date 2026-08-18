import assert from "node:assert/strict";
import test from "node:test";
import { parseHooksConfigText } from "../../../src/hooks/schema.js";

test("hooks schema accepts supported command lifecycle handlers", (): void => {
	const config = parseHooksConfigText(JSON.stringify({
		description: "Project checks",
		hooks: {
			PreToolUse: [{
				matcher: "^(apply_patch|mcp__.+)$",
				hooks: [{
					type: "command",
					command: "node validate.mjs",
					commandWindows: "node validate.mjs",
					timeout: 20,
					additionalContextLimit: 3000,
					async: false,
					failurePolicy: "block"
				}]
			}]
		}
	}));
	assert.equal(config.hooks.PreToolUse?.[0]?.hooks[0]?.failurePolicy, "block");
});

test("hooks schema rejects unsupported handlers, events, and invalid matchers", (): void => {
	assert.throws((): void => {
		parseHooksConfigText(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "prompt", prompt: "continue" }] }] } }));
	});
	assert.throws((): void => {
		parseHooksConfigText(JSON.stringify({ hooks: { UnknownEvent: [] } }));
	});
	assert.throws((): void => {
		parseHooksConfigText(JSON.stringify({ hooks: { PreToolUse: [{ matcher: "[", hooks: [{ type: "command", command: "node check.mjs" }] }] } }));
	}, /Invalid matcher regular expression/u);
});

test("hooks schema enforces command and timeout bounds", (): void => {
	assert.throws((): void => {
		parseHooksConfigText(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node check.mjs", timeout: 601 }] }] } }));
	});
	assert.throws((): void => {
		parseHooksConfigText(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "x".repeat(16_001) }] }] } }));
	});
});
