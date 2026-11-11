/**
 * A gateway that has served a burst holds what the burst left: Node keeps
 * freed pages until its next collection, and a tray daemon can sit above what
 * it serves with. Once the gateway has had nothing in flight for IDLE_MS, a
 * collection is asked for (myna's idle_memory.go calls runtime's
 * FreeOSMemory).
 *
 * debt: Node exposes no FreeOSMemory; this calls `global.gc` when the process
 * runs with --expose-gc, and is a no-op otherwise. Run the daemon with
 * NODE_OPTIONS=--expose-gc to have it hand memory back.
 */

export const IDLE_RELEASE_MS = 30_000;

export class IdleMemory {
  private inFlight = 0;
  private lastDone = 0;
  private timer: NodeJS.Timeout | null = null;
  private released = 0;

  constructor(
    private readonly idleMs: number = IDLE_RELEASE_MS,
    private readonly release: () => void = defaultRelease,
    private readonly now: () => number = Date.now,
  ) {}

  /** A request began. */
  public begin(): void {
    this.inFlight += 1;
    this.stop();
  }

  /** A request ended; the release is armed for IDLE_MS from now. */
  public end(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.lastDone = this.now();
    if (this.inFlight === 0) {
      this.arm(this.idleMs);
    }
  }

  public releases(): number {
    return this.released;
  }

  public dispose(): void {
    this.stop();
  }

  private arm(delayMs: number): void {
    this.stop();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.releaseIfResting();
    }, delayMs);
    this.timer.unref();
  }

  private releaseIfResting(): void {
    if (this.inFlight > 0) {
      return;
    }
    const waited = this.now() - this.lastDone;
    if (waited < this.idleMs) {
      this.arm(this.idleMs - waited);
      return;
    }
    this.released += 1;
    this.release();
  }

  private stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

function defaultRelease(): void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc === "function") {
    gc();
  }
}
