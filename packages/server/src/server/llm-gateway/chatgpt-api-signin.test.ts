import { describe, expect, it } from "vitest";
import {
  completeChatGptApiSignIn,
  loadOrCreateChatGptHostId,
  refreshChatGptApiAccount,
  startChatGptApiSignIn,
} from "./chatgpt-api-signin.js";
import { pkcePair } from "./oauth.js";
import type { ChatGptApiAccount } from "./subscription-store.js";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function jwt(claims: Record<string, unknown>): string {
  return `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

function jsonAnswer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ID_CLAIMS = {
  iss: "https://auth.openai.com",
  aud: "client-issued",
  nonce: "nonce-1",
  exp: 4_102_444_800,
  email: "me@example.com",
  sub: "sub-1",
  "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
};

function account(overrides: Partial<ChatGptApiAccount> = {}): ChatGptApiAccount {
  return {
    agent: "chatgpt-api",
    id: "chatgpt-api:x",
    user: "me@example.com",
    plan: "plus",
    addedAt: 1,
    lapsed: null,
    clientId: "client-issued",
    hostId: "urn:uuid:host",
    idToken: null,
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: 1000,
    scopes: ["openid"],
    ...overrides,
  };
}

describe("startChatGptApiSignIn", () => {
  it("opens OpenAI's page with the dynamic client and this machine's id", () => {
    const pair = pkcePair();
    const start = startChatGptApiSignIn({
      redirectUri: "http://127.0.0.1:1455/auth/callback",
      hostId: "urn:uuid:host",
      state: "state-1",
      verifier: pair.verifier,
      challenge: pair.challenge,
      nonce: "nonce-1",
    });
    const url = new URL(start.url);
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/api/accounts/authorize");
    expect(url.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(url.searchParams.get("agent_name_hint")).toBe("neolix");
    expect(url.searchParams.get("ext_agent_host_id")).toBe("urn:uuid:host");
    expect(url.searchParams.get("resource")).toBe("https://api.openai.com/v1");
    expect(url.searchParams.get("scope")).toContain("chatgpt.tokens.use.direct");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("nonce")).toBe("nonce-1");
  });
});

describe("completeChatGptApiSignIn", () => {
  const input = {
    code: "code-1",
    clientId: "client-issued",
    verifier: "verifier-1",
    redirectUri: "http://127.0.0.1:1455/auth/callback",
    nonce: "nonce-1",
    hostId: "urn:uuid:host",
    now: () => 5_000,
    addedAt: 7,
  };

  it("keeps the account the ID token names", async () => {
    const result = await completeChatGptApiSignIn({
      ...input,
      fetchImpl: () =>
        Promise.resolve(
          jsonAnswer({
            access_token: "access",
            refresh_token: "refresh",
            id_token: jwt(ID_CLAIMS),
            expires_in: 3600,
            scope: "openid chatgpt.tokens.use.direct",
          }),
        ),
    });
    expect(result).toEqual({
      account: {
        agent: "chatgpt-api",
        id: expect.stringMatching(/^chatgpt-api:/),
        user: "me@example.com",
        plan: "plus",
        addedAt: 7,
        lapsed: null,
        clientId: "client-issued",
        hostId: "urn:uuid:host",
        idToken: jwt(ID_CLAIMS),
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: 5_000 + 3_600_000,
        scopes: ["openid", "chatgpt.tokens.use.direct"],
      },
    });
  });

  it("says so when OpenAI registered no client", async () => {
    const result = await completeChatGptApiSignIn({ ...input, clientId: "" });
    expect(result).toEqual({
      error:
        "ChatGPT sign-in: OpenAI didn't finish registering Neox (no client id came back); start it again",
    });
  });

  it("refuses an account that may not use the subscription through the API", async () => {
    const result = await completeChatGptApiSignIn({
      ...input,
      fetchImpl: () =>
        Promise.resolve(
          jsonAnswer({
            access_token: "access",
            refresh_token: "refresh",
            id_token: jwt(ID_CLAIMS),
            expires_in: 3600,
            scope: "openid",
          }),
        ),
    });
    expect(result).toMatchObject({ error: expect.stringContaining("may not be eligible") });
  });

  it("refuses an ID token minted for another sign-in", async () => {
    const result = await completeChatGptApiSignIn({
      ...input,
      fetchImpl: () =>
        Promise.resolve(
          jsonAnswer({
            access_token: "access",
            refresh_token: "refresh",
            id_token: jwt({ ...ID_CLAIMS, nonce: "someone-else" }),
            expires_in: 3600,
            scope: "chatgpt.tokens.use.direct",
          }),
        ),
    });
    expect(result).toEqual({ error: "ChatGPT sign-in: the ID token isn't this sign-in's" });
  });
});

describe("refreshChatGptApiAccount", () => {
  it("leaves a token with time left alone", async () => {
    const result = await refreshChatGptApiAccount(account({ expiresAt: 10 * 60_000 }), {
      now: () => 5_000,
      fetchImpl: () => {
        throw new Error("no request expected");
      },
    });
    expect(result).toMatchObject({ refreshed: false });
  });

  it("renews only the tokens, keeping the client", async () => {
    const result = await refreshChatGptApiAccount(account(), {
      now: () => 5_000,
      fetchImpl: () =>
        Promise.resolve(
          jsonAnswer({
            access_token: "new-access",
            refresh_token: "new-refresh",
            id_token: jwt(ID_CLAIMS),
            expires_in: 3600,
            scope: "openid chatgpt.tokens.use.direct",
          }),
        ),
    });
    expect(result).toMatchObject({
      refreshed: true,
      account: {
        accessToken: "new-access",
        refreshToken: "new-refresh",
        clientId: "client-issued",
        hostId: "urn:uuid:host",
        expiresAt: 5_000 + 3_600_000,
      },
    });
  });

  it("marks the account lapsed when OpenAI refuses the refresh token", async () => {
    const result = await refreshChatGptApiAccount(account(), {
      now: () => 5_000,
      fetchImpl: () => Promise.resolve(jsonAnswer({ error: "invalid_grant" }, 400)),
    });
    expect(result).toEqual({
      error: "me@example.com's ChatGPT sign-in has expired — sign in again",
      lapsed: "me@example.com's ChatGPT sign-in has expired — sign in again",
    });
  });

  it("says a forgotten client is not a lapsed sign-in", async () => {
    const result = await refreshChatGptApiAccount(account(), {
      now: () => 5_000,
      fetchImpl: () => Promise.resolve(jsonAnswer({ error: "invalid_client" }, 401)),
    });
    expect(result).toMatchObject({ error: expect.stringContaining("no longer knows the client") });
    expect(result).not.toHaveProperty("lapsed");
  });
});

describe("loadOrCreateChatGptHostId", () => {
  it("makes one id and keeps it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "neolix-chatgpt-host-"));
    try {
      const first = await loadOrCreateChatGptHostId(dir);
      expect(first).toMatch(
        /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      // Windows cannot express POSIX permissions; the file is private by location there.
      if (process.platform !== "win32") {
        expect(statSync(join(dir, "chatgpt-api-host")).mode & 0o777).toBe(0o600);
      }
      expect(readFileSync(join(dir, "chatgpt-api-host"), "utf8").trim()).toBe(first);
      expect(await loadOrCreateChatGptHostId(dir)).toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
