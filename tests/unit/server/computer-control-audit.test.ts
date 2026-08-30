import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { StudioComputerRuntime } from "../../../src/server/studio-computer-runtime.js";

test("records initial paused reason and changed reasons once, without heartbeat noise or secrets", async () => {
  const events: Array<{ status: string; code: string | undefined }> = [];
  const sent: Array<{ data: { callId: string } }> = [];
  const socket = { readyState: WebSocket.OPEN, send: (text: string) => sent.push(JSON.parse(text)) } as unknown as WebSocket;
  const runtime = new StudioComputerRuntime((_scope, status, code) => events.push({ status, code }));
  const scope = { connectionId: "fixture", sessionId: "session", requestId: "turn", runId: "run" };
  try {
    const grant = runtime.execute(socket, { ...scope, toolCallId: "tool" }, "mcp_computer_request_access", { mode: "control", reason: "fixture" }, undefined,
      { approvalMode: "manual", cancel: () => {}, modeUnchanged: () => true });
    runtime.handleResult(socket, { callId: sent[0]!.data.callId, ok: true, result: { granted: true, accessId: "not-for-audit", mode: "control", generation: 1 } });
    await grant;
    runtime.updateControl(socket, { ...scope, state: "paused", code: "computer_activation_required", generation: 1, sequence: 1 });
    runtime.updateControl(socket, { ...scope, state: "paused", code: "computer_activation_required", generation: 1, sequence: 2 });
    runtime.updateControl(socket, { ...scope, state: "paused", code: "computer_user_takeover", generation: 2, sequence: 3 });
    // 恢复准备期间使用旧代次，只有取得新观察之后才提交新代次 running
    runtime.updateControl(socket, { ...scope, state: "paused", code: "computer_user_takeover", generation: 2, sequence: 4 });
    assert.throws(() => runtime.updateControl(socket, { ...scope, state: "running", generation: 2, sequence: 5 }), /computer_update_stale/);
    runtime.updateControl(socket, { ...scope, state: "running", generation: 3, sequence: 6 });
    runtime.updateControl(socket, { ...scope, state: "running", generation: 3, sequence: 7 });
    assert.deepEqual(events.filter(e => ["paused", "resumed"].includes(e.status)), [
      { status: "paused", code: "computer_activation_required" },
      { status: "paused", code: "computer_user_takeover" },
      { status: "resumed", code: undefined },
    ]);
    assert.doesNotMatch(JSON.stringify(events), /not-for-audit|accessId/);
  } finally { runtime.detachSocket(socket); }
});
