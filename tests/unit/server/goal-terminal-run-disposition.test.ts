import assert from "node:assert/strict";
import test from "node:test";
import { resolveGoalTerminalRunDisposition } from "../../../src/server/goal-controller.js";

test("a failed Goal run cannot be hidden by a pending pause request", (): void => {
	assert.equal(resolveGoalTerminalRunDisposition("pausing", "failed"), "fail");
});

test("an explicitly cancelled Goal run completes the pause request", (): void => {
	assert.equal(resolveGoalTerminalRunDisposition("pausing", "cancelled"), "pause");
});

test("a successful Goal run pauses at the requested safe boundary", (): void => {
	assert.equal(resolveGoalTerminalRunDisposition("pausing", "completed"), "pause");
});

test("an unexpected cancellation fails instead of becoming resumable", (): void => {
	assert.equal(resolveGoalTerminalRunDisposition("running", "cancelled"), "fail");
});
