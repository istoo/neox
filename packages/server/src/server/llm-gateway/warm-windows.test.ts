import { describe, expect, it } from "vitest";
import type { UsageReportEntry } from "@neolix/protocol/messages";
import { windowsFromCodexLimits, windowsFromReports } from "./warm-windows.js";

function report(input: {
  id: string;
  sourceId: string;
  label?: string;
  windows?: Array<{ id: string; usedPct?: number | null; resetsAt?: string | null }>;
  status?: "available" | "error";
}): UsageReportEntry {
  return {
    id: input.id,
    account: input.label === undefined ? {} : { label: input.label },
    fetchedAt: "2026-11-05T00:00:00.000Z",
    sourceId: input.sourceId,
    sourceLabel: input.sourceId,
    report:
      input.status === "error"
        ? { status: "error", error: "no" }
        : {
            status: "available",
            windows: (input.windows ?? []).map((window) => ({
              id: window.id,
              label: window.id,
              usedPct: window.usedPct ?? null,
              resetsAt: window.resetsAt ?? null,
            })),
          },
  };
}

describe("windowsFromReports", () => {
  it("matches a gateway account by its label or key", () => {
    const reports = [
      report({
        id: "codex-usage-source:acc-1",
        sourceId: "codex-usage-source",
        label: "first@example.com",
        windows: [{ id: "5h", usedPct: 0, resetsAt: "2026-11-05T03:00:00.000Z" }],
      }),
      report({
        id: "codex-usage-source:acc-2",
        sourceId: "codex-usage-source",
        label: "second@example.com",
        windows: [{ id: "7d", usedPct: 45, resetsAt: null }],
      }),
      report({
        id: "claude-usage-source:x",
        sourceId: "claude-usage-source",
        label: "third@example.com",
        windows: [{ id: "5h", usedPct: 80 }],
      }),
    ];

    expect(windowsFromReports(reports, "codex", { id: "acc-2" })).toEqual([
      { id: "7d", usedPct: 45, resetsAt: null },
    ]);
    expect(windowsFromReports(reports, "codex", { id: "me", label: "FIRST@example.com" })).toEqual([
      { id: "5h", usedPct: 0, resetsAt: Date.parse("2026-11-05T03:00:00.000Z") },
    ]);
    expect(windowsFromReports(reports, "claude", { id: "claude-one" })).toEqual([
      { id: "5h", usedPct: 80, resetsAt: null },
    ]);
  });

  it("reads the only account of a family rather than guessing between two", () => {
    const one = [
      report({
        id: "claude-usage-source:acc",
        sourceId: "claude-usage-source",
        label: "someone@example.com",
        windows: [{ id: "5h", usedPct: 0, resetsAt: "2026-11-05T03:00:00.000Z" }],
      }),
    ];
    expect(windowsFromReports(one, "claude", { id: "my-account" })).toHaveLength(1);
    const two = [
      ...one,
      report({
        id: "claude-usage-source:other",
        sourceId: "claude-usage-source",
        label: "other@example.com",
        windows: [{ id: "5h", usedPct: 0 }],
      }),
    ];
    expect(windowsFromReports(two, "claude", { id: "my-account" })).toBeUndefined();
  });

  it("ignores reports that read nothing", () => {
    const failed = [
      report({ id: "codex-usage-source:acc", sourceId: "codex-usage-source", status: "error" }),
    ];
    expect(windowsFromReports(failed, "codex", { id: "acc" })).toBeUndefined();
    expect(windowsFromReports([], "codex", { id: "acc" })).toBeUndefined();
  });
});

describe("windowsFromCodexLimits", () => {
  it("names the primary window the 5-hour one and the secondary the weekly one", () => {
    expect(
      windowsFromCodexLimits([
        { usedPercent: 12, windowMinutes: 300, resetAt: 1_800_000_000_000 },
        { usedPercent: 40, windowMinutes: 10_080, resetAt: null },
      ]),
    ).toEqual([
      { id: "5h", usedPct: 12, resetsAt: 1_800_000_000_000 },
      { id: "7d", usedPct: 40, resetsAt: null },
    ]);
  });

  it("keeps a window of another length by its minutes", () => {
    expect(windowsFromCodexLimits([{ usedPercent: 1, windowMinutes: 60, resetAt: null }])).toEqual([
      { id: "60m", usedPct: 1, resetsAt: null },
    ]);
  });

  it("says nothing when the backend reported no window", () => {
    expect(windowsFromCodexLimits([])).toBeUndefined();
  });
});
