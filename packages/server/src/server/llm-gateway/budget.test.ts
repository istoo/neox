import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { GatewayConfigSchema, type GatewayConfig } from "./config.js";
import {
  bindingStatus,
  loadUsageFile,
  refusalOf,
  reserveBudget,
  resetBudgetState,
  statusesOf,
  windowOf,
} from "./budget.js";

let directory: string;
let ledger: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "neolix-budget-"));
  ledger = path.join(directory, "gateway-usage.jsonl");
  resetBudgetState();
});
afterEach(async () => {
  resetBudgetState();
  await fs.rm(directory, { recursive: true, force: true });
});

function config(keys: unknown[]): GatewayConfig {
  return GatewayConfigSchema.parse({ keys });
}

async function record(
  rows: Array<{ time: Date; key: string } & Record<string, number>>,
): Promise<void> {
  const lines = rows.map((row) =>
    JSON.stringify({
      time: row.time.toISOString(),
      requested: "m",
      provider: "p",
      account: null,
      model: "m",
      protocol: "openai",
      status: 200,
      ok: true,
      inputTokens: row.inputTokens ?? 0,
      outputTokens: row.outputTokens ?? 0,
      cacheReadTokens: row.cacheReadTokens ?? 0,
      cacheWriteTokens: row.cacheWriteTokens ?? 0,
      attempts: 1,
      durationMs: 1,
      costUsd: row.costUsd ?? 0,
      priced: true,
      key: row.key,
    }),
  );
  await fs.appendFile(ledger, `${lines.join("\n")}\n`);
  await loadUsageFile(ledger);
}

const noon = new Date(2026, 10, 6, 12, 0, 0);

it("refuses a key at its day-token cap and says when it resets", async () => {
  await record([{ time: noon, key: "k", inputTokens: 100 }]);
  const cfg = config([{ key: "k", models: [], limits: [{ period: "day", tokens: 100 }] }]);
  const refusal = refusalOf(cfg, "k", noon, ledger);
  expect(refusal).not.toBeNull();
  expect(refusal?.message).toContain("100 of its 100");
  const midnight = new Date(2026, 10, 7, 0, 0, 0);
  expect(refusal?.retryAfterSeconds).toBe(Math.ceil((midnight.getTime() - noon.getTime()) / 1000));
});

it("counts cache reads only when the limit says so", async () => {
  await record([{ time: noon, key: "k", inputTokens: 10, cacheReadTokens: 90 }]);
  const without = config([
    { key: "k", models: [], limits: [{ period: "day", tokens: 50, cacheReads: false }] },
  ]);
  expect(refusalOf(without, "k", noon, ledger)).toBeNull();
  const withReads = config([
    { key: "k", models: [], limits: [{ period: "day", tokens: 50, cacheReads: true }] },
  ]);
  expect(refusalOf(withReads, "k", noon, ledger)).not.toBeNull();
});

it("holds a key to every one of its windows", async () => {
  await record([{ time: noon, key: "k", inputTokens: 40 }]);
  const cfg = config([
    {
      key: "k",
      models: [],
      limits: [
        { period: "day", tokens: 30 },
        { period: "month", tokens: 1000 },
      ],
    },
  ]);
  const statuses = statusesOf(cfg, "k", noon, ledger);
  expect(statuses.map((status) => status.spent)).toEqual([true, false]);
  expect(bindingStatus(statuses)?.period).toBe("day");
  expect(refusalOf(cfg, "k", noon, ledger)?.period).toBe("day");
});

it("refuses on the cost cap at the usage page's estimate", async () => {
  await record([{ time: noon, key: "k", inputTokens: 10, costUsd: 0.5 }]);
  const cfg = config([
    { key: "k", models: [], limits: [{ period: "day", cost: 0.25, cacheReads: false }] },
  ]);
  const refusal = refusalOf(cfg, "k", noon, ledger);
  expect(refusal?.message).toContain("$0.50 of its $0.25");
});

it("reads the older dailyTokens and monthlyUsd fields as windows", async () => {
  await record([{ time: noon, key: "k", inputTokens: 50, costUsd: 3 }]);
  const cfg = config([{ key: "k", models: [], dailyTokens: 50 }]);
  expect(refusalOf(cfg, "k", noon, ledger)?.tokenLimit).toBe(50);
  const money = config([{ key: "k", models: [], monthlyUsd: 2 }]);
  expect(refusalOf(money, "k", noon, ledger)?.costLimit).toBe(2);
});

it("holds a key issued under another to the issuer's windows too", async () => {
  await record([{ time: noon, key: "child", inputTokens: 100 }]);
  const cfg = config([
    { key: "parent", models: [], limits: [{ period: "day", tokens: 100 }] },
    { key: "child", models: [], issuer: "parent" },
  ]);
  expect(refusalOf(cfg, "child", noon, ledger)).not.toBeNull();
  expect(refusalOf(cfg, "parent", noon, ledger)).not.toBeNull();
});

it("counts the requests in flight against the window", async () => {
  await record([{ time: noon, key: "k", inputTokens: 90 }]);
  const cfg = config([{ key: "k", models: [], limits: [{ period: "day", tokens: 100 }] }]);
  const first = reserveBudget({
    config: cfg,
    key: "k",
    bodyBytes: 40,
    now: noon,
    ledgerPath: ledger,
  });
  expect("reservation" in first).toBe(true);
  const second = reserveBudget({
    config: cfg,
    key: "k",
    bodyBytes: 40,
    now: noon,
    ledgerPath: ledger,
  });
  expect("refusal" in second).toBe(true);
  if ("reservation" in first) first.reservation.release();
  const third = reserveBudget({
    config: cfg,
    key: "k",
    bodyBytes: 40,
    now: noon,
    ledgerPath: ledger,
  });
  expect("reservation" in third).toBe(true);
});

it("starts a calendar window again from a manual reset", async () => {
  await record([{ time: new Date(2026, 10, 6, 1, 0, 0), key: "k", inputTokens: 100 }]);
  const cfg = config([
    {
      key: "k",
      models: [],
      limits: [{ period: "day", tokens: 100, since: new Date(2026, 10, 6, 2, 0, 0).toISOString() }],
    },
  ]);
  expect(refusalOf(cfg, "k", noon, ledger)).toBeNull();
});

it("runs an N-day cycle from when the limit was set", () => {
  const since = new Date(2026, 10, 1, 9, 0, 0);
  const window = windowOf(
    { period: "days", days: 3, tokens: 10, cacheReads: false, since: since.toISOString() },
    new Date(2026, 10, 7, 10, 0, 0),
  );
  expect(window.start).toBe(new Date(2026, 10, 7, 9, 0, 0).getTime());
  expect(window.reset).toBe(new Date(2026, 10, 10, 9, 0, 0).getTime());
});

it("runs an hours cycle in absolute time", () => {
  const since = new Date(2026, 10, 6, 0, 0, 0);
  const window = windowOf(
    { period: "hours", hours: 5, tokens: 10, cacheReads: false, since: since.toISOString() },
    new Date(2026, 10, 6, 12, 30, 0),
  );
  expect(window.start).toBe(new Date(2026, 10, 6, 10, 0, 0).getTime());
  expect(window.reset).toBe(new Date(2026, 10, 6, 15, 0, 0).getTime());
});

it("counts only the key's calls, not another key's", async () => {
  await record([
    { time: noon, key: "k", inputTokens: 100 },
    { time: noon, key: "other", inputTokens: 100 },
  ]);
  const cfg = config([{ key: "k", models: [], limits: [{ period: "day", tokens: 100 }] }]);
  expect(refusalOf(cfg, "other", noon, ledger)).toBeNull();
});
