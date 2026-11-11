import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSubscriptionSignInManager,
  type SubscriptionSignInDeps,
} from "./subscription-signin.js";
import type { SubscriptionAccount } from "./subscription-store.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "neolix-subscription-signin-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function jsonAnswer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function jwt(claims: Record<string, unknown>): string {
  return `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

function manager(fetchImpl: typeof fetch, overrides: Partial<SubscriptionSignInDeps> = {}) {
  const saved: SubscriptionAccount[] = [];
  const created = createSubscriptionSignInManager({
    gatewayDir: tempDir(),
    listen: false,
    devicePollFloorMs: 0,
    fetchImpl,
    saveAccount: (account) => {
      const again = saved.some((entry) => entry.id === account.id);
      saved.push(account);
      return Promise.resolve({ again });
    },
    ...overrides,
  });
  return { created, saved };
}

describe("subscription sign-in: ChatGPT API", () => {
  it("waits for the browser, then keeps the account", async () => {
    let nonce = "";
    const { created, saved } = manager((input) => {
      if (String(input).endsWith("/api/accounts/oauth/token")) {
        return Promise.resolve(
          jsonAnswer({
            access_token: "access",
            refresh_token: "refresh",
            id_token: jwt({
              iss: "https://auth.openai.com",
              aud: "client-issued",
              nonce,
              exp: 4_102_444_800,
              email: "me@example.com",
              "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
            }),
            expires_in: 3600,
            scope: "openid chatgpt.tokens.use.direct",
          }),
        );
      }
      throw new Error(`unexpected request to ${String(input)}`);
    });
    const started = await created.start({ agent: "chatgpt-api", addedAt: 7 });
    const authorize = new URL(started.state.url);
    const state = authorize.searchParams.get("state") ?? "";
    nonce = authorize.searchParams.get("nonce") ?? "";
    expect(nonce).not.toBe("");
    expect(started.state.pasteCallback).toBe(true);
    expect(started.state.callbackPort).toBe(1455);

    await created.callback(
      started.state.id,
      `http://127.0.0.1:1455/auth/callback?code=code-1&client_id=client-issued&state=${state}`,
    );
    const finished = await started.done;
    expect(finished).toMatchObject({
      state: "done",
      user: "me@example.com",
      plan: "plus",
    });
    expect(saved).toEqual([
      expect.objectContaining({
        agent: "chatgpt-api",
        user: "me@example.com",
        addedAt: 7,
        accessToken: "access",
      }),
    ]);
  });

  it("says so when the ID token belongs to another sign-in", async () => {
    const { created, saved } = manager(() =>
      Promise.resolve(
        jsonAnswer({
          access_token: "access",
          refresh_token: "refresh",
          id_token: jwt({
            iss: "https://auth.openai.com",
            aud: "client-issued",
            nonce: "someone-else",
            exp: 4_102_444_800,
            email: "me@example.com",
          }),
          expires_in: 3600,
          scope: "openid chatgpt.tokens.use.direct",
        }),
      ),
    );
    const started = await created.start({ agent: "chatgpt-api" });
    const authorize = new URL(started.state.url);
    await created.callback(
      started.state.id,
      `http://127.0.0.1:1455/auth/callback?code=code-1&client_id=client-issued&state=${authorize.searchParams.get("state") ?? ""}`,
    );
    expect(await started.done).toMatchObject({
      state: "failed",
      error: "ChatGPT sign-in: the ID token isn't this sign-in's",
    });
    expect(saved).toEqual([]);
  });

  it("says so when the pasted address is another sign-in's", async () => {
    const { created } = manager(() => {
      throw new Error("no request expected");
    });
    const started = await created.start({ agent: "chatgpt-api" });
    await expect(
      created.callback(
        started.state.id,
        "http://127.0.0.1:1455/auth/callback?code=x&state=someone-else",
      ),
    ).rejects.toThrow("that address isn't from this sign-in");
    started.cancel();
    expect((await started.done).state).toBe("canceled");
  });

  it("cancels a waiting sign-in, and a stale id is unknown", async () => {
    const { created } = manager(() => {
      throw new Error("no request expected");
    });
    const started = await created.start({ agent: "chatgpt-api" });
    expect(created.status(started.state.id)?.state).toBe("waiting");
    created.cancel(started.state.id);
    expect(await started.done).toEqual({ ...started.state, state: "canceled" });
    await expect(created.callback("nope", "http://127.0.0.1:1455/auth/callback")).rejects.toThrow(
      "no such sign-in",
    );
  });
});

describe("subscription sign-in: Copilot", () => {
  it("shows GitHub's code and keeps the account once GitHub gives the token", async () => {
    const { created, saved } = manager((input, init) => {
      const url = String(input);
      if (url === "https://github.com/login/device/code") {
        return Promise.resolve(
          jsonAnswer({
            device_code: "dev-1",
            user_code: "ABCD-1234",
            verification_uri: "https://github.com/login/device",
            interval: 0,
            expires_in: 900,
          }),
        );
      }
      if (url === "https://github.com/login/oauth/access_token") {
        expect(String(init?.body)).toContain("device_code=dev-1");
        return Promise.resolve(jsonAnswer({ access_token: "gho_x" }));
      }
      if (url === "https://api.github.com/user") {
        return Promise.resolve(jsonAnswer({ login: "octocat" }));
      }
      if (url === "https://api.github.com/copilot_internal/user") {
        return Promise.resolve(jsonAnswer({ copilot_plan: "individual" }));
      }
      throw new Error(`unexpected request to ${url}`);
    });
    const started = await created.start({ agent: "copilot", addedAt: 9 });
    expect(started.state).toMatchObject({
      agent: "copilot",
      url: "https://github.com/login/device",
      code: "ABCD-1234",
    });
    const finished = await started.done;
    expect(finished).toMatchObject({ state: "done", user: "octocat", plan: "Pro" });
    expect(saved).toEqual([
      expect.objectContaining({
        agent: "copilot",
        user: "octocat",
        githubToken: "gho_x",
        host: "",
      }),
    ]);
  });

  it("keeps the proxy the sign-in went through as the account's", async () => {
    const { created, saved } = manager((input) => {
      const url = String(input);
      if (url.endsWith("/login/device/code")) {
        return Promise.resolve(
          jsonAnswer({ device_code: "d", user_code: "U", interval: 0, expires_in: 900 }),
        );
      }
      if (url.endsWith("/login/oauth/access_token")) {
        return Promise.resolve(jsonAnswer({ access_token: "gho_x" }));
      }
      if (url === "https://api.github.com/user") {
        return Promise.resolve(jsonAnswer({ login: "octocat" }));
      }
      if (url === "https://api.github.com/copilot_internal/user") {
        return Promise.resolve(jsonAnswer({ copilot_plan: "individual" }));
      }
      throw new Error(`unexpected request to ${url}`);
    });
    const started = await created.start({ agent: "copilot", proxy: "direct" });
    expect(started.state.proxy).toBe("direct");
    await started.done;
    expect(saved[0]).toMatchObject({ proxy: "direct" });
  });

  it("refuses a pasted address: a device sign-in has none", async () => {
    const { created } = manager((input) => {
      if (String(input).endsWith("/login/device/code")) {
        return Promise.resolve(jsonAnswer({ device_code: "d", user_code: "U", interval: 60 }));
      }
      throw new Error("not now");
    });
    const started = await created.start({ agent: "copilot" });
    expect(started.state.pasteCallback).toBeUndefined();
    await expect(
      created.callback(started.state.id, "http://127.0.0.1:1/callback?code=x&state=y"),
    ).rejects.toThrow("can't be finished from a pasted address");
    started.cancel();
  });
});

describe("subscription sign-in: Gemini CLI", () => {
  it("pastes Google's callback and keeps the account with its project", async () => {
    const { created, saved } = manager((input) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        return Promise.resolve(
          jsonAnswer({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
        );
      }
      if (url.startsWith("https://www.googleapis.com/oauth2/v2/userinfo")) {
        return Promise.resolve(jsonAnswer({ email: "me@example.com" }));
      }
      if (url === "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist") {
        return Promise.resolve(
          jsonAnswer({ currentTier: { name: "Standard" }, cloudaicompanionProject: "proj-1" }),
        );
      }
      throw new Error(`unexpected request to ${url}`);
    });
    const started = await created.start({ agent: "gemini" });
    const authorize = new URL(started.state.url);
    const state = authorize.searchParams.get("state") ?? "";
    const redirect = new URL(authorize.searchParams.get("redirect_uri") ?? "");
    expect(started.state.callbackPort).toBe(Number(redirect.port));

    await created.callback(
      started.state.id,
      `http://127.0.0.1:${redirect.port}/oauth2callback?code=code-1&state=${state}`,
    );
    const finished = await started.done;
    expect(finished).toMatchObject({ state: "done", user: "me@example.com", plan: "Standard" });
    expect(saved).toEqual([
      expect.objectContaining({ agent: "gemini", user: "me@example.com", project: "proj-1" }),
    ]);
  });
});
