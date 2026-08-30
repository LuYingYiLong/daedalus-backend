import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { ComputerControlLease } from "../../../src/server/computer-control-lease.js";
import { computerActionSchema, computerArgsSchemas, computerControlUpdateSchema } from "../../../src/protocol/computer-observation.js";
import { StudioComputerRuntime } from "../../../src/server/studio-computer-runtime.js";
import { ApprovalGateway } from "../../../src/tools/approval-gateway.js";
import { createClientSession } from "../../../src/server/client-session.js";
import { registerClientConnection, updateClientConnection, unregisterClientConnection } from "../../../src/server/client-connections.js";

test("control cancellation aborts its captured LLM controller, never the following turn", async () => {
  const sent: Array<{ data: { callId: string; authorization?: { approvalMode: string } } }> = [];
  const socket = { readyState: WebSocket.OPEN, send: (value: string) => sent.push(JSON.parse(value)) } as unknown as WebSocket;
  const session = createClientSession(undefined);
  session.sessionId = "session-test";
  session.approvalGateway = new ApprovalGateway("full-trust");
  const first = new AbortController(), following = new AbortController();
  session.activeAbortControllers.set("turn-one", first);
  const connection = registerClientConnection(socket, session);
  updateClientConnection(socket, { clientType: "studio", capabilities: { computerObservation: true, computerControl: true } });
  const runtime = new StudioComputerRuntime();
  try {
    const context = runtime.createControl(socket, session, "run-one");
    await assert.rejects(context.withInputPolicy!(false).execute("mcp_computer_request_access", { reason: "fixture", mode: "control" }, "turn-one", "tool"), /read_only/);
    const grant = context.execute("mcp_computer_request_access", { reason: "fixture", mode: "control" }, "turn-one", "tool");
    assert.equal(sent.at(-1)?.data.authorization?.approvalMode, "full-trust");
    runtime.handleResult(socket, { callId: sent.at(-1)!.data.callId, ok: true, result: { granted: true, accessId: "opaque", mode: "control", generation: 1 } });
    await grant;
    runtime.updateControl(socket, { connectionId: connection.connectionId, sessionId: session.sessionId, requestId: "turn-one", runId: "run-one", generation: 1, state: "running", sequence: 1 });
    assert.equal(context.hasControl!("turn-one"), true);
    const otherRun = runtime.createControl(socket, session, "run-other");
    assert.equal(otherRun.hasControl!("turn-one"), false);
    await assert.rejects(otherRun.execute("mcp_computer_action", { observationId: "frame", action: { type: "key", key: "Enter" } }, "turn-one", "other-tool"), /consent_required/);
    session.activeAbortControllers.delete("turn-one");
    session.activeAbortControllers.set("turn-two", following);
    runtime.revoke(socket, { connectionId: connection.connectionId, sessionId: session.sessionId, requestId: "turn-one", runId: "run-one", code: "computer_cancelled" });
    assert.equal(first.signal.aborted, true);
    assert.equal(following.signal.aborted, false);
    runtime.revoke(socket, { connectionId: connection.connectionId, sessionId: session.sessionId, requestId: "turn-one", runId: "run-one", code: "computer_cancelled" });
    assert.equal(following.signal.aborted, false);
  } finally {
    runtime.detachSocket(socket); unregisterClientConnection(socket);
  }
});

const scope = { connectionId: "connection", sessionId: "session", requestId: "turn", runId: "run", toolCallId: "tool" };
test("computer action contracts reject unsupported inputs and forged approval", () => {
  for (const action of [{ type: "key", key: "Alt+Tab" }, { type: "text", text: "" }, { type: "click", x: -1, y: 0, count: 1 }, { type: "click", x: 1, y: 1, count: 1, hwnd: 42 }, { type: "scroll", x: 0, y: 0, amount: 0, axis: "vertical" }]) assert.equal(computerActionSchema.safeParse(action).success, false);
  assert.equal(computerArgsSchemas.mcp_computer_request_access.safeParse({ reason: "fixture", mode: "control", approvalMode: "full-trust" }).success, false);
  assert.equal(computerControlUpdateSchema.safeParse({ ...scope, generation: 1, state: "running", sequence: 0 }).success, false); // tool identity not accepted as control state
});
test("input remains write gated even under full trust without a verified grant", async () => {
  for (const mode of ["manual", "auto-safe", "full-trust"] as const) {
    const gateway = new ApprovalGateway(mode);
    assert.equal((await gateway.evaluate("mcp_computer_action", {}, "tool")).action, "deny");
    assert.equal((await gateway.evaluate("mcp_computer_action", {}, "tool", undefined, { computerAuthorized: true })).action, "allow");
  }
});
test("paused execution waits; resume wakes once and stale updates cannot resume", async () => {
  const cancelled: string[] = [];
  const lease = new ComputerControlLease(1, code => cancelled.push(code), () => true);
  const { toolCallId: _, ...identity } = scope;
  lease.update({ ...identity, generation: 2, state: "paused", sequence: 1 });
  let completed = false;
  const waiting = lease.wait().then(() => { completed = true; });
  await Promise.resolve(); assert.equal(completed, false);
  assert.throws(() => lease.update({ ...identity, generation: 1, state: "running", sequence: 2 }), /stale/);
  lease.update({ ...identity, generation: 3, state: "running", sequence: 3 });
  await waiting; assert.equal(completed, true); assert.deepEqual(cancelled, []);
  lease.close(); assert.rejects(lease.wait(), /cancelled/);
});
test("heartbeat expiry and approval mode changes cancel exactly once", t => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
  const cancelled: string[] = [];
  const lease = new ComputerControlLease(1, code => cancelled.push(code), () => true);
  t.mock.timers.tick(5500); lease.cancel("again");
  assert.deepEqual(cancelled, ["computer_heartbeat_timeout"]);
  let unchanged = true;
  const next = new ComputerControlLease(1, code => cancelled.push(code), () => unchanged);
  unchanged = false; t.mock.timers.tick(500);
  assert.equal(cancelled.at(-1), "computer_approval_mode_changed"); next.close();
});
test("action dedup returns the same result, old run updates cannot cancel a new control", async () => {
  const sent: Array<{ data: Record<string, unknown> }> = [];
  const socket = { readyState: WebSocket.OPEN, send: (value: string) => sent.push(JSON.parse(value)) } as unknown as WebSocket;
  const runtime = new StudioComputerRuntime();
  const cancelled: string[] = [];
  const metadata = { approvalMode: "manual" as const, cancel: (code: string) => cancelled.push(code), modeUnchanged: () => true };
  const grant = runtime.execute(socket, scope, "mcp_computer_request_access", { mode: "control", reason: "fixture" }, undefined, metadata);
  runtime.handleResult(socket, { callId: sent.at(-1)!.data.callId as string, ok: true, result: { granted: true, accessId: "lease", mode: "control", generation: 1 } });
  await grant;
  const args = { observationId: "frame", action: { type: "click", x: 2, y: 3, count: 1 } };
  const first = runtime.execute(socket, scope, "mcp_computer_action", args, undefined, metadata);
  const second = runtime.execute(socket, scope, "mcp_computer_action", args, undefined, metadata);
  const event = sent.at(-1)!.data;
  runtime.handleResult(socket, { callId: event.callId as string, ok: true, result: { actionId: event.actionId as string, observationId: "frame", generation: 1, status: "dispatched", dispatchedAt: new Date().toISOString() } });
  assert.deepEqual(await first, await second); assert.equal(sent.length, 2);
  const { toolCallId: _, ...identity } = scope;
  assert.throws(() => runtime.updateControl(socket, { ...identity, runId: "old-run", generation: 2, state: "cancelled", sequence: 1 }), /scope_mismatch/);
  assert.deepEqual(cancelled, []);
  runtime.finishTurn(scope.sessionId, scope.requestId, scope.runId);
});

test("startup cancellation aborts before the grant result and rejects its late result", async () => {
  const sent: Array<{ data: { callId: string } }> = [];
  const socket = { readyState: WebSocket.OPEN, send: (text: string) => sent.push(JSON.parse(text)) } as unknown as WebSocket;
  const runtime = new StudioComputerRuntime();
  let stopped = 0;
  const pending = runtime.execute(socket, scope, "mcp_computer_request_access", { reason: "fixture", mode: "control" }, undefined, { approvalMode: "manual", cancel: () => { stopped++; }, modeUnchanged: () => true });
  const rejected = assert.rejects(pending, /computer_cancelled/);
  runtime.revoke(socket, { ...scope, code: "computer_cancelled" });
  await rejected;
  assert.equal(stopped, 1);
  assert.throws(() => runtime.handleResult(socket, { callId: sent[0]!.data.callId, ok: true, result: { granted: true, accessId: "late", mode: "control", generation: 1 } }), /call_not_found/);
});
