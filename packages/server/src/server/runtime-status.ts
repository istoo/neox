// The daemon's own runtime health: how well its main event loop is keeping up, sampled over the
// same window as the websocket runtime metrics. Delay percentiles are the honest signal for a
// busy host; process CPU alone cannot say whether terminals and agent streams waited in a queue.
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

/** A main-loop delay at or above this is a stall, not ordinary timer jitter. */
export const RUNTIME_STALL_THRESHOLD_MS = 250;

/** One window's samples, read without resetting the monitor. */
export interface RuntimeWindowSample {
  readonly sampleCount: number;
  readonly delayP50Ms: number;
  readonly delayP99Ms: number;
  readonly delayMaxMs: number;
  readonly utilization: number;
}

export interface RuntimeWindowSampleSource {
  read(): RuntimeWindowSample;
  reset(): void;
  dispose?(): void;
}

export interface DaemonRuntimeStatusSnapshot extends RuntimeWindowSample {
  readonly sampleWindowMs: number;
  /** Completed windows whose longest delay reached {@link RUNTIME_STALL_THRESHOLD_MS}. */
  readonly stallWindowCount: number;
  /** The longest stall since the daemon started. */
  readonly maxStallMs: number;
  readonly lastStall: { readonly durationMs: number; readonly ageMs: number } | null;
}

function createProcessRuntimeSampleSource(): RuntimeWindowSampleSource {
  const monitor = monitorEventLoopDelay({ resolution: 10 });
  monitor.enable();
  // eventLoopUtilization's delta form reports active/(active+idle) since the baseline without
  // resetting any shared state, so reading it on demand cannot disturb the flush window.
  let utilizationBaseline = performance.eventLoopUtilization();
  const toMs = (nanoseconds: number): number => Math.round(nanoseconds / 1e5) / 10;
  return {
    read() {
      const utilization = performance.eventLoopUtilization(utilizationBaseline).utilization;
      return {
        sampleCount: monitor.count,
        delayP50Ms: toMs(monitor.percentile(50)),
        delayP99Ms: toMs(monitor.percentile(99)),
        delayMaxMs: toMs(monitor.max),
        utilization: Math.min(1, Math.max(0, utilization)),
      };
    },
    reset() {
      monitor.reset();
      utilizationBaseline = performance.eventLoopUtilization();
    },
    dispose() {
      monitor.disable();
    },
  };
}

/**
 * Tracks the current event-loop window and the stall history across windows. `snapshot()` is
 * read-only and safe to call on every settings request; `closeWindow()` is what the metrics
 * flush calls, and it starts the next window.
 */
export class DaemonRuntimeStatusTracker {
  private readonly source: RuntimeWindowSampleSource;
  private readonly clock: () => number;
  private windowStartedAtMs: number;
  private stallWindowCount = 0;
  private maxStallMs = 0;
  private lastStallAtMs: number | null = null;
  private lastStallDurationMs = 0;

  constructor(
    options: {
      readonly source?: RuntimeWindowSampleSource;
      readonly clock?: () => number;
    } = {},
  ) {
    this.source = options.source ?? createProcessRuntimeSampleSource();
    this.clock = options.clock ?? Date.now;
    this.windowStartedAtMs = this.clock();
  }

  snapshot(): DaemonRuntimeStatusSnapshot {
    return this.read(this.clock());
  }

  /** Records a stall if this window had one, then starts a fresh window. */
  closeWindow(): DaemonRuntimeStatusSnapshot {
    const now = this.clock();
    const snapshot = this.read(now);
    if (snapshot.delayMaxMs >= RUNTIME_STALL_THRESHOLD_MS) {
      this.stallWindowCount += 1;
      this.lastStallAtMs = now;
      this.lastStallDurationMs = snapshot.delayMaxMs;
      this.maxStallMs = Math.max(this.maxStallMs, snapshot.delayMaxMs);
    }
    this.source.reset();
    this.windowStartedAtMs = now;
    return snapshot;
  }

  dispose(): void {
    this.source.dispose?.();
  }

  private read(now: number): DaemonRuntimeStatusSnapshot {
    const sample = this.source.read();
    return {
      ...sample,
      sampleWindowMs: Math.max(0, now - this.windowStartedAtMs),
      stallWindowCount: this.stallWindowCount,
      maxStallMs: this.maxStallMs,
      lastStall:
        this.lastStallAtMs === null
          ? null
          : {
              durationMs: this.lastStallDurationMs,
              ageMs: Math.max(0, now - this.lastStallAtMs),
            },
    };
  }
}
