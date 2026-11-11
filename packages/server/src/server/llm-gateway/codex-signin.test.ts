import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pollCodexDeviceSignIn, startCodexDeviceSignIn } from "./codex-signin.js";

function jsonAnswer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function jwt(claims: Record<string, unknown>): string {
  return `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}
// Tests never reach the network: every code path that would fetch takes an
// injected fetch, so the global one throws.
beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("tests never reach the network");
  });
});

describe("startCodexDeviceSignIn", () => {
  it("asks for a code and says where to enter it", async () => {
    const calls: string[] = [];
    const result = await startCodexDeviceSignIn({
      fetchImpl: (input) => {
        calls.push(String(input));
        return Promise.resolve(
          jsonAnswer({ device_auth_id: "dev-1", user_code: "ABCD", interval: "5" }),
        );
      },
    });
    expect(result).toEqual({
      start: {
        url: "https://auth.openai.com/codex/device",
        userCode: "ABCD",
        deviceAuthId: "dev-1",
        intervalMs: 5000,
      },
    });
    expect(calls).toEqual(["https://auth.openai.com/api/accounts/deviceauth/usercode"]);
  });

  it("says so when ChatGPT does not take a device code", async () => {
    const result = await startCodexDeviceSignIn({
      fetchImpl: () => Promise.resolve(new Response("no", { status: 404 })),
    });
    expect(result).toEqual({
      error: "ChatGPT doesn't take a device code for this sign-in now; use the browser sign-in",
    });
  });
});

describe("pollCodexDeviceSignIn", () => {
  it("waits while the code is not entered", async () => {
    const poll = await pollCodexDeviceSignIn(
      { deviceAuthId: "dev-1", userCode: "ABCD" },
      { fetchImpl: () => Promise.resolve(new Response("", { status: 403 })) },
    );
    expect(poll).toEqual({ state: "waiting" });
  });

  it("exchanges the code for tokens once it is entered", async () => {
    const posts: string[] = [];
    const idToken = jwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-9" },
    });
    const poll = await pollCodexDeviceSignIn(
      { deviceAuthId: "dev-1", userCode: "ABCD" },
      {
        fetchImpl: (input, init) => {
          posts.push(`${String(input)} ${String(init?.body ?? "")}`);
          if (String(input).endsWith("/deviceauth/token")) {
            return Promise.resolve(
              jsonAnswer({ authorization_code: "auth-code", code_verifier: "verifier" }),
            );
          }
          return Promise.resolve(
            jsonAnswer({
              access_token: "at",
              refresh_token: "rt",
              id_token: idToken,
            }),
          );
        },
      },
    );
    expect(poll).toEqual({
      state: "done",
      tokens: { idToken, accessToken: "at", refreshToken: "rt", accountId: "acct-9" },
    });
    expect(posts[1]).toContain("grant_type=authorization_code");
    expect(posts[1]).toContain("client_id=app_EMoamEEZ73f0CkXaXp7hrann");
    expect(posts[1]).toContain("code_verifier=verifier");
    expect(posts[1]).toContain(
      "redirect_uri=https%3A%2F%2Fauth.openai.com%2Fdeviceauth%2Fcallback",
    );
  });

  it("says so when the exchange is refused", async () => {
    const poll = await pollCodexDeviceSignIn(
      { deviceAuthId: "dev-1", userCode: "ABCD" },
      {
        fetchImpl: (input) =>
          Promise.resolve(
            String(input).endsWith("/deviceauth/token")
              ? jsonAnswer({ authorization_code: "auth-code", code_verifier: "verifier" })
              : new Response("no", { status: 400 }),
          ),
      },
    );
    expect(poll).toEqual({
      state: "error",
      error: "ChatGPT refused the code exchange (400)",
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
