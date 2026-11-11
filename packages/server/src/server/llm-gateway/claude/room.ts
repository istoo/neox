/** In every no-room answer, as myna's routing finds it to try another account. */
export const CLAUDE_NO_ROOM_SAID = "Claude Code processes are running, as many as may run at once";

/** An ask that found no room within the wait. */
export class ClaudeRoomFullError extends Error {
  public readonly status = 503;
  public readonly live: number;
  public readonly most: number;
  public readonly why: string;

  public constructor(live: number, most: number, why: string, waitedMs: number) {
    super(
      `${live} ${CLAUDE_NO_ROOM_SAID} (${why}); none ended within ${waitedMs / 1000}s. ` +
        "Set how many may run with claudeRunsMost in the gateway config",
    );
    this.name = "ClaudeRoomFullError";
    this.live = live;
    this.most = most;
    this.why = why;
  }
}

export interface ClaudeRoomOptions {
  /** How many processes may run at once; 0 or less means no bound. */
  most: number | (() => number);
  /** Why that many, for the log and the error. */
  why?: string;
  waitMs?: number;
  /** Lets one run go for room; true when it found one. */
  onPressure?: (most: number) => boolean;
  now?: () => number;
}

/**
 * The places Claude Code processes may take: each conversation's run, busy,
 * waiting for its next turn or on its caller's tool results, and each
 * one-off ask. Each holds about 100 MiB of its own, so how many run is
 * bounded by the machine's memory, and a new ask lets an idle run go before
 * it waits.
 */
export class ClaudeRoom {
  private readonly options: ClaudeRoomOptions;
  private liveCount = 0;
  private leavingCount = 0;
  private waitingCount = 0;
  private waiters: Array<() => void> = [];

  public constructor(options: ClaudeRoomOptions) {
    this.options = options;
  }

  /** Lets the bridge say which runs may be let go, once it exists. */
  public setPressure(pressure: (most: number) => boolean): void {
    this.options.onPressure = pressure;
  }

  public get most(): number {
    return this.mostNow();
  }

  public get why(): string {
    return this.options.why ?? "memory";
  }

  public get live(): number {
    return this.liveCount;
  }

  public get leaving(): number {
    return this.leavingCount;
  }

  public get waiting(): number {
    return this.waitingCount;
  }

  /**
   * Waits for room for one process, and answers the function that frees it
   * once the process has ended (its argument says the bridge ended it).
   */
  public async take(): Promise<(left: boolean) => void> {
    const began = this.now();
    const deadline = began + (this.options.waitMs ?? 2 * 60_000);
    let waiting = false;
    let pressured = false;
    try {
      for (;;) {
        const most = this.mostNow();
        if (most <= 0 || this.liveCount < most) {
          this.liveCount += 1;
          let released = false;
          return (left: boolean) => {
            if (released) {
              return;
            }
            released = true;
            this.release(left);
          };
        }
        if (!waiting) {
          waiting = true;
          this.waitingCount += 1;
        }
        const over = this.liveCount - this.leavingCount >= most;
        if (!pressured && over && this.leavingCount < this.waitingCount) {
          pressured = true;
          if (this.options.onPressure?.(most) === true) {
            continue;
          }
        }
        const remaining = deadline - this.now();
        if (remaining <= 0) {
          throw new ClaudeRoomFullError(
            this.liveCount,
            most,
            this.options.why ?? "memory",
            this.options.waitMs ?? 2 * 60_000,
          );
        }
        await this.waitFor(remaining);
      }
    } finally {
      if (waiting) {
        this.waitingCount -= 1;
      }
    }
  }

  /** Counts a process the bridge has asked to end as ending. */
  public leave(): void {
    this.leavingCount += 1;
  }

  /** Has the asks waiting for room look again: a run came to wait for its next turn. */
  public nudge(): void {
    for (const wake of this.waiters.splice(0)) {
      wake();
    }
  }

  private release(left: boolean): void {
    this.liveCount -= 1;
    if (left) {
      this.leavingCount -= 1;
    }
    this.nudge();
  }

  private waitFor(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const settle = () => {
        if (done) {
          return;
        }
        done = true;
        resolve();
      };
      const wake = () => {
        clearTimeout(timer);
        settle();
      };
      const timer = setTimeout(() => {
        const at = this.waiters.indexOf(wake);
        if (at >= 0) {
          this.waiters.splice(at, 1);
        }
        settle();
      }, ms);
      this.waiters.push(wake);
    });
  }

  private mostNow(): number {
    return typeof this.options.most === "function" ? this.options.most() : this.options.most;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

/** How many processes limit bytes of memory hold: (MiB - 256) / 128, at least 1. */
export function runsForMemory(limitBytes: number): number {
  return Math.max(Math.floor((limitBytes / (1 << 20) - 256) / 128), 1);
}

/**
 * How many processes this machine's memory holds, and why; 0 when not known,
 * which is no bound: a limit not known is not a small one.
 */
export function runsMostFor(platform: NodeJS.Platform, memoryLimitBytes: number): number {
  if (platform !== "linux" || memoryLimitBytes <= 0) {
    return 0;
  }
  return runsForMemory(memoryLimitBytes);
}
