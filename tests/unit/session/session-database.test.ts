import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function withTempProfile(run: (profile: string) => Promise<void>): Promise<void> {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const profile: string = await mkdtemp(join(tmpdir(), "daedalus-session-database-"));
	process.env.USERPROFILE = profile;
	try {
		await run(profile);
	} finally {
		const { resetSessionDatabaseForTests } = await import("../../../src/session/session-database.js");
		await resetSessionDatabaseForTests();
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		await rm(profile, { recursive: true, force: true });
	}
}

test("session database initializes canonical SQLite storage and ignores legacy files", async (): Promise<void> => {
	await withTempProfile(async (profile: string): Promise<void> => {
		const legacySessionDir: string = join(
			profile,
			".daedalus",
			"sessions",
			"session-20260723-legacy"
		);
		await mkdir(legacySessionDir, { recursive: true });
		await writeFile(
			join(legacySessionDir, "metadata.json"),
			JSON.stringify({
				id: "session-20260723-legacy",
				title: "Ignored legacy session"
			}),
			"utf8"
		);
		await writeFile(join(legacySessionDir, "messages.jsonl"), "{\"broken\":\n", "utf8");

		const { getSessionDatabase } = await import("../../../src/session/session-database.js");
		const db = await getSessionDatabase();
		const tables = db.prepare(`
			SELECT name
			FROM sqlite_master
			WHERE type = 'table'
			ORDER BY name
		`).all().map((row): string => String((row as Record<string, unknown>).name));

		for (const table of [
			"agent_run_continuations",
			"agent_runs",
			"attachments",
			"file_edit_batches",
			"messages",
			"plans",
			"schema_migrations",
			"session_events",
			"session_search_source_state",
			"selection_ask_messages",
			"selection_ask_threads",
			"sessions",
			"summaries"
		]) {
			assert.equal(tables.includes(table), true, `expected table ${table}`);
		}
		assert.equal(tables.includes("event_aliases"), false);
		assert.equal(tables.includes("legacy_imports"), false);
		assert.equal(tables.includes("migration_issues"), false);
		assert.equal(
			Number((db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number }).count),
			0
		);
		assert.equal(Number((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys), 1);
		assert.equal(Number((db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout), 5000);
		assert.equal(
			String((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode),
			"wal"
		);
		assert.equal(
			String((db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check),
			"ok"
		);
		assert.equal(Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version), 7);

		assert.equal(await exists(join(profile, ".daedalus", "migrations")), false);
		assert.equal(await exists(join(legacySessionDir, "metadata.json")), true);
		assert.equal(await exists(join(legacySessionDir, "messages.jsonl")), true);
	});
});
