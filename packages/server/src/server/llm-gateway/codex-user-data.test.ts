import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_CLIENT_ID,
  codexKeychainAccount,
  discoverCodexAccounts,
  readCodexSignIn,
  renewCodexSignIn,
} from "./codex-user-data.js";

const homes: string[] = [];
const testEnv = { VITEST: "true" };

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "neolix-codex-home-"));
  homes.push(dir);
  return dir;
}

function jwt(claims: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `e30.${body}.sig`;
}

function signedInAuth(expSeconds = Math.floor(Date.now() / 1000) + 3600): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      id_token: jwt({
        email: "me@example.com",
        "https://api.openai.com/auth": {
          chatgpt_plan_type: "pro",
          chatgpt_account_id: "acct-1",
        },
      }),
      access_token: jwt({ exp: expSeconds }),
      refresh_token: "rt",
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});
// Tests never reach the network: every code path that would fetch takes an
// injected fetch, so the global one throws.
beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("tests never reach the network");
  });
});

describe("discoverCodexAccounts", () => {
  it("reads a ChatGPT sign-in from auth.json", async () => {
    const home = tempHome();
    writeFileSync(join(home, "auth.json"), signedInAuth());
    const result = await discoverCodexAccounts({
      codexHome: home,
      env: testEnv,
      keychain: () => null,
    });
    expect(result.discovery).toBe(true);
    expect(result.accounts).toHaveLength(1);
    const account = result.accounts[0]!;
    expect(account.signedIn).toBe(true);
    expect(account.label).toBe("me@example.com");
    expect(account.plan).toBe("pro");
    expect(account.accountId).toBe("acct-1");
    expect(account.store).toBe("file");
    expect(account.expiresAt).toBeGreaterThan(Date.now());
  });

  it("names a workspace seat by its plan", async () => {
    const home = tempHome();
    const auth = JSON.parse(signedInAuth()) as {
      tokens: { id_token: string };
    };
    auth.tokens.id_token = jwt({
      email: "me@example.com",
      "https://api.openai.com/auth": { chatgpt_plan_type: "team" },
    });
    writeFileSync(join(home, "auth.json"), JSON.stringify(auth));
    const account = (await discoverCodexAccounts({ codexHome: home, env: testEnv })).accounts[0]!;
    expect(account.label).toBe("me@example.com · Team");
  });

  it("reads nothing when discovery is off", async () => {
    const home = tempHome();
    writeFileSync(join(home, "auth.json"), signedInAuth());
    const result = await discoverCodexAccounts({
      codexHome: home,
      env: testEnv,
      discovery: false,
    });
    expect(result).toEqual({ discovery: false, accounts: [] });
  });

  it("takes no ChatGPT sign-in when Codex is asked to use an API key", async () => {
    const home = tempHome();
    writeFileSync(join(home, "config.toml"), 'forced_login_method = "api"\n');
    writeFileSync(join(home, "auth.json"), signedInAuth());
    const account = (await discoverCodexAccounts({ codexHome: home, env: testEnv })).accounts[0]!;
    expect(account.signedIn).toBe(false);
    expect(account.error).toContain("API key");
  });

  it("leaves an API-key auth.json out of the ChatGPT accounts", async () => {
    const home = tempHome();
    writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "apikey" }));
    const account = (await discoverCodexAccounts({ codexHome: home, env: testEnv })).accounts[0]!;
    expect(account.signedIn).toBe(false);
    expect(account.error).toContain("API key");
  });

  it("says an unreadable auth.json says nothing", async () => {
    const home = tempHome();
    writeFileSync(join(home, "auth.json"), "{");
    const account = (await discoverCodexAccounts({ codexHome: home, env: testEnv })).accounts[0]!;
    expect(account.signedIn).toBe(false);
    expect(account.store).toBe("unreadable");
  });

  it("reads the keychain item when Codex keeps its sign-in there", async () => {
    const home = tempHome();
    writeFileSync(join(home, "config.toml"), 'cli_auth_credentials_store = "keyring"\n');
    const seen: string[] = [];
    const account = (
      await discoverCodexAccounts({
        codexHome: home,
        env: testEnv,
        keychain: (storeKey) => {
          seen.push(storeKey);
          return signedInAuth();
        },
      })
    ).accounts[0]!;
    expect(account.signedIn).toBe(true);
    expect(account.store).toBe("keychain");
    expect(seen).toEqual([await codexKeychainAccount(home)]);
  });

  it("falls back to auth.json when Codex's store is auto and the item is missing", async () => {
    const home = tempHome();
    writeFileSync(join(home, "config.toml"), 'cli_auth_credentials_store = "auto"\n');
    writeFileSync(join(home, "auth.json"), signedInAuth());
    const account = (
      await discoverCodexAccounts({
        codexHome: home,
        env: testEnv,
        keychain: () => null,
      })
    ).accounts[0]!;
    expect(account.signedIn).toBe(true);
    expect(account.store).toBe("file");
  });

  it("does not read this computer's own home in a test", async () => {
    await expect(
      discoverCodexAccounts({ env: { ...testEnv, HOME: "/tmp/a-real-looking-home" } }),
    ).resolves.toBeDefined();
    const realHome = process.env.HOME ?? "";
    await expect(
      discoverCodexAccounts({ codexHome: join(realHome, ".codex"), env: testEnv }),
    ).rejects.toThrow(/refused/);
  });

  it("leaves the real home untouched", async () => {
    const realHome = process.env.HOME ?? "";
    const auth = join(realHome, ".codex", "auth.json");
    const before = existsSync(auth) ? statSync(auth).mtimeMs : null;
    const home = tempHome();
    writeFileSync(join(home, "auth.json"), signedInAuth());
    await discoverCodexAccounts({ codexHome: home, env: testEnv });
    const after = existsSync(auth) ? statSync(auth).mtimeMs : null;
    expect(after).toBe(before);
  });
});

describe("renewCodexSignIn", () => {
  it("refreshes a dying token and writes the rotated one back where Codex keeps it", async () => {
    const home = tempHome();
    writeFileSync(join(home, "auth.json"), signedInAuth(1_000), { mode: 0o600 });
    const seen: URLSearchParams[] = [];
    const fresh = signedInAuth();
    const signIn = await renewCodexSignIn({
      codexHome: home,
      env: testEnv,
      renew: true,
      fetchImpl: (input, init) => {
        seen.push(new URLSearchParams(String(init?.body ?? "")));
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: (JSON.parse(fresh) as { tokens: { access_token: string } }).tokens
                .access_token,
              refresh_token: "rotated",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      },
    });
    expect(signIn.ok).toBe(true);
    expect(seen[0]?.get("grant_type")).toBe("refresh_token");
    expect(seen[0]?.get("client_id")).toBe(CODEX_CLIENT_ID);
    expect(seen[0]?.get("refresh_token")).toBe("rt");
    const kept = JSON.parse(readFileSync(join(home, "auth.json"), "utf8")) as {
      tokens: { access_token: string; refresh_token: string };
    };
    expect(kept.tokens.refresh_token).toBe("rotated");
    expect(kept.tokens.access_token).not.toBe("");
    // Windows cannot express POSIX permissions; the file is private by location there.
    if (process.platform !== "win32") {
      expect(statSync(join(home, "auth.json")).mode & 0o777).toBe(0o600);
    }
  });

  it("leaves an expired sign-in to Codex when its provider is left alone", async () => {
    const home = tempHome();
    const before = signedInAuth(1_000);
    writeFileSync(join(home, "auth.json"), before);
    const signIn = await renewCodexSignIn({ codexHome: home, env: testEnv, renew: false });
    expect(signIn.ok).toBe(false);
    expect(readFileSync(join(home, "auth.json"), "utf8")).toBe(before);
  });

  it("writes the keychain item when Codex keeps its sign-in there", async () => {
    const home = tempHome();
    writeFileSync(join(home, "config.toml"), 'cli_auth_credentials_store = "keyring"\n');
    const written: string[] = [];
    const fresh = signedInAuth();
    const signIn = await renewCodexSignIn({
      codexHome: home,
      env: testEnv,
      renew: true,
      keychain: () => signedInAuth(1_000),
      writeKeychain: (storeKey, secret) => {
        written.push(`${storeKey}\n${secret}`);
        return Promise.resolve();
      },
      fetchImpl: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: (JSON.parse(fresh) as { tokens: { access_token: string } }).tokens
                .access_token,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
    });
    expect(signIn.ok).toBe(true);
    expect(written).toHaveLength(1);
    expect(written[0]?.startsWith(`${await codexKeychainAccount(home)}\n`)).toBe(true);
  });

  it("refreshes a token with time left when the backend returns 401", async () => {
    const home = tempHome();
    writeFileSync(join(home, "auth.json"), signedInAuth());
    let asked = 0;
    const signIn = await renewCodexSignIn({
      codexHome: home,
      env: testEnv,
      renew: true,
      force: true,
      fetchImpl: () => {
        asked += 1;
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: jwt({ exp: 9_999_999_999 }) }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      },
    });
    expect(signIn.ok).toBe(true);
    expect(asked).toBe(1);
  });

  it("writes nothing and calls nothing when write-back is off", async () => {
    const home = tempHome();
    const before = signedInAuth(1_000);
    writeFileSync(join(home, "auth.json"), before);
    writeFileSync(join(home, "config.toml"), 'cli_auth_credentials_store = "keyring"\n');
    let fetched = 0;
    let written = 0;
    const signIn = await renewCodexSignIn({
      codexHome: home,
      env: testEnv,
      renew: true,
      writeBack: false,
      keychain: () => before,
      fetchImpl: () => {
        fetched += 1;
        return Promise.resolve(new Response("{}", { status: 200 }));
      },
      writeKeychain: () => {
        written += 1;
        return Promise.resolve();
      },
    });
    expect(signIn.ok).toBe(false);
    expect(fetched).toBe(0);
    expect(written).toBe(0);
    expect(readFileSync(join(home, "auth.json"), "utf8")).toBe(before);
  });

  it("keeps the file as it was when the refresh is refused", async () => {
    const home = tempHome();
    const before = signedInAuth(1_000);
    writeFileSync(join(home, "auth.json"), before);
    const signIn = await renewCodexSignIn({
      codexHome: home,
      env: testEnv,
      renew: true,
      fetchImpl: () => Promise.resolve(new Response("no", { status: 401 })),
    });
    expect(signIn.ok).toBe(false);
    expect(readFileSync(join(home, "auth.json"), "utf8")).toBe(before);
  });
});

describe("readCodexSignIn", () => {
  it("gives the access token and account id Codex keeps", async () => {
    const home = tempHome();
    writeFileSync(join(home, "auth.json"), signedInAuth());
    const signIn = await readCodexSignIn({ codexHome: home, env: testEnv });
    expect(signIn.ok).toBe(true);
    if (signIn.ok) {
      expect(signIn.accessToken).toBeTypeOf("string");
      expect(signIn.accountId).toBe("acct-1");
    }
  });

  it("leaves an expired sign-in to Codex to renew", async () => {
    const home = tempHome();
    writeFileSync(join(home, "auth.json"), signedInAuth(1_000));
    const signIn = await readCodexSignIn({ codexHome: home, env: testEnv });
    expect(signIn).toEqual({
      ok: false,
      error: "Codex's sign-in has expired; Codex renews it as it runs",
    });
  });

  it("reads nothing when discovery is off", async () => {
    const home = tempHome();
    writeFileSync(join(home, "auth.json"), signedInAuth());
    const signIn = await readCodexSignIn({
      codexHome: home,
      env: testEnv,
      discovery: false,
    });
    expect(signIn.ok).toBe(false);
  });
});
