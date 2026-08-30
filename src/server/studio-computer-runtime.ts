import { randomUUID, createHash } from "node:crypto";
import WebSocket from "ws";
import {
  computerAccessResultSchema,
  computerArgsSchemas,
  computerObservationSchema,
  computerActionResultSchema,
  type ComputerControlUpdate,
  COMPUTER_RESULT_MAX_BYTES,
  type ComputerToolResultParams,
  type ComputerToolName,
} from "../protocol/computer-observation.js";
import type { ComputerControlContext } from "../tools/computer-tools.js";
import type { ClientSession } from "./client-session.js";
import { getClientConnection, getActiveSessionRunController } from "./client-connections.js";
import { ComputerControlLease } from "./computer-control-lease.js";
import { sendJson } from "./send-json.js";

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
  control?: { approvalMode: "manual" | "auto-safe" | "full-trust"; cancel(code: string): void; modeUnchanged(): boolean };
  actionId?: string;
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
  private controls = new Map<WebSocket, { scope: Scope; lease: ComputerControlLease }>();
  private actions = new Map<string, Promise<Record<string, unknown>>>();
  private actionScopes = new Map<string, { socket: WebSocket; scope: Scope; argsHash: string }>();
  constructor(
    private readonly audit: (
      scope: Scope,
      status: string,
      code?: string,
      summary?: Record<string, unknown>,
    ) => void = () => {},
  ) {}
  private sequence = 0;
  createControl(
    socket: WebSocket,
    session: ClientSession,
    explicitRunId?: string,
    inputAllowed = true,
  ): ComputerControlContext {
    const findRun = (requestId: string) =>
      [...session.agentRuns.values()].reverse().find(
        (run) =>
          (run.requestId === requestId || run.rootRequestId === requestId) &&
          (!explicitRunId || run.runId === explicitRunId),
      );
    return {
      inputAllowed: inputAllowed && getClientConnection(socket)?.capabilities.computerControl === true,
      withInputPolicy: allowed => this.createControl(socket, session, explicitRunId, allowed),
      hasControl: requestId => {
        const control = this.controls.get(socket);
        const run = findRun(requestId);
        return control?.scope.requestId === (run?.rootRequestId ?? requestId) && control.scope.runId === (explicitRunId ?? run?.runId ?? requestId) && control.lease.active && !control.lease.paused;
      },
      waitUntilRunning: async (requestId, signal) => {
        const control = this.controls.get(socket);
        const run = findRun(requestId);
        if (control?.scope.requestId === (run?.rootRequestId ?? requestId) && control.scope.runId === (explicitRunId ?? run?.runId ?? requestId)) await control.lease.wait(signal);
      },
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
        const controlRequested = toolName === "mcp_computer_action" || (toolName === "mcp_computer_request_access" && args.mode === "control");
        if (controlRequested && (!inputAllowed || connection.capabilities.computerControl !== true))
          return Promise.reject(new ComputerRuntimeError("computer_read_only"));
        if (toolName === "mcp_computer_action" && (!this.controls.get(socket)?.lease.active || this.controls.get(socket)?.scope.requestId !== scope.requestId || this.controls.get(socket)?.scope.runId !== scope.runId))
          return Promise.reject(new ComputerRuntimeError("computer_consent_required"));
        const approvalMode = session.approvalGateway.getMode();
        // 捕获当前控制器，而非取消时寻找任意活动轮次
        const controller = session.activeAbortControllers.get(requestId) ?? getActiveSessionRunController(session.sessionId, requestId)?.controller;
        if (controlRequested && !controller) return Promise.reject(new ComputerRuntimeError("computer_run_unavailable"));
        const control = controlRequested ? {
          approvalMode,
          modeUnchanged: () => session.approvalGateway.getMode() === approvalMode,
          cancel: (code: string): void => {
            controller?.abort();
            void import("./approval-continuation.js").then(m => m.cancelPendingApprovalsForRequest(session, requestId)).catch(() => {});
            void import("./tool-budget-continuation.js").then(m => m.cancelPendingToolBudgetsForRequest(session, requestId)).catch(() => {});
            this.emit(socket, "computer.tool.cancel", scope, { scope, code, control: true });
          },
        } : undefined;
        return this.execute(socket, scope, toolName, args, signal, control);
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
    control?: Pending["control"],
  ): Promise<Record<string, unknown>> {
    const args = computerArgsSchemas[toolName].parse(rawArgs);
    if (socket.readyState !== WebSocket.OPEN || signal?.aborted)
      return Promise.reject(new ComputerRuntimeError("computer_disconnected"));
    if (this.pending.size >= 32)
      return Promise.reject(new ComputerRuntimeError("computer_busy"));
    const callId = `computer-${randomUUID()}`;
    const actionId = toolName === "mcp_computer_action" ? `action-${createHash("sha256").update(JSON.stringify([scope.connectionId, scope.sessionId, scope.requestId, scope.runId, scope.toolCallId])).digest("hex")}` : undefined;
    const argsHash = createHash("sha256").update(JSON.stringify(args)).digest("hex");
    if (actionId && this.actions.has(actionId)) {
      if (this.actionScopes.get(actionId)?.argsHash !== argsHash) return Promise.reject(new ComputerRuntimeError("computer_action_mismatch"));
      return this.actions.get(actionId)!;
    }
    if (toolName === "mcp_computer_request_access")
      this.audit(scope, "requested");
    const operation = new Promise<Record<string, unknown>>((resolve, reject) => {
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
        ...(control ? { control } : {}),
        ...(actionId ? { actionId } : {}),
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
        ...(control ? { authorization: { approvalMode: control.approvalMode } } : {}),
        ...(actionId ? { actionId } : {}),
      });
    });
    if (actionId) {
      this.actions.set(actionId, operation);
      this.actionScopes.set(actionId, { socket, scope, argsHash });
      // 只在轮次释放时清除幂等结果；超时和未知结果同样不能重发输入
      void operation.catch(() => {});
    }
    return operation;
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
      if (pending.actionId) this.audit(pending.scope, "action_failed", params.error.code, { actionId: pending.actionId, observationId: pending.args.observationId, actionType: (pending.args.action as Record<string, unknown>)?.type });
      pending.reject(new ComputerRuntimeError(params.error.code));
      return;
    }
    try {
      const result =
        pending.toolName === "mcp_computer_request_access"
          ? computerAccessResultSchema.parse(params.result)
          : pending.toolName === "mcp_computer_action" ? computerActionResultSchema.parse(params.result) : computerObservationSchema.parse(params.result);
      if ("actionId" in result && (result.actionId !== pending.actionId || result.observationId !== pending.args.observationId))
        throw new ComputerRuntimeError("computer_action_mismatch");
      if ("nodes" in result) {
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
        if (pending.args.mode === "control") {
          if (!("mode" in result) || result.mode !== "control" || !result.generation || !pending.control)
            throw new ComputerRuntimeError("computer_consent_required");
          this.controls.get(socket)?.lease.close();
          const metadata = pending.control;
          const lease = new ComputerControlLease(result.generation, code => { metadata.cancel(code); this.audit(pending.scope, "cancelled", code); }, metadata.modeUnchanged, true);
          this.controls.set(socket, { scope: pending.scope, lease });
        } else if ("mode" in result && result.mode === "control") throw new ComputerRuntimeError("computer_result_invalid");
        const grants = this.grants.get(socket) ?? new Map<string, Scope>();
        grants.set(
          `${pending.scope.sessionId}:${pending.scope.requestId}`,
          pending.scope,
        );
        this.grants.set(socket, grants);
        this.audit(pending.scope, pending.args.mode === "control" && pending.control?.approvalMode === "full-trust" ? "auto_allowed" : "allowed");
      }
      if ("actionId" in result) this.audit(pending.scope, "action_dispatched", undefined, { ...result, actionType: (pending.args.action as Record<string, unknown>)?.type });
      pending.resolve(result);
    } catch {
      pending.reject(new ComputerRuntimeError("computer_result_invalid"));
    }
  }
  revoke(
    socket: WebSocket,
    value: Omit<Scope, "toolCallId"> & { code: string },
  ): void {
    // 启动覆盖层后、grant result 到达前也可能取消，必须停止该请求的模型控制器
    for (const [id, pending] of this.pending) {
      if (pending.socket !== socket || !pending.control || !["connectionId", "sessionId", "requestId", "runId"].every(key => pending.scope[key as keyof Scope] === value[key as keyof typeof value])) continue;
      this.remove(id, pending);
      if (value.code !== "computer_turn_finished") pending.control.cancel(value.code);
      pending.reject(new ComputerRuntimeError(value.code));
      this.audit(pending.scope, "cancelled", value.code);
    }
    const grants = this.grants.get(socket),
      key = `${value.sessionId}:${value.requestId}`,
      grant = grants?.get(key);
    if (!grant) return;
    if (grant.connectionId !== value.connectionId)
      throw new ComputerRuntimeError("computer_connection_mismatch");
    if (grant.runId !== value.runId) throw new ComputerRuntimeError("computer_scope_mismatch");
    const control = this.controls.get(socket);
    if (control?.scope.requestId === value.requestId) {
      if (value.code === "computer_turn_finished") control.lease.close();
      else control.lease.cancel(value.code);
      this.controls.delete(socket);
    }
    grants!.delete(key);
    if (!grants!.size) this.grants.delete(socket);
    this.audit(grant, "revoked", value.code);
  }
  updateControl(socket: WebSocket, value: ComputerControlUpdate): void {
    const control = this.controls.get(socket);
    if (!control || ["connectionId", "sessionId", "requestId", "runId"].some(key => control.scope[key as keyof Scope] !== value[key as keyof ComputerControlUpdate]))
      throw new ComputerRuntimeError("computer_scope_mismatch");
    const wasPaused = control.lease.paused;
    control.lease.update(value);
    if (control.lease.active && wasPaused !== control.lease.paused) this.audit(control.scope, control.lease.paused ? "paused" : "resumed", value.code);
  }
  finishTurn(sessionId: string, requestId: string, runId: string): void {
    for (const [id, { scope }] of this.actionScopes) if (scope.sessionId === sessionId && (scope.requestId === requestId || scope.runId === runId)) { this.actions.delete(id); this.actionScopes.delete(id); }
    for (const [socket, grants] of this.grants)
      for (const grant of grants.values())
        if (
          grant.sessionId === sessionId &&
          (grant.requestId === requestId || grant.runId === runId)
        )
          this.revoke(socket, { ...grant, code: "computer_turn_finished" });
  }
  detachSocket(socket: WebSocket): void {
    for (const [id, action] of this.actionScopes) if (action.socket === socket) { this.actions.delete(id); this.actionScopes.delete(id); }
    this.controls.get(socket)?.lease.cancel("computer_disconnected");
    this.controls.delete(socket);
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
  (scope, status, code, summary) => {
    // 审计只保存关联身份和状态，不保存窗口列表、标题或授权标识
    auditQueue = auditQueue
      .then(async () =>
        (await import("../session/session-store.js")).appendApprovalEvent(
          scope.sessionId,
          `computer-${scope.requestId}`,
          scope.requestId,
          `computer.access.${status}`,
          { ...scope, ...summary, status, ...(code ? { code } : {}) },
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
