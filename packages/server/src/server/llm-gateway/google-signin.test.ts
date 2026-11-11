import { describe, expect, it } from "vitest";
import {
  completeGoogleSignIn,
  discoverGoogleProject,
  googleAppOf,
  refreshGoogleAccount,
  startGoogleSignIn,
} from "./google-signin.js";
import type { GoogleSubscriptionAccount } from "./subscription-store.js";

function jsonAnswer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function route(routes: Record<string, () => Response>): typeof fetch {
  return (input) => {
    const url = String(input);
    const answer = routes[url];
    if (answer === undefined) {
      throw new Error(`unexpected request to ${url}`);
    }
    return Promise.resolve(answer());
  };
}

function account(overrides: Partial<GoogleSubscriptionAccount> = {}): GoogleSubscriptionAccount {
  return {
    agent: "gemini",
    id: "gemini:x",
    user: "me@example.com",
    plan: null,
    addedAt: 1,
    lapsed: null,
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: 10,
    project: null,
    ...overrides,
  };
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo?alt=json";
const LOAD_URL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const _ONBOARD_URL = "https://cloudcode-pa.googleapis.com/v1internal:onboardUser";

describe("startGoogleSignIn", () => {
  it("opens Google's page with the app's own client and scopes", () => {
    const start = startGoogleSignIn({
      agent: "antigravity",
      redirectUri: "http://localhost:5000/oauth-callback",
      state: "state-1",
      verifier: "v",
      challenge: "c",
    });
    const url = new URL(start.url);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(googleAppOf("antigravity").clientId);
    expect(url.searchParams.get("scope")).toContain("auth/cclog");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });
});

describe("completeGoogleSignIn", () => {
  it("keeps the account and the project Code Assist names", async () => {
    const result = await completeGoogleSignIn({
      agent: "gemini",
      code: "code-1",
      verifier: "v",
      redirectUri: "http://127.0.0.1:5000/oauth2callback",
      addedAt: 7,
      now: () => 5_000,
      fetchImpl: route({
        [TOKEN_URL]: () =>
          jsonAnswer({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
        [USERINFO_URL]: () => jsonAnswer({ email: "me@example.com" }),
        [LOAD_URL]: () =>
          jsonAnswer({
            currentTier: { id: "standard", name: "Standard" },
            cloudaicompanionProject: "proj-1",
          }),
      }),
    });
    expect(result).toEqual({
      account: {
        agent: "gemini",
        id: expect.stringMatching(/^gemini:/),
        user: "me@example.com",
        plan: "Standard",
        addedAt: 7,
        lapsed: null,
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: 5_000 + 3_600_000,
        project: "proj-1",
      },
    });
  });

  it("sets an Antigravity account up for Code Assist when it has no project", async () => {
    const daily = "https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser";
    const calls: string[] = [];
    const result = await completeGoogleSignIn({
      agent: "antigravity",
      code: "code-1",
      verifier: "v",
      redirectUri: "http://localhost:5000/oauth-callback",
      now: () => 5_000,
      onboardPollMs: 0,
      fetchImpl: (input, init) => {
        const url = String(input);
        calls.push(url);
        if (url === TOKEN_URL) {
          return Promise.resolve(
            jsonAnswer({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
          );
        }
        if (url === USERINFO_URL) {
          return Promise.resolve(jsonAnswer({ email: "me@example.com" }));
        }
        if (url === LOAD_URL) {
          return Promise.resolve(
            jsonAnswer({ allowedTiers: [{ id: "free-tier", name: "Free", isDefault: true }] }),
          );
        }
        if (url === daily) {
          expect(String(init?.body)).toContain('"tier_id":"free-tier"');
          return Promise.resolve(
            jsonAnswer({ done: true, response: { cloudaicompanionProject: { id: "proj-new" } } }),
          );
        }
        throw new Error(`unexpected ${url}`);
      },
    });
    expect(result).toMatchObject({
      account: { agent: "antigravity", project: "proj-new", plan: "Free" },
    });
    expect(calls).toContain(daily);
  });

  it("keeps a Gemini account Code Assist has no project for, for the user to name one", async () => {
    const result = await completeGoogleSignIn({
      agent: "gemini",
      code: "code-1",
      verifier: "v",
      redirectUri: "http://127.0.0.1:5000/oauth2callback",
      now: () => 5_000,
      fetchImpl: route({
        [TOKEN_URL]: () =>
          jsonAnswer({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
        [USERINFO_URL]: () => jsonAnswer({ email: "me@example.com" }),
        [LOAD_URL]: () => jsonAnswer({ currentTier: { id: "standard" } }),
      }),
    });
    expect(result).toMatchObject({
      account: { user: "me@example.com", project: null, plan: null },
    });
  });
});

describe("discoverGoogleProject", () => {
  it("says why a Gemini account has no project", async () => {
    const result = await discoverGoogleProject(account(), {
      fetchImpl: route({
        [LOAD_URL]: () => jsonAnswer({ currentTier: { id: "standard" } }),
      }),
    });
    expect(result).toMatchObject({
      error: expect.stringContaining("Gemini Code Assist Standard and Enterprise"),
    });
  });
});

describe("refreshGoogleAccount", () => {
  it("leaves a token with time left alone", async () => {
    const result = await refreshGoogleAccount(account({ expiresAt: 10 * 60_000 }), {
      now: () => 5_000,
      fetchImpl: () => {
        throw new Error("no request expected");
      },
    });
    expect(result).toMatchObject({ refreshed: false });
  });

  it("renews the access token, keeping the refresh token and project", async () => {
    const result = await refreshGoogleAccount(account({ project: "proj-1" }), {
      now: () => 5_000,
      fetchImpl: () =>
        Promise.resolve(jsonAnswer({ access_token: "new-access", expires_in: 3600 })),
    });
    expect(result).toMatchObject({
      refreshed: true,
      account: {
        accessToken: "new-access",
        refreshToken: "refresh",
        project: "proj-1",
        expiresAt: 5_000 + 3_600_000,
      },
    });
  });

  it("marks a refused sign-in lapsed", async () => {
    const result = await refreshGoogleAccount(account(), {
      now: () => 5_000,
      fetchImpl: () => Promise.resolve(jsonAnswer({ error: "invalid_grant" }, 400)),
    });
    expect(result).toEqual({
      error: "me@example.com is signed out of Gemini CLI; sign in again",
      lapsed: "me@example.com is signed out of Gemini CLI; sign in again",
    });
  });
});
