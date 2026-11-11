import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  callbackGatewaySignIn,
  cancelGatewaySignIn,
  clearGatewaySignIns,
  settleBrowserCallback,
  startGatewaySignIn,
  statusGatewaySignIn,
  type SignInContext,
} from "./gateway-signin.js";
import { loadSubscriptionAccounts } from "./subscription-store.js";
import { loadCodexAccounts } from "./codex-accounts.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "neolix-gateway-signin-"));
  dirs.push(dir);
  return dir;
}

function jsonAnswer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function jwt(claims: Record<string, unknown>): string {
  return `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

afterEach(() => {
  clearGatewaySignIns();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("gateway sign-in: Copilot", () => {
  it("starts a device sign-in, then lists the account it kept", async () => {
    const dir = tempDir();
    const context: SignInContext = {
      accountsFile: join(dir, "codex-accounts.json"),
      listen: false,
      devicePollFloorMs: 0,
      fetchImpl: (input) => {
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
          return Promise.resolve(jsonAnswer({ access_token: "gho_x" }));
        }
        if (url === "https://api.github.com/user") {
          return Promise.resolve(jsonAnswer({ login: "octocat" }));
        }
        if (url === "https://api.github.com/copilot_internal/user") {
          return Promise.resolve(jsonAnswer({ copilot_plan: "individual" }));
        }
        throw new Error(`unexpected request to ${url}`);
      },
    };
    const started = await startGatewaySignIn({ agent: "copilot" }, context);
    expect(started).toMatchObject({
      agent: "copilot",
      state: "waiting",
      url: "https://github.com/login/device",
      code: "ABCD-1234",
    });
    // The flow finishes on its own once GitHub gives the token.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const status = await statusGatewaySignIn(started.id, context);
    expect(status).toMatchObject({ state: "done", user: "octocat", plan: "Pro" });
    const file = join(dir, "copilot-accounts.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await loadSubscriptionAccounts(file, "copilot")).toEqual([
      expect.objectContaining({ user: "octocat", githubToken: "gho_x", host: "" }),
    ]);
  });
});

describe("gateway sign-in: ChatGPT API", () => {
  it("takes the pasted callback and keeps the account", async () => {
    const dir = tempDir();
    // The ID token's nonce must be the sign-in's, which only the authorize
    // URL carries; a real sign-in's ID token echoes it, so the fake reads
    // the nonce the test takes from that URL.
    let nonce = "";
    const context: SignInContext = {
      accountsFile: join(dir, "codex-accounts.json"),
      listen: false,
      fetchImpl: () =>
        Promise.resolve(
          jsonAnswer({
            access_token: "access",
            refresh_token: "refresh",
            id_token: jwt({
              iss: "https://auth.openai.com",
              aud: "client-issued",
              nonce,
              exp: 4_102_444_800,
              email: "me@example.com",
            }),
            expires_in: 3600,
            scope: "openid chatgpt.tokens.use.direct",
          }),
        ),
    };
    const started = await startGatewaySignIn({ agent: "chatgpt-api" }, context);
    const authorize = new URL(started.url ?? "");
    nonce = authorize.searchParams.get("nonce") ?? "";
    const state = authorize.searchParams.get("state") ?? "";
    expect(started.pasteCallback).toBe(true);
    const result = await callbackGatewaySignIn(
      started.id,
      `http://127.0.0.1:1455/auth/callback?code=code-1&client_id=client-issued&state=${state}`,
      context,
    );
    expect(result).toEqual({ ok: true });
    const status = await statusGatewaySignIn(started.id, context);
    expect(status).toMatchObject({ state: "done", user: "me@example.com" });
  });
});

describe("gateway sign-in: Codex browser", () => {
  it("takes the pasted callback and keeps the account", async () => {
    const dir = tempDir();
    let verifier = "";
    const context: SignInContext = {
      accountsFile: join(dir, "codex-accounts.json"),
      listen: false,
      fetchImpl: (_input, init) => {
        const form = new URLSearchParams(String(init?.body ?? ""));
        expect(form.get("grant_type")).toBe("authorization_code");
        expect(form.get("code")).toBe("code-1");
        expect(form.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
        verifier = form.get("code_verifier") ?? "";
        return Promise.resolve(
          jsonAnswer({
            access_token: jwt({ exp: 4_102_444_800 }),
            refresh_token: "rt",
            id_token: jwt({
              email: "me@example.com",
              "https://api.openai.com/auth": {
                chatgpt_account_id: "acct-1",
                chatgpt_plan_type: "pro",
              },
            }),
          }),
        );
      },
    };
    const started = await startGatewaySignIn({ agent: "codex" }, context);
    expect(started).toMatchObject({
      agent: "codex",
      state: "waiting",
      pasteCallback: true,
      callbackPort: 1455,
    });
    const authorize = new URL(started.url ?? "");
    expect(`${authorize.origin}${authorize.pathname}`).toBe(
      "https://auth.openai.com/oauth/authorize",
    );
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
    const state = authorize.searchParams.get("state") ?? "";
    const result = await callbackGatewaySignIn(
      started.id,
      `http://localhost:1455/auth/callback?code=code-1&state=${state}`,
      context,
    );
    expect(result).toEqual({ ok: true });
    expect(verifier.length).toBeGreaterThan(0);
    const status = await statusGatewaySignIn(started.id, context);
    expect(status).toMatchObject({ state: "done", user: "me@example.com", plan: "pro" });
    expect(await loadCodexAccounts(join(dir, "codex-accounts.json"))).toEqual([
      expect.objectContaining({ id: "neolix:acct-1", refreshToken: "rt" }),
    ]);
  });

  it("refuses a callback address from another sign-in", async () => {
    const context: SignInContext = {
      accountsFile: join(tempDir(), "codex-accounts.json"),
      listen: false,
      fetchImpl: () => {
        throw new Error("no request expected");
      },
    };
    const started = await startGatewaySignIn({ agent: "codex" }, context);
    const result = await callbackGatewaySignIn(
      started.id,
      "http://localhost:1455/auth/callback?code=c&state=other",
      context,
    );
    expect(result).toEqual({
      ok: false,
      error: "This address belongs to another sign-in; start again",
    });
  });
});

describe("gateway sign-in: browser callback", () => {
  it("shows a failed save on the login state instead of rejecting", async () => {
    const dir = tempDir();
    // A regular file where the accounts directory should be makes the save
    // throw, as a read-only or broken home does.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "x");
    const context: SignInContext = {
      accountsFile: join(blocker, "codex-accounts.json"),
      listen: false,
      fetchImpl: () => Promise.resolve(jsonAnswer({ access_token: "at", refresh_token: "rt" })),
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const started = await startGatewaySignIn({ agent: "codex" }, context);
      const state = new URL(started.url ?? "").searchParams.get("state") ?? "";
      const params = new URLSearchParams({ code: "code-1", state });

      await expect(
        settleBrowserCallback(started.id, context, Promise.resolve(params)),
      ).resolves.toBeUndefined();

      const status = await statusGatewaySignIn(started.id, context);
      expect(status.state).toBe("failed");
      expect(status.error).toMatch(/EEXIST|ENOTDIR|not a directory/i);
    } finally {
      error.mockRestore();
    }
  });
});

describe("gateway sign-in: other agents", () => {
  it("says an agent it cannot sign in", async () => {
    const context: SignInContext = { accountsFile: join(tempDir(), "codex-accounts.json") };
    const started = await startGatewaySignIn({ agent: "zed" }, context);
    expect(started).toEqual({
      id: "",
      agent: "zed",
      state: "failed",
      error: "Signing in zed is not supported here yet",
    });
  });

  it("cancels a waiting sign-in", async () => {
    const context: SignInContext = {
      accountsFile: join(tempDir(), "codex-accounts.json"),
      listen: false,
      fetchImpl: () => {
        throw new Error("no request expected");
      },
    };
    const started = await startGatewaySignIn({ agent: "gemini" }, context);
    expect(started.state).toBe("waiting");
    expect(cancelGatewaySignIn(started.id)).toBe(true);
    expect((await statusGatewaySignIn(started.id, context)).state).toBe("canceled");
    expect(cancelGatewaySignIn(started.id)).toBe(false);
  });
});
