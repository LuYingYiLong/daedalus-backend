import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClientSession } from "../../../src/server/client-session.js";
import { createSessionContextControl } from "../../../src/server/context-control-runtime.js";
import { createToolContextBlock, listContextBlocks, upsertContextBlock } from "../../../src/context/context-ledger.js";
import { createSession } from "../../../src/session/session-store.js";
import { resetSessionDatabaseForTests } from "../../../src/session/session-database.js";
import { CONTEXT_RETRIEVE_TOOL_NAME, CONTEXT_SEARCH_TOOL_NAME } from "../../../src/tools/context-control.js";
import { serializeToolFailure } from "../../../src/tools/tool-failure.js";

test("context search and retrieve stay scoped to the active session", async (): Promise<void> => {
	const tempDirectory: string = await fs.mkdtemp(path.join(os.tmpdir(), "daedalus-context-control-"));
	await resetSessionDatabaseForTests(path.join(tempDirectory, "sessions.sqlite"));
	try {
		const first = await createSession("First");
		const second = await createSession("Second");
		await upsertContextBlock(createToolContextBlock({
			sessionId: first.id,
			requestId: "request-first",
			toolCallId: "call-first",
			content: "private first session evidence",
			tokenEstimate: 8
		}));
		await upsertContextBlock(createToolContextBlock({
			sessionId: second.id,
			requestId: "request-second",
			toolCallId: "call-second",
			content: "private second session evidence",
			tokenEstimate: 8
		}));
		const session = createClientSession(undefined);
		session.sessionId = first.id;
		const control = createSessionContextControl({ session, apiKey: "test", requestId: "request" });
		const search = await control.execute(CONTEXT_SEARCH_TOOL_NAME, { query: "private" });
		assert.equal((search.results as unknown[]).length, 1);
		const retrieve = await control.execute(CONTEXT_RETRIEVE_TOOL_NAME, {
			blockIds: [`tool:${first.id}:missing`, "tool:request-second:call-second", "tool:request-first:call-first"]
		});
		const results = retrieve.results as Array<{ blockId: string }>;
		assert.deepEqual(results.map((result): string => result.blockId), ["tool:request-first:call-first"]);
	} finally {
		await resetSessionDatabaseForTests();
		await fs.rm(tempDirectory, { recursive: true, force: true });
	}
});

test("tool failures retain structured codes, source refs, and terminal identity", async (): Promise<void> => {
	const tempDirectory: string = await fs.mkdtemp(path.join(os.tmpdir(), "daedalus-context-control-"));
	await resetSessionDatabaseForTests(path.join(tempDirectory, "sessions.sqlite"));
	try {
		const metadata = await createSession("Failure ledger");
		const session = createClientSession(undefined);
		session.sessionId = metadata.id;
		const control = createSessionContextControl({ session, apiKey: "test", requestId: "request-failure" });
		await control.recordToolResult?.({
			toolCallId: "terminal-failure",
			toolName: "mcp_terminal_run_command",
			args: {},
			content: serializeToolFailure({
				code: "target_not_found",
				category: "business",
				message: "Target file is missing",
				retryable: true,
				artifactRefs: [],
				artifactFileRefs: [{ workspaceId: "workspace-a", sourceFolderId: "backend", relativePath: "src/missing.ts" }]
			})
		});

		const blocks = await listContextBlocks(metadata.id, false);
		assert.equal(blocks[0]?.kind, "terminal");
		assert.equal(blocks[0]?.summary?.unresolvedFailures[0]?.code, "target_not_found");
		assert.equal(blocks[0]?.fileRefs[0]?.sourceFolderId, "backend");
		const search = await control.execute(CONTEXT_SEARCH_TOOL_NAME, { query: "target_not_found" });
		assert.equal((search.results as unknown[]).length, 1);
	} finally {
		await resetSessionDatabaseForTests();
		await fs.rm(tempDirectory, { recursive: true, force: true });
	}
});
