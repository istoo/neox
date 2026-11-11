import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codexCreditsFirst } from "./codex-credits.js";
import { GatewayConfigSchema, type GatewayConfig } from "./config.js";
import {
  clearSignInReturn,
  readSignInReturn,
  SignInSwitchScheduler,
  switchSignInWhenSpent,
} from "./sign-in-switch.js";
import {
  BACK_SHARE,
  capReached,
  nextInOrder,
  nextLogin,
  returnsToFirst,
  roomLeft,
  spentShareOf,
  usedPast,
  type SignInWindow,
} from "./switch-only.js";

const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Home {
  root: string;
  homeDir: string;
  codexHome: string;
  gatewayDir: string;
  claudeCredentials: string;
  claudeAccountsFile: string;
}

async function tempHome(): Promise<Home> {
  const root = await mkdtemp(join(tmpdir(), "neolix-signin-"));
  dirs.push(root);
  const homeDir = join(root, "home");
  const codexHome = join(homeDir, ".codex");
  const gatewayDir = join(root, "neolix", "gateway");
  await mkdir(codexHome, { recursive: true });
  await mkdir(gatewayDir, { recursive: true });
  return {
    root,
    homeDir,
    codexHome,
    gatewayDir,
    claudeCredentials: join(homeDir, ".claude", ".credentials.json"),
    claudeAccountsFile: join(gatewayDir, "claude-accounts.json"),
  };
}

function authText(refreshToken: string, accountId: string): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      id_token: "",
      access_token: `access-${accountId}`,
      refresh_token: refreshToken,
      account_id: accountId,
    },
  });
}

async function writeCodexHome(home: Home, refreshToken: string, accountId: string): Promise<void> {
  await writeFile(join(home.codexHome, "auth.json"), authText(refreshToken, accountId), "utf8");
}

async function writeCodexPool(home: Home): Promise<void> {
  const entry = (accountId: string, label: string): Record<string, unknown> => ({
    id: `neolix:${accountId}`,
    label,
    plan: "plus",
    accountId,
    accessToken: `access-${accountId}`,
    refreshToken: `r-${accountId}`,
    idToken: null,
    expiresAt: null,
    addedAt: 1,
  });
  await writeFile(
    join(home.gatewayDir, "codex-accounts.json"),
    JSON.stringify([entry("acct-a", "a@example.com"), entry("acct-b", "b@example.com")]),
    "utf8",
  );
}

function codexConfig(overrides: Record<string, unknown> = {}): GatewayConfig {
  return GatewayConfigSchema.parse({
    codexAutoSwitchSignIn: true,
    providers: [
      {
        id: "codex",
        protocol: "openai",
        baseUrl: "https://chatgpt.test/backend-api/codex",
        switchOnly: true,
        accounts: [],
        models: [],
      },
    ],
    ...overrides,
  });
}

function windows(usedPercent: number, resetAt: number | null = null): SignInWindow[] {
  return [{ usedPercent, resetAt }];
}

async function codexAuthRefresh(home: Home): Promise<string> {
  const parsed = JSON.parse(await readFile(join(home.codexHome, "auth.json"), "utf8")) as {
    tokens?: { refresh_token?: string };
  };
  return parsed.tokens?.refresh_token ?? "";
}

describe("nextLogin rules", () => {
  const account = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    enabled: true,
    lapsed: null,
    home: "",
    ...overrides,
  });

  it("keeps myna's shares and the routing that moves at 100 instead of 98", () => {
    expect(BACK_SHARE).toBe(90);
    expect(spentShareOf(undefined)).toBe(98);
    expect(spentShareOf("smart")).toBe(98);
    expect(spentShareOf("order")).toBe(100);
    expect(spentShareOf("drain")).toBe(100);
    expect(returnsToFirst("codex", undefined, true)).toBe(false);
    expect(returnsToFirst("codex", "order", true)).toBe(true);
    expect(returnsToFirst("claude", undefined, true)).toBe(false);
    expect(returnsToFirst("codex", undefined, false)).toBe(true);
  });

  it("counts a window whose reset passed as started again", () => {
    expect(usedPast(windows(100, NOW - 1), 98, NOW)).toBe(false);
    expect(usedPast(windows(100, NOW + 1), 98, NOW)).toBe(true);
    expect(usedPast(windows(97), 98, NOW)).toBe(false);
  });

  it("holds an account at its own cap, and leaves no room past it", () => {
    expect(capReached(windows(60), { all: 50 }, NOW)).toBe(true);
    expect(capReached(windows(60), undefined, NOW)).toBe(false);
    expect(
      capReached(
        [{ usedPercent: 60, resetAt: null, name: "5h" }],
        { windows: { "5 hours": 50 } },
        NOW,
      ),
    ).toBe(true);
    expect(roomLeft(windows(60), 98, { all: 50 }, NOW)).toBe(-10);
    expect(roomLeft(windows(95), 98, undefined, NOW)).toBe(3);
  });

  it("goes back to the account it moved off once that is no longer low", () => {
    const accounts = [account("a"), account("b")];
    const limits = new Map([
      ["a", windows(89)],
      ["b", windows(10)],
    ]);
    const input = {
      agent: "codex" as const,
      routing: "order" as const,
      switchOnly: true,
      activeId: "b",
      accounts,
      returnTo: "a",
      windowsOf: (id: string) => limits.get(id),
      now: NOW,
    };
    expect(nextLogin(input)).toEqual({ from: "b", to: "a", back: true });
    limits.set("a", windows(90));
    expect(nextLogin(input)).toBeNull();
  });

  it("keeps a spent account on its credits only when creditsMode is first", () => {
    const limits = new Map([
      ["a", windows(100)],
      ["b", windows(10)],
    ]);
    const base = {
      agent: "codex" as const,
      switchOnly: true,
      activeId: "a",
      accounts: [account("a"), account("b")],
      returnTo: null,
      windowsOf: (id: string) => limits.get(id),
      now: NOW,
    };
    // myna's CodexCreditsFirst is only the "first" mode: "on" spends the
    // credits in its place and the sign-in still moves on.
    expect(codexCreditsFirst({ creditsMode: "first" })).toBe(true);
    for (const mode of ["on", "last", "off"] as const) {
      expect(codexCreditsFirst({ creditsMode: mode })).toBe(false);
    }
    expect(codexCreditsFirst({})).toBe(false);
    expect(
      nextLogin({
        ...base,
        creditsFirstOf: () => codexCreditsFirst({ creditsMode: "first" }),
        creditsOf: () => true,
      }),
    ).toBeNull();
    expect(
      nextLogin({
        ...base,
        creditsFirstOf: () => codexCreditsFirst({ creditsMode: "on" }),
        creditsOf: () => true,
      }),
    ).toEqual({ from: "a", to: "b", back: false });
    expect(nextLogin({ ...base, creditsFirstOf: () => true, creditsOf: () => false })).toEqual({
      from: "a",
      to: "b",
      back: false,
    });
  });

  it("picks the first spare with room, else the one with the most room left", () => {
    const accounts = [account("a"), account("b"), account("c")];
    const limits = new Map([
      ["a", windows(99)],
      ["b", windows(100)],
      ["c", windows(30)],
    ]);
    expect(
      nextLogin({
        agent: "codex",
        switchOnly: true,
        activeId: "a",
        accounts,
        returnTo: null,
        windowsOf: (id) => limits.get(id),
        now: NOW,
      }),
    ).toEqual({ from: "a", to: "c", back: false });
    limits.set("a", windows(100));
    limits.set("b", windows(98.2));
    limits.set("c", windows(99.2));
    expect(
      nextLogin({
        agent: "codex",
        switchOnly: true,
        activeId: "a",
        accounts,
        returnTo: null,
        windowsOf: (id) => limits.get(id),
        now: NOW,
      }),
    ).toEqual({ from: "a", to: "b", back: false });
  });
});

describe("nextInOrder rules", () => {
  const account = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    enabled: true,
    lapsed: null,
    home: "",
    ...overrides,
  });

  it("takes the first switchable account after the one it is on, cyclically", () => {
    const limits = new Map([
      ["a", windows(10)],
      ["b", windows(10)],
      ["c", windows(10)],
    ]);
    expect(
      nextInOrder({
        accounts: [account("a"), account("b"), account("c")],
        activeId: "b",
        share: 98,
        windowsOf: (id) => limits.get(id),
        now: NOW,
      }),
    ).toEqual({ status: "chosen", to: "c", over: false });
    // An account switched off in Neolix is still taken: on/off is the
    // gateway's, not the sign-in's.
    expect(
      nextInOrder({
        accounts: [account("a"), account("b"), account("c", { enabled: false })],
        activeId: "b",
        share: 98,
        windowsOf: (id) => limits.get(id),
        now: NOW,
      }),
    ).toEqual({ status: "chosen", to: "c", over: false });
  });

  it("passes over a lapsed account and one held in another Codex folder", () => {
    const limits = new Map([
      ["a", windows(10)],
      ["b", windows(10)],
      ["c", windows(10)],
    ]);
    expect(
      nextInOrder({
        accounts: [
          account("a"),
          account("b"),
          account("c", { lapsed: "revoked" }),
          account("d", { home: "/tmp/other-codex" }),
          account("e"),
        ],
        activeId: "b",
        share: 98,
        windowsOf: (id) => limits.get(id) ?? windows(10),
        now: NOW,
      }),
    ).toEqual({ status: "chosen", to: "e", over: false });
  });

  it("says over when every other account is past its line", () => {
    const limits = new Map([
      ["a", windows(100)],
      ["b", windows(99.5)],
    ]);
    expect(
      nextInOrder({
        accounts: [account("a"), account("b")],
        activeId: "a",
        share: 98,
        windowsOf: (id) => limits.get(id),
        now: NOW,
      }),
    ).toEqual({ status: "chosen", to: "b", over: true });
  });

  it("says unread when no other account's allowance is known", () => {
    expect(
      nextInOrder({
        accounts: [account("a"), account("b")],
        activeId: "a",
        share: 98,
        windowsOf: () => undefined,
        now: NOW,
      }),
    ).toEqual({ status: "unread" });
  });
});

describe("the automatic sign-in switch", () => {
  it("signs Codex in to the next account with room and keeps the one to go back to", async () => {
    const home = await tempHome();
    await writeCodexHome(home, "r-acct-a", "acct-a");
    await writeCodexPool(home);
    const restart = vi.fn();
    const result = await switchSignInWhenSpent({
      agent: "codex",
      provider: codexConfig().providers[0]!,
      config: codexConfig(),
      gatewayDir: home.gatewayDir,
      homeDir: home.homeDir,
      codexHome: home.codexHome,
      env: {},
      now: NOW,
      windowsOf: (_agent, account) => (account.id === "neolix:acct-a" ? windows(99) : windows(10)),
      restartCodexApp: restart,
    });
    expect(result).toMatchObject({
      status: "switched",
      from: "neolix:acct-a",
      to: "neolix:acct-b",
      back: false,
    });
    expect(await codexAuthRefresh(home)).toBe("r-acct-b");
    expect(await readSignInReturn(home.gatewayDir, "codex")).toEqual({
      back: "neolix:acct-a",
      to: "neolix:acct-b",
    });
    expect(restart).toHaveBeenCalledWith({
      from: "neolix:acct-a",
      to: "neolix:acct-b",
      back: false,
      spent: true,
    });
  });

  it("puts the sign-in Codex already holds into the pool first", async () => {
    const home = await tempHome();
    await writeCodexHome(home, "r-acct-a", "acct-a");
    // The pool holds only the spare: Codex's own sign-in was made with
    // `codex login`, outside Neolix.
    await writeFile(
      join(home.gatewayDir, "codex-accounts.json"),
      JSON.stringify([
        {
          id: "neolix:acct-b",
          label: "b@example.com",
          plan: "plus",
          accountId: "acct-b",
          accessToken: "access-acct-b",
          refreshToken: "r-acct-b",
          idToken: null,
          expiresAt: null,
          addedAt: 1,
        },
      ]),
      "utf8",
    );
    const config = codexConfig();
    const result = await switchSignInWhenSpent({
      agent: "codex",
      provider: config.providers[0]!,
      config,
      gatewayDir: home.gatewayDir,
      homeDir: home.homeDir,
      codexHome: home.codexHome,
      env: {},
      now: NOW,
      windowsOf: (_agent, account) => (account.id === "neolix:acct-a" ? windows(99) : windows(10)),
    });
    expect(result).toMatchObject({
      status: "switched",
      from: "neolix:acct-a",
      to: "neolix:acct-b",
    });
    const pool = JSON.parse(
      await readFile(join(home.gatewayDir, "codex-accounts.json"), "utf8"),
    ) as { id: string }[];
    expect(pool.map((entry) => entry.id)).toContain("neolix:acct-a");
    expect(await codexAuthRefresh(home)).toBe("r-acct-b");
  });

  it("restarts Codex's app-server on the way off, and back only with restartApp", async () => {
    const home = await tempHome();
    await writeCodexHome(home, "r-acct-a", "acct-a");
    await writeCodexPool(home);
    const limits = new Map([
      ["neolix:acct-a", windows(100)],
      ["neolix:acct-b", windows(10)],
    ]);
    const restart = vi.fn();
    const config = codexConfig({
      providers: [
        {
          id: "codex",
          protocol: "openai",
          baseUrl: "https://chatgpt.test/backend-api/codex",
          switchOnly: true,
          routing: "order",
          accounts: [],
          models: [],
        },
      ],
    });
    const switchNow = async (restartApp: boolean) =>
      switchSignInWhenSpent({
        agent: "codex",
        provider: { ...config.providers[0]!, restartApp },
        config,
        gatewayDir: home.gatewayDir,
        homeDir: home.homeDir,
        codexHome: home.codexHome,
        env: {},
        now: NOW,
        windowsOf: (_agent, account) => limits.get(account.id),
        restartCodexApp: restart,
      });
    expect(await switchNow(false)).toMatchObject({ status: "switched", back: false });
    expect(restart).toHaveBeenCalledWith(expect.objectContaining({ back: false, spent: true }));
    // The account it moved off has room again: the switch back does not
    // restart the app while restartApp is off.
    limits.set("neolix:acct-a", windows(10));
    restart.mockClear();
    expect(await switchNow(false)).toMatchObject({ status: "switched", back: true });
    expect(restart).not.toHaveBeenCalled();
    // With restartApp on, the switch it makes by itself restarts it too.
    await writeCodexHome(home, "r-acct-b", "acct-b");
    await writeFile(
      join(home.gatewayDir, "sign-in-returns.json"),
      JSON.stringify({ codex: { back: "neolix:acct-a", to: "neolix:acct-b" } }),
      "utf8",
    );
    expect(await switchNow(true)).toMatchObject({ status: "switched", back: true });
    expect(restart).toHaveBeenCalledWith(expect.objectContaining({ back: true, spent: false }));
  });

  it("does not switch before 98%", async () => {
    const home = await tempHome();
    await writeCodexHome(home, "r-acct-a", "acct-a");
    await writeCodexPool(home);
    const config = codexConfig();
    const result = await switchSignInWhenSpent({
      agent: "codex",
      provider: config.providers[0]!,
      config,
      gatewayDir: home.gatewayDir,
      homeDir: home.homeDir,
      codexHome: home.codexHome,
      env: {},
      now: NOW,
      windowsOf: (_agent, account) => (account.id === "neolix:acct-a" ? windows(97) : windows(0)),
    });
    expect(result.status).toBe("stayed");
    expect(await codexAuthRefresh(home)).toBe("r-acct-a");
    expect(await readSignInReturn(home.gatewayDir, "codex")).toBeNull();
  });

  it("writes nothing when switch-only or the automatic switch is off", async () => {
    for (const [switchOnly, auto] of [
      [false, true],
      [true, false],
    ] as const) {
      const home = await tempHome();
      await writeCodexHome(home, "r-acct-a", "acct-a");
      await writeCodexPool(home);
      const config = GatewayConfigSchema.parse({
        codexAutoSwitchSignIn: auto,
        providers: [
          {
            id: "codex",
            protocol: "openai",
            baseUrl: "https://chatgpt.test/backend-api/codex",
            switchOnly,
            accounts: [],
            models: [],
          },
        ],
      });
      const scheduler = new SignInSwitchScheduler({
        config: () => config,
        gatewayDir: home.gatewayDir,
        logger: { info: () => undefined, warn: () => undefined, debug: () => undefined },
        homeDir: home.homeDir,
        codexHome: home.codexHome,
        env: {},
        now: () => NOW,
        windowsOf: (_agent, account) =>
          account.id === "neolix:acct-a" ? windows(100) : windows(0),
      });
      const look = await scheduler.lookNow("codex");
      expect(look.status).toBe("skipped");
      scheduler.dispose();
      expect(await codexAuthRefresh(home)).toBe("r-acct-a");
      expect(await readSignInReturn(home.gatewayDir, "codex")).toBeNull();
    }
  });

  it("switches on its timer, and again back at the account's reset under order", async () => {
    const home = await tempHome();
    await writeCodexHome(home, "r-acct-a", "acct-a");
    await writeCodexPool(home);
    const limits = new Map([
      ["neolix:acct-a", windows(100)],
      ["neolix:acct-b", windows(10)],
    ]);
    const config = codexConfig({
      providers: [
        {
          id: "codex",
          protocol: "openai",
          baseUrl: "https://chatgpt.test/backend-api/codex",
          switchOnly: true,
          routing: "order",
          accounts: [],
          models: [],
        },
      ],
    });
    const scheduler = new SignInSwitchScheduler({
      config: () => config,
      gatewayDir: home.gatewayDir,
      logger: { info: () => undefined, warn: () => undefined, debug: () => undefined },
      homeDir: home.homeDir,
      codexHome: home.codexHome,
      env: {},
      now: () => NOW,
      firstLookMs: 1,
      everyMs: 60_000,
      windowsOf: (_agent, account) => limits.get(account.id),
    });
    scheduler.start();
    try {
      await vi.waitFor(
        async () => {
          expect(await codexAuthRefresh(home)).toBe("r-acct-b");
        },
        { timeout: 5000, interval: 10 },
      );
    } finally {
      scheduler.dispose();
    }
    expect(await readSignInReturn(home.gatewayDir, "codex")).toEqual({
      back: "neolix:acct-a",
      to: "neolix:acct-b",
    });
    // The first account has room again: back to it, at once.
    limits.set("neolix:acct-a", windows(10));
    limits.set("neolix:acct-b", windows(50));
    const back = await scheduler.lookNow("codex");
    expect(back).toMatchObject({ status: "switched", to: "neolix:acct-a", back: true });
    expect(await codexAuthRefresh(home)).toBe("r-acct-a");
    expect(await readSignInReturn(home.gatewayDir, "codex")).toBeNull();
  });

  it("signs Claude Code in to the next account when the one it is on is spent", async () => {
    const home = await tempHome();
    const credentials = (name: string): string =>
      JSON.stringify({
        claudeAiOauth: {
          accessToken: `access-${name}`,
          refreshToken: `r-${name}`,
          expiresAt: NOW + 60 * 60_000,
          subscriptionType: "max",
          scopes: [],
        },
      });
    await mkdir(join(home.homeDir, ".claude"), { recursive: true });
    await writeFile(home.claudeCredentials, credentials("a"), "utf8");
    await writeFile(
      home.claudeAccountsFile,
      JSON.stringify([
        {
          id: "claude:a",
          user: "a@example.com",
          plan: "max",
          addedAt: 1,
          lapsed: null,
          credentials: credentials("a"),
          accessToken: "access-a",
          refreshToken: "r-a",
          expiresAt: NOW + 60 * 60_000,
          subscriptionType: "max",
        },
        {
          id: "claude:b",
          user: "b@example.com",
          plan: "max",
          addedAt: 2,
          lapsed: null,
          credentials: credentials("b"),
          accessToken: "access-b",
          refreshToken: "r-b",
          expiresAt: NOW + 60 * 60_000,
          subscriptionType: "max",
        },
      ]),
      "utf8",
    );
    const config = GatewayConfigSchema.parse({
      claudeAutoSwitchSignIn: true,
      providers: [
        {
          id: "claude",
          protocol: "anthropic",
          baseUrl: "https://api.anthropic.test",
          switchOnly: true,
          accounts: [],
          models: [],
        },
      ],
    });
    const result = await switchSignInWhenSpent({
      agent: "claude",
      provider: config.providers[0]!,
      config,
      gatewayDir: home.gatewayDir,
      homeDir: home.homeDir,
      env: {},
      now: NOW,
      claudeCredentialsPath: home.claudeCredentials,
      readClaudeKeychain: async () => null,
      writeClaudeKeychain: async () => undefined,
      windowsOf: (_agent, account) => (account.id === "claude:a" ? windows(99) : windows(5)),
    });
    expect(result).toMatchObject({
      status: "switched",
      from: "claude:a",
      to: "claude:b",
      back: false,
    });
    expect(await readFile(home.claudeCredentials, "utf8")).toBe(credentials("b"));
  });

  it("clears the record the user's own switch replaces", async () => {
    const home = await tempHome();
    await writeFile(
      join(home.gatewayDir, "sign-in-returns.json"),
      JSON.stringify({ codex: { back: "a", to: "b" } }),
      "utf8",
    );
    expect(await readSignInReturn(home.gatewayDir, "codex")).toEqual({ back: "a", to: "b" });
    await clearSignInReturn(home.gatewayDir, "codex");
    expect(await readSignInReturn(home.gatewayDir, "codex")).toBeNull();
  });
});
