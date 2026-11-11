import { afterEach, describe, expect, it } from "vitest";
import type { Logger } from "pino";
import { clearCodexLimits, noteCodexLimits } from "./codex-limits.js";
import {
  CodexResetScheduler,
  CodexWeekReset,
  readCodexResetCredits,
  spendCodexReset,
  type CodexResetSignIn,
} from "./codex-reset-run.js";
import type { GatewayAccount, GatewayConfig, GatewayProvider } from "./config.js";

const now = Date.parse("2026-11-06T12:00:00.000Z");
const minutes = (n: number): number => n * 60_000;

function captureLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const note = (...args: unknown[]) => {
    lines.push(JSON.stringify(args));
  };
  return { logger: { info: note, warn: note } as unknown as Logger, lines };
}

const logger = { info: () => undefined, warn: () => undefined } as unknown as Logger;

function account(overrides: Partial<GatewayAccount> = {}): GatewayAccount {
  return {
    id: "a1",
    priority: 0,
    weight: 1,
    models: [],
    warmup: false,
    warmAt: "",
    enabled: true,
    codexAccountId: "neolix:acc1",
    autoReset: "expiring",
    ...overrides,
  } as GatewayAccount;
}

function provider(accounts: GatewayAccount[]): GatewayProvider {
  return {
    id: "codex",
    protocol: "openai-responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    models: [],
    accounts,
    enabled: true,
  } as unknown as GatewayProvider;
}

function config(codexResetLead?: number): GatewayConfig {
  return { providers: [], codexResetLead } as unknown as GatewayConfig;
}

function signIn(overrides: Partial<CodexResetSignIn> = {}): CodexResetSignIn {
  return { accessToken: "token-1", accountId: "acc1", limitKey: "neolix:acc1", ...overrides };
}

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(answer: (call: Call) => Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  return { fetch: impl, calls };
}

function credits(
  entries: Array<{ id: string; expiresAt: string | null; status?: string }>,
): Response {
  return new Response(
    JSON.stringify({
      available_count: entries.length,
      credits: entries.map((entry) => ({
        id: entry.id,
        status: entry.status ?? "available",
        expires_at: entry.expiresAt,
      })),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function consumed(code = "reset"): Response {
  return new Response(JSON.stringify({ code, windows_reset: 1 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  clearCodexLimits();
});

describe("readCodexResetCredits", () => {
  it("asks as the account and keeps what still runs out, soonest first", async () => {
    const { fetch, calls } = fakeFetch((call) =>
      call.url.endsWith("/consume")
        ? consumed()
        : credits([
            { id: "later", expiresAt: "2026-11-06T18:00:00.000Z" },
            { id: "used", expiresAt: "2026-11-06T13:00:00.000Z", status: "redeemed" },
            { id: "soon", expiresAt: "2026-11-06T14:00:00.000Z" },
            { id: "never", expiresAt: null },
          ]),
    );
    const read = await readCodexResetCredits({ signIn: signIn(), fetchImpl: fetch });
    expect(read).toEqual([
      { id: "soon", expiresAt: Date.parse("2026-11-06T14:00:00.000Z") },
      { id: "later", expiresAt: Date.parse("2026-11-06T18:00:00.000Z") },
      { id: "never", expiresAt: null },
    ]);
    expect(calls[0]?.url).toBe("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer token-1");
    expect(headers["chatgpt-account-id"]).toBe("acc1");
    expect(headers.originator).toBe("codex_cli_rs");
  });
});

describe("CodexResetScheduler", () => {
  it("spends the reset the lead before it runs out, as the account, logging it without the token", async () => {
    noteCodexLimits("neolix:acc1", [{ usedPercent: 40, windowMinutes: 300, resetAt: null }]);
    const { fetch, calls } = fakeFetch((call) =>
      call.url.endsWith("/consume")
        ? consumed()
        : credits([{ id: "c1", expiresAt: new Date(now + minutes(20)).toISOString() }]),
    );
    const captured = captureLogger();
    const scheduler = new CodexResetScheduler({
      providers: () => [provider([account()])],
      config: () => config(),
      accountsFile: () => "/nonexistent/codex-accounts.json",
      logger: captured.logger,
      now: () => now,
      fetchImpl: fetch,
      signIn: async () => signIn(),
    });
    await scheduler.tick();
    expect(calls.map((call) => call.url.split("/wham")[1])).toEqual([
      "/rate-limit-reset-credits",
      "/rate-limit-reset-credits/consume",
    ]);
    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({ credit_id: "c1" });
    expect(captured.lines).toHaveLength(2);
    expect(captured.lines.join("\n")).toContain("Spending a Codex reset");
    expect(captured.lines.join("\n")).toContain("Spent a Codex reset");
    expect(captured.lines.join("\n")).not.toContain("token-1");
  });

  it("waits for a reset that is not near yet", async () => {
    noteCodexLimits("neolix:acc1", [{ usedPercent: 40, windowMinutes: 300, resetAt: null }]);
    const { fetch, calls } = fakeFetch(() =>
      credits([{ id: "c1", expiresAt: new Date(now + minutes(180)).toISOString() }]),
    );
    const scheduler = new CodexResetScheduler({
      providers: () => [provider([account()])],
      config: () => config(),
      accountsFile: () => "/nonexistent/codex-accounts.json",
      logger,
      now: () => now,
      fetchImpl: fetch,
      signIn: async () => signIn(),
    });
    await scheduler.tick();
    await scheduler.tick();
    expect(calls).toHaveLength(1);
  });

  it("keeps a reset when the account's windows have not been used", async () => {
    noteCodexLimits("neolix:acc1", [{ usedPercent: 0, windowMinutes: 300, resetAt: null }]);
    const { fetch, calls } = fakeFetch(() =>
      credits([{ id: "c1", expiresAt: new Date(now + minutes(5)).toISOString() }]),
    );
    const scheduler = new CodexResetScheduler({
      providers: () => [provider([account()])],
      config: () => config(),
      accountsFile: () => "/nonexistent/codex-accounts.json",
      logger,
      now: () => now,
      fetchImpl: fetch,
      signIn: async () => signIn(),
    });
    await scheduler.tick();
    expect(calls).toHaveLength(1);
  });

  it("uses the lead the gateway config sets", async () => {
    noteCodexLimits("neolix:acc1", [{ usedPercent: 40, windowMinutes: 300, resetAt: null }]);
    const { fetch, calls } = fakeFetch((call) =>
      call.url.endsWith("/consume")
        ? consumed()
        : credits([{ id: "c1", expiresAt: new Date(now + minutes(45)).toISOString() }]),
    );
    const scheduler = new CodexResetScheduler({
      providers: () => [provider([account()])],
      config: () => config(60),
      accountsFile: () => "/nonexistent/codex-accounts.json",
      logger,
      now: () => now,
      fetchImpl: fetch,
      signIn: async () => signIn(),
    });
    await scheduler.tick();
    expect(calls).toHaveLength(2);
  });

  it("spends at once when the account rests past the lead", async () => {
    noteCodexLimits("neolix:acc1", [{ usedPercent: 40, windowMinutes: 300, resetAt: null }]);
    const { fetch, calls } = fakeFetch((call) =>
      call.url.endsWith("/consume")
        ? consumed()
        : credits([{ id: "c1", expiresAt: new Date(now + minutes(180)).toISOString() }]),
    );
    const scheduler = new CodexResetScheduler({
      providers: () => [provider([account()])],
      config: () => config(),
      accountsFile: () => "/nonexistent/codex-accounts.json",
      logger,
      now: () => now,
      fetchImpl: fetch,
      signIn: async () => signIn(),
      restUntil: () => now + minutes(240),
    });
    await scheduler.tick();
    expect(calls).toHaveLength(2);
  });

  it("waits when the rest ends before the lead", async () => {
    noteCodexLimits("neolix:acc1", [{ usedPercent: 40, windowMinutes: 300, resetAt: null }]);
    const { fetch, calls } = fakeFetch(() =>
      credits([{ id: "c1", expiresAt: new Date(now + minutes(180)).toISOString() }]),
    );
    const scheduler = new CodexResetScheduler({
      providers: () => [provider([account()])],
      config: () => config(),
      accountsFile: () => "/nonexistent/codex-accounts.json",
      logger,
      now: () => now,
      fetchImpl: fetch,
      signIn: async () => signIn(),
      restUntil: () => now + minutes(10),
    });
    await scheduler.tick();
    expect(calls).toHaveLength(1);
  });

  it("leaves alone an account not let spend its resets", async () => {
    const { fetch, calls } = fakeFetch(() => credits([]));
    const scheduler = new CodexResetScheduler({
      providers: () => [provider([account({ autoReset: "week" })])],
      config: () => config(),
      accountsFile: () => "/nonexistent/codex-accounts.json",
      logger,
      now: () => now,
      fetchImpl: fetch,
      signIn: async () => signIn(),
    });
    await scheduler.tick();
    expect(calls).toHaveLength(0);
  });
});

describe("CodexWeekReset", () => {
  it("spends one when the week is used up, and only once for that week", async () => {
    noteCodexLimits("neolix:acc1", [
      { usedPercent: 100, windowMinutes: 10_080, resetAt: now + minutes(600) },
    ]);
    const { fetch, calls } = fakeFetch((call) =>
      call.url.endsWith("/consume") ? consumed() : credits([{ id: "c1", expiresAt: null }]),
    );
    const week = new CodexWeekReset({
      accountsFile: () => "/nonexistent/codex-accounts.json",
      logger,
      now: () => now,
      fetchImpl: fetch,
      signIn: async () => signIn(),
    });
    expect(await week.spend(account({ autoReset: "auto" }))).toEqual({
      spent: true,
      code: "reset",
    });
    expect(await week.spend(account({ autoReset: "auto" }))).toEqual({
      spent: false,
      code: "already_spent",
    });
    expect(calls.filter((call) => call.url.endsWith("/consume"))).toHaveLength(1);
  });

  it("does not try a second credit when the spend fails", async () => {
    noteCodexLimits("neolix:acc1", [
      { usedPercent: 100, windowMinutes: 10_080, resetAt: now + minutes(600) },
    ]);
    const { fetch, calls } = fakeFetch((call) =>
      call.url.endsWith("/consume")
        ? new Response("no", { status: 500 })
        : credits([
            { id: "c1", expiresAt: null },
            { id: "c2", expiresAt: null },
          ]),
    );
    const week = new CodexWeekReset({
      accountsFile: () => "/nonexistent/codex-accounts.json",
      logger,
      now: () => now,
      fetchImpl: fetch,
      signIn: async () => signIn(),
    });
    expect(await week.spend(account({ autoReset: "auto" }))).toEqual({
      spent: false,
      code: "error",
    });
    expect(calls.filter((call) => call.url.endsWith("/consume"))).toHaveLength(1);
  });

  it("keeps the reset while the week still has room", async () => {
    noteCodexLimits("neolix:acc1", [
      { usedPercent: 99, windowMinutes: 10_080, resetAt: now + minutes(600) },
    ]);
    const { fetch, calls } = fakeFetch(() => credits([]));
    const week = new CodexWeekReset({
      accountsFile: () => "/nonexistent/codex-accounts.json",
      logger,
      now: () => now,
      fetchImpl: fetch,
      signIn: async () => signIn(),
    });
    expect(await week.spend(account({ autoReset: "auto" }))).toEqual({
      spent: false,
      code: "week_not_used_up",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("spendCodexReset", () => {
  const spendInput = (fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) => ({
    config: { providers: [provider([account({ label: "Me" })])] } as unknown as GatewayConfig,
    accountsFile: "/nonexistent/codex-accounts.json",
    now,
    fetchImpl,
    logger,
    signIn: async () => signIn(),
    ...overrides,
  });

  it("spends the reset that runs out first by hand, logging it without the token", async () => {
    const { fetch, calls } = fakeFetch((call) =>
      call.url.endsWith("/consume")
        ? consumed()
        : credits([
            { id: "soon", expiresAt: new Date(now + minutes(30)).toISOString() },
            { id: "later", expiresAt: new Date(now + minutes(300)).toISOString() },
          ]),
    );
    const captured = captureLogger();
    const result = await spendCodexReset(
      spendInput(fetch, { account: "Me", logger: captured.logger }),
    );
    expect(result).toEqual({
      spent: true,
      code: "reset",
      windows: 1,
      accountLabel: "Me",
    });
    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({ credit_id: "soon" });
    expect(captured.lines.join("\n")).toContain("Spending a Codex reset by hand");
    expect(captured.lines.join("\n")).toContain("Spent a Codex reset by hand");
    expect(captured.lines.join("\n")).not.toContain("token-1");
  });

  it("takes the nth reset when a card is named", async () => {
    const { fetch, calls } = fakeFetch((call) =>
      call.url.endsWith("/consume")
        ? consumed()
        : credits([
            { id: "soon", expiresAt: new Date(now + minutes(30)).toISOString() },
            { id: "later", expiresAt: new Date(now + minutes(300)).toISOString() },
          ]),
    );
    const result = await spendCodexReset(spendInput(fetch, { card: 2 }));
    expect(result.spent).toBe(true);
    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({ credit_id: "later" });
  });

  it("says no_credit without a POST", async () => {
    const { fetch, calls } = fakeFetch(() => credits([]));
    const result = await spendCodexReset(spendInput(fetch));
    expect(result).toMatchObject({ spent: false, code: "no_credit" });
    expect(calls).toHaveLength(1);
  });

  it("refuses a card past the resets held", async () => {
    const { fetch } = fakeFetch(() => credits([{ id: "one", expiresAt: null }]));
    const result = await spendCodexReset(spendInput(fetch, { card: 3 }));
    expect(result).toMatchObject({ spent: false, code: "card_out_of_range" });
  });

  it("refuses an account it does not know without asking the vendor", async () => {
    const { fetch, calls } = fakeFetch(() => credits([]));
    const result = await spendCodexReset(spendInput(fetch, { account: "nobody" }));
    expect(result).toMatchObject({ spent: false, code: "no_account" });
    expect(calls).toHaveLength(0);
  });

  it("does not try a second reset when the spend fails", async () => {
    const { fetch, calls } = fakeFetch((call) =>
      call.url.endsWith("/consume")
        ? new Response("no", { status: 500 })
        : credits([
            { id: "one", expiresAt: null },
            { id: "two", expiresAt: null },
          ]),
    );
    const result = await spendCodexReset(spendInput(fetch));
    expect(result).toMatchObject({ spent: false, code: "error" });
    expect(calls.filter((call) => call.url.endsWith("/consume"))).toHaveLength(1);
  });
});
