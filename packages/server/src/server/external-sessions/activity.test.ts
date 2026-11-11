import { describe, expect, it } from "vitest";
import { IDLE_GAP_MS, activityDate, activityOfSpans } from "./activity.js";
import type { SessionTraceSpan } from "./trace-spans.js";

function at(date: string): number {
  return new Date(`${date}T00:00:00`).getTime();
}

function span(overrides: Partial<SessionTraceSpan>): SessionTraceSpan {
  return {
    id: "span",
    traceId: "trace",
    name: "model response",
    kind: "generation",
    startMs: 0,
    endMs: 0,
    ...overrides,
  };
}

describe("activityOfSpans", () => {
  it("puts each response's tokens on its own local day", () => {
    const activity = activityOfSpans([
      span({
        startMs: at("2026-09-20") + 60_000,
        endMs: at("2026-09-20") + 120_000,
        tokens: { input: 100, output: 50, cacheRead: 20, cacheWrite: 0 },
      }),
      span({
        startMs: at("2026-09-21") + 60_000,
        endMs: at("2026-09-21") + 120_000,
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 2 },
      }),
    ]);

    expect(activity).toEqual([
      {
        date: "2026-09-20",
        tokens: { input: 100, output: 50, cacheRead: 20, cacheWrite: 0 },
        activeSeconds: 60,
        models: [],
      },
      {
        date: "2026-09-21",
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 2 },
        activeSeconds: 60,
        models: [],
      },
    ]);
  });

  it("splits a day's tokens by the model each response named", () => {
    const activity = activityOfSpans([
      span({
        startMs: at("2026-09-20") + 60_000,
        endMs: at("2026-09-20") + 120_000,
        model: "claude-opus-5-5",
        tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
      }),
      span({
        startMs: at("2026-09-20") + 180_000,
        endMs: at("2026-09-20") + 240_000,
        model: "claude-haiku-5-5",
        tokens: { input: 20, output: 10, cacheRead: 5, cacheWrite: 0 },
      }),
      span({
        startMs: at("2026-09-20") + 300_000,
        endMs: at("2026-09-20") + 360_000,
        model: "claude-opus-5-5",
        tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      }),
    ]);

    expect(activity).toEqual([
      {
        date: "2026-09-20",
        tokens: { input: 121, output: 62, cacheRead: 5, cacheWrite: 0 },
        activeSeconds: 300,
        models: [
          {
            model: "claude-opus-5-5",
            tokens: { input: 101, output: 52, cacheRead: 0, cacheWrite: 0 },
          },
          {
            model: "claude-haiku-5-5",
            tokens: { input: 20, output: 10, cacheRead: 5, cacheWrite: 0 },
          },
        ],
      },
    ]);
  });

  it("counts the gaps under five minutes as work, on the later line's day", () => {
    const base = at("2026-09-20") + 9 * 3_600_000;
    const activity = activityOfSpans([
      span({ startMs: base, endMs: base + 60_000 }),
      span({ startMs: base + 120_000, endMs: base + 180_000 }),
      // A pause over the gap is not work.
      span({ startMs: base + IDLE_GAP_MS + 200_000, endMs: base + IDLE_GAP_MS + 260_000 }),
    ]);

    // 60s (start to end), 60s (end to next start), 60s (next start to end).
    expect(activity[0]?.activeSeconds).toBe(180 + 60);
  });

  it("leaves an agent without timestamps with nothing to say", () => {
    expect(activityOfSpans([])).toEqual([]);
    expect(activityDate(new Date("2026-09-20T23:30:00").getTime())).toBe("2026-09-20");
  });
});
