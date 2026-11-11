import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addCodexAccount,
  arrangeCodexAccounts,
  codexAccountResting,
  loadCodexAccounts,
  pooledCodexSignIn,
  redactedCodexAccounts,
  removeCodexAccount,
  saveCodexAccounts,
  selectCodexAccount,
  setCodexAccountEnabled,
  type CodexOwnedAccount,
} from "./codex-accounts.js";
import { clearCodexLimits, noteCodexLimits } from "./codex-limits.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "neolix-codex-accounts-"));
  dirs.push(dir);
  return dir;
}

function account(overrides: Partial<CodexOwnedAccount> = {}): CodexOwnedAccount {
  return {
    id: "one",
    label: "me@example.com",
    plan: "pro",
    accountId: "acct-1",
    accessToken: "at",
    refreshToken: "rt",
    idToken: null,
    expiresAt: Date.now() + 60_000,
    addedAt: 1,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearCodexLimits();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
// Tests never reach the network: every code path that would fetch takes an
// injected fetch, so the global one throws.
beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("tests never reach the network");
  });
});

describe("codex account store", () => {
  it("reads an empty store as no accounts", async () => {
    expect(await loadCodexAccounts(join(tempDir(), "codex-accounts.json"))).toEqual([]);
  });

  it("writes the store 0600 and reads it back", async () => {
    const file = join(tempDir(), "codex-accounts.json");
    const saved = account();
    await saveCodexAccounts(file, [saved]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await loadCodexAccounts(file)).toEqual([saved]);
  });

  it("ignores a store that is not a list of accounts", async () => {
    const file = join(tempDir(), "codex-accounts.json");
    writeFileSync(file, JSON.stringify({ nope: true }));
    expect(await loadCodexAccounts(file)).toEqual([]);
  });

  it("never shows a token", () => {
    const saved = account();
    expect(redactedCodexAccounts([saved])).toEqual([
      {
        id: "one",
        label: "me@example.com",
        plan: "pro",
        accountId: "acct-1",
        expiresAt: saved.expiresAt,
        addedAt: 1,
        disabled: false,
      },
    ]);
  });

  it("replaces an account with the same ChatGPT account id", () => {
    const next = addCodexAccount([account()], account({ id: "two" }));
    expect(next).toHaveLength(1);
    expect(next[0]?.id).toBe("two");
  });

  it("removes an account by id", () => {
    expect(removeCodexAccount([account()], "one")).toEqual([]);
    expect(removeCodexAccount([account()], "other")).toHaveLength(1);
  });

  it("keeps the order the user set, then the rest as they were", () => {
    const accounts = [account({ id: "a" }), account({ id: "b" }), account({ id: "c" })];
    expect(arrangeCodexAccounts(accounts, ["c", "a", "gone"]).map((x) => x.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("switches an account off without losing its place", () => {
    const accounts = [account({ id: "a" }), account({ id: "b" })];
    const off = setCodexAccountEnabled(accounts, "b", false);
    expect(off.map((x) => x.disabled)).toEqual([undefined, true]);
    expect(setCodexAccountEnabled(off, "b", true)[1]?.disabled).toBe(false);
  });
});

describe("pooledCodexSignIn", () => {
  const now = 1_700_000_000_000;

  function jwt(exp: number): string {
    return `e30.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.sig`;
  }

  it("takes the first usable account of the pool", async () => {
    const file = join(tempDir(), "codex-accounts.json");
    await saveCodexAccounts(file, [
      account({ id: "one", accessToken: "at-one", expiresAt: now + 3_600_000 }),
      account({ id: "two", accountId: "acct-2" }),
    ]);
    const signIn = await pooledCodexSignIn({ accountsFile: file, writeBack: true, now });
    expect(signIn).toMatchObject({ accessToken: "at-one", limitKey: "one" });
  });

  it("skips an account whose window is spent and takes the next", async () => {
    const file = join(tempDir(), "codex-accounts.json");
    await saveCodexAccounts(file, [
      account({ id: "spent", expiresAt: now + 120_000 }),
      account({ id: "next", accountId: "acct-2" }),
    ]);
    noteCodexLimits("spent", [{ usedPercent: 100, windowMinutes: 300, resetAt: now + 60_000 }]);
    const signIn = await pooledCodexSignIn({ accountsFile: file, writeBack: true, now });
    expect(signIn?.limitKey).toBe("next");
  });

  it("never routes to an account switched off", async () => {
    const file = join(tempDir(), "codex-accounts.json");
    await saveCodexAccounts(file, [
      account({ id: "off", disabled: true }),
      account({ id: "on", accountId: "acct-2" }),
    ]);
    const signIn = await pooledCodexSignIn({ accountsFile: file, writeBack: true, now });
    expect(signIn?.limitKey).toBe("on");
  });

  it("refreshes a dying owned token and saves the rotated one", async () => {
    const file = join(tempDir(), "codex-accounts.json");
    await saveCodexAccounts(file, [
      account({ id: "one", accessToken: jwt(1_600_000_000), expiresAt: now - 1 }),
    ]);
    const fresh = jwt(1_800_000_000);
    const signIn = await pooledCodexSignIn({
      accountsFile: file,
      writeBack: true,
      now,
      fetchImpl: () =>
        Promise.resolve(
          new Response(JSON.stringify({ access_token: fresh, refresh_token: "rotated" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
    });
    expect(signIn?.accessToken).toBe(fresh);
    expect(signIn?.expiresAt).toBe(1_800_000_000_000);
    const saved = await loadCodexAccounts(file);
    expect(saved[0]?.refreshToken).toBe("rotated");
  });

  it("renews on demand when force asks, even far from expiry", async () => {
    const file = join(tempDir(), "codex-accounts.json");
    await saveCodexAccounts(file, [
      account({ id: "one", expiresAt: now + 3_600_000, refreshToken: "rt" }),
    ]);
    const fresh = jwt(1_800_000_000);
    const signIn = await pooledCodexSignIn({
      accountsFile: file,
      writeBack: true,
      force: true,
      now,
      fetchImpl: () =>
        Promise.resolve(
          new Response(JSON.stringify({ access_token: fresh, refresh_token: "rotated" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
    });
    expect(signIn?.accessToken).toBe(fresh);
    expect((await loadCodexAccounts(file))[0]?.refreshToken).toBe("rotated");
  });

  it("answers null when write-back is off and the only token has expired", async () => {
    const file = join(tempDir(), "codex-accounts.json");
    await saveCodexAccounts(file, [
      account({ id: "one", accessToken: jwt(1_600_000_000), expiresAt: now - 1 }),
    ]);
    let fetched = 0;
    const signIn = await pooledCodexSignIn({
      accountsFile: file,
      writeBack: false,
      now,
      fetchImpl: () => {
        fetched += 1;
        return Promise.resolve(new Response("{}", { status: 200 }));
      },
    });
    expect(signIn).toBeNull();
    expect(fetched).toBe(0);
  });

  it("answers null for an empty store", async () => {
    expect(
      await pooledCodexSignIn({
        accountsFile: join(tempDir(), "none.json"),
        writeBack: true,
        now,
      }),
    ).toBeNull();
  });
});

describe("codex account selection", () => {
  const now = 1_700_000_000_000;

  it("rests a spent window until it resets", () => {
    expect(
      codexAccountResting([{ usedPercent: 100, windowMinutes: 300, resetAt: now + 1 }], now),
    ).toBe(true);
    expect(codexAccountResting([{ usedPercent: 42, windowMinutes: 300, resetAt: null }], now)).toBe(
      false,
    );
  });

  it("takes the first usable account that is not resting", () => {
    const first = account({ id: "first", expiresAt: now - 1 });
    const second = account({ id: "second", accountId: "acct-2" });
    const third = account({ id: "third", accountId: "acct-3" });
    const limits = new Map([
      ["second", [{ usedPercent: 100, windowMinutes: 300, resetAt: now + 60_000 }]],
    ]);
    expect(
      selectCodexAccount([first, second, third], (entry) => limits.get(entry.id) ?? [], now)?.id,
    ).toBe("third");
  });

  it("passes over an account switched off", () => {
    const off = account({ id: "off", disabled: true });
    const on = account({ id: "on", accountId: "acct-2" });
    expect(selectCodexAccount([off, on], () => [], now)?.id).toBe("on");
  });

  it("says none when every account has expired or rests", () => {
    const expired = account({ id: "expired", expiresAt: now - 1 });
    const spent = account({ id: "spent" });
    expect(
      selectCodexAccount(
        [expired, spent],
        (entry) =>
          entry.id === "spent" ? [{ usedPercent: 100, windowMinutes: 300, resetAt: now + 1 }] : [],
        now,
      ),
    ).toBeNull();
  });
});
