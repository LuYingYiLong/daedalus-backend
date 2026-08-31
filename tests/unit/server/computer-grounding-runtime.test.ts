import assert from "node:assert/strict";
import test from "node:test";
import type WebSocket from "ws";
import { ComputerGroundingRuntime } from "../../../src/server/computer-grounding-runtime.js";
import type { ComputerLocateExecution } from "../../../src/tools/computer-tools.js";
import type { ComputerGroundingFrame } from "../../../src/protocol/computer-observation.js";
import type { ComputerGroundingResult } from "../../../src/protocol/computer-grounding.js";

const socket = {} as WebSocket;
const scope = { connectionId: "connection", sessionId: "session", requestId: "turn", runId: "run" };
const frame: ComputerGroundingFrame = {
  generation: 2,
  observation: { observationId: "frame", capturedAt: "2026-08-31T00:00:00.000Z", uiaCapturedAt: "2026-08-31T00:00:00.000Z",
    width: 100, height: 100, dpi: 96, screenBounds: { x: -100, y: 0, width: 100, height: 100 },
    nodes: [], texts: [], durationMs: 10, truncated: false, dataUrl: "data:image/png;base64,AAAA" },
};
function fixture() {
  const runtime = new ComputerGroundingRuntime();
  let inferences = 0, writes = 0, validations = 0;
  const input: ComputerLocateExecution = {
    args: { observationId: "frame", target: "Settings icon" }, requestId: "turn", toolCallId: "locate", signal: undefined,
    infer: async (_frame, groundingId) => {
      inferences++;
      return { groundingId, observationId: "frame", generation: 2, target: "Settings icon", uiaAction: "uia_invoke",
        coordinateSpace: "image_pixels", status: "matched", candidates: [{ description: "Gear", box: { x: 5, y: 5, width: 10, height: 10 },
          status: "matched", nodeId: "button", supportedActions: ["uia_invoke"] }], provider: "fixture", model: "vision", durationMs: 100, untrustedEvidence: true };
    },
    persist: async (_value, isCurrent) => { assert.ok(isCurrent()); writes++; },
  };
  const forward = async (operation: "grounding.prepare" | "grounding.validate") => {
    if (operation === "grounding.prepare") return frame;
    validations++;
    return { observationId: "frame", generation: 2, valid: true };
  };
  const run = (change: Partial<ComputerLocateExecution> = {}) => runtime.run(socket, scope, { ...input, ...change }, forward, () => {});
  return { runtime, input, forward, run, counts: () => ({ inferences, writes, validations }) };
}
async function tick(): Promise<void> { await new Promise<void>(resolve => setImmediate(resolve)); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test("duplicate locate IDs run one inference; validated receipt binds exact scope/node/action", async () => {
  const f = fixture();
  const first = f.run(), second = f.run();
  assert.equal(first, second);
  const result = await first;
  assert.deepEqual(f.counts(), { inferences: 1, writes: 1, validations: 1 });
  const action = { observationId: "frame", groundingId: result.groundingId, action: { type: "uia_invoke", nodeId: "button" } };
  assert.doesNotThrow(() => f.runtime.assertAction(socket, scope, action));
  assert.throws(() => f.runtime.assertAction({} as WebSocket, scope, action), /stale/);
  assert.throws(() => f.runtime.assertAction(socket, { ...scope, runId: "other" }, action), /stale/);
  assert.throws(() => f.runtime.assertAction(socket, scope, { ...action, action: { type: "uia_toggle", nodeId: "button" } }), /mismatch/);
  assert.throws(() => f.runtime.assertAction(socket, scope, { ...action, action: { type: "uia_invoke", nodeId: "wrong" } }), /mismatch/);
  assert.throws(() => f.runtime.assertAction(socket, scope, { observationId: "frame", action: action.action }), /required/);
  await assert.rejects(f.run({ args: { observationId: "frame", target: "Different" } }), /mismatch/);
});

test("ambiguous visual candidates cannot execute with a receipt or by omitting it", async () => {
  const f = fixture();
  const result = await f.run({ infer: async (snapshot, id, signal) => {
    const result = await f.input.infer(snapshot, id, signal);
    return { ...result, status: "ambiguous", candidates: [{ description: "Gear", box: result.candidates[0]!.box, status: "ambiguous" }] };
  } });
  assert.throws(() => f.runtime.assertAction(socket, scope, { observationId: "frame", groundingId: result.groundingId, action: { type: "uia_invoke", nodeId: "button" } }), /mismatch/);
  assert.throws(() => f.runtime.assertAction(socket, scope, { observationId: "frame", action: { type: "uia_invoke", nodeId: "button" } }), /required/);
  assert.doesNotThrow(() => f.runtime.assertAction(socket, scope, { observationId: "new-frame", action: { type: "uia_invoke", nodeId: "button" } }));
});

for (const cause of ["computer_paused", "computer_disconnected", "computer_grounding_stale", "computer_cancelled"]) {
  test(`${cause} aborts inference and prevents late validation/persistence`, async () => {
    const f = fixture(), response = deferred<ComputerGroundingResult>();
    let delayedResult!: ComputerGroundingResult, signal!: AbortSignal;
    const running = f.run({ infer: async (snapshot, id, scoped) => { signal = scoped; delayedResult = await f.input.infer(snapshot, id, scoped); return response.promise; } });
    const rejected = assert.rejects(running, new RegExp(cause));
    await tick();
    assert.equal(f.runtime.busy("session"), true);
    await assert.rejects(f.run({ toolCallId: "parallel" }), /busy/);
    f.runtime.invalidate((owner, candidate) => owner === socket && candidate.requestId === "turn", cause);
    await rejected;
    assert.equal(signal.aborted, true);
    response.resolve(delayedResult); await tick();
    assert.deepEqual(f.counts(), { inferences: 1, writes: 0, validations: 0 });
    await assert.rejects(f.run(), /stale/);
  });
}

test("model-only deadline is 60 seconds and late response cannot commit", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  const running = f.run({ infer: () => new Promise(() => {}) });
  const rejected = assert.rejects(running, /computer_grounding_timeout/);
  await tick(); t.mock.timers.tick(60_000); await rejected;
  assert.equal(f.counts().writes, 0);
});

test("generation changes invalidate receipts; heartbeats for the same generation do not", async () => {
  const f = fixture(), result = await f.run();
  const action = { observationId: "frame", groundingId: result.groundingId, action: { type: "uia_invoke", nodeId: "button" } };
  f.runtime.update(socket, scope, 2, "running");
  assert.doesNotThrow(() => f.runtime.assertAction(socket, scope, action));
  f.runtime.update(socket, scope, 3, "running");
  assert.throws(() => f.runtime.assertAction(socket, scope, action), /stale/);
});

test("invalid post-model validation never persists a result", async () => {
  const f = fixture();
  await assert.rejects(f.runtime.run(socket, scope, f.input, async operation => operation === "grounding.prepare" ? frame : { observationId: "other", generation: 2, valid: true }, () => {}), /stale/);
  assert.equal(f.counts().writes, 0);
});

test("cancellation during asynchronous storage setup makes commit guard false", async () => {
  const f = fixture(), storage = deferred<void>();
  let current!: () => boolean;
  const running = f.run({ persist: async (_result, guard) => { current = guard; await storage.promise; assert.equal(guard(), false); } });
  const rejected = assert.rejects(running, /stale/);
  await tick(); assert.ok(current());
  f.runtime.invalidate(() => true); assert.equal(current(), false);
  storage.resolve(); await rejected;
});
