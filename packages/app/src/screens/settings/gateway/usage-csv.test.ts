import type { GatewayUsageRequestWire } from "@neolix/protocol/gateway";
import { describe, expect, it } from "vitest";
import { CSV_COLUMNS, usageCsv, usageCsvTime, usageExportName } from "./usage-csv";

function row(overrides: Partial<GatewayUsageRequestWire> = {}): GatewayUsageRequestWire {
  return {
    time: "2026-11-05T10:20:30.000Z",
    client: "claude-code",
    requested: "claude-x",
    model: "claude-x",
    provider: "p",
    account: null,
    protocol: "anthropic",
    status: 200,
    ok: true,
    attempts: 1,
    durationMs: 1_200,
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 40,
    reasoningTokens: 0,
    costUsd: 0.001234,
    handedOn: false,
    key: null,
    ...overrides,
  };
}

describe("usageCsvTime", () => {
  it("writes RFC 3339 with the reader's offset", () => {
    const written = usageCsvTime("2026-11-05T10:20:30.000Z");
    expect(written).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(Date.parse(written)).toBe(Date.parse("2026-11-05T10:20:30.000Z"));
  });

  it("leaves a time it cannot read as it is", () => {
    expect(usageCsvTime("not a time")).toBe("not a time");
  });
});

describe("usageCsv", () => {
  it("writes myna's columns, the time with its offset and the cost at six places", () => {
    const lines = usageCsv([row()]).trimEnd().split("\n");
    // The same 47 columns the CLI writes, from protocol's shared projection.
    expect(CSV_COLUMNS).toHaveLength(47);
    expect(lines[0]).toBe(CSV_COLUMNS.join(","));
    const cells = lines[1]!.split(",");
    expect(cells[0]).toBe(usageCsvTime("2026-11-05T10:20:30.000Z"));
    expect(cells[1]).toBe("claude-code");
    expect(cells[CSV_COLUMNS.indexOf("cost_usd")]).toBe("0.001234");
  });

  it("writes a priced zero, and leaves a call with no price empty", () => {
    const free = usageCsv([row({ costUsd: 0, priced: true })])
      .trimEnd()
      .split("\n")[1]!;
    expect(free.split(",")[CSV_COLUMNS.indexOf("cost_usd")]).toBe("0.000000");
    const unpriced = usageCsv([row({ costUsd: 0, priced: false })])
      .trimEnd()
      .split("\n")[1]!;
    expect(unpriced.split(",")[CSV_COLUMNS.indexOf("cost_usd")]).toBe("");
  });

  it("quotes a value that holds a comma", () => {
    const line = usageCsv([row({ client: "a,b" })])
      .trimEnd()
      .split("\n")[1]!;
    expect(line).toContain('"a,b"');
  });
});

describe("usageExportName", () => {
  it("names the file for the period and the day", () => {
    expect(usageExportName("7d", new Date("2026-11-05T12:00:00.000Z"))).toBe(
      "neolix-usage-7d-2026-11-05.csv",
    );
  });
});
