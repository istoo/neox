import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Request as ExpressRequest } from "express";
import pino from "pino";
import { describe, expect, it } from "vitest";
import {
  allowsAccount,
  allowsReadOnly,
  checkAccess,
  combineAccountFilters,
  heldModels,
  keyAccountFilter,
  keyIsHeld,
  quotaScopeAllows,
  RateLimiter,
  resolvePrincipal,
} from "./access.js";
import type { GatewayCandidate } from "./catalog.js";
import type { GatewayConfig } from "./config.js";
import { UsageLedger } from "./usage.js";

const logger = pino({ level: "silent" });

function config(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    version: 1,
    enabled: true,
    keys: [],
    pricing: {},
    providers: [],
    groups: [],
    ...overrides,
  };
}

function request(
  headers: Record<string, string> = {},
  remoteAddress = "127.0.0.1",
): ExpressRequest {
  return {
    socket: { remoteAddress },
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as ExpressRequest;
}

function ledger(): UsageLedger {
  return new UsageLedger({
    neolixHome: mkdtempSync(path.join(os.tmpdir(), "neolix-access-")),
    logger,
  });
}

function candidate(providerId: string, modelId: string): GatewayCandidate {
  return {
    provider: {
      id: providerId,
      protocol: "anthropic",
      baseUrl: "https://example.test/v1",
      accounts: [],
      models: [{ id: modelId }],
    },
    model: { id: modelId },
  };
}

describe("resolvePrincipal", () => {
  it("expands an object key into its rules", () => {
    const principal = resolvePrincipal(
      request({ "x-api-key": "secret" }),
      config({ keys: [{ key: "secret", label: "team", models: ["local/m"], dailyTokens: 10 }] }),
    );
    expect(principal).toMatchObject({
      key: "secret",
      label: "team",
      models: ["local/m"],
      dailyTokens: 10,
    });
  });

  it("accepts a bearer token for a string key", () => {
    const principal = resolvePrincipal(
      request({ authorization: "Bearer legacy" }),
      config({ keys: ["legacy"] }),
    );
    expect(principal?.key).toBe("legacy");
  });

  it("rejects a wrong key", () => {
    expect(
      resolvePrincipal(request({ "x-api-key": "nope" }), config({ keys: ["secret"] })),
    ).toBeNull();
  });

  it("reads Gemini and query-string keys", () => {
    expect(
      resolvePrincipal(request({ "x-goog-api-key": "secret" }), config({ keys: ["secret"] }))?.key,
    ).toBe("secret");
    const withQuery = {
      socket: { remoteAddress: "127.0.0.1" },
      get: () => undefined,
      query: { key: "secret" },
    } as unknown as ExpressRequest;
    expect(resolvePrincipal(withQuery, config({ keys: ["secret"] }))?.key).toBe("secret");
  });

  it("refuses an expired key", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(
      resolvePrincipal(
        request({ "x-api-key": "secret" }),
        config({ keys: [{ key: "secret", expiresAt: past }] }),
      ),
    ).toBeNull();
  });

  it("marks a read-only key", () => {
    const principal = resolvePrincipal(
      request({ "x-api-key": "read" }),
      config({ keys: [{ key: "read", readOnly: true }] }),
    );
    expect(principal?.readOnly).toBe(true);
    expect(allowsReadOnly("GET", "/v1/models")).toBe(true);
    expect(allowsReadOnly("POST", "/v1/messages")).toBe(false);
    expect(allowsReadOnly("POST", "/v1/messages/count_tokens")).toBe(true);
  });

  it("allows loopback only when no key is configured", () => {
    expect(resolvePrincipal(request({}, "127.0.0.1"), config())?.key).toBeNull();
    expect(resolvePrincipal(request({}, "10.0.0.5"), config())).toBeNull();
  });
});

describe("checkAccess", () => {
  const candidates = [candidate("local", "m")];

  it("denies a model the key cannot use", () => {
    const denial = checkAccess({
      config: config(),
      ledger: ledger(),
      principal: {
        key: "k",
        label: null,
        models: ["other/model"],
        dailyTokens: null,
        monthlyUsd: null,
        limits: [],
        ratePerMinute: null,
      },
      requestedModel: "group/fast",
      routingModel: "group/fast",
      candidates,
      rateLimiter: new RateLimiter(),
      now: Date.now(),
    });
    expect(denial).toMatchObject({ status: 403, type: "model_not_allowed" });
  });

  it("allows a model that resolves through a member of the group", () => {
    const denial = checkAccess({
      config: config(),
      ledger: ledger(),
      principal: {
        key: "k",
        label: null,
        models: ["local/m"],
        dailyTokens: null,
        monthlyUsd: null,
        limits: [],
        ratePerMinute: null,
      },
      requestedModel: "group/fast",
      routingModel: "group/fast",
      candidates,
      rateLimiter: new RateLimiter(),
      now: Date.now(),
    });
    expect(denial).toBeNull();
  });

  it("stops a key at its daily token limit", () => {
    const now = Date.now();
    const usage = ledger();
    usage.record({
      time: new Date(now).toISOString(),
      requested: "local/m",
      provider: "local",
      account: null,
      model: "m",
      protocol: "anthropic",
      status: 200,
      ok: true,
      inputTokens: 8,
      outputTokens: 4,
      attempts: 1,
      durationMs: 10,
      costUsd: 0,
      key: "k",
    });
    const denial = checkAccess({
      config: config(),
      ledger: usage,
      principal: {
        key: "k",
        label: null,
        models: [],
        dailyTokens: 10,
        monthlyUsd: null,
        limits: [],
        ratePerMinute: null,
      },
      requestedModel: "local/m",
      routingModel: "local/m",
      candidates,
      rateLimiter: new RateLimiter(),
      now,
    });
    expect(denial).toMatchObject({ status: 429, type: "quota_exceeded" });
  });

  it("stops the gateway at the monthly budget", () => {
    const now = Date.now();
    const usage = ledger();
    usage.record({
      time: new Date(now).toISOString(),
      requested: "local/m",
      provider: "local",
      account: null,
      model: "m",
      protocol: "anthropic",
      status: 200,
      ok: true,
      inputTokens: 1,
      outputTokens: 1,
      attempts: 1,
      durationMs: 10,
      costUsd: 5,
      key: null,
    });
    const denial = checkAccess({
      config: config({ budget: { monthlyUsd: 4 } }),
      ledger: usage,
      principal: {
        key: null,
        label: "loopback",
        models: [],
        dailyTokens: null,
        monthlyUsd: null,
        limits: [],
        ratePerMinute: null,
      },
      requestedModel: "local/m",
      routingModel: "local/m",
      candidates,
      rateLimiter: new RateLimiter(),
      now,
    });
    expect(denial).toMatchObject({ status: 402, type: "budget_exceeded" });
  });

  it("paces requests per minute", () => {
    const limiter = new RateLimiter();
    const now = Date.now();
    const check = () =>
      checkAccess({
        config: config(),
        ledger: ledger(),
        principal: {
          key: "k",
          label: null,
          models: [],
          dailyTokens: null,
          monthlyUsd: null,
          limits: [],
          ratePerMinute: 2,
        },
        requestedModel: "local/m",
        routingModel: "local/m",
        candidates,
        rateLimiter: limiter,
        now,
      });
    expect(check()).toBeNull();
    expect(check()).toBeNull();
    expect(check()).toMatchObject({ status: 429, type: "rate_limited" });
  });
});

describe("key accounts (myna's Key.Accounts)", () => {
  it("narrows a key naming accounts and no model to their providers' models", () => {
    expect(heldModels([], [])).toEqual([]);
    expect(heldModels(["openai/*"], ["codex/acct-1"])).toEqual(["openai/*"]);
    expect(heldModels([], ["codex/acct-1", "claude/me@example.com", "codex/acct-2"])).toEqual([
      "codex/*",
      "claude/*",
    ]);
    expect(heldModels([], ["nonsense"])).toEqual(["/"]);
  });

  it("lets a provider it names no account of keep every account", () => {
    expect(allowsAccount([], "codex", "acct-1")).toBe(true);
    expect(allowsAccount(["codex/acct-1"], "codex", "acct-1")).toBe(true);
    expect(allowsAccount(["codex/Acct-1"], "codex", "acct-1")).toBe(true);
    expect(allowsAccount(["codex/acct-1"], "codex", "acct-2")).toBe(false);
    expect(allowsAccount(["codex/acct-1"], "claude", "acct-2")).toBe(true);
  });

  it("folds a key's accounts into the models it may use", () => {
    const principal = resolvePrincipal(
      request({ "x-api-key": "secret" }),
      config({
        keys: [{ key: "secret", label: "held", accounts: ["codex/acct-1"], quotas: true }],
      }),
    );
    expect(principal?.models).toEqual(["codex/*"]);
    expect(principal?.accounts).toEqual(["codex/acct-1"]);
    expect(principal?.quotas).toBe(true);
  });

  it("tells a held key quotas only with quotas on and every model of the provider", () => {
    const held = {
      models: ["codex/*"],
      accounts: ["codex/acct-1"],
      quotas: false,
      limits: [],
      dailyTokens: null,
      monthlyUsd: null,
    };
    expect(keyIsHeld(held)).toBe(true);
    expect(
      quotaScopeAllows(held, {
        providerId: "codex",
        accountRef: "acct-1",
        usesEveryModelOfProvider: true,
      }),
    ).toBe(false);
    expect(
      quotaScopeAllows(
        { ...held, quotas: true },
        { providerId: "codex", accountRef: "acct-1", usesEveryModelOfProvider: true },
      ),
    ).toBe(true);
    expect(
      quotaScopeAllows(
        { ...held, quotas: true },
        { providerId: "codex", accountRef: "acct-2", usesEveryModelOfProvider: true },
      ),
    ).toBe(false);
    expect(
      quotaScopeAllows(
        { ...held, quotas: true },
        { providerId: "codex", accountRef: "acct-1", usesEveryModelOfProvider: false },
      ),
    ).toBe(false);
    // a key held to nothing is this machine's owner: told everything
    expect(
      quotaScopeAllows(
        {
          models: [],
          accounts: [],
          quotas: false,
          limits: [],
          dailyTokens: null,
          monthlyUsd: null,
        },
        { providerId: "codex", accountRef: "acct-1", usesEveryModelOfProvider: false },
      ),
    ).toBe(true);
  });
});

describe("account filters", () => {
  it("keeps only the accounts a group and a key both name", () => {
    const group = keyAccountFilter({ accounts: ["codex/acct-1", "claude/me"] });
    const key = keyAccountFilter({ accounts: ["codex/acct-2", "gemini/other"] });
    const both = combineAccountFilters(group, key)!;
    // codex: the two share none, held to none; claude only the group names;
    // gemini only the key names
    expect([...both.get("codex")!]).toEqual([]);
    expect([...both.get("claude")!]).toEqual(["me"]);
    expect([...both.get("gemini")!]).toEqual(["other"]);
    expect(combineAccountFilters(null, key)).toBe(key);
    expect(combineAccountFilters(group, null)).toBe(group);
  });
});
