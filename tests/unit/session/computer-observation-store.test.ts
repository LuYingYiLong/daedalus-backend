import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveComputerObservation,
  saveComputerScreenshot,
  readComputerScreenshot,
  getComputerObservation,
  compactComputerObservations,
} from "../../../src/session/computer-observation-store.js";
import {
  getSessionDatabase,
  resetSessionDatabaseForTests,
  runSessionTransaction,
} from "../../../src/session/session-database.js";
import {
  createSession,
  appendMessage,
} from "../../../src/session/session-store.js";
import { compactSessionActivity } from "../../../src/session/activity-compaction.js";
import { hydrateToolImageReferences } from "../../../src/providers/tool-image-reference.js";
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
function fixture(observationId: string) {
  return {
    observationId,
    capturedAt: "2026-08-30T00:00:00.000Z",
    uiaCapturedAt: "2026-08-30T00:00:00.000Z",
    screenBounds: { x: -100, y: 0, width: 1, height: 1 },
    width: 1,
    height: 1,
    dpi: 144,
    nodes: [],
    texts: [
      {
        id: "text-1",
        text: "本地 fixture",
        confidence: 0.99,
        bounds: { x: 0, y: 0, width: 1, height: 1 },
      },
    ],
    truncated: false,
    durationMs: 10,
  };
}
test("independent observations: same-frame image, summary hiding, transaction rollback and ten-turn compaction", async () => {
  const previous = process.env.USERPROFILE,
    directory = await mkdtemp(join(tmpdir(), "computer-observation-"));
  process.env.USERPROFILE = directory;
  try {
    const session = await createSession("Observation fixture");
    for (let index = 1; index <= 11; index++) {
      const requestId = `turn-${index}`;
      await appendMessage(session.id, {
        role: "user",
        content: `user ${index}`,
        requestId,
        createdAt: new Date(1700000000000 + index * 1000).toISOString(),
      });
      await saveComputerObservation(
        session.id,
        requestId,
        `tool-${index}`,
        fixture(`obs-${index}`),
      );
      await appendMessage(session.id, {
        role: "assistant",
        content: `final ${index}`,
        requestId,
        createdAt: new Date(1700000000001 + index * 1000).toISOString(),
      });
    }
    const reference = await saveComputerScreenshot(session.id, "turn-1", {
      ...fixture("obs-1"),
      dataUrl: PNG,
    });
    assert.equal(reference.source.kind, "computer_observation");
    const hydrated = await hydrateToolImageReferences([reference]);
    assert.equal(hydrated[0]?.dataUrl, PNG);
    await assert.rejects(hydrateToolImageReferences([reference, reference, reference, reference]), /at most 3/);
    await assert.rejects(hydrateToolImageReferences([{ ...reference, byteSize: 13 * 1024 * 1024 }]), /continuation limit/);
    await assert.rejects(
      saveComputerScreenshot(session.id, "turn-2", {
        ...fixture("obs-1"),
        dataUrl: PNG,
      }),
      /computer_observation_stale/,
    );
    assert.equal(
      (await getComputerObservation(session.id, "obs-1", false)).detailLevel,
      "summary",
    );
    assert.equal(
      (await getComputerObservation(session.id, "obs-1", false)).dataUrl,
      undefined,
    );
    assert.equal(
      (await readComputerScreenshot(session.id, "obs-1")).length > 0,
      true,
    );
    const db = await getSessionDatabase();
    const searchState = () => db.prepare("SELECT revision, rebuild_epoch FROM session_search_source_state WHERE session_id=?").get(session.id) as { revision: number; rebuild_epoch: number };
    const before = searchState();
    assert.equal((await compactSessionActivity(session.id, false)).skipped, "disabled");
    const now = new Date().toISOString();
    db.prepare("INSERT INTO agent_runs(run_id,session_id,request_id,root_request_id,retry_of_run_id,revision,stage,state_json,checkpoint_json,created_at,updated_at) VALUES (?,?,?,?,NULL,1,'executing','{}','{}',?,?)").run("active", session.id, "turn-11", "turn-11", now, now);
    assert.equal((await compactSessionActivity(session.id)).skipped, "active_run");
    db.prepare("DELETE FROM agent_runs WHERE run_id=?").run("active");
    assert.throws(
      () =>
        runSessionTransaction(db, () => {
          compactComputerObservations(db, session.id, ["turn-1"]);
          throw new Error("rollback");
        }),
      /rollback/,
    );
    assert.equal(
      (await getComputerObservation(session.id, "obs-1", true)).detailLevel,
      "full",
    );
    const compacted = await compactSessionActivity(session.id);
    assert.deepEqual(compacted.compactedRequestIds, ["turn-1"]);
    assert.ok(compacted.removedBytes > 0);
    assert.ok(searchState().revision > before.revision);
    assert.ok(searchState().rebuild_epoch > before.rebuild_epoch);
    assert.equal(
      (await getComputerObservation(session.id, "obs-1", true)).detailLevel,
      "compacted",
    );
    await assert.rejects(
      readComputerScreenshot(session.id, "obs-1"),
      /computer_details_compacted/,
    );
    await assert.rejects(hydrateToolImageReferences([reference]), /computer_details_compacted/);
    assert.equal(
      (await getComputerObservation(session.id, "obs-2", true)).detailLevel,
      "full",
    );
    assert.equal((await compactSessionActivity(session.id)).removedBytes, 0);
    assert.equal(
      (
        db
          .prepare("SELECT count(*) AS n FROM messages WHERE session_id=?")
          .get(session.id) as { n: number }
      ).n,
      22,
    );
  } finally {
    await resetSessionDatabaseForTests();
    if (previous === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
