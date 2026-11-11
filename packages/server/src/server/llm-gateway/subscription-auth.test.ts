import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearCopilotSessions,
  loadSubscriptionAccount,
  subscriptionAuth,
} from "./subscription-auth.js";
import {
  saveSubscriptionAccounts,
  subscriptionAccountsFile,
  type ChatGptApiAccount,
  type CopilotAccount,
  type GoogleSubscriptionAccount,
} from "./subscription-store.js";

function jsonAnswer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "neolix-subscription-auth-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  clearCopilotSessions();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function googleAccount(user: string, id: string): GoogleSubscriptionAccount {
  return {
    agent: "gemini",
    id,
    user,
    plan: "Standard",
    addedAt: 1,
    lapsed: null,
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: 10 * 60_000,
    project: null,
  };
}

describe("loadSubscriptionAccount", () => {
  it("takes the first account when the provider names none", async () => {
    const dir = await tempDir();
    await saveSubscriptionAccounts(subscriptionAccountsFile(dir, "gemini"), [
      googleAccount("first@example.test", "g1"),
      googleAccount("second@example.test", "g2"),
    ]);

    expect(await loadSubscriptionAccount(dir, "gemini", "")).toMatchObject({
      user: "first@example.test",
    });
  });

  it("takes the account the provider names, by user or id", async () => {
    const dir = await tempDir();
    await saveSubscriptionAccounts(subscriptionAccountsFile(dir, "gemini"), [
      googleAccount("first@example.test", "g1"),
      googleAccount("second@example.test", "g2"),
    ]);

    expect(await loadSubscriptionAccount(dir, "gemini", "SECOND@example.test")).toMatchObject({
      user: "second@example.test",
    });
    expect(await loadSubscriptionAccount(dir, "gemini", "g1")).toMatchObject({
      user: "first@example.test",
    });
  });

  it("takes Copilot's own sign-in when Neox keeps no account", async () => {
    const home = await tempDir();
    const configDir = join(home, ".config");
    const hosts = join(configDir, "github-copilot", "hosts.json");
    const found = await loadSubscriptionAccount(join(home, "gateway"), "copilot", "", {
      home,
      configDir,
      readFileImpl: (path) =>
        path === hosts
          ? Promise.resolve(
              JSON.stringify({ "github.com": { oauth_token: "gho_own", user: "octocat" } }),
            )
          : Promise.reject(new Error("missing")),
    });

    expect(found).toMatchObject({ agent: "copilot", user: "octocat", own: true });
  });

  it("reads no Copilot own sign-in while account discovery is off", async () => {
    const home = await tempDir();
    const configDir = join(home, ".config");
    const found = await loadSubscriptionAccount(join(home, "gateway"), "copilot", "", {
      home,
      configDir,
      discovery: false,
      readFileImpl: () =>
        Promise.resolve(
          JSON.stringify({ "github.com": { oauth_token: "gho_own", user: "octocat" } }),
        ),
    });
    expect(found).toBeNull();
  });

  it("answers null when neither Neox nor the agent has a sign-in", async () => {
    const dir = await tempDir();
    expect(await loadSubscriptionAccount(dir, "gemini", "")).toBeNull();
    expect(await loadSubscriptionAccount(dir, "copilot", "", { home: dir })).toBeNull();
  });
});

describe("subscriptionAuth: ChatGPT API", () => {
  const account: ChatGptApiAccount = {
    agent: "chatgpt-api",
    id: "chatgpt-api:x",
    user: "me@example.com",
    plan: "plus",
    addedAt: 1,
    lapsed: null,
    clientId: "client",
    hostId: "host",
    idToken: null,
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: 10 * 60_000,
    scopes: ["openid"],
  };

  it("signs with the token it has", async () => {
    const auth = await subscriptionAuth(account, {
      now: () => 5_000,
      fetchImpl: () => {
        throw new Error("no request expected");
      },
    });
    expect(auth).toEqual({ agent: "chatgpt-api", headers: { authorization: "Bearer access" } });
  });

  it("renews a token about to expire, and hands the account back to be saved", async () => {
    const auth = await subscriptionAuth(
      { ...account, expiresAt: 5_000 + 60_000 },
      {
        now: () => 5_000,
        fetchImpl: () =>
          Promise.resolve(
            jsonAnswer({
              access_token: "new-access",
              refresh_token: "new-refresh",
              expires_in: 3600,
              scope: "openid",
            }),
          ),
      },
    );
    expect(auth).toMatchObject({
      headers: { authorization: "Bearer new-access" },
      renewed: { accessToken: "new-access", refreshToken: "new-refresh" },
    });
  });
});

describe("subscriptionAuth: Copilot", () => {
  const account: CopilotAccount = {
    agent: "copilot",
    id: "copilot:x",
    user: "octocat",
    plan: "Pro",
    addedAt: 1,
    lapsed: null,
    githubToken: "gho_x",
    host: "",
  };

  it("trades the GitHub token for a session and sends Copilot's own headers", async () => {
    const auth = await subscriptionAuth(account, {
      now: () => 5_000,
      fetchImpl: () =>
        Promise.resolve(
          jsonAnswer({
            token: "session",
            expires_at: 1_800_000_000,
            endpoints: { api: "https://api.githubcopilot.com" },
          }),
        ),
    });
    expect(auth).toMatchObject({
      baseUrl: "https://api.githubcopilot.com",
      headers: {
        authorization: "Bearer session",
        "Copilot-Integration-Id": "vscode-chat",
        "X-GitHub-Api-Version": "2026-01-09",
      },
    });
  });

  it("keeps the session until it is near expiring", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = () => {
      calls += 1;
      return Promise.resolve(
        jsonAnswer({ token: "session", expires_at: 1_800_000_000, endpoints: {} }),
      );
    };
    await subscriptionAuth(account, { now: () => 5_000, fetchImpl });
    await subscriptionAuth(account, { now: () => 6_000, fetchImpl });
    expect(calls).toBe(1);
  });

  it("trades the token through the account's proxy", async () => {
    let dispatcher: unknown = null;
    const fetchImpl = ((_input: unknown, init?: { dispatcher?: unknown }) => {
      dispatcher = init?.dispatcher ?? null;
      return Promise.resolve(
        jsonAnswer({ token: "session", expires_at: 1_800_000_000, endpoints: {} }),
      );
    }) as unknown as typeof fetch;
    await subscriptionAuth({ ...account, proxy: "direct" }, { now: () => 5_000, fetchImpl });
    expect(dispatcher).not.toBeNull();
  });

  it("says a refused sign-in, with no session to send", async () => {
    const auth = await subscriptionAuth(account, {
      now: () => 5_000,
      fetchImpl: () => Promise.resolve(jsonAnswer({ message: "bad" }, 401)),
    });
    expect(auth).toEqual({ error: "Copilot refused the sign-in; sign in again" });
  });
});

describe("subscriptionAuth: Google", () => {
  const account: GoogleSubscriptionAccount = {
    agent: "gemini",
    id: "gemini:x",
    user: "me@example.com",
    plan: "Standard",
    addedAt: 1,
    lapsed: null,
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: 10 * 60_000,
    project: "proj-1",
  };

  it("signs with the token it has", async () => {
    const auth = await subscriptionAuth(account, {
      now: () => 5_000,
      fetchImpl: () => {
        throw new Error("no request expected");
      },
    });
    expect(auth).toEqual({ agent: "gemini", headers: { authorization: "Bearer access" } });
  });
});
