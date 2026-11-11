import { describe, expect, it } from "vitest";
import type { ExternalSession } from "@neolix/protocol/messages";
import {
  checkinWord,
  displayWidth,
  filterSessions,
  fmtTokens,
  matchOptions,
  pad,
  pageForKey,
  pickerChoice,
  seriesBars,
  sessionStats,
  truncate,
  windowSlice,
} from "./format.js";

function session(overrides: Partial<ExternalSession> = {}): ExternalSession {
  return {
    id: "s1",
    agent: "claude",
    cwd: "/work/acme",
    title: "A session",
    start: "2026-11-01T09:00:00.000Z",
    last: "2026-11-06T09:00:00.000Z",
    messages: 3,
    size: 100,
    tokens: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 50 },
    models: [
      {
        model: "claude-sonnet",
        tokens: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 50 },
        cost: 0.25,
        priced: true,
      },
    ],
    cost: 0.25,
    priced: true,
    resume: "claude --resume s1",
    path: "/tmp/s1.jsonl",
    deletable: true,
    ...overrides,
  };
}

describe("pageForKey", () => {
  it("maps 1-6 and wraps with brackets", () => {
    expect(pageForKey("1", 3)).toBe(0);
    expect(pageForKey("6", 0)).toBe(5);
    expect(pageForKey("]", 5)).toBe(0);
    expect(pageForKey("[", 0)).toBe(5);
    expect(pageForKey("x", 2)).toBeNull();
    expect(pageForKey("3q", 0)).toBeNull();
    expect(pageForKey("23", 0)).toBeNull();
  });
});

describe("formatting", () => {
  it("formats token counts as myna does", () => {
    expect(fmtTokens(999)).toBe("999");
    expect(fmtTokens(1200)).toBe("1.2K");
    expect(fmtTokens(120_000)).toBe("120K");
    expect(fmtTokens(1_200_000)).toBe("1.2M");
    expect(fmtTokens(12_000_000)).toBe("12M");
    expect(fmtTokens(1_200_000_000)).toBe("1.20B");
  });

  it("pads and truncates by terminal cells, counting CJK as two", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("中a")).toBe(3);
    expect(pad("中", 4)).toBe("中  ");
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(displayWidth(truncate("中文字符", 5))).toBeLessThanOrEqual(5);
  });
});

describe("windowSlice", () => {
  it("keeps the cursor in view", () => {
    expect(windowSlice(0, 0, 5)).toEqual([0, 0]);
    expect(windowSlice(10, 0, 5)).toEqual([0, 5]);
    expect(windowSlice(10, 7, 5)).toEqual([3, 8]);
    expect(windowSlice(3, 2, 5)).toEqual([0, 3]);
  });
});

describe("sessions", () => {
  const now = new Date("2026-11-06T12:00:00.000Z");

  it("filters by range, model and folder", () => {
    const old = session({ id: "old", last: "2026-10-01T09:00:00.000Z" });
    const other = session({ id: "other", cwd: "/work/other" });
    const all = [session(), old, other];
    expect(
      filterSessions(all, { days: 7, model: "", folder: "" }, now).map((item) => item.id),
    ).toEqual(["s1", "other"]);
    expect(
      filterSessions(all, { days: 0, model: "claude-sonnet", folder: "/work/other" }, now).map(
        (item) => item.id,
      ),
    ).toEqual(["other"]);
  });

  it("aggregates totals, shares and days", () => {
    const stats = sessionStats(
      [
        session({
          activity: [
            {
              date: "2026-11-05",
              tokens: { input: 600, output: 200, cacheRead: 0, cacheWrite: 0 },
              activeSeconds: 120,
            },
            {
              date: "2026-11-06",
              tokens: { input: 400, output: 300, cacheRead: 0, cacheWrite: 0 },
              activeSeconds: 60,
            },
          ],
        }),
        session({
          id: "s2",
          cwd: "/work/other",
          tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
        }),
      ],
      { days: 7, model: "", folder: "" },
      now,
    );
    expect(stats.tokens.input).toBe(1100);
    expect(stats.daysUsed).toBe(2);
    expect(stats.activeSeconds).toBe(180);
    expect(stats.models[0]?.name).toBe("claude-sonnet");
    expect(stats.folders.map((share) => share.name)).toEqual(["/work/acme", "/work/other"]);
  });
});

describe("picker options", () => {
  const items = [
    { value: "claude-sonnet", note: "fast" },
    { value: "claude-opus", note: "deep" },
    { value: "gpt-5", note: "openai" },
  ];

  it("ranks prefix before substring before note", () => {
    expect(matchOptions(items, "claude")).toEqual([0, 1]);
    expect(matchOptions(items, "openai")).toEqual([2]);
    expect(matchOptions(items, "x")).toEqual([]);
  });

  it("uses the typed custom value when nothing matches", () => {
    expect(pickerChoice(items, [], 0, true, "my-model")).toBe("my-model");
    expect(pickerChoice(items, [], 0, false, "my-model")).toBeNull();
    expect(pickerChoice(items, matchOptions(items, "opus"), 0, false, "opus")).toBe("claude-opus");
  });
});

describe("checkinWord", () => {
  it("names the credits and the streak a claim gave", () => {
    expect(checkinWord("claimed", 5, 3)).toBe("checked in +5 · 3-day streak");
    expect(checkinWord("done", 5)).toBe("already in +5");
    expect(checkinWord("done")).toBe("already in");
  });

  it("says where a press has to happen and why one failed", () => {
    expect(checkinWord("own-app")).toBe("do it in the app");
    expect(checkinWord("captcha")).toBe("needs a captcha in the app");
    expect(checkinWord("failed", undefined, undefined, "code 10000")).toBe("failed: code 10000");
    expect(checkinWord(undefined)).toBe("not checked in yet");
  });
});

describe("seriesBars", () => {
  it("draws one bar per point with the first and last label", () => {
    const bars = seriesBars([
      { label: "Nov 5", start: "", calls: 1, inputTokens: 0, outputTokens: 0, costUsd: 0 },
      { label: "Nov 6", start: "", calls: 1, inputTokens: 10, outputTokens: 10, costUsd: 0 },
    ]);
    expect(bars.endsWith("Nov 5 – Nov 6")).toBe(true);
    expect(bars.startsWith(" █")).toBe(true);
  });
});
