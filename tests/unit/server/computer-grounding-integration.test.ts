import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { StudioComputerRuntime } from "../../../src/server/studio-computer-runtime.js";
import { createClientSession } from "../../../src/server/client-session.js";
import { registerClientConnection, updateClientConnection, unregisterClientConnection } from "../../../src/server/client-connections.js";
import { computerArgsSchemas, computerToolResultParamsSchema, type ComputerGroundingFrame } from "../../../src/protocol/computer-observation.js";
import { clientRequestEnvelopeSchema } from "../../../src/protocol/schema.js";
import { createWorkspaceToolCatalog } from "../../../src/tools/tool-catalog.js";
import { createToolFailure } from "../../../src/tools/tool-failure.js";
import type { ComputerLocateExecution } from "../../../src/tools/computer-tools.js";

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const snapshot: ComputerGroundingFrame["observation"] = {
  observationId: "frame", capturedAt: "2026-08-31T00:00:00.000Z", uiaCapturedAt: "2026-08-31T00:00:00.000Z",
  width: 100, height: 100, screenBounds: { x: 0, y: 0, width: 100, height: 100 }, dpi: 96,
  nodes: [], texts: [], truncated: false, durationMs: 1, dataUrl: "data:image/png;base64,AAAA",
};
function fixture() {
  type Event = { event: string; data: { callId: string; toolName: string; actionId: string } };
  const sent: Event[] = [];
  const socket = { readyState: WebSocket.OPEN, send: (text: string) => sent.push(JSON.parse(text)) } as unknown as WebSocket;
  const session = createClientSession(undefined);
  session.sessionId = "session";
  session.activeAbortControllers.set("turn", new AbortController());
  const connection = registerClientConnection(socket, session);
  updateClientConnection(socket, { clientType: "studio", capabilities: { computerObservation: true, computerControl: true, computerGrounding: true } });
  const runtime = new StudioComputerRuntime();
  const context = runtime.createControl(socket, session, "run");
  const scope = { connectionId: connection.connectionId, sessionId: "session", requestId: "turn", runId: "run" };
  const reply = (result: Record<string, unknown>): void => runtime.handleResult(socket, computerToolResultParamsSchema.parse({ callId: sent.at(-1)!.data.callId, ok: true, result }));
  const grant = async (mode: "observe" | "control" = "observe"): Promise<void> => {
    const pending = context.execute("mcp_computer_request_access", { reason: "Fixture", mode }, "turn", `grant-${mode}`);
    reply(mode === "control" ? { granted: true, accessId: "opaque", mode, generation: 1 } : { granted: true, accessId: "opaque" });
    await pending;
    if (mode === "control") runtime.updateControl(socket, { ...scope, generation: 1, sequence: 1, state: "running" });
  };
  let requests = 0, saves = 0;
  const input: ComputerLocateExecution = {
    requestId: "turn", toolCallId: "locate", args: { observationId: "frame", target: "Gear icon" }, signal: undefined,
    infer: async (frame, id) => {
      requests++;
      return { groundingId: id, observationId: "frame", generation: frame.generation, target: "Gear icon", uiaAction: "uia_invoke",
        coordinateSpace: "image_pixels", status: "matched", candidates: [{ description: "Gear", box: { x: 5, y: 5, width: 10, height: 10 },
          status: "matched", nodeId: "button", supportedActions: ["uia_invoke"] }], provider: "fixture", model: "vision", durationMs: 1, untrustedEvidence: true };
    },
    persist: async (_result, isCurrent) => { assert.ok(isCurrent()); saves++; },
  };
  const locate = async (toolCallId: string, generation: number) => {
    const pending = context.locate!({ ...input, toolCallId });
    assert.equal(sent.at(-1)!.data.toolName, "grounding.prepare");
    reply({ observation: snapshot, generation });
    await tick();
    assert.equal(sent.at(-1)!.data.toolName, "grounding.validate");
    reply({ observationId: "frame", generation, valid: true });
    return pending;
  };
  const close = (): void => { runtime.detachSocket(socket); unregisterClientConnection(socket); };
  return { runtime, context, socket, scope, sent, reply, grant, input, locate, close, counts: () => ({ requests, saves }) };
}

test("negotiated grounding is optional and cannot introduce keyboard receipts or coordinate input", () => {
  const old = createWorkspaceToolCatalog({ clientType: "studio", computerControl: { execute: async () => ({}) } }).getEntries();
  assert.ok(old.some(entry => entry.id === "mcp_computer_observe"));
  assert.equal(old.some(entry => entry.id === "mcp_computer_locate"), false);
  assert.ok(clientRequestEnvelopeSchema.safeParse({ protocolVersion: 3, type: "request", id: "cap", method: "client.capabilities.update", params: { capabilities: { computerGrounding: true } } }).success);
  for (const action of [{ type: "key", key: "Enter" }, { type: "click", x: 1, y: 1 }]) {
    assert.equal(computerArgsSchemas.mcp_computer_action.safeParse({ observationId: "frame", groundingId: "ground", action }).success, false);
  }
  for (const code of ["computer_grounding_timeout", "computer_grounding_stale", "computer_grounding_invalid_response"]) assert.equal(createToolFailure(new Error(code)).retryable, false);
});

test("grounding uses the internal prepare/validate channel; observation consent does not grant input", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.context.locate!(f.input), /consent_required/);
    assert.equal(f.sent.length, 0);
    await f.grant();
    await f.locate("locate-observe", 0);
    await assert.rejects(f.context.execute("mcp_computer_action", { observationId: "frame", action: { type: "uia_invoke", nodeId: "button" } }, "turn", "action"), /consent_required/);
    assert.deepEqual(f.counts(), { requests: 1, saves: 1 });
    await assert.rejects(f.context.execute("mcp_computer_locate", f.input.args, "turn", "wrong-dispatch"), /tool_not_supported/);
  } finally { f.close(); }
});

test("control upgrade invalidates old grounding; matched UIA action is dispatched only once", async () => {
  const f = fixture();
  try {
    await f.grant();
    const old = await f.locate("old", 0);
    await f.grant("control");
    const args = { observationId: "frame", groundingId: old.groundingId, action: { type: "uia_invoke", nodeId: "button" } };
    await assert.rejects(f.context.execute("mcp_computer_action", args, "turn", "stale"), /grounding_stale/);
    const current = await f.locate("new", 1);
    args.groundingId = current.groundingId;
    await assert.rejects(f.context.withInputPolicy!(false).execute("mcp_computer_action", args, "turn", "read-only"), /read_only/);
    const action = f.context.execute("mcp_computer_action", args, "turn", "action");
    const event = f.sent.at(-1)!.data;
    assert.equal(event.toolName, "mcp_computer_action");
    f.reply({ actionId: event.actionId, observationId: "frame", generation: 1, status: "dispatched", dispatchedAt: new Date().toISOString(), transport: "uia" });
    const result = await action, count = f.sent.length;
    assert.deepEqual(await f.context.execute("mcp_computer_action", args, "turn", "action"), result);
    assert.equal(f.sent.length, count);
    await assert.rejects(f.context.execute("mcp_computer_action", args, "turn", "replay"), /grounding_stale/);
  } finally { f.close(); }
});

for (const invalidation of ["observe", "revoke", "disconnect", "capability", "finish"] as const) {
  test(`${invalidation} aborts an in-flight visual request before a receipt is stored`, async () => {
    const f = fixture();
    try {
      await f.grant();
      let modelSignal: AbortSignal | undefined;
      const pending = f.context.locate!({ ...f.input, infer: async (_frame, _id, signal) => {
        modelSignal = signal;
        return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      } });
      f.reply({ observation: snapshot, generation: 0 });
      await tick();
      const rejected = assert.rejects(pending, /computer_(grounding_stale|cancelled|disconnected|disabled)/);
      if (invalidation === "observe") {
        const observe = f.context.execute("mcp_computer_observe", {}, "turn", "observe-new");
        const { dataUrl: _, ...plain } = snapshot;
        f.reply({ ...plain, observationId: "new-frame" });
        await observe;
      } else if (invalidation === "revoke") f.runtime.revoke(f.socket, { ...f.scope, code: "computer_cancelled" });
      else if (invalidation === "disconnect") f.runtime.detachSocket(f.socket);
      else if (invalidation === "capability") f.runtime.disableGrounding(f.socket);
      else f.runtime.finishTurn("session", "turn", "run");
      await rejected;
      assert.ok(modelSignal?.aborted);
      assert.equal(f.counts().saves, 0);
      assert.equal(f.sent.filter(e => e.data.toolName === "grounding.validate").length, 0);
    } finally { f.close(); }
  });
}
