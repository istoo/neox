import { afterEach, describe, expect, it } from "vitest";
import {
  clearCopilotAutoPicks,
  copilotApisOf,
  copilotAutoPick,
  copilotEndpointFallbacks,
  copilotRefusal,
  invalidateSession,
  isRefused,
  markRefused,
} from "./copilot-auto.js";

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

afterEach(() => {
  clearCopilotAutoPicks();
});

const ACCOUNT = { githubToken: "token-a", host: "" };

describe("copilotAutoPick", () => {
  it("asks /auto first and keeps the pick for an hour", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = (input, init) => {
      calls += 1;
      expect(String(input)).toBe("https://api.githubcopilot.com/auto");
      expect(new Headers(init?.headers).get("X-GitHub-Api-Version")).toBe("2026-08-01");
      expect(String(init?.body)).toContain('"prompt":"hello"');
      return Promise.resolve(
        jsonAnswer({ session_token: "session", selected_model: { id: "gpt-6" }, expires_at: 0 }),
      );
    };
    const first = await copilotAutoPick({
      ...ACCOUNT,
      prompt: "hello",
      now: () => 5_000,
      fetchImpl,
    });
    expect(first).toMatchObject({
      model: "gpt-6",
      sessionToken: "session",
      via: "auto",
    });
    await copilotAutoPick({ ...ACCOUNT, prompt: "hello", now: () => 6_000, fetchImpl });
    expect(calls).toBe(1);
  });

  it("falls back to /models/session when /auto doesn't answer", async () => {
    const fetchImpl = route({
      "https://api.githubcopilot.com/auto": () => jsonAnswer({ message: "no" }, 404),
      "https://api.githubcopilot.com/models/session": () =>
        jsonAnswer({
          session_token: "session",
          available_models: [{ id: "gpt-5" }, { id: "claude-haiku-4.5" }],
        }),
    });
    const pick = await copilotAutoPick({ ...ACCOUNT, now: () => 5_000, fetchImpl });
    expect(pick).toMatchObject({
      model: "gpt-5",
      sessionToken: "session",
      via: "models-session",
      skipped: "Copilot refused the pick (404)",
    });
  });

  it("stands a model in when Copilot gives no pick at all", async () => {
    const fetchImpl = route({
      "https://api.githubcopilot.com/auto": () => jsonAnswer({ message: "no" }, 404),
      "https://api.githubcopilot.com/models/session": () => jsonAnswer({}, 404),
    });
    const pick = await copilotAutoPick({
      ...ACCOUNT,
      fallbackModel: "gpt-4.1",
      now: () => 5_000,
      fetchImpl,
    });
    expect(pick).toMatchObject({ model: "gpt-4.1", via: "fallback", sessionToken: null });
  });

  it("says so when there is nothing to stand in either", async () => {
    const fetchImpl = route({
      "https://api.githubcopilot.com/auto": () => jsonAnswer({ message: "no" }, 404),
      "https://api.githubcopilot.com/models/session": () => jsonAnswer({}, 404),
    });
    expect(await copilotAutoPick({ ...ACCOUNT, now: () => 5_000, fetchImpl })).toEqual({
      error: "Copilot refused the pick (404)",
    });
  });
});

describe("copilotRefusal", () => {
  it("says a model offered on another endpoint", () => {
    expect(
      copilotRefusal(
        400,
        '{"error":{"code":"unsupported_api_for_model"},"message":"not accessible via the /chat/completions endpoint"}',
      ),
    ).toBe("endpoint");
  });

  it("says a model the plan doesn't have", () => {
    expect(
      copilotRefusal(
        400,
        '{"error":{"code":"model_not_supported"},"message":"The requested model is not supported."}',
      ),
    ).toBe("model");
  });

  it("says an Auto session that no longer holds its model", () => {
    expect(copilotRefusal(400, "Requested model not available for session")).toBe("session");
  });

  it("says nothing of a refusal that isn't one of these", () => {
    expect(copilotRefusal(500, "boom")).toBeNull();
    expect(copilotRefusal(400, "rate limited")).toBeNull();
  });
});

describe("copilotEndpointFallbacks", () => {
  it("takes the model's own endpoints in the list's order", () => {
    expect(copilotEndpointFallbacks("openai", ["/chat/completions", "/v1/messages"])).toEqual([
      "anthropic",
    ]);
    expect(
      copilotEndpointFallbacks("openai-responses", [
        "/responses",
        "/chat/completions",
        "/messages",
      ]),
    ).toEqual(["openai", "anthropic"]);
  });

  it("is the fixed order only when the list names no endpoints", () => {
    expect(copilotEndpointFallbacks("anthropic")).toEqual(["openai-responses", "openai"]);
    expect(copilotEndpointFallbacks("anthropic", undefined)).toEqual([
      "openai-responses",
      "openai",
    ]);
    expect(copilotEndpointFallbacks("openai-responses", null)).toEqual(["openai", "anthropic"]);
  });

  it("serves a model with no endpoints on chat completions alone", () => {
    expect(copilotApisOf([])).toEqual(["openai"]);
    expect(copilotEndpointFallbacks("openai", [])).toEqual([]);
  });

  it("leaves out what Neox doesn't speak instead of falling back", () => {
    expect(copilotApisOf(["/ws", "/chat/completions", "/chat/completions"])).toEqual(["openai"]);
    expect(copilotEndpointFallbacks("openai", ["/ws"])).toEqual([]);
  });
});

describe("refusals kept per account", () => {
  it("keeps a refused model out for six hours", () => {
    markRefused(ACCOUNT, "gpt-5", 1_000);
    expect(isRefused(ACCOUNT, "gpt-5", 2_000)).toBe(true);
    expect(isRefused(ACCOUNT, "gpt-5", 1_000 + 6 * 60 * 60_000 - 1)).toBe(true);
    expect(isRefused(ACCOUNT, "gpt-5", 1_000 + 6 * 60 * 60_000)).toBe(false);
    expect(isRefused({ githubToken: "token-b", host: "" }, "gpt-5", 2_000)).toBe(false);
  });

  it("doesn't serve a kept pick the account was refused", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = () => {
      calls += 1;
      return Promise.resolve(
        jsonAnswer({ session_token: "s2", selected_model: { id: "gpt-6" }, expires_at: 0 }),
      );
    };
    const first = await copilotAutoPick({ ...ACCOUNT, now: () => 5_000, fetchImpl });
    expect(first).toMatchObject({ model: "gpt-6" });
    markRefused(ACCOUNT, "gpt-6", 6_000);
    const again = await copilotAutoPick({ ...ACCOUNT, now: () => 7_000, fetchImpl });
    expect(calls).toBe(3);
    expect(again).toEqual({
      error: "Copilot's /models/session gave no model the account can use",
    });
  });

  it("asks again when /auto picks a refused model", async () => {
    markRefused(ACCOUNT, "gpt-6", 5_000);
    const fetchImpl = route({
      "https://api.githubcopilot.com/auto": () =>
        jsonAnswer({ session_token: "s1", selected_model: { id: "gpt-6" }, expires_at: 0 }),
      "https://api.githubcopilot.com/models/session": () =>
        jsonAnswer({ session_token: "s2", available_models: [{ id: "gpt-6" }, { id: "gpt-5" }] }),
    });
    const pick = await copilotAutoPick({ ...ACCOUNT, now: () => 6_000, fetchImpl });
    expect(pick).toMatchObject({
      model: "gpt-5",
      via: "models-session",
      skipped: "Copilot picked gpt-6, which the account was refused",
    });
  });

  it("passes over a refused model in /models/session's own pick", async () => {
    markRefused(ACCOUNT, "gpt-6", 5_000);
    const fetchImpl = route({
      "https://api.githubcopilot.com/auto": () => jsonAnswer({ message: "no" }, 404),
      "https://api.githubcopilot.com/models/session": () =>
        jsonAnswer({
          session_token: "s2",
          selected_model: { id: "gpt-6" },
          available_models: [{ id: "gpt-6" }, { id: "gpt-5" }],
        }),
    });
    const pick = await copilotAutoPick({ ...ACCOUNT, now: () => 6_000, fetchImpl });
    expect(pick).toMatchObject({ model: "gpt-5", via: "models-session" });
  });

  it("doesn't stand in a refused fallback model", async () => {
    markRefused(ACCOUNT, "gpt-4.1", 5_000);
    const fetchImpl = route({
      "https://api.githubcopilot.com/auto": () => jsonAnswer({ message: "no" }, 404),
      "https://api.githubcopilot.com/models/session": () => jsonAnswer({}, 404),
    });
    expect(
      await copilotAutoPick({
        ...ACCOUNT,
        fallbackModel: "gpt-4.1",
        now: () => 6_000,
        fetchImpl,
      }),
    ).toEqual({ error: "Copilot refused the pick (404)" });
  });

  it("keeps the pick's endpoints from the list", async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        jsonAnswer({
          session_token: "s",
          selected_model: { id: "claude-sonnet-5", supported_endpoints: ["/v1/messages"] },
        }),
      );
    const pick = await copilotAutoPick({ ...ACCOUNT, now: () => 5_000, fetchImpl });
    if ("error" in pick) {
      throw new Error(pick.error);
    }
    expect(pick).toMatchObject({ model: "claude-sonnet-5", endpoints: ["/v1/messages"] });
    expect(copilotEndpointFallbacks("anthropic", pick.endpoints)).toEqual([]);
  });

  it("lets go of the pick when its session token no longer holds it", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = () => {
      calls += 1;
      return Promise.resolve(
        jsonAnswer({ session_token: `s${calls}`, selected_model: { id: "gpt-6" } }),
      );
    };
    await copilotAutoPick({ ...ACCOUNT, now: () => 5_000, fetchImpl });
    invalidateSession(ACCOUNT);
    await copilotAutoPick({ ...ACCOUNT, now: () => 6_000, fetchImpl });
    expect(calls).toBe(2);
  });
});
