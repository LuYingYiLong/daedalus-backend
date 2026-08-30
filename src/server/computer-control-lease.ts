import type { ComputerControlUpdate } from "../protocol/computer-observation.js";

/** 仅记录 Main 已核验的权限，不根据模型参数创建授权 */
export class ComputerControlLease {
  private sequence = -1;
  private lastHeartbeat = Date.now();
  private pausedAt: number | null = null;
  private waiters = new Set<() => void>();
  private timer: NodeJS.Timeout;
  private ended = false;
  private currentGeneration: number;
  constructor(
    generation: number,
    private readonly cancelRun: (code: string) => void,
    private readonly modeUnchanged: () => boolean,
    awaitingFirstHeartbeat = false,
  ) {
    if (awaitingFirstHeartbeat) this.pausedAt = Date.now();
    this.currentGeneration = generation;
    this.timer = setInterval(() => this.check(), 500);
    this.timer.unref();
  }
  get generation(): number { return this.currentGeneration; }
  get active(): boolean { return !this.ended; }
  get paused(): boolean { return this.pausedAt !== null; }
  update(value: ComputerControlUpdate): void {
    if (this.ended) throw new Error("computer_access_revoked");
    if (value.generation < this.currentGeneration || value.sequence <= this.sequence || (this.sequence >= 0 && this.paused && value.state === "running" && value.generation <= this.currentGeneration))
      throw new Error("computer_update_stale");
    if (!this.modeUnchanged()) { this.cancel("computer_approval_mode_changed"); return; }
    this.sequence = value.sequence;
    this.currentGeneration = value.generation;
    this.lastHeartbeat = Date.now();
    if (value.state === "cancelled") { this.cancel(value.code ?? "computer_cancelled"); return; }
    if (value.state === "paused") this.pausedAt ??= Date.now();
    else { this.pausedAt = null; this.wake(); }
  }
  private check(): void {
    if (!this.modeUnchanged()) this.cancel("computer_approval_mode_changed");
    else if (Date.now() - this.lastHeartbeat > 5000) this.cancel("computer_heartbeat_timeout");
    else if (this.pausedAt !== null && Date.now() - this.pausedAt >= 300000) this.cancel("computer_pause_timeout");
  }
  async wait(signal?: AbortSignal): Promise<void> {
    while (this.pausedAt !== null && !this.ended) {
      if (signal?.aborted) throw new Error("computer_cancelled");
      await new Promise<void>(resolve => {
        const done = (): void => { this.waiters.delete(done); signal?.removeEventListener("abort", done); resolve(); };
        this.waiters.add(done);
        signal?.addEventListener("abort", done, { once: true });
      });
    }
    if (this.ended || signal?.aborted) throw new Error("computer_cancelled");
  }
  cancel(code: string): void {
    if (this.ended) return;
    this.close();
    this.cancelRun(code);
  }
  close(): void { this.ended = true; clearInterval(this.timer); this.wake(); }
  private wake(): void { for (const resolve of [...this.waiters]) resolve(); }
}
