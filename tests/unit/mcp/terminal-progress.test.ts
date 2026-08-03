import assert from "node:assert/strict";
import test from "node:test";
import {
	parseTerminalMcpProgress,
	serializeTerminalMcpProgress
} from "../../../src/mcp/terminal/progress.js";
import { createTerminalProgressReporter } from "../../../src/mcp/terminal/registration.js";

test("terminal progress round trips and sanitizes display text", (): void => {
	const message: string = serializeTerminalMcpProgress({
		version: 1,
		kind: "terminal_output",
		stream: "stderr",
		sequence: 4,
		text: "\u001b[31mAPI_KEY=secret-value\u001b[0m",
		omittedChars: 12
	});
	const parsed = parseTerminalMcpProgress({ progress: 4, message });

	assert.equal(parsed?.stream, "stderr");
	assert.equal(parsed?.sequence, 4);
	assert.equal(parsed?.omittedChars, 12);
	assert.equal(parsed?.text, "API_KEY=[REDACTED]");
});

test("terminal progress rejects malformed messages", (): void => {
	assert.equal(parseTerminalMcpProgress({ progress: 1, message: "not-json" }), null);
	assert.equal(parseTerminalMcpProgress({
		progress: 1,
		message: JSON.stringify({ version: 1, kind: "terminal_output", stream: "stdout", sequence: 0, text: "x", omittedChars: 0 })
	}), null);
});

test("terminal progress redacts secrets split across process chunks before notification", async (): Promise<void> => {
	const notifications: Array<{ params: { message: string } }> = [];
	const reporter = createTerminalProgressReporter({
		_meta: { progressToken: "terminal-test" },
		sendNotification: async (notification): Promise<void> => {
			notifications.push(notification);
		}
	});

	reporter.onOutput?.("stdout", "TOKEN=split-");
	reporter.onOutput?.("stdout", "secret\nready\n");
	await new Promise<void>((resolve) => setTimeout(resolve, 100));
	await reporter.close();

	assert.ok(notifications.length > 0);
	assert.doesNotMatch(notifications.map((notification): string => notification.params.message).join("\n"), /split-secret/);
	const parsed = parseTerminalMcpProgress({
		progress: 1,
		message: notifications[0]?.params.message
	});
	assert.match(parsed?.text ?? "", /TOKEN=\[REDACTED\]/);
	assert.match(parsed?.text ?? "", /ready/);
});
