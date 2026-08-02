import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

test("isolated session search indexer builds a persistent projection", async (): Promise<void> => {
	const profile: string = await mkdtemp(join(tmpdir(), "daedalus-search-indexer-"));
	const previousProfile: string | undefined = process.env.USERPROFILE;
	process.env.USERPROFILE = profile;
	let child: ChildProcessWithoutNullStreams | null = null;
	const database = await import("../../../src/session/session-database.js");
	const cache = await import("../../../src/session-search/search-cache.js");
	try {
		const store = await import("../../../src/session/session-store.js");
		const session = await store.createSession("Indexer test");
		await store.appendMessage(session.id, { role: "user", requestId: "request-index", content: "search me" });
		await store.appendMessage(session.id, { role: "assistant", requestId: "request-index", content: "found" });
		const source = await store.readSessionSearchSourceState(session.id);
		const generation = await cache.beginSearchGeneration({
			sessionId: session.id,
			sourceRevision: source.revision,
			rebuildEpoch: source.rebuildEpoch,
			forceNew: true
		});
		await database.closeSessionDatabases();
		await cache.closeSearchCacheDatabase();

		child = spawn(process.execPath, [
			"--import",
			"tsx",
			resolve("src", "cli.ts"),
			"internal",
			"session-search-indexer"
		], {
			cwd: resolve("."),
			env: { ...process.env, USERPROFILE: profile, DAEDALUS_LOG_CONSOLE: "0" },
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true
		});
		let stderr: string = "";
		child.stderr.on("data", (chunk: Buffer): void => { stderr += chunk.toString("utf8"); });
		const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
		const completed = new Promise<Record<string, unknown>>((resolveCompleted, reject): void => {
			const timeout = setTimeout((): void => reject(new Error(`Indexer timed out. ${stderr}`)), 10_000);
			lines.on("line", (line: string): void => {
				const response = JSON.parse(line) as Record<string, unknown>;
				if (response.type !== "completed" && response.type !== "error") return;
				clearTimeout(timeout);
				resolveCompleted(response);
			});
		});
		child.stdin.write(`${JSON.stringify({
			id: "build-1",
			type: "build",
			sessionId: session.id,
			generationId: generation.generationId,
			reason: "test"
		})}\n`);
		const response = await completed;
		assert.equal(response.type, "completed", stderr);
		child.stdin.write(`${JSON.stringify({ id: "shutdown", type: "shutdown" })}\n`);
		await new Promise<void>((resolveExit): void => { child!.once("exit", (): void => resolveExit()); });

		const documents = await cache.readSearchDocumentsPage(generation.generationId, 0, 10);
		assert.equal(documents.some((document): boolean => document.markdownSegments.includes("search me")), true);
	} finally {
		if (child?.exitCode === null) child.kill();
		await database.closeSessionDatabases();
		await cache.closeSearchCacheDatabase();
		if (previousProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousProfile;
		await rm(profile, { recursive: true, force: true });
	}
});
