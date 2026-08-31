import { createHash } from "node:crypto";
import type WebSocket from "ws";
import type { ComputerLocateExecution } from "../tools/computer-tools.js";
import { computerGroundingFrameSchema } from "../protocol/computer-observation.js";
import { computerGroundingResultSchema, computerGroundingValidationSchema, type ComputerGroundingResult } from "../protocol/computer-grounding.js";

export type GroundingScope = { connectionId: string; sessionId: string; requestId: string; runId: string };
type Job = {
  socket: WebSocket; scope: GroundingScope; argsHash: string; controller: AbortController;
  promise: Promise<ComputerGroundingResult>; generation?: number; live: boolean;
};
type Receipt = { socket: WebSocket; scope: GroundingScope; result: ComputerGroundingResult };
type Forward = (operation: "grounding.prepare" | "grounding.validate", args: Record<string, unknown>, signal: AbortSignal) => Promise<Record<string, unknown>>;
const same = (a: GroundingScope, b: GroundingScope): boolean =>
  a.connectionId === b.connectionId && a.sessionId === b.sessionId && a.requestId === b.requestId && a.runId === b.runId;
const identity = (scope: GroundingScope): string => JSON.stringify([scope.connectionId, scope.sessionId, scope.requestId, scope.runId]);

// 这里只保存定位调用和候选回执；授权事实始终由既有 runtime/Main 校验
export class ComputerGroundingRuntime {
  private readonly jobs = new Map<string, Job>();
  private readonly receipts = new Map<string, Receipt>();
  private readonly localizedFrames = new Map<string, { socket: WebSocket; scope: GroundingScope }>();

  run(socket: WebSocket, scope: GroundingScope, input: ComputerLocateExecution, forward: Forward, assertAuthorized: () => void): Promise<ComputerGroundingResult> {
    const key = JSON.stringify([identity(scope), input.toolCallId]);
    const argsHash = createHash("sha256").update(JSON.stringify(input.args)).digest("hex");
    const previous = this.jobs.get(key);
    if (previous) {
      if (previous.socket !== socket || previous.argsHash !== argsHash) return Promise.reject(new Error("computer_grounding_mismatch"));
      if (!previous.live) return Promise.reject(new Error("computer_grounding_stale"));
      return previous.promise;
    }
    if (this.busy(scope.sessionId))
      return Promise.reject(new Error("computer_busy"));
    const controller = new AbortController();
    const job: Job = { socket, scope, argsHash, controller, live: true, generation: -1, promise: undefined as unknown as Promise<ComputerGroundingResult> };
    this.jobs.set(key, job);
    const signal = controller.signal;
    const assertCurrent = (): void => {
      if (signal.aborted || !job.live) throw signal.reason instanceof Error ? signal.reason : new Error("computer_grounding_stale");
      assertAuthorized();
    };
    const isCurrent = (): boolean => { try { assertCurrent(); return true; } catch { return false; } };
    const cancel = (): void => controller.abort(new Error("computer_cancelled"));
    input.signal?.addEventListener("abort", cancel, { once: true });
    if (input.signal?.aborted) cancel();
    const groundingId = `grounding-${createHash("sha256").update(key).digest("hex")}`;
    const operation = async (): Promise<ComputerGroundingResult> => {
      assertCurrent();
      const frame = computerGroundingFrameSchema.parse(await forward("grounding.prepare", { observationId: input.args.observationId }, signal));
      assertCurrent();
      if (frame.observation.observationId !== input.args.observationId) throw new Error("computer_observation_mismatch");
      job.generation = frame.generation;
      this.localizedFrames.set(JSON.stringify([identity(scope), input.args.observationId]), { socket, scope });
      const timer = setTimeout(() => controller.abort(new Error("computer_grounding_timeout")), 60_000);
      let result: ComputerGroundingResult;
      try {
        result = computerGroundingResultSchema.parse(await raceAbort(input.infer(frame, groundingId, signal), signal));
      } finally { clearTimeout(timer); }
      assertCurrent();
      if (result.groundingId !== groundingId || result.observationId !== input.args.observationId || result.generation !== frame.generation || result.uiaAction !== (input.args.uiaAction ?? "uia_invoke")) throw new Error("computer_grounding_mismatch");
      const valid = computerGroundingValidationSchema.parse(await forward("grounding.validate", { observationId: result.observationId, generation: frame.generation }, signal));
      assertCurrent();
      if (valid.observationId !== result.observationId || valid.generation !== frame.generation) throw new Error("computer_grounding_stale");
      await input.persist(result, isCurrent);
      assertCurrent();
      this.receipts.set(groundingId, { socket, scope, result });
      return result;
    };
    this.running.add(job);
    job.promise = raceAbort(operation(), signal).finally(() => {
      this.running.delete(job);
      input.signal?.removeEventListener("abort", cancel);
    });
    void job.promise.catch(() => {});
    return job.promise;
  }
  private readonly running = new Set<Job>();
  busy(sessionId: string): boolean { return [...this.running].some(job => job.scope.sessionId === sessionId && job.live); }

  assertAction(socket: WebSocket, scope: GroundingScope, args: Record<string, unknown>): void {
    const action = args.action as Record<string, unknown>;
    const required = "nodeId" in action && this.localizedFrames.has(JSON.stringify([identity(scope), args.observationId]));
    if (args.groundingId === undefined) {
      if (required) throw new Error("computer_grounding_required");
      return;
    }
    const receipt = this.receipts.get(String(args.groundingId));
    if (!receipt || receipt.socket !== socket || !same(receipt.scope, scope)) throw new Error("computer_grounding_stale");
    const result = receipt.result;
    if (result.observationId !== args.observationId || result.status !== "matched" || result.uiaAction !== action.type || result.candidates.length !== 1 || result.candidates[0]?.nodeId !== action.nodeId || !result.candidates[0]?.supportedActions?.includes(result.uiaAction))
      throw new Error("computer_grounding_mismatch");
  }

  invalidate(matches: (socket: WebSocket, scope: GroundingScope) => boolean, code = "computer_grounding_stale", forget = false): void {
    for (const [key, job] of this.jobs) if (matches(job.socket, job.scope)) {
      job.live = false;
      job.controller.abort(new Error(code));
      if (forget) this.jobs.delete(key);
    }
    for (const [key, receipt] of this.receipts) if (matches(receipt.socket, receipt.scope)) this.receipts.delete(key);
    if (forget) for (const [key, frame] of this.localizedFrames) if (matches(frame.socket, frame.scope)) this.localizedFrames.delete(key);
  }
  update(socket: WebSocket, scope: GroundingScope, generation: number, state: string): void {
    if (state !== "running" || [...this.jobs.values()].some(job => job.socket === socket && same(job.scope, scope) && job.live && job.generation !== undefined && job.generation >= 0 && job.generation !== generation))
      this.invalidate((owner, candidate) => owner === socket && same(candidate, scope));
  }
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason ?? new Error("computer_cancelled"));
    if (signal.aborted) { void promise.catch(() => {}); abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
