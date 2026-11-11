import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayQuotaAccountWire } from "@neolix/protocol/gateway";
import type { UsageReportEntry } from "@neolix/protocol/messages";
import { render } from "../../output/index.js";
import { createCli } from "../../cli.js";
import {
  createUsageCommand,
  parseLead,
  resetAccountOf,
  runAlertCommand,
  runAutoResetCommand,
  runResetLeadCommand,
  runUsageCommand,
  runUsageHistoryCommand,
  runCreditsCommand,
  runUsageRefreshCommand,
  runUsageResetCommand,
  runUsageWaitCommand,
} from "./index.js";

const options = { daemonTarget: { kind: "endpoint" as const, host: "example.test:1234" } };
const reports: UsageReportEntry[] = [
  {
    id: "plugin.source:work.account",
    sourceId: "plugin.source",
    sourceLabel: "Plugin Source",
    account: { label: "Work" },
    fetchedAt: "2026-10-09T12:00:00Z",
    icon: "<svg />",
    report: {
      status: "available",
      planLabel: "Pro",
      windows: [
        {
          id: "5h",
          label: "Five hours",
          usedPct: 12.5,
          remainingPct: 87.5,
          resetsAt: "2026-10-09T17:00:00Z",
          runsOutAt: "2026-10-09T16:00:00Z",
          shortfallPct: 4.25,
        },
        { id: "week", label: "Weekly", usedPct: null, remainingPct: 0 },
        { id: "extra", label: "Extra", usedPct: 0 },
      ],
      balances: [
        {
          id: "credit",
          label: "Credit",
          used: 0,
          remaining: 2.5,
          limit: 10,
          unit: "usd",
          resetsAt: "2026-11-01T00:00:00Z",
        },
        { id: "requests", label: "Requests", remaining: null, unit: "requests" },
      ],
      details: [{ id: "tier", label: "Tier", value: "Enterprise" }],
    },
  },
  {
    id: "plugin.source:personal",
    sourceId: "plugin.source",
    sourceLabel: "Plugin Source",
    account: {},
    fetchedAt: "2026-10-09T12:00:00Z",
    report: {
      status: "unavailable",
      problem: { kind: "rejected", status: 401, refreshedBy: "codex login" },
    },
    loginErrors: [
      {
        harness: "Claude Code",
        report: {
          status: "unavailable",
          problem: { kind: "expired", expiresAt: "2026-10-08T00:00:00Z", refreshedBy: "claude" },
        },
      },
      {
        harness: "Codex",
        report: {
          status: "unavailable",
          problem: { kind: "rejected", status: 401, refreshedBy: "codex login" },
        },
      },
      { harness: "Other", report: { status: "error", error: "Login service failed" } },
    ],
  },
  {
    id: "other:broken",
    sourceId: "other",
    sourceLabel: "Other",
    account: {},
    fetchedAt: "2026-10-09T12:00:00Z",
    report: { status: "error", error: "Source failed" },
  },
  {
    id: "other:noquota",
    sourceId: "other",
    sourceLabel: "Other",
    account: {},
    fetchedAt: "2026-10-09T12:00:00Z",
    report: {
      status: "unavailable",
      problem: { kind: "no_quota", detail: "No quota for this plan" },
    },
  },
];

function host(entries = reports, supported = true) {
  const requests: Array<Parameters<NonNullable<Parameters<typeof runUsageCommand>[2]>>[0]> = [];
  const queries: Array<
    { agentId?: string; forceRefresh?: boolean; reportIds?: string[] } | undefined
  > = [];
  let closed = 0;
  return {
    requests,
    queries,
    get closed() {
      return closed;
    },
    connect: async (input: (typeof requests)[number]) => {
      requests.push(input);
      return {
        getLastServerInfoMessage: () => ({ features: { usageSources: supported } }),
        listUsageReports: async (query?: (typeof queries)[number]) => {
          queries.push(query);
          const selected = query?.reportIds
            ? entries.filter((entry) => query.reportIds!.includes(entry.id))
            : entries;
          return { requestId: "request", reports: selected };
        },
        close: async () => {
          closed++;
        },
      };
    },
  };
}

it("preserves complete JSON entries, numeric values and quiet full IDs", async () => {
  const daemon = host();
  const result = await runUsageCommand(options, { kind: "list" }, daemon.connect);
  expect(JSON.parse(render(result, { format: "json" }))).toEqual(reports);
  expect(render(result, { quiet: true })).toBe(reports.map((entry) => entry.id).join("\n"));
  expect(daemon.requests).toEqual([{ target: options.daemonTarget }]);
  expect(daemon.closed).toBe(1);
});

it("lists all windows, balances, missing values, failures and remedies", async () => {
  const result = await runUsageCommand(options, { kind: "list" }, host().connect);
  const text = render(result, { noColor: true });
  for (const expected of [
    "REPORT ID",
    "SOURCE",
    "ACCOUNT",
    "STATUS",
    "USAGE",
    "FETCHED",
    "Five hours: 12.5% used, 87.5% remaining",
    "Weekly: - used, 0% remaining",
    "Extra: 0% used, - remaining",
    "Credit: 0 used, 2.5 remaining, 10 limit (usd)",
    "Requests: - used, - remaining, - limit (requests)",
    "Login expired at 2026-10-08T00:00:00Z. Run claude",
    "Login rejected (HTTP 401). Run codex login",
    "Other: Login service failed",
    "Source failed",
    "No quota for this plan",
  ])
    expect(text).toContain(expected);
  expect(render(result, { noHeaders: true })).not.toContain("REPORT ID");
});

it("inspects exact opaque IDs and includes resets, forecasts, details and login failures", async () => {
  const daemon = host();
  const result = await runUsageCommand(
    options,
    { kind: "inspect", id: reports[0]!.id },
    daemon.connect,
  );
  expect(JSON.parse(render(result, { format: "json" }))).toEqual(reports[0]);
  const text = render(result);
  for (const expected of [
    "Source ID: plugin.source",
    "Plan: Pro",
    "Resets: 2026-10-09T17:00:00Z",
    "Runs out: 2026-10-09T16:00:00Z",
    "Shortfall: 4.25%",
    "Resets: -",
    "Resets: 2026-11-01T00:00:00Z",
    "Tier: Enterprise",
  ])
    expect(text).toContain(expected);
  const failure = await runUsageCommand(
    options,
    { kind: "inspect", id: reports[1]!.id },
    daemon.connect,
  );
  expect(render(failure)).toContain("Login failures:\n  Claude Code: Login expired at");
  expect(render(failure)).toContain("  Other: Login service failed");
});

it("discovers before inspecting, then refreshes only the selected report", async () => {
  const daemon = host();
  await runUsageCommand(
    { ...options, refresh: true },
    { kind: "inspect", id: reports[0]!.id },
    daemon.connect,
  );
  expect(daemon.queries).toEqual([undefined, { reportIds: [reports[0]!.id], forceRefresh: true }]);
});

it("rejects agent selection combined with inspect before connecting", async () => {
  const daemon = host();
  await expect(
    runUsageCommand(
      { ...options, agent: "agent-A" },
      { kind: "inspect", id: reports[0]!.id },
      daemon.connect,
    ),
  ).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
  expect(daemon.requests).toEqual([]);
});

it("passes agent account selection and refresh without converting it to token consumption", async () => {
  const daemon = host();
  await runUsageCommand(
    { ...options, agent: "agent-123", refresh: true },
    { kind: "list" },
    daemon.connect,
  );
  expect(daemon.queries).toEqual([{ agentId: "agent-123", forceRefresh: true }]);
});

it("returns an empty array in JSON and explains empty discovery in human output", async () => {
  const result = await runUsageCommand(options, { kind: "list" }, host([]).connect);
  expect(render(result, { format: "json" })).toBe("[]");
  expect(render(result)).toBe("No usage reports returned");
  expect(render(result, { quiet: true })).toBe("");
});

it("rejects unknown IDs and prefixes and closes the client", async () => {
  const daemon = host();
  await expect(
    runUsageCommand(options, { kind: "inspect", id: "plugin.source:work" }, daemon.connect),
  ).rejects.toEqual({
    code: "REPORT_NOT_FOUND",
    message: "Unknown usage report: plugin.source:work",
  });
  expect(daemon.closed).toBe(1);
});

it("gates unsupported hosts before any request and closes the connection", async () => {
  const daemon = host(reports, false);
  await expect(runUsageCommand(options, { kind: "list" }, daemon.connect)).rejects.toMatchObject({
    code: "UNSUPPORTED_HOST",
  });
  expect(daemon.queries).toEqual([]);
  expect(daemon.closed).toBe(1);
});

it("propagates connection and request failures", async () => {
  await expect(
    runUsageCommand(options, { kind: "list" }, async () => {
      throw new Error("Connection failed");
    }),
  ).rejects.toThrow("Connection failed");
  let closed = false;
  const connect = async () => ({
    getLastServerInfoMessage: () => ({ features: { usageSources: true } }),
    listUsageReports: async () => {
      throw new Error("Request failed");
    },
    close: async () => {
      closed = true;
    },
  });
  await expect(runUsageCommand(options, { kind: "list" }, connect)).rejects.toThrow(
    "Request failed",
  );
  expect(closed).toBe(true);
});

describe("usage CLI registration", () => {
  it("registers the commands myna's quota CLI has a backend for", () => {
    const usage = createCli().commands.find((command) => command.name() === "usage")!;
    expect(usage.commands.map((command) => command.name())).toEqual([
      "ls",
      "inspect",
      "report",
      "auto-reset",
      "credits",
      "alert",
      "refresh",
      "history",
      "wait",
      "reset",
    ]);
    expect(usage.helpInformation()).toContain("--agent <id>");
    expect(usage.commands[0]!.helpInformation()).toContain("--refresh");
    expect(usage.commands[1]!.helpInformation()).toContain("<report-id>");
    const autoReset = usage.commands.find((command) => command.name() === "auto-reset")!;
    expect(autoReset.commands.map((command) => command.name())).toEqual(["lead"]);
    expect(autoReset.helpInformation()).toContain("week or expiring");
    expect(
      usage.commands.find((command) => command.name() === "history")!.helpInformation(),
    ).toContain("--days <n>");
    expect(
      usage.commands.find((command) => command.name() === "wait")!.helpInformation(),
    ).toContain("--timeout <duration>");
  });
});

const homes: string[] = [];

function home(config: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "neolix-usage-"));
  homes.push(dir);
  writeFileSync(join(dir, "gateway.json"), JSON.stringify(config));
  return dir;
}

function saved(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, "gateway.json"), "utf8")) as Record<string, unknown>;
}

afterEach(() => {
  for (const dir of homes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function codexConfig(autoReset?: "week" | "expiring" | "auto"): Record<string, unknown> {
  return {
    providers: [
      {
        id: "openai",
        label: "OpenAI",
        protocol: "openai",
        baseUrl: "https://api.example.test/v1",
        accounts: [
          {
            id: "me",
            label: "Me",
            codexAccountId: "neox:me",
            ...(autoReset === undefined ? {} : { autoReset }),
          },
          { id: "work", label: "Work", codexAccountId: "neox:work" },
        ],
      },
    ],
  };
}

function accountIn(dir: string, id: string): Record<string, unknown> {
  const config = saved(dir) as {
    providers: Array<{ accounts: Array<Record<string, unknown>> }>;
  };
  return config.providers[0]!.accounts.find((account) => account.id === id)!;
}

describe("usage auto-reset lead", () => {
  it("shows the default when the config names none", async () => {
    expect(await runResetLeadCommand(undefined, { home: home() })).toEqual({ minutes: 30 });
  });

  it("shows a lead the config names", async () => {
    expect(await runResetLeadCommand(undefined, { home: home({ codexResetLead: 90 }) })).toEqual({
      minutes: 90,
    });
  });

  it("takes minutes and hours", async () => {
    const dir = home();
    expect(await runResetLeadCommand("3h", { home: dir })).toEqual({ minutes: 180 });
    expect(saved(dir)).toMatchObject({ codexResetLead: 180 });
    expect(parseLead("1h30m")).toBe(90);
    expect(parseLead("45")).toBe(45);
  });

  it("drops the key for the default", async () => {
    const dir = home({ codexResetLead: 120 });
    expect(await runResetLeadCommand("default", { home: dir })).toEqual({ minutes: 30 });
    expect(saved(dir)).not.toHaveProperty("codexResetLead");
  });

  it("refuses a lead outside myna's range and keeps the old one", async () => {
    const dir = home({ codexResetLead: 120 });
    expect(() => parseLead("14m")).toThrow();
    expect(() => parseLead("25h")).toThrow();
    expect(() => parseLead("1h30")).toThrow();
    await expect(runResetLeadCommand("14m", { home: dir })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(saved(dir)).toMatchObject({ codexResetLead: 120 });
  });
});

describe("usage auto-reset", () => {
  it("lists only the accounts that spend a reset by themselves", async () => {
    const { rows } = await runAutoResetCommand([], { home: home(codexConfig("auto")) });
    expect(rows).toEqual([{ provider: "openai", account: "me", label: "Me", autoReset: "auto" }]);
  });

  it("turns both times on and off", async () => {
    const dir = home(codexConfig());
    await runAutoResetCommand(["me", "on"], { home: dir });
    expect(accountIn(dir, "me")).toMatchObject({ autoReset: "auto" });
    await runAutoResetCommand(["me", "off"], { home: dir });
    expect(accountIn(dir, "me")).not.toHaveProperty("autoReset");
  });

  it("keeps the other time when one is turned off", async () => {
    const dir = home(codexConfig("auto"));
    await runAutoResetCommand(["me", "week", "off"], { home: dir });
    expect(accountIn(dir, "me")).toMatchObject({ autoReset: "expiring" });
  });

  it("names an account by its Codex account id", async () => {
    const dir = home(codexConfig());
    await runAutoResetCommand(["neox:work", "expiring", "on"], { home: dir });
    expect(accountIn(dir, "work")).toMatchObject({ autoReset: "expiring" });
  });

  it("parses both the account form and the lead subcommand through commander", async () => {
    const dir = home(codexConfig());
    const usage = createUsageCommand();
    const written: string[] = [];
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      });
    try {
      await usage.parseAsync(["auto-reset", "me", "week", "on", "--home", dir], { from: "user" });
      await usage.parseAsync(["auto-reset", "lead", "3h", "--home", dir], { from: "user" });
    } finally {
      write.mockRestore();
    }
    expect(accountIn(dir, "me")).toMatchObject({ autoReset: "week" });
    expect(saved(dir)).toMatchObject({ codexResetLead: 180 });
    expect(written.join("")).toContain("Reset lead: 180 min");
  });

  it("refuses an unknown account and a lone time", async () => {
    await expect(
      runAutoResetCommand(["nobody", "on"], { home: home(codexConfig()) }),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
    await expect(
      runAutoResetCommand(["me", "week"], { home: home(codexConfig()) }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});

describe("usage refresh", () => {
  it("asks the vendors again and narrows to the named source or account", async () => {
    const daemon = host();
    const result = await runUsageRefreshCommand(
      options,
      { provider: "plugin.source" },
      daemon.connect,
    );
    expect(daemon.queries).toEqual([{ forceRefresh: true }]);
    expect(JSON.parse(render(result, { format: "json" }))).toHaveLength(2);
    const byAccount = await runUsageRefreshCommand(options, { account: "Work" }, host().connect);
    expect(JSON.parse(render(byAccount, { format: "json" }))).toEqual([reports[0]]);
    await expect(
      runUsageRefreshCommand(options, { provider: "nobody" }, host().connect),
    ).rejects.toMatchObject({ code: "REPORT_NOT_FOUND" });
  });
});

const quotaAccounts: GatewayQuotaAccountWire[] = [
  {
    id: "openai/me",
    provider: "openai",
    providerLabel: "OpenAI",
    account: "me",
    accountLabel: "Me",
    enabled: true,
    restingUntil: null,
    windows: [
      {
        id: "5h",
        kind: "allowance",
        usedPercent: 42,
        remaining: 58,
        limit: 100,
        resetsAt: 1_760_000_000_000,
        pacePct: 3,
        history: [{ at: 1_759_999_000_000, usedPercent: 40, resetsAt: 1_760_000_000_000 }],
      },
    ],
    spendUsd: 0,
    monthlyUsdCap: null,
    canWarm: true,
    warmup: false,
    lastReadAt: 1_759_999_000_000,
    history: [{ at: 1_759_999_000_000, usedPercent: 40, resetsAt: null }],
  },
  {
    id: "openai/work",
    provider: "openai",
    providerLabel: "OpenAI",
    account: "work",
    accountLabel: "Work",
    enabled: true,
    restingUntil: null,
    windows: [],
    spendUsd: 0,
    monthlyUsdCap: null,
    canWarm: false,
    warmup: false,
    lastReadAt: null,
    history: [],
  },
];

function quotaHost(accounts = quotaAccounts, supported = true, history45 = true, reset = true) {
  const queries: Array<{ historyDays?: number; read?: boolean } | undefined> = [];
  const resets: Array<{ account?: string; card?: number; confirm: boolean }> = [];
  return {
    queries,
    resets,
    connect: async () => ({
      getLastServerInfoMessage: () => ({
        features: {
          gatewayQuotas: supported,
          gatewayQuotaHistory45: history45,
          gatewayQuotaReset: reset,
        },
      }),
      listUsageReports: async () => ({ requestId: "request", reports: [] }),
      getGatewayQuota: async (query?: { historyDays?: number; read?: boolean }) => {
        queries.push(query);
        return { requestId: "request", quota: { accounts, until: 0 } };
      },
      resetGatewayQuota: async (input: { account?: string; card?: number; confirm: boolean }) => {
        resets.push(input);
        return { requestId: "request", spent: true, code: "reset", windows: 2 };
      },
      close: async () => {},
    }),
  };
}

describe("usage history", () => {
  it("reads the kept points and narrows by provider or account", async () => {
    const daemon = quotaHost();
    const result = await runUsageHistoryCommand([], { ...options, days: "7" }, daemon.connect);
    expect(daemon.queries).toEqual([{ historyDays: 7, read: true }]);
    expect(JSON.parse(render(result, { format: "json" }))).toEqual(quotaAccounts);
    const text = render(result);
    expect(text).toContain("OpenAI · Me");
    expect(text).toContain("5h: 42% used");
    expect(text).toContain("1 readings");
    const narrowed = await runUsageHistoryCommand(["openai/work"], options, quotaHost().connect);
    expect(JSON.parse(render(narrowed, { format: "json" }))).toEqual([quotaAccounts[1]]);
  });

  it("prints a plan card by its plan, with why it has no windows", async () => {
    const plan: GatewayQuotaAccountWire = {
      id: "volcengine/plan/coding",
      provider: "volcengine",
      providerLabel: "Volcengine",
      account: "plan",
      accountLabel: "Coding Plan",
      enabled: true,
      restingUntil: null,
      windows: [],
      spendUsd: 0,
      monthlyUsdCap: null,
      canWarm: false,
      warmup: false,
      lastReadAt: null,
      history: [],
      kind: "plan",
      providerId: "volcengine",
      planId: "coding",
      error: "this plan's usage is read with the account's access key",
    };
    const result = await runUsageHistoryCommand([], options, quotaHost([plan]).connect);
    const text = render(result);
    expect(text).toContain("Volcengine · Coding Plan");
    expect(text).toContain("access key");
    // A plan card is keyed by its own id, not the shared synthetic account.
    expect(JSON.parse(render(result, { format: "json" }))[0].id).toBe("volcengine/plan/coding");
  });

  it("won't ask an older host for more than 30 days", async () => {
    const old = quotaHost(quotaAccounts, true, false);
    await expect(
      runUsageHistoryCommand([], { ...options, days: "45" }, old.connect),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_HOST" });
    expect(old.queries).toEqual([]);
    await runUsageHistoryCommand([], { ...options, days: "30" }, old.connect);
    expect(old.queries).toEqual([{ historyDays: 30, read: true }]);
  });

  it("reads every kept day when none is asked for", async () => {
    const daemon = quotaHost();
    await runUsageHistoryCommand([], options, daemon.connect);
    expect(daemon.queries).toEqual([{ historyDays: 45, read: true }]);
  });

  it("reads myna's 45 days and asks for no more", async () => {
    const daemon = quotaHost();
    await runUsageHistoryCommand([], { ...options, days: "45" }, daemon.connect);
    expect(daemon.queries).toEqual([{ historyDays: 45, read: true }]);
    const clamped = quotaHost();
    await runUsageHistoryCommand([], { ...options, days: "60" }, clamped.connect);
    expect(clamped.queries).toEqual([{ historyDays: 45, read: true }]);
    await expect(
      runUsageHistoryCommand([], { ...options, days: "soon" }, quotaHost().connect),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("gates unsupported hosts", async () => {
    await expect(
      runUsageHistoryCommand([], options, quotaHost(quotaAccounts, false).connect),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_HOST" });
  });
});

function waitHost(entries: UsageReportEntry[]) {
  return async () => ({
    getLastServerInfoMessage: () => ({ features: { usageSources: true } }),
    listUsageReports: async () => ({ requestId: "request", reports: entries }),
    close: async () => {},
  });
}

describe("usage wait", () => {
  const free: UsageReportEntry = {
    ...reports[0]!,
    report: {
      status: "available",
      windows: [{ id: "5h", label: "Five hours", usedPct: 10, remainingPct: 90 }],
    },
  };

  it("returns as soon as an account has allowance again", async () => {
    const result = await runUsageWaitCommand(
      "plugin.source",
      { daemonTarget: options.daemonTarget },
      waitHost([free]),
    );
    expect(result.target).toBe("plugin.source");
  });

  it("refuses a name no report has", async () => {
    await expect(
      runUsageWaitCommand("nobody", { daemonTarget: options.daemonTarget }, waitHost([free])),
    ).rejects.toMatchObject({ code: "UNKNOWN_TARGET" });
  });

  it("times out when the window stays used up", async () => {
    const blocked: UsageReportEntry = {
      ...free,
      report: {
        status: "available",
        windows: [{ id: "week", label: "Weekly", usedPct: 100, remainingPct: 0 }],
      },
    };
    let clock = 0;
    const result = runUsageWaitCommand(
      "plugin.source",
      { daemonTarget: options.daemonTarget, timeoutMs: 60_000 },
      waitHost([blocked]),
      {
        now: () => {
          const value = clock;
          clock = 120_000;
          return value;
        },
        sleep: async () => {
          throw new Error("must not sleep past the deadline");
        },
      },
    );
    await expect(result).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});

it("shows retained values with current failures and separates successful time from latest attempt", async () => {
  const success: UsageReportEntry = { ...reports[0]!, successfulAt: "2026-10-09T12:00:15Z" };
  const current = await runUsageCommand(
    options,
    { kind: "inspect", id: success.id },
    host([success]).connect,
  );
  expect(render(current)).toContain("Latest attempt: 2026-10-09T12:00:00Z");
  expect(render(current)).toContain("Last successful: 2026-10-09T12:00:15Z");
  const currentList = await runUsageCommand(options, { kind: "list" }, host([success]).connect);
  expect(render(currentList)).toContain("Last successful: 2026-10-09T12:00:15Z");
  if (success.report.status !== "available") throw new Error("fixture must be available");
  const retained: UsageReportEntry = {
    ...success,
    fetchedAt: "2026-10-09T12:06:00Z",
    report: { status: "error", error: "Rate limited" },
    successfulAt: undefined,
    lastSuccessful: { fetchedAt: success.successfulAt!, report: success.report },
  };
  const daemon = host([retained]);
  const listed = await runUsageCommand(options, { kind: "list" }, daemon.connect);
  expect(render(listed)).toContain("Retained: Five hours: 12.5% used");
  expect(render(listed)).toContain("Last successful: 2026-10-09T12:00:15Z");
  expect(render(listed)).toContain("Rate limited");
  expect(JSON.parse(render(listed, { format: "json" }))).toEqual([retained]);
  const inspected = await runUsageCommand(
    options,
    { kind: "inspect", id: retained.id },
    daemon.connect,
  );
  expect(render(inspected)).toContain("Latest attempt: 2026-10-09T12:06:00Z");
  expect(render(inspected)).toContain("Last successful: 2026-10-09T12:00:15Z");
  expect(render(inspected)).toContain("Retained usage:");
  expect(render(inspected)).toContain("Five hours: 12.5% used");
  expect(render(inspected)).toContain("Reason: Rate limited");
});

describe("usage reset", () => {
  it("asks first unless --yes, then sends the daemon a confirmed spend", async () => {
    const confirmed = quotaHost();
    let asked = 0;
    const result = await runUsageResetCommand(
      "Me",
      { ...options, card: "2" },
      confirmed.connect,
      async () => {
        asked += 1;
        return true;
      },
    );
    expect(asked).toBe(1);
    expect(result).toMatchObject({ spent: true, code: "reset", windows: 2 });
    expect(confirmed.resets).toEqual([{ account: "Me", card: 2, confirm: true }]);

    const direct = quotaHost();
    await runUsageResetCommand(undefined, { ...options, yes: true }, direct.connect);
    expect(direct.resets).toEqual([{ confirm: true }]);
  });

  it("spends nothing without confirmation", async () => {
    const daemon = quotaHost();
    await expect(runUsageResetCommand(undefined, options, daemon.connect)).rejects.toMatchObject({
      code: "NOT_CONFIRMED",
    });
    await expect(
      runUsageResetCommand(undefined, options, daemon.connect, async () => false),
    ).rejects.toMatchObject({ code: "NOT_CONFIRMED" });
    expect(daemon.resets).toEqual([]);
  });

  it("takes one account and no unknown flags, as myna's quota reset does", () => {
    expect(resetAccountOf([])).toBeUndefined();
    expect(resetAccountOf(["Me"])).toBe("Me");
    expect(() => resetAccountOf(["A", "B"])).toThrow("one account at a time: A or B");
    expect(() => resetAccountOf(["--card", "2"])).toThrow("neox usage reset doesn't know --card");
  });

  it("refuses a card that is not a positive number", async () => {
    const daemon = quotaHost();
    await expect(
      runUsageResetCommand(undefined, { ...options, yes: true, card: "0" }, daemon.connect),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(daemon.resets).toEqual([]);
  });

  it("gates hosts without the reset RPC", async () => {
    await expect(
      runUsageResetCommand(
        undefined,
        { ...options, yes: true },
        quotaHost(quotaAccounts, true, true, false).connect,
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_HOST" });
  });
});

describe("usage credits", () => {
  it("lists only the accounts that change how they spend credits", async () => {
    const config = codexConfig();
    (config.providers as Array<{ accounts: Array<Record<string, unknown>> }>)[0]!.accounts[0]![
      "creditsMode"
    ] = "off";
    const { rows } = await runCreditsCommand([], { home: home(config) });
    expect(rows).toEqual([{ provider: "openai", account: "me", label: "Me", creditsMode: "off" }]);
  });

  it("sets each mode and clears it back to on", async () => {
    const dir = home(codexConfig());
    await runCreditsCommand(["me", "first"], { home: dir });
    expect(accountIn(dir, "me")).toMatchObject({ creditsMode: "first" });
    await runCreditsCommand(["neox:work", "last"], { home: dir });
    expect(accountIn(dir, "work")).toMatchObject({ creditsMode: "last" });
    await runCreditsCommand(["me", "off"], { home: dir });
    expect(accountIn(dir, "me")).toMatchObject({ creditsMode: "off" });
    await runCreditsCommand(["me", "on"], { home: dir });
    expect(accountIn(dir, "me")).not.toHaveProperty("creditsMode");
  });

  it("refuses a mode without an account and an unknown account", async () => {
    await expect(runCreditsCommand(["off"], { home: home(codexConfig()) })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(
      runCreditsCommand(["nobody", "on"], { home: home(codexConfig()) }),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
  });
});

describe("usage alert", () => {
  function configHome(config: Record<string, unknown> = {}): string {
    const dir = home();
    writeFileSync(join(dir, "config.json"), JSON.stringify(config));
    return dir;
  }
  const savedConfig = (dir: string) =>
    JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as Record<string, unknown>;

  it("shows the thresholds the daemon keeps", async () => {
    const row = await runAlertCommand(undefined, {
      home: configHome({ usageAlertPercent: 80, balanceAlert: 5 }),
    });
    expect(row).toEqual({ usageAlertPercent: 80, balanceAlert: 5 });
  });

  it("writes both thresholds and asks the daemon to take them", async () => {
    const dir = configHome();
    const reloads: string[] = [];
    const row = await runAlertCommand("70", { home: dir, balance: "2.5" }, async (neolixHome) => {
      reloads.push(neolixHome);
      return true;
    });
    expect(row).toEqual({ usageAlertPercent: 70, balanceAlert: 2.5, applied: true });
    expect(savedConfig(dir)).toMatchObject({ usageAlertPercent: 70, balanceAlert: 2.5 });
    expect(reloads).toHaveLength(1);
  });

  it("turns either off with 0 and keeps the other", async () => {
    const dir = configHome({ usageAlertPercent: 80, balanceAlert: 5 });
    await runAlertCommand("off", { home: dir }, async () => false);
    expect(savedConfig(dir)).toMatchObject({ usageAlertPercent: 0, balanceAlert: 5 });
    await runAlertCommand(undefined, { home: dir, balance: "off" }, async () => false);
    expect(savedConfig(dir)).toMatchObject({ usageAlertPercent: 0, balanceAlert: 0 });
  });

  it("refuses a share outside 1 to 100", async () => {
    const dir = configHome();
    await expect(runAlertCommand("101", { home: dir }, async () => false)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(savedConfig(dir)).not.toHaveProperty("usageAlertPercent");
  });
});
