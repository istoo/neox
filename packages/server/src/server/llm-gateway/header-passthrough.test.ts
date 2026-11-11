import type { Response as ExpressResponse } from "express";
import { describe, expect, it } from "vitest";
import type { GatewayAccount, GatewayProvider } from "./config.js";
import {
  agentUserAgentOf,
  applyReplyHeaders,
  canonicalHeaderName,
  cleanHeaderList,
  DEFAULT_REPLY_HEADERS,
  gatewayUserAgent,
  passClientHeaders,
  passedReplyHeaders,
  neolixOwnUserAgent,
  sentUserAgentOf,
  replyHeaderPassable,
  replyHeadersProblem,
  requestHeaderPassable,
  requestHeadersProblem,
  validHeaderName,
} from "./header-passthrough.js";
import { buildUpstreamHeaders } from "./upstream.js";
import { markMiddlewareReplyHeaders } from "./middleware-reply-headers.js";

function provider(overrides: Partial<GatewayProvider> = {}): GatewayProvider {
  return {
    id: "fake",
    protocol: "openai-responses",
    baseUrl: "https://up.example/v1",
    accounts: [],
    countFree: false,
    queueWaitMs: 0,
    sink: false,
    priceRate: 1,
    models: [],
    replyHeaders: [],
    passHeaders: [],
    ...overrides,
  } as GatewayProvider;
}

function response(headers: Record<string, string>): { headers: Headers } {
  return { headers: new Headers(headers) };
}

describe("canonicalHeaderName", () => {
  it("spells a name as HTTP does, whatever its case", () => {
    expect(canonicalHeaderName(" x-oneapi-request-id ")).toBe("X-Oneapi-Request-Id");
    expect(canonicalHeaderName("X-TRACE")).toBe("X-Trace");
  });
});

describe("header names", () => {
  it("accepts an HTTP token and refuses anything else", () => {
    expect(validHeaderName("X-Trace")).toBe(true);
    expect(validHeaderName("bad name")).toBe(false);
    expect(validHeaderName("a:b")).toBe(false);
    expect(validHeaderName("")).toBe(false);
  });
});

describe("reply headers", () => {
  it("keeps a list canonical and once each, dropping what is never passed", () => {
    expect(
      cleanHeaderList(
        [
          " x-oneapi-request-id ",
          "X-OneAPI-Request-ID",
          "set-cookie",
          "content-length",
          "access-control-allow-origin",
          "x-magpie-rest",
          "x-neolix-gateway-internal",
          "bad name",
          "",
          "x-trace",
        ],
        replyHeaderPassable,
      ),
    ).toEqual(["X-Oneapi-Request-Id", "X-Trace"]);
  });

  it("says what is wrong with a list", () => {
    for (const bad of [
      ["Set-Cookie"],
      ["Content-Encoding"],
      ["Transfer-Encoding"],
      ["Authorization"],
      ["Proxy-Authenticate"],
      ["X-Magpie-Note"],
      ["X-Neolix-Gateway-Internal"],
      ["a b"],
      ["a:b"],
    ]) {
      expect(replyHeadersProblem(bad)).not.toBeNull();
    }
    expect(replyHeadersProblem(["x-oneapi-request-id", " ", "X-Trace"])).toBeNull();
  });

  it("passes the defaults and the listed ones, never a denied one", () => {
    const headers = response({
      "X-Request-Id": "r1",
      "x-trace": "t1",
      "Set-Cookie": "s",
      "X-Other": "o",
    });
    expect(passedReplyHeaders(provider({ replyHeaders: ["x-trace"] }), headers)).toEqual({
      "X-Request-Id": "r1",
      "X-Trace": "t1",
    });
    expect(
      passedReplyHeaders(provider({ replyHeaders: ["Set-Cookie", "X-Other"] }), headers),
    ).toEqual({ "X-Request-Id": "r1", "X-Other": "o" });
    expect(passedReplyHeaders(provider(), response({ "X-Other": "o" }))).toEqual({});
    expect(DEFAULT_REPLY_HEADERS).toContain("X-Oneapi-Request-Id");
  });

  it("puts them into the reply", () => {
    const written = new Map<string, string>();
    const res = {
      setHeader(name: string, value: string) {
        written.set(name, value);
        return res;
      },
    } as unknown as ExpressResponse;
    applyReplyHeaders(
      res,
      provider({ replyHeaders: ["x-trace", "set-cookie"] }),
      response({ "X-Request-Id": "r1", "X-Trace": "t1", "Set-Cookie": "s" }),
    );
    expect(Object.fromEntries(written)).toEqual({ "X-Request-Id": "r1", "X-Trace": "t1" });
  });

  it("passes the ones a gateway middleware marked, under the same rules", () => {
    const marked = response({ "X-Mw": "yes", "Set-Cookie": "s", "X-Other": "o" });
    markMiddlewareReplyHeaders(marked, ["x-mw", "set-cookie"]);
    expect(passedReplyHeaders(provider(), marked)).toEqual({ "X-Mw": "yes" });
    const listed = response({ "Set-Cookie": "s", "X-Other": "o" });
    markMiddlewareReplyHeaders(listed, ["Set-Cookie", "X-Other"]);
    expect(passedReplyHeaders(provider(), listed)).toEqual({ "X-Other": "o" });
  });
});

describe("pass headers", () => {
  it("keeps a list canonical and once each, dropping keys and connection fields", () => {
    expect(
      cleanHeaderList(
        [
          " x-tenant ",
          "X-TENANT",
          "authorization",
          "x-api-key",
          "host",
          "content-length",
          "x-magpie-agent",
          "x-neolix-gateway-internal",
          "bad name",
          "",
          "x-trace",
        ],
        requestHeaderPassable,
      ),
    ).toEqual(["X-Tenant", "X-Trace"]);
  });

  it("says what is wrong with a list", () => {
    for (const bad of [
      ["Authorization"],
      ["x-api-key"],
      ["X-Goog-Api-Key"],
      ["api-key"],
      ["Cookie"],
      ["Host"],
      ["Content-Length"],
      ["Connection"],
      ["Transfer-Encoding"],
      ["Proxy-Authorization"],
      ["Accept-Encoding"],
      ["X-Magpie-Session"],
      ["a b"],
    ]) {
      expect(requestHeadersProblem(bad)).not.toBeNull();
    }
    expect(requestHeadersProblem(["x-tenant", " ", "User-Agent", "Anthropic-Beta"])).toBeNull();
  });

  it("puts the agent's headers over the fixed ones, never a key", () => {
    const upstream = new Headers({ "x-route": "fixed", "x-only": "o" });
    passClientHeaders(
      provider({ passHeaders: ["X-Tenant", "Authorization", "X-Api-Key", "X-Route"] }),
      {
        "x-tenant": "t1",
        authorization: "Bearer agent-key",
        "x-api-key": "agent-key",
        "x-route": "r1",
      },
      upstream,
    );
    expect(upstream.get("x-tenant")).toBe("t1");
    expect(upstream.get("x-route")).toBe("r1");
    expect(upstream.get("x-only")).toBe("o");
    expect(upstream.get("authorization")).toBeNull();
    expect(upstream.get("x-api-key")).toBeNull();
  });

  it("leaves the fixed header when the agent sent none", () => {
    const upstream = new Headers({ "x-route": "fixed" });
    passClientHeaders(provider({ passHeaders: ["X-Route", "X-Tenant"] }), {}, upstream);
    expect(upstream.get("x-route")).toBe("fixed");
    expect(upstream.get("x-tenant")).toBeNull();
  });

  it("reaches the upstream request through buildUpstreamHeaders", () => {
    const incoming = {
      "x-tenant": "t1",
      authorization: "Bearer agent-key",
      host: "127.0.0.1:6767",
    };
    const headers = buildUpstreamHeaders(
      provider({
        apiKey: "up-key",
        headers: { "X-Route": "fixed" },
        passHeaders: ["X-Route", "X-Tenant", "Authorization", "Host"],
      }),
      undefined,
      incoming,
    );
    expect(headers.get("x-tenant")).toBe("t1");
    expect(headers.get("x-route")).toBe("fixed");
    expect(headers.get("authorization")).toBe("Bearer up-key");
    expect(headers.get("host")).toBeNull();
  });
});

describe("sentUserAgentOf", () => {
  it("extracts the agent's User-Agent", () => {
    expect(sentUserAgentOf({ "user-agent": "claude-code/2.1.0" })).toBe("claude-code/2.1.0");
  });

  it("answers none when the agent sent none", () => {
    expect(sentUserAgentOf({})).toBeNull();
    expect(sentUserAgentOf({ "user-agent": "   " })).toBeNull();
  });

  it("keeps Neox's own User-Agent out of the agents'", () => {
    expect(sentUserAgentOf({ "user-agent": "neolix/0.15.0" })).toBeNull();
    expect(sentUserAgentOf({ "user-agent": "neolix-router/1" })).toBeNull();
  });

  it("takes no decision of its own, even through the old signature", () => {
    // The provider and account are provider-shaping's to read; this only
    // extracts what the agent sent (COMPAT(agentUserAgentOfArgs)).
    expect(
      agentUserAgentOf(provider(), { id: "acc" } as GatewayAccount, {
        "user-agent": "codex/0.50.0",
      }),
    ).toBe("codex/0.50.0");
  });
});

describe("gatewayUserAgent", () => {
  it("names Neox and its version", () => {
    expect(gatewayUserAgent()).toMatch(/^neolix\/\S+$/);
  });

  it("knows the agents from Neox's own requests", () => {
    expect(neolixOwnUserAgent("neolix/1")).toBe(true);
    expect(neolixOwnUserAgent("neolix-vision/1")).toBe(true);
    expect(neolixOwnUserAgent("codex/0.165.0")).toBe(false);
  });
});
