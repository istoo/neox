import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { GatewayUsageReportWireSchema } from "@neolix/protocol/gateway";
import { calendarWindow } from "./budget.js";
import { createGatewayRuntime } from "./runtime.js";
import { UsageLedger, clientOfUserAgent, sessionOfRequest, type UsageRecord } from "./usage.js";
import { buildUsageReport, periodStart, readUsageRecords, windowOf } from "./usage-report.js";

const logger = pino({ level: "silent" });

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    time: new Date(0).toISOString(),
    requested: "group/g",
    provider: "a",
    model: "m",
    protocol: "anthropic",
    status: 200,
    ok: true,
    inputTokens: 10,
    outputTokens: 5,
    attempts: 1,
    durationMs: 42,
    ...overrides,
  };
}

describe("UsageLedger", () => {
  it("counts requests per upstream", () => {
    const ledger = new UsageLedger({
      neolixHome: mkdtempSync(path.join(os.tmpdir(), "neolix-usage-")),
      logger,
    });
    ledger.record(record());
    ledger.record(record());
    ledger.record(record({ status: 500, ok: false }));

    expect(ledger.countFor("a/m")).toBe(2);
    expect(ledger.countFor("b/m")).toBe(0);
  });

  it("writes a probe to the log without counting it", () => {
    const ledger = new UsageLedger({
      neolixHome: mkdtempSync(path.join(os.tmpdir(), "neolix-usage-")),
      logger,
    });
    ledger.record(
      record({
        probe: "test",
        inputTokens: 100,
        outputTokens: 100,
        costUsd: 9,
        key: "k",
      }),
    );

    expect(ledger.countFor("a/m")).toBe(0);
    expect(ledger.spentThisMonth(NOW)).toBe(0);
    expect(ledger.tokensToday("k", NOW)).toBe(0);
    expect(ledger.recentEntries()).toHaveLength(1);
  });

  it("keeps myna's last 40 calls, newest first", async () => {
    const ledger = new UsageLedger({
      neolixHome: mkdtempSync(path.join(os.tmpdir(), "neolix-usage-")),
      logger,
    });
    for (let index = 0; index < 60; index += 1) ledger.record(record({ model: `m${index}` }));

    const recent = ledger.recentEntries();
    expect(recent).toHaveLength(40);
    expect(recent[0]?.model).toBe("m59");
    expect(recent[39]?.model).toBe("m20");
    await ledger.flush();
  });

  it("appends one JSON line per request", async () => {
    const neolixHome = mkdtempSync(path.join(os.tmpdir(), "neolix-usage-"));
    const ledger = new UsageLedger({ neolixHome, logger });
    ledger.record(record({ status: 500, ok: false }));

    await new Promise((resolve) => setTimeout(resolve, 20));

    const lines = readFileSync(path.join(neolixHome, "gateway-usage.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ provider: "a", status: 500, ok: false });
  });
});

const NOW = Date.parse("2026-11-05T12:00:00.000Z");

function reportQuery(overrides: Partial<Parameters<typeof buildUsageReport>[1]> = {}) {
  return {
    period: "7d" as const,
    now: NOW,
    timezoneOffsetMinutes: 0,
    offset: 0,
    limit: 100,
    ...overrides,
  };
}

function report(records: UsageRecord[], overrides = {}) {
  return buildUsageReport(records, reportQuery(overrides), {
    filePath: "/tmp/gateway-usage.jsonl",
  });
}

describe("gateway usage report", () => {
  it("counts a failed attempt apart from the calls and keeps its tokens", () => {
    const answer = report([
      record({ time: "2026-11-05T10:00:00.000Z", inputTokens: 10, outputTokens: 5 }),
      record({
        time: "2026-11-05T10:01:00.000Z",
        status: 500,
        ok: false,
        inputTokens: 3,
        outputTokens: 0,
      }),
    ]);

    expect(answer.totals).toMatchObject({
      calls: 1,
      failed: 1,
      inputTokens: 13,
      outputTokens: 5,
    });
  });

  it("reads cache reads out of a prompt the vendor counted them in", () => {
    const answer = report([
      record({
        time: "2026-11-05T10:00:00.000Z",
        protocol: "openai",
        inputTokens: 100,
        outputTokens: 0,
        cacheReadTokens: 40,
      }),
    ]);

    expect(answer.totals.inputTokens).toBe(60);
    expect(answer.totals.cacheReadTokens).toBe(40);
    expect(answer.totals.cacheHitRate).toBeCloseTo(0.4);
  });

  it("keeps an Anthropic prompt, whose input excludes the cache, as it is", () => {
    const answer = report([
      record({
        time: "2026-11-05T10:00:00.000Z",
        protocol: "anthropic",
        inputTokens: 100,
        outputTokens: 0,
        cacheReadTokens: 40,
        cacheWriteTokens: 10,
      }),
    ]);

    expect(answer.totals.inputTokens).toBe(100);
    expect(answer.totals.cacheHitRate).toBeCloseTo(40 / 150);
  });

  it("keeps a probe in the request log but out of every total", () => {
    const answer = report([
      record({ time: "2026-11-05T10:00:00.000Z", inputTokens: 10, outputTokens: 5 }),
      record({
        time: "2026-11-05T10:01:00.000Z",
        probe: "test",
        inputTokens: 100,
        outputTokens: 100,
        costUsd: 9,
      }),
    ]);

    expect(answer.totals.calls).toBe(1);
    expect(answer.totals.inputTokens).toBe(10);
    expect(answer.totals.costUsd).toBe(0);
    expect(answer.requests.rows.map((row) => row.probe)).toEqual(["test", undefined]);
  });

  it("leaves an answered model list out of the request log", () => {
    const answer = report([
      record({ time: "2026-11-05T10:00:00.000Z" }),
      record({ time: "2026-11-05T10:01:00.000Z", probe: "list" }),
      record({ time: "2026-11-05T10:02:00.000Z", probe: "list", status: 500, ok: false }),
    ]);

    expect(answer.requests.rows.map((row) => row.probe)).toEqual(["list", undefined]);
  });

  it("says which call had no price", () => {
    const answer = report([
      record({ time: "2026-11-05T10:00:00.000Z", costUsd: 0 }),
      record({ time: "2026-11-05T10:01:00.000Z", costUsd: 0.5 }),
    ]);

    expect(answer.totals.unpricedCalls).toBe(1);
    expect(answer.totals.costUsd).toBe(0.5);
  });

  it("re-prices a period's calls at the price it is given", () => {
    const answer = buildUsageReport(
      [record({ time: "2026-11-05T10:00:00.000Z", costUsd: 0 })],
      reportQuery(),
      { filePath: "/tmp/gateway-usage.jsonl", priceOf: () => ({ costUsd: 1.25, priced: true }) },
    );

    expect(answer.totals.costUsd).toBe(1.25);
    expect(answer.totals.unpricedCalls).toBe(0);
    expect(answer.requests.rows[0]?.costUsd).toBe(1.25);
  });

  it("tells a free call from one with no price", () => {
    const free = report([record({ time: "2026-11-05T10:00:00.000Z", costUsd: 0, priced: true })]);
    expect(free.totals.unpricedCalls).toBe(0);
    expect(free.requests.rows[0]?.priced).toBe(true);

    const unpriced = report([
      record({ time: "2026-11-05T10:00:00.000Z", costUsd: 0, priced: false }),
    ]);
    expect(unpriced.totals.unpricedCalls).toBe(1);
    expect(unpriced.requests.rows[0]?.priced).toBe(false);
  });

  it("keeps the stored cost for a call no price is known for", () => {
    const answer = buildUsageReport(
      [record({ time: "2026-11-05T10:00:00.000Z", costUsd: 0.5 })],
      reportQuery(),
      { filePath: "/tmp/gateway-usage.jsonl", priceOf: () => null },
    );

    expect(answer.totals.costUsd).toBe(0.5);
  });

  it("pages the requests newest first and filters them", () => {
    const records = [
      record({ time: "2026-11-05T09:00:00.000Z", model: "m1", client: "codex" }),
      record({ time: "2026-11-05T10:00:00.000Z", model: "m2", client: "claude-code" }),
      record({ time: "2026-11-05T11:00:00.000Z", model: "m3", client: "codex" }),
    ];

    const page = report(records, { limit: 1, offset: 1 });
    expect(page.requests.total).toBe(3);
    expect(page.requests.rows.map((row) => row.model)).toEqual(["m2"]);

    const codex = report(records, { client: "codex" });
    expect(codex.requests.rows.map((row) => row.model)).toEqual(["m3", "m1"]);
  });

  it("ranks each agent by the tokens it moved", () => {
    const answer = report([
      record({ time: "2026-11-05T09:00:00.000Z", client: "codex", inputTokens: 1 }),
      record({ time: "2026-11-05T10:00:00.000Z", client: "claude-code", inputTokens: 100 }),
    ]);

    expect(answer.byClient.map((group) => group.id)).toEqual(["claude-code", "codex"]);
    expect(answer.byClient[0]?.calls).toBe(1);
  });

  it("groups the calls whose client named a session, and no others", () => {
    const answer = report([
      record({ time: "2026-11-05T09:00:00.000Z", session: "s1" }),
      record({ time: "2026-11-05T10:00:00.000Z", session: "s1" }),
      record({ time: "2026-11-05T11:00:00.000Z" }),
    ]);

    expect(answer.bySession).toHaveLength(1);
    expect(answer.bySession[0]).toMatchObject({ id: "s1", calls: 2 });
  });

  it("produces a report the wire schema accepts", () => {
    const answer = report([
      record({
        time: "2026-11-05T10:00:00.000Z",
        client: "codex",
        session: "s1",
        cacheReadTokens: 40,
        ttftMs: 250,
        key: "sk-1234567890abcdef",
        costUsd: 0.25,
      }),
    ]);

    expect(GatewayUsageReportWireSchema.safeParse(answer).success).toBe(true);
  });

  it("starts today where the reader's day starts", () => {
    const noonUtc = Date.parse("2026-11-05T12:00:00.000Z");
    expect(periodStart("today", noonUtc, 0)).toBe(Date.parse("2026-11-05T00:00:00.000Z"));
    expect(periodStart("today", noonUtc, 480)).toBe(Date.parse("2026-11-04T16:00:00.000Z"));
    expect(periodStart("7d", noonUtc, 0)).toBe(Date.parse("2026-10-30T00:00:00.000Z"));
  });

  it("names an agent from the User-Agent and a library as other", () => {
    expect(clientOfUserAgent("claude-cli/2.1.0 (external, cli)")).toBe("claude-code");
    expect(clientOfUserAgent("codex_cli_rs/0.48.0")).toBe("codex");
    expect(clientOfUserAgent("curl/8.7.1")).toBe("other");
    expect(clientOfUserAgent(undefined)).toBe("other");
    expect(clientOfUserAgent("my-agent/1.0")).toBe("my-agent");
    // "pi" inside another word names no agent: a Python client is "other",
    // and a product that merely contains "pi" keeps its own name.
    expect(clientOfUserAgent("python-httpx/0.27.0")).toBe("other");
    expect(clientOfUserAgent("spider/1.0")).toBe("spider");
    expect(clientOfUserAgent("pi/1.1")).toBe("pi");
  });
});

describe("reading the ledger", () => {
  it("keeps the records the window keeps and skips the rest", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "neolix-usage-report-"));
    const file = path.join(dir, "gateway-usage.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify(record({ time: "2026-10-01T10:00:00.000Z", model: "old" })),
        "not json",
        JSON.stringify(record({ time: "2026-11-05T10:00:00.000Z", model: "new" })),
        "",
      ].join("\n"),
    );

    const kept = await readUsageRecords(file, Date.parse("2026-11-01T00:00:00.000Z"));
    expect(kept.map((entry) => entry.model)).toEqual(["new"]);
  });

  it("treats a ledger that is not there as an empty one", async () => {
    const missing = path.join(os.tmpdir(), "neolix-usage-missing-file.jsonl");
    await expect(readUsageRecords(missing, 0)).resolves.toEqual([]);
  });
});

describe("a failed try a later try took over", () => {
  it("is in neither the calls nor the failed count", () => {
    const answer = report([
      record({
        time: "2026-11-05T10:00:00.000Z",
        status: 500,
        ok: false,
        requestId: "r1",
      }),
      record({ time: "2026-11-05T10:00:01.000Z", requestId: "r1", attempts: 2 }),
    ]);

    expect(answer.totals).toMatchObject({ calls: 1, failed: 0, handedOn: 1 });
    const handed = answer.requests.rows.find((row) => row.handedOn);
    expect(handed?.status).toBe(500);
    expect(
      report([record({ time: "2026-11-05T10:00:01.000Z", requestId: "r1" })], { failedOnly: true })
        .requests.total,
    ).toBe(0);
  });

  it("counts a failure no later try took over, and one from an older record", () => {
    const answer = report([
      record({ time: "2026-11-05T10:00:00.000Z", status: 500, ok: false, requestId: "r2" }),
      record({ time: "2026-11-05T10:00:02.000Z", status: 500, ok: false }),
    ]);

    expect(answer.totals).toMatchObject({ calls: 0, failed: 2, handedOn: 0 });
  });
});

describe("a window picked day by day", () => {
  it("starts where the first day starts and ends where the last one ends", () => {
    const now = Date.parse("2026-11-05T12:00:00.000Z");
    const window = windowOf({
      period: "custom",
      now,
      timezoneOffsetMinutes: 0,
      from: "2026-11-01",
      to: "2026-11-03",
    });

    expect(window.since).toBe(Date.parse("2026-11-01T00:00:00.000Z"));
    expect(window.until).toBe(Date.parse("2026-11-03T23:59:59.999Z"));
  });

  it("keeps only the calls of the picked days", () => {
    const answer = buildUsageReport(
      [
        record({ time: "2026-10-31T23:00:00.000Z", model: "before" }),
        record({ time: "2026-11-02T10:00:00.000Z", model: "inside" }),
        record({ time: "2026-11-04T00:00:00.000Z", model: "after" }),
      ],
      {
        period: "custom",
        now: Date.parse("2026-11-05T12:00:00.000Z"),
        timezoneOffsetMinutes: 0,
        offset: 0,
        limit: 100,
        from: "2026-11-01",
        to: "2026-11-03",
      },
      { filePath: "/tmp/gateway-usage.jsonl" },
    );

    expect(answer.requests.rows.map((row) => row.model)).toEqual(["inside"]);
    expect(answer.period).toBe("custom");
    expect(answer.from).toBe("2026-11-01");
  });
});

describe("a rolling window under a day", () => {
  it("uses since and until, never ending after now", () => {
    const since = NOW - 5_400_000;
    expect(
      windowOf({ period: "custom", now: NOW, timezoneOffsetMinutes: 0, since, until: NOW }),
    ).toEqual({ since, until: NOW });
    expect(
      windowOf({
        period: "custom",
        now: NOW,
        timezoneOffsetMinutes: 0,
        since,
        until: NOW + 3_600_000,
      }).until,
    ).toBe(NOW);
  });

  it("keeps only the calls inside it", () => {
    const answer = buildUsageReport(
      [
        record({ time: "2026-11-05T10:20:00.000Z", model: "before" }),
        record({ time: "2026-11-05T10:40:00.000Z", model: "inside" }),
        record({ time: "2026-11-05T11:30:00.000Z", model: "inside too" }),
      ],
      reportQuery({
        period: "custom",
        since: NOW - 5_400_000,
        until: NOW,
      }),
      { filePath: "/tmp/gateway-usage.jsonl" },
    );

    expect(answer.requests.rows.map((row) => row.model)).toEqual(["inside too", "inside"]);
  });
});

describe("the conversation a request belongs to", () => {
  it("reads Neox's header before any other", () => {
    expect(sessionOfRequest({ "x-neolix-conversation": "p1", "x-session-id": "s1" }, {})).toBe(
      "p1",
    );
  });

  it("reads the headers the agents name a session in", () => {
    expect(sessionOfRequest({ "x-claude-code-session-id": "abc" }, {})).toBe("abc");
    expect(sessionOfRequest({ "x-session-id": "  spaced  " }, {})).toBe("spaced");
  });

  it("derives the same id from the same opening, and another from another", () => {
    const first = {
      model: "m",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
    };
    const second = { model: "m", messages: [{ role: "user", content: "hello" }] };
    const other = { model: "m", messages: [{ role: "user", content: "bye" }] };

    const id = sessionOfRequest({}, first);
    expect(id).toMatch(/^neolix-[0-9a-f]{24}$/);
    expect(sessionOfRequest({}, second)).toBe(id);
    expect(sessionOfRequest({}, other)).not.toBe(id);
  });

  it("has no session without a user turn or a header", () => {
    expect(sessionOfRequest({}, { messages: [{ role: "assistant", content: "hi" }] })).toBeNull();
    expect(sessionOfRequest({}, null)).toBeNull();
  });
});

describe("the prompt a record keeps", () => {
  it("keeps the slices the gateway can tell apart", () => {
    const answer = report([
      record({
        time: "2026-11-05T10:00:00.000Z",
        prompt: {
          tokens: 130,
          parts: [
            { kind: "system", tokens: 40 },
            { kind: "tools", tokens: 20 },
            { kind: "results", tokens: 30 },
            { kind: "chat", tokens: 40 },
          ],
        },
      }),
    ]);

    expect(answer.prompt.calls).toBe(1);
    expect(answer.prompt.tokens).toBe(130);
    expect(answer.prompt.parts).toEqual([
      { kind: "system", tokens: 40 },
      { kind: "tools", tokens: 20 },
      { kind: "results", tokens: 30 },
      { kind: "chat", tokens: 40 },
    ]);
    expect(answer.byClient[0]?.prompt?.tokens).toBe(130);
  });
});

describe("a restart", () => {
  function homeWith(lines: UsageRecord[]): string {
    const neolixHome = mkdtempSync(path.join(os.tmpdir(), "neolix-usage-"));
    writeFileSync(
      path.join(neolixHome, "gateway-usage.jsonl"),
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    );
    return neolixHome;
  }

  it("seeds each account's window under its provider/account key", async () => {
    const at = Date.now();
    const neolixHome = homeWith([
      record({
        time: new Date(at).toISOString(),
        provider: "p",
        account: "a",
        inputTokens: 100,
        outputTokens: 0,
      }),
    ]);
    const ledger = new UsageLedger({ neolixHome, logger });
    await ledger.start();

    const runtime = createGatewayRuntime(ledger);
    expect(runtime.quotaTracker.usage("p/a", at).tokens5h).toBe(100);
    expect(runtime.quotaTracker.usage("a", at).tokens5h).toBe(0);
  });

  it("leaves a probe out of the budget, key tokens and account windows", async () => {
    const at = Date.now();
    const neolixHome = homeWith([
      record({
        time: new Date(at).toISOString(),
        provider: "p",
        account: "a",
        probe: "test",
        inputTokens: 1000,
        outputTokens: 1000,
        costUsd: 9,
        key: "k",
      }),
    ]);
    const ledger = new UsageLedger({ neolixHome, logger });
    await ledger.start();

    expect(ledger.countFor("a/m")).toBe(0);
    expect(ledger.spentThisMonth(at)).toBe(0);
    expect(ledger.spentThisMonthForKey("k", at)).toBe(0);
    expect(ledger.tokensToday("k", at)).toBe(0);
    const runtime = createGatewayRuntime(ledger);
    expect(runtime.quotaTracker.usage("p/a", at).tokens5h).toBe(0);
  });
});

describe("calendar windows", () => {
  it("counts the month and the day where the budgets count them", () => {
    const zone = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      const neolixHome = mkdtempSync(path.join(os.tmpdir(), "neolix-usage-"));
      const ledger = new UsageLedger({ neolixHome, logger });
      // 15:00 Dec 31 in New York, already Jan 1 in UTC.
      const recordedAt = Date.parse("2025-12-31T20:00:00Z");
      const now = Date.parse("2026-01-01T03:00:00Z");
      ledger.record(
        record({
          time: new Date(recordedAt).toISOString(),
          key: "k",
          costUsd: 0.5,
          inputTokens: 10,
          outputTokens: 0,
        }),
      );

      const month = calendarWindow("month", new Date(now));
      expect(recordedAt).toBeGreaterThanOrEqual(month.start);
      expect(recordedAt).toBeLessThan(month.reset);
      expect(ledger.spentThisMonth(now)).toBeCloseTo(0.5);
      expect(ledger.spentThisMonthForKey("k", now)).toBeCloseTo(0.5);
      expect(ledger.tokensToday("k", now)).toBe(10);
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });
});
