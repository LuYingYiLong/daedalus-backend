import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { COMPUTER_GROUNDING_MAX_BYTES, type ComputerGroundingResult } from "../../../src/protocol/computer-grounding.js";
import type { ComputerObservation } from "../../../src/protocol/computer-observation.js";
import {
  assertComputerGroundingCapacity,
  compactComputerObservations,
  getComputerObservation,
  readComputerScreenshot,
  saveComputerGrounding,
  saveComputerObservation,
  saveComputerScreenshot,
} from "../../../src/session/computer-observation-store.js";
import {
  getSessionDatabase,
  resetSessionDatabaseForTests,
  runSessionTransaction,
} from "../../../src/session/session-database.js";
import { appendMessage, createSession } from "../../../src/session/session-store.js";
import { compactSessionActivity } from "../../../src/session/activity-compaction.js";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function observation(observationId = "frame-1"): ComputerObservation {
  return {
    observationId,
    capturedAt: "2026-08-31T00:00:00.000Z",
    uiaCapturedAt: "2026-08-31T00:00:00.000Z",
    screenBounds: { x: -100, y: 0, width: 1, height: 1 },
    width: 1, height: 1, dpi: 144, durationMs: 10, truncated: false,
    nodes: [{
      id: "button-1", parentId: null, name: "确认", automationId: "confirm",
      controlType: "Button", enabled: true, password: false,
      bounds: { x: 0, y: 0, width: 1, height: 1 }, supportedActions: ["uia_invoke"],
    }],
    texts: [],
  };
}

function grounding(groundingId = "grounding-1", observationId = "frame-1"): ComputerGroundingResult {
  return {
    groundingId, observationId, generation: 1, target: "确认按钮",
    uiaAction: "uia_invoke", coordinateSpace: "image_pixels", status: "matched",
    candidates: [{
      description: "确认", box: { x: 0, y: 0, width: 1, height: 1 },
      status: "matched", nodeId: "button-1", supportedActions: ["uia_invoke"],
    }],
    provider: "fixture", model: "vision-fixture", durationMs: 123.5, untrustedEvidence: true,
  };
}

async function withStore(run: (db: DatabaseSync, sessionId: string) => Promise<void>): Promise<void> {
  const previous = process.env.USERPROFILE;
  const directory = await mkdtemp(join(tmpdir(), "computer-grounding-"));
  process.env.USERPROFILE = directory;
  try {
    const session = await createSession("Grounding storage fixture");
    const db = await getSessionDatabase();
    await saveComputerObservation(session.id, "turn-1", "tool-1", observation());
    await run(db, session.id);
  } finally {
    await resetSessionDatabaseForTests();
    if (previous === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

function readRow(db: DatabaseSync, sessionId: string) {
  return db.prepare("SELECT * FROM computer_observations WHERE session_id=? AND observation_id='frame-1'").get(sessionId) as {
    detail_json: string | null; groundings_json: string | null; summary_json: string;
    png: Uint8Array | null; revision: number; detail_level: string;
  };
}

function searchState(db: DatabaseSync, sessionId: string) {
  return db.prepare("SELECT revision,rebuild_epoch FROM session_search_source_state WHERE session_id=?").get(sessionId) as {
    revision: number; rebuild_epoch: number;
  };
}

test("groundings persist separately, redact text, preserve screenshot identity and hide bodies from summary", async () => {
  await withStore(async (db, sessionId) => {
    assert.equal((await getComputerObservation(sessionId, "frame-1", true)).groundings, undefined);
    const before = readRow(db, sessionId);
    const searchBefore = searchState(db, sessionId);
    const result = grounding();
    result.target = "Find sk-fixtureSecret123456789";
    result.candidates[0]!.description = "确认 Bearer private-token";
    await assertComputerGroundingCapacity(sessionId, "turn-1", "frame-1");
    await saveComputerGrounding(sessionId, "turn-1", result);
    assert.equal(result.target, "Find sk-fixtureSecret123456789");
    const saved = readRow(db, sessionId);
    assert.equal(saved.detail_json, before.detail_json);
    assert.equal(saved.revision, before.revision + 1);
    assert.equal(searchState(db, sessionId).revision, searchBefore.revision + 1);
    assert.equal(searchState(db, sessionId).rebuild_epoch, searchBefore.rebuild_epoch + 1);
    assert.ok(!saved.groundings_json!.includes("fixtureSecret"));
    assert.ok(!saved.groundings_json!.includes("private-token"));
    const expected = { ...result, target: "Find [redacted]", candidates: [{ ...result.candidates[0]!, description: "确认 Bearer [redacted]" }] };
    const full = await getComputerObservation(sessionId, "frame-1", true);
    assert.deepEqual(full.observation, observation());
    assert.deepEqual(full.groundings, [expected]);
    assert.equal((full.observation as Record<string, unknown>).groundings, undefined);
    const hidden = await getComputerObservation(sessionId, "frame-1", false);
    assert.deepEqual(hidden, {
      detailLevel: "summary", revision: saved.revision,
      summary: { observationId: "frame-1", capturedAt: observation().capturedAt, durationMs: 10,
        nodeCount: 1, textCount: 0, width: 1, height: 1, truncated: false,
        groundingCount: 1, groundingCandidateCount: 1, groundingStatus: "matched" },
    });
    const reference = await saveComputerScreenshot(sessionId, "turn-1", { ...observation(), dataUrl: PNG });
    const pngBefore = await readComputerScreenshot(sessionId, "frame-1");
    await saveComputerGrounding(sessionId, "turn-1", { ...grounding("grounding-2"), status: "not_found", candidates: [] });
    assert.deepEqual(await readComputerScreenshot(sessionId, "frame-1"), pngBefore);
    assert.deepEqual(await saveComputerScreenshot(sessionId, "turn-1", { ...observation(), dataUrl: PNG }), reference);
    assert.equal(readRow(db, sessionId).detail_json, before.detail_json);
    await assert.rejects(saveComputerScreenshot(sessionId, "turn-1", { ...observation(), durationMs: 11, dataUrl: PNG }), /computer_observation_mismatch/);
    await resetSessionDatabaseForTests();
    const reopened = await getComputerObservation(sessionId, "frame-1", true);
    assert.equal(reopened.dataUrl, PNG);
    assert.equal((reopened.groundings as ComputerGroundingResult[]).length, 2);
    assert.deepEqual((reopened.groundings as ComputerGroundingResult[])[0], expected);
  });
});

test("capacity is per frame, enforced at save time, and duplicate grounding IDs are idempotent at the limit", async () => {
  await withStore(async (db, sessionId) => {
    for (let i = 0; i < 9; i++) await saveComputerGrounding(sessionId, "turn-1", grounding(`grounding-${i}`));
    await assertComputerGroundingCapacity(sessionId, "turn-1", "frame-1");
    const saves = await Promise.allSettled([
      saveComputerGrounding(sessionId, "turn-1", grounding("grounding-9")),
      saveComputerGrounding(sessionId, "turn-1", grounding("grounding-10")),
    ]);
    assert.equal(saves.filter((result) => result.status === "fulfilled").length, 1);
    const failure = saves.find((result) => result.status === "rejected");
    assert.match(String(failure?.reason), /computer_grounding_limit/);
    await assert.rejects(assertComputerGroundingCapacity(sessionId, "turn-1", "frame-1"), /computer_grounding_limit/);
    const before = readRow(db, sessionId);
    const searchBefore = searchState(db, sessionId);
    await saveComputerGrounding(sessionId, "turn-1", { ...grounding("grounding-0"), target: "duplicate must not overwrite" });
    assert.deepEqual(readRow(db, sessionId), before);
    assert.deepEqual(searchState(db, sessionId), searchBefore);
    await saveComputerObservation(sessionId, "turn-2", "tool-2", observation("frame-2"));
    await assertComputerGroundingCapacity(sessionId, "turn-2", "frame-2");
    await saveComputerGrounding(sessionId, "turn-2", grounding("grounding-0", "frame-2"));
    for (const [session, request, frame] of [[sessionId, "wrong-turn", "frame-1"], [sessionId, "turn-1", "missing-frame"], ["other-session", "turn-1", "frame-1"]]) {
      await assert.rejects(assertComputerGroundingCapacity(session!, request!, frame!), /computer_observation_stale/);
      await assert.rejects(saveComputerGrounding(session!, request!, grounding("grounding-new", frame!)), /computer_observation_stale/);
    }
  });
});

test("a valid model response below 16 KiB can persist with target and metadata above 16 KiB total", async () => {
  await withStore(async (db, sessionId) => {
    const result: ComputerGroundingResult = {
      ...grounding(),
      target: "定".repeat(2000),
      status: "ambiguous",
      candidates: Array.from({ length: 5 }, () => ({
        description: "证".repeat(1000),
        box: { x: 0, y: 0, width: 1, height: 1 },
        status: "visual_only" as const,
      })),
    };
    const modelResponse = {
      coordinateSpace: result.coordinateSpace,
      candidates: result.candidates.map(({ description, box }) => ({ description, box })),
    };
    assert.ok(Buffer.byteLength(JSON.stringify(modelResponse)) <= COMPUTER_GROUNDING_MAX_BYTES);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) > COMPUTER_GROUNDING_MAX_BYTES);
    await saveComputerGrounding(sessionId, "turn-1", result);
    assert.deepEqual((await getComputerObservation(sessionId, "frame-1", true)).groundings, [result]);
    const before = readRow(db, sessionId);
    await assert.rejects(saveComputerGrounding(sessionId, "turn-1", {
      ...result, groundingId: "invalid-target", target: "定".repeat(2001),
    }));
    await assert.rejects(saveComputerGrounding(sessionId, "turn-1", {
      ...result, groundingId: "invalid-candidates", candidates: [...result.candidates, result.candidates[0]!],
    }));
    assert.deepEqual(readRow(db, sessionId), before);
  });
});

test("late cancellation is checked inside the write transaction after database acquisition, including duplicate saves", async () => {
  await withStore(async (db, sessionId) => {
    const before = readRow(db, sessionId);
    const searchBefore = searchState(db, sessionId);
    let current = true;
    let checked = false;
    const pending = saveComputerGrounding(sessionId, "turn-1", grounding(), () => {
      checked = true;
      assert.equal(db.isTransaction, true);
      return current;
    });
    assert.equal(checked, false);
    current = false;
    await assert.rejects(pending, /computer_grounding_stale/);
    assert.equal(checked, true);
    assert.deepEqual(readRow(db, sessionId), before);
    assert.deepEqual(searchState(db, sessionId), searchBefore);
    assert.equal(db.isTransaction, false);
    await saveComputerGrounding(sessionId, "turn-1", grounding(), () => true);
    await assert.rejects(saveComputerGrounding(sessionId, "turn-1", grounding(), () => false), /computer_grounding_stale/);
  });
});

test("save failures roll back grounding, summary, row revision and search invalidation together", async () => {
  await withStore(async (db, sessionId) => {
    await saveComputerScreenshot(sessionId, "turn-1", { ...observation(), dataUrl: PNG });
    const before = readRow(db, sessionId);
    const searchBefore = searchState(db, sessionId);
    db.exec("CREATE TEMP TRIGGER fail_grounding AFTER UPDATE OF groundings_json ON computer_observations BEGIN SELECT RAISE(ABORT, 'fixture_save_failure'); END");
    await assert.rejects(saveComputerGrounding(sessionId, "turn-1", grounding()), /fixture_save_failure/);
    assert.deepEqual(readRow(db, sessionId), before);
    assert.deepEqual(searchState(db, sessionId), searchBefore);
    db.exec("DROP TRIGGER fail_grounding");
    await saveComputerGrounding(sessionId, "turn-1", grounding());
    assert.equal((await getComputerObservation(sessionId, "frame-1", true)).detailLevel, "full");
  });
});

test("compaction removes grounding and screenshot bytes atomically, rolls back, and cannot resurrect on a late write", async () => {
  await withStore(async (db, sessionId) => {
    await saveComputerGrounding(sessionId, "turn-1", grounding());
    await saveComputerScreenshot(sessionId, "turn-1", { ...observation(), dataUrl: PNG });
    const before = readRow(db, sessionId);
    const searchBefore = searchState(db, sessionId);
    const expectedBytes = Buffer.byteLength(before.detail_json!) + Buffer.byteLength(before.groundings_json!) + before.png!.byteLength;
    assert.throws(() => runSessionTransaction(db, () => {
      assert.equal(compactComputerObservations(db, sessionId, ["turn-1"]), expectedBytes);
      assert.equal(readRow(db, sessionId).groundings_json, null);
      throw new Error("fixture_compaction_rollback");
    }), /fixture_compaction_rollback/);
    assert.deepEqual(readRow(db, sessionId), before);
    assert.deepEqual(searchState(db, sessionId), searchBefore);
    const pending = saveComputerGrounding(sessionId, "turn-1", grounding("late-grounding"));
    assert.equal(runSessionTransaction(db, () => compactComputerObservations(db, sessionId, ["turn-1"])), expectedBytes);
    await assert.rejects(pending, /computer_details_compacted/);
    assert.equal(runSessionTransaction(db, () => compactComputerObservations(db, sessionId, ["turn-1"])), 0);
    const compacted = readRow(db, sessionId);
    assert.equal(compacted.detail_json, null);
    assert.equal(compacted.groundings_json, null);
    assert.equal(compacted.png, null);
    assert.equal(compacted.summary_json, before.summary_json);
    assert.equal(compacted.revision, before.revision + 1);
    assert.equal(searchState(db, sessionId).revision, searchBefore.revision + 1);
    for (const developer of [false, true]) {
      const detail = await getComputerObservation(sessionId, "frame-1", developer);
      assert.equal(detail.detailLevel, "compacted");
      for (const body of ["observation", "dataUrl", "groundings"]) assert.equal(Object.hasOwn(detail, body), false);
    }
    await assert.rejects(assertComputerGroundingCapacity(sessionId, "turn-1", "frame-1"), /computer_details_compacted/);
    await assert.rejects(saveComputerGrounding(sessionId, "turn-1", grounding()), /computer_details_compacted/);
    await assert.rejects(saveComputerScreenshot(sessionId, "turn-1", { ...observation(), dataUrl: PNG }), /computer_details_compacted/);
    await assert.rejects(readComputerScreenshot(sessionId, "frame-1"), /computer_details_compacted/);
    await assert.rejects(saveComputerObservation(sessionId, "turn-1", "tool-1", observation()), /UNIQUE constraint/);
    assert.deepEqual(readRow(db, sessionId), compacted);
  });
});

test("activity compaction includes grounding bytes for the old turn while keeping recent evidence", async () => {
  await withStore(async (db, sessionId) => {
    for (let i = 1; i <= 11; i++) {
      const requestId = `turn-${i}`;
      await appendMessage(sessionId, { role: "user", content: `turn ${i}`, requestId, createdAt: new Date(1700000000000 + i * 1000).toISOString() });
      if (i > 1) await saveComputerObservation(sessionId, requestId, `tool-${i}`, observation(`frame-${i}`));
      await saveComputerGrounding(sessionId, requestId, grounding(`grounding-${i}`, `frame-${i}`));
      await appendMessage(sessionId, { role: "assistant", content: `done ${i}`, requestId, createdAt: new Date(1700000000001 + i * 1000).toISOString() });
    }
    const before = readRow(db, sessionId);
    const result = await compactSessionActivity(sessionId);
    assert.deepEqual(result.compactedRequestIds, ["turn-1"]);
    assert.equal(result.removedBytes, Buffer.byteLength(before.detail_json!) + Buffer.byteLength(before.groundings_json!));
    assert.equal(readRow(db, sessionId).groundings_json, null);
    assert.equal((await getComputerObservation(sessionId, "frame-2", true)).detailLevel, "full");
    assert.deepEqual((await getComputerObservation(sessionId, "frame-2", true)).groundings, [grounding("grounding-2", "frame-2")]);
  });
});

test("schema 10 upgrades to 11 without changing observation or screenshot, and reopens idempotently", async () => {
  await withStore(async (db, sessionId) => {
    await saveComputerScreenshot(sessionId, "turn-1", { ...observation(), dataUrl: PNG });
    const before = readRow(db, sessionId);
    db.exec("ALTER TABLE computer_observations DROP COLUMN groundings_json; DELETE FROM schema_migrations WHERE version=11; INSERT OR IGNORE INTO schema_migrations VALUES(10,datetime('now')); PRAGMA user_version=10;");
    await resetSessionDatabaseForTests();
    const migrated = await getSessionDatabase();
    assert.equal(migrated.prepare("PRAGMA user_version").get()!.user_version, 11);
    assert.equal(migrated.prepare("SELECT count(*) AS n FROM schema_migrations WHERE version IN (10,11)").get()!.n, 2);
    assert.deepEqual(readRow(migrated, sessionId), before);
    assert.equal((await getComputerObservation(sessionId, "frame-1", true)).dataUrl, PNG);
    await saveComputerGrounding(sessionId, "turn-1", grounding());
    await resetSessionDatabaseForTests();
    const reopened = await getSessionDatabase();
    assert.equal(reopened.prepare("SELECT count(*) AS n FROM schema_migrations WHERE version=11").get()!.n, 1);
    assert.deepEqual((await getComputerObservation(sessionId, "frame-1", true)).groundings, [grounding()]);
  });
});
