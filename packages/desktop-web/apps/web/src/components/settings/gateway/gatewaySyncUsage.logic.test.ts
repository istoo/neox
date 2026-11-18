import type { NeolixSyncUsage } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { buildSyncUsageView, sparklinePath } from "./gatewaySyncUsage.logic";

function usage(overrides: Partial<NeolixSyncUsage> = {}): NeolixSyncUsage {
  return {
    devices: [],
    quotas: [],
    ...overrides,
  };
}

const seriesPoint = {
  label: "8/17",
  time: "2026-08-17",
  calls: 2,
  errors: 0,
  input: 100,
  output: 50,
  cache_read: 0,
  cache_write: 0,
  reasoning: 0,
  cost: 0.1,
  unpriced: 0,
};

const computer = {
  errors: 0,
  cache_read: 0,
  cache_write: 0,
  reasoning: 0,
  unpriced: 0,
};

describe("buildSyncUsageView", () => {
  it("lists each computer with its own totals and marks this one", () => {
    const view = buildSyncUsageView(
      usage({
        calls: 3,
        input: 150,
        output: 75,
        cost: 0.2,
        series: [seriesPoint],
        computers: [
          { ...computer, id: "this", name: "", calls: 1, input: 50, output: 25, cost: 0.05 },
          {
            ...computer,
            id: "studio",
            name: "Studio",
            calls: 2,
            input: 100,
            output: 50,
            cost: 0.15,
          },
        ],
      }),
    );

    expect(view.totals).toEqual({ tokens: 225, calls: 3, cost: 0.2 });
    expect(view.devices).toEqual([
      { id: "this", name: "", isThis: true, tokens: 75, calls: 1, cost: 0.05 },
      { id: "studio", name: "Studio", isThis: false, tokens: 150, calls: 2, cost: 0.15 },
    ]);
    expect(view.hasSharedUsage).toBe(true);
  });

  it("sums the series when the period totals are absent", () => {
    const view = buildSyncUsageView(
      usage({
        series: [
          seriesPoint,
          { ...seriesPoint, label: "8/18", calls: 4, input: 200, output: 100, cost: 0.3 },
        ],
      }),
    );

    expect(view.totals).toEqual({ tokens: 450, calls: 6, cost: 0.4 });
    expect(view.series).toEqual([
      { key: "8/17", label: "8/17", tokens: 150, calls: 2, cost: 0.1 },
      { key: "8/18", label: "8/18", tokens: 300, calls: 4, cost: 0.3 },
    ]);
  });

  it("keeps only the other computers' recent calls, newest first", () => {
    const row = {
      agent: "claude",
      provider: "claude",
      model: "claude-sonnet",
      in: 100,
      out: 50,
      cache_read: 0,
      cache_write: 0,
      ms: 1000,
      status: 200,
      cost: 0.1,
      priced: true,
    };
    const view = buildSyncUsageView(
      usage({
        rows: [
          { ...row, t: "2026-08-17T10:00:00.000Z", computer: "studio", computerName: "Studio" },
          { ...row, t: "2026-08-17T09:00:00.000Z" },
          {
            ...row,
            t: "2026-08-17T08:00:00.000Z",
            computer: "laptop",
            computerName: "Second studio",
            priced: false,
          },
        ],
      }),
    );

    expect(view.recentCalls).toEqual([
      {
        key: "2026-08-17T10:00:00.000Z|studio|claude-sonnet|150",
        computer: "Studio",
        model: "claude-sonnet",
        tokens: 150,
        cost: 0.1,
        at: "2026-08-17T10:00:00.000Z",
      },
      {
        key: "2026-08-17T08:00:00.000Z|laptop|claude-sonnet|150",
        computer: "Second studio",
        model: "claude-sonnet",
        tokens: 150,
        cost: null,
        at: "2026-08-17T08:00:00.000Z",
      },
    ]);
  });

  it("keeps the latest quota reading for each merged account", () => {
    const view = buildSyncUsageView(
      usage({
        quotaHistory: [
          {
            provider: "claude",
            user: "work@example.com",
            lines: [
              {
                name: "allowance",
                points: [
                  { at: "2026-08-17T08:00:00.000Z", left: 80 },
                  { at: "2026-08-17T12:00:00.000Z", left: 64 },
                ],
              },
            ],
          },
        ],
      }),
    );

    expect(view.quotas).toEqual([
      {
        key: "claude/work@example.com/allowance",
        provider: "claude",
        account: "work@example.com",
        name: "allowance",
        latestLeft: 64,
        latestAt: "2026-08-17T12:00:00.000Z",
        points: [
          { at: "2026-08-17T08:00:00.000Z", left: 80 },
          { at: "2026-08-17T12:00:00.000Z", left: 64 },
        ],
      },
    ]);
    expect(view.hasSharedUsage).toBe(true);
  });

  it("is empty when nothing has been shared", () => {
    const view = buildSyncUsageView(usage());
    expect(view.devices).toEqual([]);
    expect(view.quotas).toEqual([]);
    expect(view.hasSharedUsage).toBe(false);
  });
});

describe("sparklinePath", () => {
  it("maps percent-left readings across the width", () => {
    expect(sparklinePath([{ left: 100 }, { left: 50 }, { left: 0 }], 100, 20)).toBe(
      "M0,0 L50,10 L100,20",
    );
  });

  it("draws a flat line for a single reading", () => {
    expect(sparklinePath([{ left: 25 }], 100, 20)).toBe("M0,15 L100,15");
  });

  it("has no path without readings", () => {
    expect(sparklinePath([], 100, 20)).toBe("");
  });
});
