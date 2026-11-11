import type { PreventSleepMode } from "../settings/desktop-settings.js";

/**
 * myna's awake package (magpie/internal/awake/awake.go:1): holding sleep off
 * only while agents are at work. The app turns the preference on, but the
 * blocker runs only while the gateway has a request in flight, an agent is
 * running, or one stopped less than {@link AWAKE_GRACE_MS} ago — an agent
 * running a build or the tests between two requests. Idle means the computer
 * may sleep.
 *
 * The renderer reports activity (it can see the sessions and the gateway
 * trace); this controller owns the timing so the grace period survives a
 * hidden or reloading renderer.
 */
export const AWAKE_GRACE_MS = 10 * 60 * 1000;

/** How long a "busy" report stays trusted without another one. */
export const AWAKE_STALE_MS = 30 * 1000;

export type AwakeLevel = "system" | "display";

export interface AwakeControllerDeps {
  start(level: AwakeLevel): void;
  stop(): void;
  now?(): number;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export interface AwakeController {
  /** Applies the preference; `off` releases a held blocker at once. */
  setMode(mode: PreventSleepMode): void;
  /** The renderer's report: any agent running, or the gateway busy. */
  reportBusy(busy: boolean): void;
  /** Test seam: release the blocker and forget the timers. */
  dispose(): void;
}

export function createAwakeController(deps: AwakeControllerDeps): AwakeController {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer =
    deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let mode: PreventSleepMode = "off";
  let busy = false;
  let lastBusyAt: number | null = null;
  let lastReportAt: number | null = null;
  let held: AwakeLevel | null = null;
  let timer: unknown = null;

  function release(): void {
    if (held === null) {
      return;
    }
    deps.stop();
    held = null;
  }

  function schedule(): void {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (mode === "off") {
      return;
    }
    const at = now();
    let next: number | null = null;
    if (busy && lastReportAt !== null) {
      // A renderer that stops reporting (window closed, crash) must not keep
      // the computer awake forever.
      next = lastReportAt + AWAKE_STALE_MS;
    } else if (!busy && lastBusyAt !== null) {
      next = lastBusyAt + AWAKE_GRACE_MS;
    }
    if (next === null || next <= at) {
      return;
    }
    timer = setTimer(evaluate, next - at);
  }

  function evaluate(): void {
    const at = now();
    if (busy && lastReportAt !== null && at - lastReportAt >= AWAKE_STALE_MS) {
      busy = false;
      lastBusyAt = lastReportAt;
    }
    const withinGrace = lastBusyAt !== null && at - lastBusyAt < AWAKE_GRACE_MS;
    const want = mode !== "off" && (busy || withinGrace);
    if (want) {
      const level: AwakeLevel = mode === "display" ? "display" : "system";
      if (held !== level) {
        release();
        try {
          deps.start(level);
          held = level;
        } catch {
          // A platform without the blocker: leave it released, as myna does.
          held = null;
        }
      }
    } else {
      release();
    }
    schedule();
  }

  return {
    setMode(next: PreventSleepMode): void {
      if (next === mode) {
        return;
      }
      mode = next;
      evaluate();
    },
    reportBusy(next: boolean): void {
      const at = now();
      lastReportAt = at;
      if (next === busy) {
        // An unchanged report still refreshes the stale deadline.
        if (busy) {
          schedule();
        }
        return;
      }
      busy = next;
      if (next) {
        lastBusyAt = null;
      } else {
        lastBusyAt = at;
      }
      evaluate();
    },
    dispose(): void {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      release();
      mode = "off";
      busy = false;
      lastBusyAt = null;
      lastReportAt = null;
    },
  };
}
