import { describe, expect, it } from "vitest";
import {
  completeCopilotSignIn,
  copilotAccountName,
  copilotHostOf,
  copilotSessionToken,
  pollCopilotDeviceSignIn,
  startCopilotDeviceSignIn,
} from "./copilot-signin.js";

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

describe("copilotHostOf", () => {
  it("takes github.com as no host", () => {
    expect(copilotHostOf("github.com")).toEqual({ host: "" });
    expect(copilotHostOf("https://www.github.com/")).toEqual({ host: "" });
    expect(copilotHostOf("")).toEqual({ host: "" });
  });

  it("takes an enterprise's ghe.com host", () => {
    expect(copilotHostOf("acme.ghe.com")).toEqual({ host: "acme.ghe.com" });
    expect(copilotHostOf("https://acme.ghe.com/")).toEqual({ host: "acme.ghe.com" });
  });

  it("refuses a host a GitHub token must not be sent to", () => {
    expect(copilotHostOf("evil.example.com")).toMatchObject({ error: expect.any(String) });
    expect(copilotHostOf("acme.ghe.com/path")).toMatchObject({ error: expect.any(String) });
  });
});

describe("copilotAccountName", () => {
  it("carries the host, so one login on two hosts is two accounts", () => {
    expect(copilotAccountName("octocat", "")).toBe("octocat");
    expect(copilotAccountName("octocat", "acme.ghe.com")).toBe("octocat@acme.ghe.com");
  });
});

describe("startCopilotDeviceSignIn", () => {
  it("shows the code GitHub gives", async () => {
    const result = await startCopilotDeviceSignIn({
      host: "",
      fetchImpl: route({
        "https://github.com/login/device/code": () =>
          jsonAnswer({
            device_code: "dev-1",
            user_code: "ABCD-1234",
            verification_uri: "https://github.com/login/device",
            interval: 5,
            expires_in: 900,
          }),
      }),
    });
    expect(result).toEqual({
      start: {
        url: "https://github.com/login/device",
        code: "ABCD-1234",
        deviceCode: "dev-1",
        intervalMs: 5000,
        expiresInMs: 900_000,
      },
    });
  });

  it("asks GitHub's enterprise host for an enterprise account", async () => {
    const calls: string[] = [];
    await startCopilotDeviceSignIn({
      host: "acme.ghe.com",
      fetchImpl: (input) => {
        calls.push(String(input));
        return Promise.resolve(jsonAnswer({ device_code: "d", user_code: "U" }));
      },
    });
    expect(calls).toEqual(["https://acme.ghe.com/login/device/code"]);
  });
});

describe("pollCopilotDeviceSignIn", () => {
  it("waits while the code is not entered", async () => {
    const poll = await pollCopilotDeviceSignIn({
      host: "",
      deviceCode: "dev-1",
      fetchImpl: () => Promise.resolve(jsonAnswer({ error: "authorization_pending" })),
    });
    expect(poll).toEqual({ state: "waiting" });
  });

  it("keeps waiting when GitHub asks to slow down", async () => {
    const poll = await pollCopilotDeviceSignIn({
      host: "",
      deviceCode: "dev-1",
      fetchImpl: () => Promise.resolve(jsonAnswer({ error: "slow_down" })),
    });
    expect(poll).toEqual({ state: "waiting", intervalMs: 5000 });
  });

  it("gives the token once the code is entered", async () => {
    const poll = await pollCopilotDeviceSignIn({
      host: "",
      deviceCode: "dev-1",
      fetchImpl: () => Promise.resolve(jsonAnswer({ access_token: "gho_x" })),
    });
    expect(poll).toEqual({ state: "done", githubToken: "gho_x" });
  });

  it("says a code that expired", async () => {
    const poll = await pollCopilotDeviceSignIn({
      host: "",
      deviceCode: "dev-1",
      fetchImpl: () => Promise.resolve(jsonAnswer({ error: "expired_token" })),
    });
    expect(poll).toEqual({ state: "error", error: "the code expired; start again" });
  });
});

describe("completeCopilotSignIn", () => {
  it("keeps the account's login, host and plan", async () => {
    const result = await completeCopilotSignIn({
      githubToken: "gho_x",
      host: "acme.ghe.com",
      addedAt: 7,
      fetchImpl: route({
        "https://api.acme.ghe.com/user": () => jsonAnswer({ login: "octocat" }),
        "https://api.acme.ghe.com/copilot_internal/user": () =>
          jsonAnswer({ copilot_plan: "business", access_type_sku: "business" }),
      }),
    });
    expect(result).toEqual({
      account: {
        agent: "copilot",
        id: expect.stringMatching(/^copilot:/),
        user: "octocat@acme.ghe.com",
        plan: "Business",
        addedAt: 7,
        lapsed: null,
        githubToken: "gho_x",
        host: "acme.ghe.com",
      },
    });
  });

  it("refuses an account with no Copilot subscription", async () => {
    const result = await completeCopilotSignIn({
      githubToken: "gho_x",
      host: "",
      fetchImpl: route({
        "https://api.github.com/user": () => jsonAnswer({ login: "octocat" }),
        "https://api.github.com/copilot_internal/user": () => jsonAnswer({ message: "no" }, 404),
      }),
    });
    expect(result).toEqual({ error: "octocat has no Copilot subscription" });
  });
});

describe("copilotSessionToken", () => {
  it("reads the token, its expiry and the API the session names", async () => {
    const result = await copilotSessionToken({
      githubToken: "gho_x",
      host: "",
      fetchImpl: route({
        "https://api.github.com/copilot_internal/v2/token": () =>
          jsonAnswer({
            token: "session",
            expires_at: 1_800_000_000,
            endpoints: { api: "https://api.githubcopilot.com/" },
          }),
      }),
    });
    expect(result).toEqual({
      session: {
        token: "session",
        expiresAt: 1_800_000_000_000,
        apiBase: "https://api.githubcopilot.com",
      },
    });
  });

  it("says a refused sign-in, so the account can be marked", async () => {
    const result = await copilotSessionToken({
      githubToken: "gho_x",
      host: "",
      fetchImpl: () => Promise.resolve(jsonAnswer({ message: "bad" }, 401)),
    });
    expect(result).toEqual({ error: "Copilot refused the sign-in; sign in again" });
  });
});
