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
import { createToolContextBlock, listContextBlocks, upsertContextBlock } from "../../../src/context/context-ledger.js";

const STRUCTURED_SUMMARY_JSON: string = JSON.stringify({
	userGoals: ["Continue the completed requests"],
	constraints: [],
	decisions: [],
	workspaceFacts: ["Two requests were completed"],
	changedFiles: [],
	verification: [],
	unresolvedFailures: [],
	pendingApprovals: [],
	openQuestions: [],
	nextActions: []
});

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
				return STRUCTURED_SUMMARY_JSON;
			}
		});

		assert.equal(result.compressed, true);
		assert.equal(result.oldMessageCount, 4);
		assert.equal(result.keptMessageCount, 2);
		assert.equal(result.source, "llm_retry");
		assert.equal(result.level, "capture");
		assert.equal(result.generation, 1);
		assert.equal(result.restorableBlockCount, 4);
		assert.equal(callCount, 2);
		assert.match(retryPrompt, /previous response was empty or invalid/i);
		assert.match((await readSummary(metadata.id))?.content ?? "", /Daedalus 可恢复上下文摘要/u);
		assert.equal((await listContextBlocks(metadata.id)).filter((block): boolean => block.level === "raw").length, 4);
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
		assert.match((await readSummary(metadata.id))?.content ?? "", /低优先级历史事实/u);
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

test("session compression retains original blocks when the structured quality gate fails", async (): Promise<void> => {
	const tempDirectory: string = await fs.mkdtemp(path.join(os.tmpdir(), "godot-daedalus-session-compression-"));
	await resetSessionDatabaseForTests(path.join(tempDirectory, "sessions.sqlite"));
	try {
		const metadata = await createSession("Compression quality gate test");
		const session = createClientSession(undefined);
		session.sessionId = metadata.id;
		const block = createToolContextBlock({
			sessionId: metadata.id,
			toolCallId: "write-a",
			content: "changed src/App.tsx",
			tokenEstimate: 8,
			fileRefs: [{ workspaceId: "workspace-a", sourceFolderId: "frontend", relativePath: "src/App.tsx" }]
		});
		await upsertContextBlock(block);

		const result = await compressSessionHistory(session, "test-key", 2, "compression-quality-gate", {
			blockIds: [block.blockId],
			chat: async (): Promise<string> => STRUCTURED_SUMMARY_JSON
		});

		assert.equal(result.compressed, false);
		assert.equal(result.warning, "structured_file_refs_missing");
		assert.equal((await listContextBlocks(metadata.id, false)).some((item): boolean => item.blockId === block.blockId), true);
		assert.equal(await readSummary(metadata.id), null);
	} finally {
		await resetSessionDatabaseForTests();
		await fs.rm(tempDirectory, { recursive: true, force: true });
	}
});
