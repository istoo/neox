import { describe, expect, test } from "vitest";

import {
  DaemonRuntimeStatusTracker,
  RUNTIME_STALL_THRESHOLD_MS,
  type RuntimeWindowSample,
  type RuntimeWindowSampleSource,
} from "./runtime-status.js";

function trackerWith(sample: RuntimeWindowSample, startMs = 1_000) {
  let now = startMs;
  let resets = 0;
  const source: RuntimeWindowSampleSource = {
    read: () => sample,
    reset: () => {
      resets += 1;
    },
  };
  return {
    tracker: new DaemonRuntimeStatusTracker({ source, clock: () => now }),
    advance: (ms: number) => {
      now += ms;
    },
    resets: () => resets,
  };
}

const healthySample: RuntimeWindowSample = {
  sampleCount: 1_200,
  delayP50Ms: 1.2,
  delayP99Ms: 8.4,
  delayMaxMs: 14.1,
  utilization: 0.42,
};

describe("DaemonRuntimeStatusTracker", () => {
  test("reports the current window's real samples and elapsed time", () => {
    const { tracker, advance } = trackerWith(healthySample);
    advance(5_000);

    expect(tracker.snapshot()).toEqual({
      sampleWindowMs: 5_000,
      sampleCount: 1_200,
      delayP50Ms: 1.2,
      delayP99Ms: 8.4,
      delayMaxMs: 14.1,
      utilization: 0.42,
      stallWindowCount: 0,
      maxStallMs: 0,
      lastStall: null,
    });
  });

  test("records a stall window and reports its duration and age", () => {
    const stalled: RuntimeWindowSample = { ...healthySample, delayMaxMs: 640 };
    const { tracker, advance, resets } = trackerWith(stalled);

    expect(tracker.closeWindow()).toMatchObject({ sampleWindowMs: 0, delayMaxMs: 640 });
    expect(resets()).toBe(1);

    advance(2_500);
    expect(tracker.snapshot()).toMatchObject({
      sampleWindowMs: 2_500,
      stallWindowCount: 1,
      maxStallMs: 640,
      lastStall: { durationMs: 640, ageMs: 2_500 },
    });
  });

  test("does not count ordinary delay as a stall", () => {
    const sample: RuntimeWindowSample = {
      ...healthySample,
      delayMaxMs: RUNTIME_STALL_THRESHOLD_MS - 1,
    };
    const { tracker, advance } = trackerWith(sample);

    tracker.closeWindow();
    advance(10_000);

    expect(tracker.snapshot()).toMatchObject({
      stallWindowCount: 0,
      maxStallMs: 0,
      lastStall: null,
    });
  });

  test("keeps the longest stall across later quieter windows", () => {
    let sample: RuntimeWindowSample = { ...healthySample, delayMaxMs: 900 };
    let now = 1_000;
    const tracker = new DaemonRuntimeStatusTracker({
      source: { read: () => sample, reset: () => {} },
      clock: () => now,
    });

    tracker.closeWindow();
    now += 30_000;
    sample = { ...healthySample, delayMaxMs: 300 };
    tracker.closeWindow();
    now += 30_000;

    expect(tracker.snapshot()).toMatchObject({
      stallWindowCount: 2,
      maxStallMs: 900,
      lastStall: { durationMs: 300, ageMs: 30_000 },
    });
  });
});
