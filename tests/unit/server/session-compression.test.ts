import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ChatMessage } from "../../../src/protocol/types.js";
import { ProviderEmptyResponseError } from "../../../src/providers/provider-response-error.js";
import { createClientSession } from "../../../src/server/client-session.js";
import { compressSessionHistory } from "../../../src/server/session-compression.js";
import { createSession, readSummary } from "../../../src/session/session-store.js";
import { resetSessionDatabaseForTests } from "../../../src/session/session-database.js";

function createHistory(): ChatMessage[] {
	return [
		{ role: "user", content: "First completed request" },
		{ role: "assistant", content: "First completed result" },
		{ role: "user", content: "Second completed request" },
		{ role: "assistant", content: "Second completed result" },
		{ role: "user", content: "Most recent request" },
		{ role: "assistant", content: "Most recent result" }
	];
}

test("session compression retries an empty provider response without enabling reasoning", async (): Promise<void> => {
	const tempDirectory: string = await fs.mkdtemp(path.join(os.tmpdir(), "godot-daedalus-session-compression-"));
	const databasePath: string = path.join(tempDirectory, "sessions.sqlite");
	await resetSessionDatabaseForTests(databasePath);
	try {
		const metadata = await createSession("Compression test");
		const session = createClientSession(undefined);
		session.sessionId = metadata.id;
		session.messages = createHistory();
		let callCount: number = 0;
		let retryPrompt = "";

		const result = await compressSessionHistory(session, "test-key", 2, "compression-request", {
			chat: async (_params, options, _history, systemPrompt): Promise<string> => {
				callCount += 1;
				assert.equal(options.reasoningMode, "disabled");
				if (callCount === 1) {
					throw new ProviderEmptyResponseError({ reasoningChars: 123 });
				}
				retryPrompt = systemPrompt;
				return "- Compressed conversation state";
			}
		});

		assert.deepEqual(result, {
			compressed: true,
			oldMessageCount: 4,
			keptMessageCount: 2,
			summaryLength: 31,
			source: "llm_retry"
		});
		assert.equal(callCount, 2);
		assert.match(retryPrompt, /previous attempt returned no visible summary/i);
		assert.equal((await readSummary(metadata.id))?.content, "- Compressed conversation state");
	} finally {
		await resetSessionDatabaseForTests();
		await fs.rm(tempDirectory, { recursive: true, force: true });
	}
});

test("session compression creates a guarded local snapshot after repeated empty responses", async (): Promise<void> => {
	const tempDirectory: string = await fs.mkdtemp(path.join(os.tmpdir(), "godot-daedalus-session-compression-"));
	const databasePath: string = path.join(tempDirectory, "sessions.sqlite");
	const previousLogLevel: string | undefined = process.env.DAEDALUS_LOG_LEVEL;
	process.env.DAEDALUS_LOG_LEVEL = "error";
	await resetSessionDatabaseForTests(databasePath);
	try {
		const metadata = await createSession("Compression fallback test");
		const session = createClientSession(undefined);
		session.sessionId = metadata.id;
		session.messages = createHistory();

		const result = await compressSessionHistory(session, "test-key", 2, "compression-fallback", {
			chat: async (): Promise<string> => {
				throw new ProviderEmptyResponseError();
			}
		});

		assert.equal(result.compressed, true);
		assert.equal(result.source, "local_fallback");
		assert.match((await readSummary(metadata.id))?.content ?? "", /\u4e0d\u53ef\u4fe1\u7684\u5386\u53f2\u8bb0\u5f55\u6458\u5f55/u);
	} finally {
		await resetSessionDatabaseForTests();
		if (previousLogLevel === undefined) {
			delete process.env.DAEDALUS_LOG_LEVEL;
		} else {
			process.env.DAEDALUS_LOG_LEVEL = previousLogLevel;
		}
		await fs.rm(tempDirectory, { recursive: true, force: true });
	}
});
