import { describe, expect, it } from "vitest";
import { fetchThroughProxy, proxyOfAccount } from "./proxy-fetch.js";

function jsonAnswer(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchThroughProxy", () => {
  it("uses the fetch it was given when no proxy is named", () => {
    const base: typeof fetch = () => Promise.resolve(jsonAnswer({}));
    expect(fetchThroughProxy("", base)).toBe(base);
    expect(fetchThroughProxy(null, base)).toBe(base);
  });

  it("sends the daemon's own proxy for an empty choice", () => {
    expect(proxyOfAccount({ proxy: "" })).toBe("");
    expect(proxyOfAccount({ proxy: "  direct " })).toBe("direct");
    expect(proxyOfAccount({})).toBe("");
  });

  it("wraps the fetch with a dispatcher when a proxy is named", async () => {
    let seen: unknown = null;
    const base = ((_input: unknown, init?: { dispatcher?: unknown }) => {
      seen = init?.dispatcher ?? null;
      return Promise.resolve(jsonAnswer({ ok: true }));
    }) as unknown as typeof fetch;
    const proxied = fetchThroughProxy("direct", base);
    expect(proxied).not.toBe(base);
    await proxied("https://example.test/");
    expect(seen).not.toBeNull();
  });
});
