import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

test("latest completed turn model is used when session metadata is stale", async (): Promise<void> => {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const appDataDir: string = await fs.mkdtemp(path.join(os.tmpdir(), "godot-daedalus-model-transition-"));
	process.env.USERPROFILE = appDataDir;
	try {
		const store = await import(`../../../src/session/session-store.js?model-transition=${Date.now()}-${Math.random()}`);
		const transitions = await import(`../../../src/session/session-model-transition.js?model-transition=${Date.now()}-${Math.random()}`);
		const metadata = await store.createSession("Model transition", "workspace-a", undefined, undefined, {
			provider: "deepseek",
			model: "deepseek-v4-pro",
		});
		await store.appendSessionEvent(metadata.id, "request-1", "agent.message.done", {
			context: {
				modelRef: {
					provider: "mimo",
					model: "mimo-v2.5",
				},
			},
		});

		assert.deepEqual(await transitions.readLatestSessionModelRef(metadata.id), {
			provider: "mimo",
			model: "mimo-v2.5",
		});
	} finally {
		const { resetSessionDatabaseForTests } = await import("../../../src/session/session-database.js");
		await resetSessionDatabaseForTests();
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		await fs.rm(appDataDir, { recursive: true, force: true });
	}
});
