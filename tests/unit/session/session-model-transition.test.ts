import assert from "node:assert/strict";
import test from "node:test";
import { hasSessionUserTurn } from "../../../src/session/session-model-transition.js";

test("a model selected before the first user turn establishes the session baseline", (): void => {
	assert.equal(hasSessionUserTurn([]), false);
	assert.equal(hasSessionUserTurn([{ role: "assistant" }]), false);
});

test("a model selected after a user turn can create a timeline transition", (): void => {
	assert.equal(hasSessionUserTurn([
		{ role: "user" },
		{ role: "assistant" },
	]), true);
});
