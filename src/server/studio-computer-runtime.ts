import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  computerAccessResultSchema,
  computerArgsSchemas,
  computerObservationSchema,
  COMPUTER_RESULT_MAX_BYTES,
  type ComputerToolResultParams,
  type ComputerToolName,
} from "../protocol/computer-observation.js";
import type { ComputerControlContext } from "../tools/computer-tools.js";
import type { ClientSession } from "./client-session.js";
import { getClientConnection } from "./client-connections.js";
import { sendJson } from "./send-json.js";
import { appendApprovalEvent } from "../session/session-store.js";
import { logger } from "../logger.js";

type Scope = {
  sessionId: string;
  requestId: string;
  runId: string;
  toolCallId: string;
  connectionId: string;
};
type Pending = {
  socket: WebSocket;
  scope: Scope;
  toolName: ComputerToolName;
  args: Record<string, unknown>;
  timer: NodeJS.Timeout;
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  cleanup(): void;
};
export class ComputerRuntimeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ComputerRuntimeError";
  }
}
export class StudioComputerRuntime {
  private pending = new Map<string, Pending>();
  private grants = new Map<WebSocket, Map<string, Scope>>();
  constructor(
    private readonly audit: (
      scope: Scope,
      status: string,
      code?: string,
    ) => void = () => {},
  ) {}
  private sequence = 0;
  createControl(
    socket: WebSocket,
    session: ClientSession,
    explicitRunId?: string,
  ): ComputerControlContext {
    const findRun = (requestId: string) =>
      [...session.agentRuns.values()].find(
        (run) =>
          run.requestId === requestId &&
          (!explicitRunId || run.runId === explicitRunId),
      );
    return {
      canonicalRequestId: (requestId) =>
        findRun(requestId)?.rootRequestId ?? requestId,
      execute: (toolName, args, requestId, toolCallId, signal) => {
        const connection = getClientConnection(socket);
        if (
          connection?.clientType !== "studio" ||
          connection.capabilities.computerObservation !== true ||
          !session.sessionId ||
          session.scheduledTaskOrigin ||
          signal?.aborted
        )
          return Promise.reject(new ComputerRuntimeError("computer_disabled"));
        const run = findRun(requestId);
        if (run?.goalId)
          return Promise.reject(new ComputerRuntimeError("computer_disabled"));
        const scope: Scope = {
          connectionId: connection.connectionId,
          sessionId: session.sessionId,
          requestId: run?.rootRequestId ?? requestId,
          runId: explicitRunId ?? run?.runId ?? requestId,
          toolCallId,
        };
        return this.execute(socket, scope, toolName, args, signal);
      },
    };
  }
  private emit(
    socket: WebSocket,
    event: "computer.tool.request" | "computer.tool.cancel",
    scope: Scope,
    data: Record<string, unknown>,
  ): void {
    sendJson(socket, {
      protocolVersion: 3,
      type: "event",
      eventId: `computer-${randomUUID()}`,
      event,
      sessionId: scope.sessionId,
      requestId: scope.requestId,
      runId: scope.runId,
      sequence: ++this.sequence,
      createdAt: new Date().toISOString(),
      data,
    });
  }
  execute(
    socket: WebSocket,
    scope: Scope,
    toolName: ComputerToolName,
    rawArgs: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const args = computerArgsSchemas[toolName].parse(rawArgs);
    if (socket.readyState !== WebSocket.OPEN || signal?.aborted)
      return Promise.reject(new ComputerRuntimeError("computer_disconnected"));
    if (this.pending.size >= 32)
      return Promise.reject(new ComputerRuntimeError("computer_busy"));
    const callId = `computer-${randomUUID()}`;
    if (toolName === "mcp_computer_request_access")
      this.audit(scope, "requested");
    return new Promise((resolve, reject) => {
      const cancel = (code: string): void => {
        const pending = this.pending.get(callId);
        if (!pending) return;
        this.remove(callId, pending);
        if (toolName === "mcp_computer_request_access")
          this.audit(scope, "denied", code);
        this.emit(socket, "computer.tool.cancel", scope, { callId });
        reject(new ComputerRuntimeError(code));
      };
      const abort = (): void => cancel("computer_cancelled");
      const timer = setTimeout(
        () => cancel("computer_timeout"),
        toolName === "mcp_computer_request_access" ? 125000 : 22000,
      );
      const pending: Pending = {
        socket,
        scope,
        toolName,
        args,
        timer,
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", abort),
      };
      this.pending.set(callId, pending);
      signal?.addEventListener("abort", abort, { once: true });
      this.emit(socket, "computer.tool.request", scope, {
        ...scope,
        callId,
        toolName,
        args,
      });
    });
  }
  handleResult(socket: WebSocket, params: ComputerToolResultParams): void {
    const pending = this.pending.get(params.callId);
    if (!pending) throw new ComputerRuntimeError("computer_call_not_found");
    if (pending.socket !== socket)
      throw new ComputerRuntimeError("computer_connection_mismatch");
    if (Buffer.byteLength(JSON.stringify(params)) > COMPUTER_RESULT_MAX_BYTES) {
      this.remove(params.callId, pending);
      pending.reject(new ComputerRuntimeError("computer_result_too_large"));
      return;
    }
    this.remove(params.callId, pending);
    if (!params.ok) {
      if (pending.toolName === "mcp_computer_request_access")
        this.audit(pending.scope, "denied", params.error.code);
      pending.reject(new ComputerRuntimeError(params.error.code));
      return;
    }
    try {
      const result =
        pending.toolName === "mcp_computer_request_access"
          ? computerAccessResultSchema.parse(params.result)
          : computerObservationSchema.parse(params.result);
      if ("observationId" in result) {
        if (
          (pending.toolName === "mcp_computer_observe" &&
            result.dataUrl !== undefined) ||
          (pending.toolName === "mcp_computer_screenshot" &&
            (!result.dataUrl ||
              result.observationId !== pending.args.observationId))
        )
          throw new ComputerRuntimeError("computer_observation_mismatch");
      }
      if (pending.toolName === "mcp_computer_request_access") {
        const grants = this.grants.get(socket) ?? new Map<string, Scope>();
        grants.set(
          `${pending.scope.sessionId}:${pending.scope.requestId}`,
          pending.scope,
        );
        this.grants.set(socket, grants);
        this.audit(pending.scope, "allowed");
      }
      pending.resolve(result);
    } catch {
      pending.reject(new ComputerRuntimeError("computer_result_invalid"));
    }
  }
  revoke(
    socket: WebSocket,
    value: Omit<Scope, "toolCallId"> & { code: string },
  ): void {
    const grants = this.grants.get(socket),
      key = `${value.sessionId}:${value.requestId}`,
      grant = grants?.get(key);
    if (!grant) return;
    if (grant.connectionId !== value.connectionId)
      throw new ComputerRuntimeError("computer_connection_mismatch");
    grants!.delete(key);
    if (!grants!.size) this.grants.delete(socket);
    this.audit(grant, "revoked", value.code);
  }
  finishTurn(sessionId: string, requestId: string, runId: string): void {
    for (const [socket, grants] of this.grants)
      for (const grant of grants.values())
        if (
          grant.sessionId === sessionId &&
          (grant.requestId === requestId || grant.runId === runId)
        )
          this.revoke(socket, { ...grant, code: "computer_turn_finished" });
  }
  detachSocket(socket: WebSocket): void {
    for (const grant of this.grants.get(socket)?.values() ?? [])
      this.audit(grant, "revoked", "computer_disconnected");
    this.grants.delete(socket);
    for (const [id, pending] of this.pending)
      if (pending.socket === socket) {
        this.remove(id, pending);
        pending.reject(new ComputerRuntimeError("computer_disconnected"));
      }
  }
  private remove(id: string, pending: Pending): void {
    clearTimeout(pending.timer);
    pending.cleanup();
    this.pending.delete(id);
  }
}
let auditQueue: Promise<void> = Promise.resolve();
export const studioComputerRuntime = new StudioComputerRuntime(
  (scope, status, code) => {
    // 审计只保存关联身份和状态，不保存窗口列表、标题或授权标识
    auditQueue = auditQueue
      .then(() =>
        appendApprovalEvent(
          scope.sessionId,
          `computer-${scope.requestId}`,
          scope.requestId,
          `computer.access.${status}`,
          { ...scope, status, ...(code ? { code } : {}) },
        ),
      )
      .catch(() => {
        logger.warn("computer", "audit_write_failed", {
          sessionId: scope.sessionId,
        });
      });
  },
);
export function getStudioComputerControl(
  socket: WebSocket,
  session: ClientSession,
  runId?: string,
): ComputerControlContext | undefined {
  const connection = getClientConnection(socket);
  if (
    connection?.clientType !== "studio" ||
    connection.capabilities.computerObservation !== true ||
    !session.sessionId ||
    session.scheduledTaskOrigin
  )
    return undefined;
  return studioComputerRuntime.createControl(socket, session, runId);
}
