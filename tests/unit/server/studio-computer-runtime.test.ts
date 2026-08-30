import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { StudioComputerRuntime } from "../../../src/server/studio-computer-runtime.js";
import {
  computerObservationSchema,
  computerToolResultParamsSchema,
} from "../../../src/protocol/computer-observation.js";
import { clientRequestEnvelopeSchema } from "../../../src/protocol/schema.js";
import { createWorkspaceToolCatalog } from "../../../src/tools/tool-catalog.js";
import { COMPUTER_TOOL_NAMES } from "../../../src/tools/computer-tools.js";
const scope = {
  sessionId: "session",
  requestId: "turn",
  runId: "run",
  toolCallId: "tool",
  connectionId: "connection",
};
test("audit keeps scope and status, never authorization secrets; terminal and disconnect revoke", async () => {
  const audit: unknown[] = [],
    runtime = new StudioComputerRuntime((identity, status, code) =>
      audit.push({ identity, status, code }),
    ),
    owner = socket();
  const pending = runtime.execute(owner, scope, "mcp_computer_request_access", {
    reason: "fixture",
  });
  runtime.handleResult(owner, {
    callId: owner.sent[0]!.data.callId,
    ok: true,
    result: { granted: true, accessId: "secret-never-audited" },
  });
  await pending;
  runtime.finishTurn("session", "turn", "run");
  runtime.detachSocket(owner);
  assert.deepEqual(
    audit.map((value) => (value as { status: string }).status),
    ["requested", "allowed", "revoked"],
  );
  assert.doesNotMatch(
    JSON.stringify(audit),
    /secret-never-audited|accessId|title|hwnd/,
  );
});
function socket() {
  const sent: Array<{
    data: { callId: string };
    requestId: string;
    runId: string;
  }> = [];
  return {
    sent,
    readyState: WebSocket.OPEN,
    send: (text: string) => sent.push(JSON.parse(text)),
  } as unknown as WebSocket & { sent: typeof sent };
}
test("computer RPC strictly validates results and additional capability", () => {
  assert.equal(
    clientRequestEnvelopeSchema.safeParse({
      protocolVersion: 3,
      type: "request",
      id: "hello",
      method: "client.capabilities.update",
      params: { capabilities: { computerObservation: true } },
    }).success,
    true,
  );
  assert.equal(
    computerToolResultParamsSchema.safeParse({
      callId: "call",
      ok: true,
      result: { granted: true, accessId: "lease", hwnd: 12 },
    }).success,
    false,
  );
  assert.equal(
    computerObservationSchema.safeParse({
      observationId: "obs",
      dataUrl: "file://private",
    }).success,
    false,
  );
});
test("computer tools are read-only desktop capabilities and are absent for Remote/Goal", () => {
  const computerControl = { inputAllowed: true, execute: async () => ({}) };
  for (const clientType of [
    "studio_remote",
    "studio_scheduler",
    "cli",
  ] as const) {
    const entries = createWorkspaceToolCatalog({
      clientType,
      computerControl,
    }).getEntries();
    assert.equal(
      entries.some((entry) =>
        COMPUTER_TOOL_NAMES.includes(
          entry.id as (typeof COMPUTER_TOOL_NAMES)[number],
        ),
      ),
      false,
    );
  }
  const desktop = createWorkspaceToolCatalog({
    clientType: "studio",
    computerControl,
  }).getEntries();
  for (const name of COMPUTER_TOOL_NAMES)
    assert.ok(desktop.some((entry) => entry.id === name));
  const goal = createWorkspaceToolCatalog({
    clientType: "studio",
    computerControl,
    hookContext: {
      model: "test",
      approvalMode: "full-trust",
      chatMode: "goal",
    },
  }).getEntries();
  assert.equal(
    goal.some((entry) => entry.id === "mcp_computer_observe"),
    false,
  );
});
test("results are bound to call, socket and actual turn/run; duplicates are rejected", async () => {
  const runtime = new StudioComputerRuntime(),
    owner = socket(),
    other = socket();
  const pending = runtime.execute(owner, scope, "mcp_computer_request_access", {
    reason: "Fixture",
  });
  const event = owner.sent[0]!;
  assert.equal(event.requestId, "turn");
  assert.equal(event.runId, "run");
  const result = {
    callId: event.data.callId,
    ok: true as const,
    result: { granted: true as const, accessId: "access" },
  };
  assert.throws(
    () => runtime.handleResult(other, result),
    /computer_connection_mismatch/,
  );
  runtime.handleResult(owner, result);
  assert.deepEqual(await pending, result.result);
  assert.throws(
    () => runtime.handleResult(owner, result),
    /computer_call_not_found/,
  );
});
test("cancel/disconnect discard pending results and send cancellation", async () => {
  const runtime = new StudioComputerRuntime(),
    owner = socket(),
    abort = new AbortController();
  const pending = runtime.execute(
    owner,
    scope,
    "mcp_computer_observe",
    {},
    abort.signal,
  );
  const rejected = assert.rejects(pending, /computer_cancelled/);
  abort.abort();
  await rejected;
  assert.equal(owner.sent.length, 2);
  const disconnected = runtime.execute(
    owner,
    scope,
    "mcp_computer_observe",
    {},
  );
  const rejection = assert.rejects(disconnected, /computer_disconnected/);
  runtime.detachSocket(owner);
  await rejection;
});
