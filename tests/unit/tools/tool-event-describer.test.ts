import assert from "node:assert/strict";
import test from "node:test";
import { describeToolEvent } from "../../../src/tools/tool-event-describer.js";

test("raw terminal commands use the model-provided purpose as their visible summary", (): void => {
	const display = describeToolEvent("mcp_terminal_run_command", {
		commandLine: "godot --headless --path . --check-only --quit",
		reason: "运行临时无头 playtest 脚本，验证游戏核心机制在真实运行实例中是否可玩"
	});

	assert.equal(display.summary, "运行临时无头 playtest 脚本，验证游戏核心机制在真实运行实例中是否可玩");
	assert.equal(display.target.label, "godot --headless --path . --check-only --quit");
});
