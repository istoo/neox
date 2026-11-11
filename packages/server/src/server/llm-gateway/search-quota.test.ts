import { describe, expect, it } from "vitest";
import type { SearchApiConfig } from "./search-apis.js";
import {
  canReadSearchQuota,
  maskSearchKey,
  readTavilyUsage,
  searchQuotas,
} from "./search-quota.js";

const key = "tvly-1234567890abcdef";

describe("a search key's quota", () => {
  it("reads a key's own limit", () => {
    expect(
      readTavilyUsage({ key: { usage: 10, limit: 100 }, account: { plan_limit: 1000 } }),
    ).toMatchObject({ known: true, used: 10, limit: 100, of: "key", usedUp: false });
  });

  it("reads the plan's limit and says it is the plan's", () => {
    expect(
      readTavilyUsage({
        key: { usage: 7, limit: null },
        account: { current_plan: "researcher", plan_limit: 1000, plan_usage: 250 },
      }),
    ).toMatchObject({ known: true, used: 250, limit: 1000, of: "plan", plan: "researcher" });
  });

  it("reads an unlimited plan", () => {
    expect(
      readTavilyUsage({ key: { usage: 42, limit: null }, account: { plan_limit: null } }),
    ).toMatchObject({ known: true, unlimited: true, used: 42 });
  });

  it("says a key is used up at its limit", () => {
    expect(readTavilyUsage({ key: { usage: 100, limit: 100 } }).usedUp).toBe(true);
  });

  it("keeps pay-as-you-go credit in the count", () => {
    const quota = readTavilyUsage({
      key: { usage: 5, limit: null },
      account: { plan_limit: 10, plan_usage: 10, paygo_limit: 50, paygo_usage: 20 },
    });
    expect(quota).toMatchObject({ usedUp: false, paygoLeft: 30 });
  });

  it("is unknown, never 0 used, when the reply lacks what it takes", () => {
    expect(() => readTavilyUsage({ key: { usage: 1 } })).toThrow(/limit/);
    expect(() => readTavilyUsage({ account: {} })).toThrow(/key/);
  });

  it("masks a key before it is shown", () => {
    expect(maskSearchKey(key)).toMatch(/^tvly…/);
    expect(maskSearchKey(key)).not.toBe(key);
    expect(maskSearchKey(key)).not.toContain(key.slice(4, -4));
    expect(maskSearchKey("short")).toBe("…");
  });

  it("reads Tavily's /usage per key and lets a refused read say why", async () => {
    const seen: string[] = [];
    const api: SearchApiConfig = { vendor: "tavily", key: `${key}, other-key-0001` };
    const quotas = await searchQuotas(api, {
      fresh: true,
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        seen.push(`${String(input)} ${String(headers.authorization)}`);
        const auth = headers.authorization;
        return auth === `Bearer ${key}`
          ? new Response(JSON.stringify({ key: { usage: 3, limit: 100 } }), { status: 200 })
          : new Response("no", { status: 401 });
      }) as typeof fetch,
    });
    expect(quotas).toHaveLength(2);
    expect(quotas[0]).toMatchObject({ key: maskSearchKey(key), known: true, used: 3 });
    expect(quotas[1]?.known).toBe(false);
    expect(quotas[1]?.err).toContain("401");
    expect(quotas[1]?.err).not.toContain("other-key-0001");
    expect(seen[0]).toContain("https://api.tavily.com/usage");
  });

  it("reads nothing for a vendor whose quota it cannot ask", async () => {
    expect(canReadSearchQuota({ vendor: "brave", key })).toBe(false);
    await expect(searchQuotas({ vendor: "brave", key })).resolves.toEqual([]);
  });
});
