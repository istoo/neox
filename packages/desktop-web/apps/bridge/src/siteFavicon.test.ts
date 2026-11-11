import { describe, expect, it } from "vitest";

import {
  declaredIconUrls,
  isPublicAddress,
  normalizeSiteHost,
  SiteFaviconCache,
} from "./siteFavicon.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PUBLIC = [{ address: "93.184.216.34" }];

function fakeFetch(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    const route = routes[url];
    return route ? route() : new Response(null, { status: 404 });
  };
  return { calls, fetch };
}

describe("site favicon proxy", () => {
  it("accepts public hostnames only", () => {
    expect(normalizeSiteHost(" GitHub.com. ")).toBe("github.com");
    expect(normalizeSiteHost("docs.workos.com")).toBe("docs.workos.com");
    for (const bad of [
      "localhost",
      "printer.local",
      "db.internal",
      "127.0.0.1",
      "::1",
      "10.0.0.5",
      "example",
      "exa mple.com",
      "-bad.com",
      "",
    ])
      expect(normalizeSiteHost(bad)).toBeNull();
  });

  it("treats private, loopback, link-local and mapped-private addresses as non-public", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
    ])
      expect(isPublicAddress(address)).toBe(false);
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("2606:4700::1111")).toBe(true);
    // Proxy clients in fake-IP mode answer every lookup from 198.18.0.0/15.
    expect(isPublicAddress("198.18.0.36")).toBe(true);
    expect(isPublicAddress("::ffff:198.18.0.36")).toBe(true);
  });

  it("serves a real image and caches it, including a site that has none", async () => {
    const { calls, fetch } = fakeFetch({
      "https://example.com/favicon.ico": () =>
        new Response(PNG, { headers: { "content-type": "image/x-icon" } }),
    });
    let now = 0;
    const cache = new SiteFaviconCache({ resolve: async () => PUBLIC, fetch, now: () => now });
    expect(await cache.get("example.com")).toMatchObject({ contentType: "image/png" });
    expect(await cache.get("example.com")).not.toBeNull();
    expect(await cache.get("noicon.com")).toBeNull();
    expect(await cache.get("noicon.com")).toBeNull();
    expect(calls.filter((url) => url.includes("example.com"))).toHaveLength(1);
    expect(calls.filter((url) => url.includes("noicon.com"))).toHaveLength(3);
    now += 2 * 60 * 60 * 1000;
    await cache.get("noicon.com");
    expect(calls.filter((url) => url.includes("noicon.com"))).toHaveLength(6);
  });

  it("refuses a redirect to a private address and a body that is not an image", async () => {
    const { fetch } = fakeFetch({
      "https://evil.example/favicon.ico": () =>
        new Response(null, { status: 302, headers: { location: "https://metadata.example/x" } }),
      "https://html.example/favicon.ico": () =>
        new Response("<html>nope</html>", { headers: { "content-type": "image/x-icon" } }),
    });
    const resolve = async (host: string) =>
      host === "metadata.example" ? [{ address: "169.254.169.254" }] : PUBLIC;
    const cache = new SiteFaviconCache({ resolve, fetch });
    expect(await cache.get("evil.example")).toBeNull();
    expect(await cache.get("html.example")).toBeNull();
  });

  it("falls back to the icon the home page declares", async () => {
    const { fetch } = fakeFetch({
      "https://declared.example/": () =>
        new Response(
          '<head><link rel="apple-touch-icon" href="/touch.png"><link rel="icon" href="/favicon/favicon.ico" type="image/x-icon"/></head>',
          { headers: { "content-type": "text/html" } },
        ),
      "https://declared.example/favicon/favicon.ico": () => new Response(PNG),
    });
    const cache = new SiteFaviconCache({ resolve: async () => PUBLIC, fetch });
    expect(await cache.get("declared.example")).toMatchObject({ contentType: "image/png" });
    expect(
      declaredIconUrls(
        '<link rel="shortcut icon" href="a.ico"><link rel="stylesheet" href="x.css"><link href="data:x" rel="icon">',
        new URL("https://s.example/docs/"),
      ).map(String),
    ).toEqual(["https://s.example/docs/a.ico"]);
  });

  it("refuses an oversized icon", async () => {
    const big = new Uint8Array(300 * 1024);
    big.set(PNG);
    const { fetch } = fakeFetch({ "https://big.example/favicon.ico": () => new Response(big) });
    const cache = new SiteFaviconCache({ resolve: async () => PUBLIC, fetch });
    expect(await cache.get("big.example")).toBeNull();
  });
});
