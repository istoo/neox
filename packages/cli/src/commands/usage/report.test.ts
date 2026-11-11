import { describe, expect, it } from "vitest";
import type {
  GatewayUsageGroupWire,
  GatewayUsageReportWire,
  GatewayUsageRequestWire,
  GatewayUsageTotalsWire,
} from "@neolix/protocol/gateway";
import {
  formatUsageCsv,
  formatUsageReport,
  reportSelection,
  runUsageReportCommand,
} from "./report.js";

const options = { daemonTarget: { kind: "endpoint" as const, host: "example.test:1234" } };

const totals: GatewayUsageTotalsWire = {
  calls: 3,
  failed: 1,
  retried: 1,
  inputTokens: 1_200,
  outputTokens: 800,
  cacheReadTokens: 400,
  cacheWriteTokens: 100,
  reasoningTokens: 50,
  costUsd: 1.5,
  unpricedCalls: 0,
  handedOn: 0,
  cacheHitRate: 25,
  meanTtftMs: 220,
};

function group(id: string, name: string, sub?: string): GatewayUsageGroupWire {
  return { id, name, ...(sub === undefined ? {} : { sub }), ...totals };
}

function request(id: string): GatewayUsageRequestWire {
  return {
    time: "2026-11-05T10:00:00.000Z",
    client: "Claude Code",
    requested: "claude-sonnet",
    model: "claude-sonnet",
    provider: "anthropic",
    account: "me",
    protocol: "anthropic",
    status: 200,
    ok: true,
    attempts: 1,
    durationMs: 1234,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    cacheWriteTokens: 60,
    cacheWrite1hTokens: 20,
    reasoningTokens: 0,
    costUsd: 0.25,
    priced: true,
    ttftMs: 200,
    handedOn: false,
    session: "s1",
    requestId: id,
    responseId: `resp-${id}`,
    upstreamProtocol: "anthropic",
    key: "sk-…abcd",
    keyLabel: "Team",
  };
}

function report(rows: GatewayUsageRequestWire[], total = rows.length): GatewayUsageReportWire {
  return {
    period: "30d",
    since: "2026-10-07T00:00:00.000Z",
    until: "2026-11-06T00:00:00.000Z",
    bucket: "day",
    totals,
    prompt: { tokens: 2_000, calls: 3, parts: [{ kind: "system", tokens: 100 }] },
    series: [],
    byClient: [group("claude", "Claude Code")],
    byModel: [group("claude-sonnet", "claude-sonnet", "anthropic")],
    byProvider: [group("anthropic", "Anthropic")],
    byAccount: [group("me", "Me", "anthropic")],
    byKey: [group("team", "Team")],
    bySession: [group("s1", "Claude Code  s1")],
    requests: { rows, total, offset: 0, limit: rows.length },
    path: "~/.neox/gateway-usage.jsonl",
  };
}

function host(
  make: (query: Record<string, unknown> | undefined) => GatewayUsageReportWire,
  features: Record<string, boolean> = { gatewayUsageReport: true, gatewayUsageWindow: true },
) {
  const queries: Array<Record<string, unknown> | undefined> = [];
  return {
    queries,
    connect: async () => ({
      getLastServerInfoMessage: () => ({ features }),
      getGatewayUsage: async (query?: Record<string, unknown>) => {
        queries.push(query);
        return { requestId: "request", report: make(query) };
      },
      close: async () => {},
    }),
  };
}

describe("usage report window", () => {
  it("takes myna's period names and aliases", () => {
    expect(reportSelection(undefined, {}).period).toBe("30d");
    expect(reportSelection("week", {}).period).toBe("7d");
    expect(reportSelection("day", {}).period).toBe("today");
    expect(reportSelection("month", {}).period).toBe("30d");
    expect(reportSelection("all", {}).period).toBe("all");
    expect(() => reportSelection("yesterday", {})).toThrow();
  });

  it("turns whole days into a local day window, never mixing them with a period", () => {
    const now = Date.parse("2026-11-06T03:00:00Z");
    expect(reportSelection(undefined, { days: "7" }, now, 480)).toEqual({
      period: "custom",
      from: "2026-10-31",
      to: "2026-11-06",
      days: 7,
    });
    expect(reportSelection(undefined, { last: "48h" }, now, 480).days).toBe(2);
    expect(() => reportSelection("7d", { days: "7" }, now, 480)).toThrow();
    expect(() => reportSelection(undefined, { days: "1.5" }, now, 480)).toThrow();
    expect(() => reportSelection(undefined, { last: "0m" }, now, 480)).toThrow();
  });

  it("turns a window that isn't whole local days into since/until, ending now", () => {
    const now = Date.parse("2026-11-06T03:00:00Z");
    expect(reportSelection(undefined, { last: "90m" }, now, 480)).toEqual({
      period: "custom",
      since: now - 5_400_000,
      until: now,
      lastMs: 5_400_000,
    });
    expect(reportSelection(undefined, { last: "36h" }, now, 480)).toEqual({
      period: "custom",
      since: now - 36 * 3_600_000,
      until: now,
      lastMs: 36 * 3_600_000,
    });
    expect(() => reportSelection("today", { last: "90m" }, now, 480)).toThrow();
  });
});

describe("usage report", () => {
  it("sums a period and names its parts like myna", async () => {
    const daemon = host(() => report([request("r1")], 3));
    const result = await runUsageReportCommand(undefined, { ...options }, daemon.connect);
    expect(daemon.queries[0]).toMatchObject({ period: "30d", limit: 1 });
    const text = formatUsageReport(result.report!, undefined);
    expect(text).toContain("2.0K tokens last 30 days · 3 calls · ≈$1.50");
    expect(text).toContain("in 1.2K  out 800");
    expect(text).toContain("  agents");
    expect(text).toContain("anthropic/claude-sonnet");
    expect(text).toContain("anthropic / Me");
    expect(text).toContain("gateway keys");
    expect(text).toContain("sessions");
    expect(text).toContain("~/.neox/gateway-usage.jsonl");
  });

  it("explains an empty window", async () => {
    const empty = report([], 0);
    empty.totals = { ...totals, calls: 0 };
    const text = formatUsageReport(empty, undefined);
    expect(text).toContain("no calls last 30 days");
    expect(text).toContain("route an agent through Neox's gateway");
  });

  it("pages every row for CSV and takes myna's columns", async () => {
    const rows = [request("r1"), request("r2"), request("r3")];
    const daemon = host((query) => {
      const offset = Number(query?.offset ?? 0);
      return report(rows.slice(offset, offset + 2), rows.length);
    });
    const result = await runUsageReportCommand(
      undefined,
      { ...options, csv: true },
      daemon.connect,
    );
    const csv = formatUsageCsv(result.rows!);
    const lines = csv.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("time,agent,requested_model,provider,host,model");
    const columns = lines[0]!.split(",");
    for (const line of lines) {
      expect(line.split(",").length).toBe(columns.length);
    }
    expect(lines[1]).toContain("Claude Code,claude-sonnet,anthropic,,claude-sonnet,");
    expect(lines[1]).toContain("0.250000");
    const cells = lines[1]!.split(",");
    const cell = (name: string) => cells[columns.indexOf(name)];
    // The columns Neolix has a source for.
    expect(cell("served_model")).toBe("");
    expect(cell("provider_key_name")).toBe("");
    expect(cell("caller_key_id")).toBe("sk-…abcd");
    expect(cell("caller_key_name")).toBe("Team");
    expect(cell("rejected")).toBe("false");
    expect(cell("session_official_login")).toBe("false");
    expect(cell("cache_write_5m_tokens")).toBe("40");
    expect(cell("cache_write_1h_tokens")).toBe("20");
    expect(daemon.queries.map((query) => query?.offset)).toEqual([0, 2]);
  });

  it("keeps --account to CSV, as myna does", async () => {
    await expect(
      runUsageReportCommand(
        undefined,
        { ...options, account: "me" },
        host(() => report([])).connect,
      ),
    ).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
  });

  it("gates hosts without the usage report", async () => {
    const connect = async () => ({
      getLastServerInfoMessage: () => ({ features: { gatewayUsageReport: false } }),
      getGatewayUsage: async () => ({ requestId: "request", report: report([]) }),
      close: async () => {},
    });
    await expect(runUsageReportCommand(undefined, {}, connect)).rejects.toMatchObject({
      code: "UNSUPPORTED_HOST",
    });
  });

  it("asks for a sub-day window with since/until and titles it like myna", async () => {
    const now = Date.parse("2026-11-06T03:00:00Z");
    const daemon = host(() => report([request("r1")], 3));
    const result = await runUsageReportCommand(
      undefined,
      { ...options, last: "90m" },
      daemon.connect,
      now,
    );
    expect(daemon.queries[0]).toMatchObject({
      period: "custom",
      since: now - 5_400_000,
      until: now,
    });
    expect(daemon.queries[0]).not.toHaveProperty("from");
    expect(formatUsageReport(result.report!, { lastMs: 5_400_000 })).toContain(
      "2.0K tokens last 90 minutes",
    );
  });

  it("gates a sub-day window on hosts without the window filter", async () => {
    const daemon = host(() => report([]), { gatewayUsageReport: true });
    await expect(
      runUsageReportCommand(undefined, { ...options, last: "90m" }, daemon.connect),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_HOST" });
    expect(daemon.queries).toHaveLength(0);
  });
});
