import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import { describe, expect, it } from "vitest";
import { EMPTY_GATEWAY_CONFIG, type GatewayConfig } from "./config.js";
import {
  applyGatewayCors,
  cleanOrigin,
  cleanOrigins,
  corsAllowHeaders,
  corsAllowed,
  corsRefusal,
  foreignPage,
  isCorsPreflight,
  isGatewayPath,
  isListedPreflight,
  localhostSubdomain,
} from "./cors.js";

function config(corsOrigins: string[]): GatewayConfig {
  return { ...EMPTY_GATEWAY_CONFIG, corsOrigins };
}

interface FakeResponse {
  statusCode: number;
  headers: Map<string, string>;
  body: string;
  ended: boolean;
  setHeader(name: string, value: string): FakeResponse;
  getHeader(name: string): string | undefined;
  status(code: number): FakeResponse;
  json(value: unknown): FakeResponse;
  end(value?: string): FakeResponse;
}

function fakeResponse(): FakeResponse {
  const response: FakeResponse = {
    statusCode: 200,
    headers: new Map<string, string>(),
    body: "",
    ended: false,
    setHeader(name, value) {
      response.headers.set(name.toLowerCase(), value);
      return response;
    },
    getHeader(name) {
      return response.headers.get(name.toLowerCase());
    },
    status(code) {
      response.statusCode = code;
      return response;
    },
    json(value) {
      response.body = JSON.stringify(value);
      response.ended = true;
      return response;
    },
    end(value) {
      if (value !== undefined) {
        response.body = value;
      }
      response.ended = true;
      return response;
    },
  };
  return response;
}

function fakeRequest(input: {
  method?: string;
  origin?: string;
  host?: string;
  requestedMethod?: string;
  requestedHeaders?: string;
}): ExpressRequest {
  const headers: Record<string, string> = {};
  if (input.origin !== undefined) {
    headers.origin = input.origin;
  }
  if (input.host !== undefined) {
    headers.host = input.host;
  }
  if (input.requestedMethod !== undefined) {
    headers["access-control-request-method"] = input.requestedMethod;
  }
  if (input.requestedHeaders !== undefined) {
    headers["access-control-request-headers"] = input.requestedHeaders;
  }
  return {
    method: input.method ?? "POST",
    headers,
    url: "/v1/responses",
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as ExpressRequest;
}

describe("cleanOrigin", () => {
  it("writes an origin as a browser's Origin header does", () => {
    expect(cleanOrigin("http://localhost:3000/")).toBe("http://localhost:3000");
    expect(cleanOrigin("HTTPS://App.Example.com:443")).toBe("https://app.example.com");
    expect(cleanOrigin("http://example.com:80")).toBe("http://example.com");
    expect(cleanOrigin("http://[::1]:8080")).toBe("http://[::1]:8080");
  });

  it("refuses a wildcard, a path and a non-web scheme", () => {
    expect(cleanOrigin("*")).toBeNull();
    expect(cleanOrigin("http://example.com/path")).toBeNull();
    expect(cleanOrigin("file:///tmp/x.html")).toBeNull();
    expect(cleanOrigin("")).toBeNull();
  });

  it("reads a browser extension's origin by its id", () => {
    const id = "a".repeat(32);
    expect(cleanOrigin(`chrome-extension://${id}/`)).toBe(`chrome-extension://${id}`);
    expect(cleanOrigin("chrome-extension://short")).toBeNull();
    const uuid = "01234567-89ab-cdef-0123-456789abcdef";
    expect(cleanOrigin(`moz-extension://${uuid}`)).toBe(`moz-extension://${uuid}`);
  });

  it("dedupes a list", () => {
    expect(cleanOrigins(["http://localhost:3000/", "http://localhost:3000", "bad"])).toEqual([
      "http://localhost:3000",
    ]);
  });
});

describe("corsAllowed", () => {
  it("matches only a listed origin", () => {
    const saved = config(["http://localhost:3000"]);
    expect(corsAllowed("http://localhost:3000", saved)).toBe(true);
    expect(corsAllowed("http://localhost:3001", saved)).toBe(false);
    expect(corsAllowed("http://evil.example", saved)).toBe(false);
    expect(corsAllowed("http://localhost:3000", config([]))).toBe(false);
  });
});

describe("foreignPage", () => {
  const req = fakeRequest({ host: "127.0.0.1:6767" });

  it("is a page elsewhere", () => {
    expect(foreignPage(req, "https://evil.example")).toBe(true);
  });

  it("is not a page on this computer or the request's own origin", () => {
    expect(foreignPage(req, "http://localhost:3000")).toBe(false);
    expect(foreignPage(req, "http://app.localhost:3000")).toBe(false);
    expect(foreignPage(req, "http://127.0.0.1:3000")).toBe(false);
    expect(foreignPage(req, "http://[::1]:3000")).toBe(false);
    expect(foreignPage(req, "http://127.0.0.1:6767")).toBe(false);
  });

  it("leaves an app's or an extension's scheme alone", () => {
    expect(foreignPage(req, "chrome-extension://abcdefghijklmnop")).toBe(false);
    expect(foreignPage(req, "file:///tmp/page.html")).toBe(false);
    expect(foreignPage(req, "app://neolix")).toBe(false);
  });
});

describe("localhostSubdomain", () => {
  it("is a page under a localhost name", () => {
    expect(localhostSubdomain("http://evil.localhost:3000")).toBe(true);
    expect(localhostSubdomain("http://localhost:3000")).toBe(false);
    expect(localhostSubdomain("https://evil.example")).toBe(false);
  });
});

describe("corsAllowHeaders", () => {
  it("allows the header names asked for, and nothing else", () => {
    expect(corsAllowHeaders("Authorization, x-api-key,X-Bad Name")).toBe(
      "Authorization, x-api-key",
    );
    expect(corsAllowHeaders("")).toBe("");
  });
});

describe("isCorsPreflight", () => {
  it("is an OPTIONS declaring the call", () => {
    expect(
      isCorsPreflight(
        fakeRequest({
          method: "OPTIONS",
          origin: "http://localhost:3000",
          requestedMethod: "POST",
        }),
      ),
    ).toBe(true);
    expect(
      isCorsPreflight(fakeRequest({ method: "OPTIONS", origin: "http://localhost:3000" })),
    ).toBe(false);
    expect(
      isCorsPreflight(
        fakeRequest({ method: "POST", origin: "http://localhost:3000", requestedMethod: "POST" }),
      ),
    ).toBe(false);
  });
});

describe("isListedPreflight", () => {
  it("is a listed origin's preflight only", () => {
    const saved = config(["http://localhost:3000"]);
    const listed = fakeRequest({
      method: "OPTIONS",
      origin: "http://localhost:3000",
      requestedMethod: "POST",
    });
    expect(isListedPreflight(listed, saved)).toBe(true);
    expect(
      isListedPreflight(
        fakeRequest({ method: "OPTIONS", origin: "https://evil.example", requestedMethod: "POST" }),
        saved,
      ),
    ).toBe(false);
  });
});

describe("applyGatewayCors", () => {
  it("answers a listed origin's preflight with headers and 204", () => {
    const res = fakeResponse();
    const outcome = applyGatewayCors(
      fakeRequest({
        method: "OPTIONS",
        origin: "http://localhost:3000",
        requestedMethod: "POST",
        requestedHeaders: "authorization, content-type",
      }),
      res as unknown as ExpressResponse,
      config(["http://localhost:3000"]),
      false,
    );
    expect(outcome.done).toBe(true);
    expect(res.statusCode).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(res.headers.get("access-control-allow-headers")).toBe("authorization, content-type");
    expect(res.headers.get("access-control-max-age")).toBe("600");
  });

  it("refuses a listed origin's call that carries no key", () => {
    const res = fakeResponse();
    const outcome = applyGatewayCors(
      fakeRequest({ origin: "http://localhost:3000" }),
      res as unknown as ExpressResponse,
      config(["http://localhost:3000"]),
      false,
    );
    expect(outcome.done).toBe(true);
    expect(res.statusCode).toBe(401);
  });

  it("lets a listed origin's keyed call through with the headers", () => {
    const res = fakeResponse();
    const outcome = applyGatewayCors(
      fakeRequest({ origin: "http://localhost:3000" }),
      res as unknown as ExpressResponse,
      config(["http://localhost:3000"]),
      true,
    );
    expect(outcome.done).toBe(false);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(res.headers.get("access-control-expose-headers")).toContain("x-magpie-session");
  });

  it("refuses another web page", () => {
    const res = fakeResponse();
    const outcome = applyGatewayCors(
      fakeRequest({ origin: "https://evil.example" }),
      res as unknown as ExpressResponse,
      config([]),
      true,
    );
    expect(outcome.done).toBe(true);
    expect(res.statusCode).toBe(403);
  });

  it("refuses Origin null and a localhost subdomain without a key", () => {
    for (const origin of ["null", "http://evil.localhost:3000"]) {
      const res = fakeResponse();
      const outcome = applyGatewayCors(
        fakeRequest({ origin }),
        res as unknown as ExpressResponse,
        config([]),
        false,
      );
      expect(outcome.done).toBe(true);
      expect(res.statusCode).toBe(403);
    }
  });

  it("lets Origin null through with a key, without CORS headers", () => {
    const res = fakeResponse();
    const outcome = applyGatewayCors(
      fakeRequest({ origin: "null" }),
      res as unknown as ExpressResponse,
      config([]),
      true,
    );
    expect(outcome.done).toBe(false);
    expect(res.headers.size).toBe(0);
  });

  it("leaves a request with no Origin untouched", () => {
    const res = fakeResponse();
    const outcome = applyGatewayCors(
      fakeRequest({}),
      res as unknown as ExpressResponse,
      config([]),
      false,
    );
    expect(outcome.done).toBe(false);
    expect(res.headers.size).toBe(0);
  });
});

describe("corsRefusal", () => {
  it("refuses an unlisted page, not a listed one", () => {
    expect(
      corsRefusal(fakeRequest({ origin: "https://evil.example" }), config([]), false)?.status,
    ).toBe(403);
    expect(
      corsRefusal(
        fakeRequest({ origin: "http://localhost:3000" }),
        config(["http://localhost:3000"]),
        false,
      ),
    ).toBeNull();
  });
});

describe("isGatewayPath", () => {
  it("names the paths the gateway answers", () => {
    for (const path of [
      "/v1/responses",
      "/responses",
      "/v1/models",
      "/me",
      "/backend-api/codex/responses",
      "/api/tags",
      "/muse-code/models",
    ]) {
      expect(isGatewayPath(path)).toBe(true);
    }
    expect(isGatewayPath("/api/health")).toBe(false);
    expect(isGatewayPath("/ws")).toBe(false);
  });
});
