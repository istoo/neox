import { describe, expect, it, vi } from "vitest";

import { applyUpdateProxy, resolveUpdateProxy } from "./update-proxy";

describe("resolveUpdateProxy", () => {
  it("follows the environment's proxy, with its bypass list", () => {
    expect(
      resolveUpdateProxy({
        HTTPS_PROXY: "http://127.0.0.1:7890",
        NO_PROXY: "localhost, 127.0.0.1",
      }),
    ).toEqual({
      proxyRules: "http://127.0.0.1:7890",
      proxyBypassRules: "localhost,127.0.0.1",
    });
  });

  it("prefers HTTPS_PROXY and falls back through the usual variables", () => {
    expect(resolveUpdateProxy({ HTTPS_PROXY: "http://a:1", ALL_PROXY: "socks5://b:2" })).toEqual({
      proxyRules: "http://a:1",
    });
    expect(resolveUpdateProxy({ all_proxy: "socks5://b:2" })).toEqual({
      proxyRules: "socks5://b:2",
    });
  });

  it("uses the system's proxy when the environment names none", () => {
    expect(resolveUpdateProxy({})).toEqual({ mode: "system" });
  });
});

describe("applyUpdateProxy", () => {
  it("hands the resolved config to the session", async () => {
    const setProxy = vi.fn(async () => undefined);
    await applyUpdateProxy(setProxy, { HTTP_PROXY: "http://p:1" });
    expect(setProxy).toHaveBeenCalledWith({ proxyRules: "http://p:1" });
  });

  it("keeps Electron's default when the session refuses it", async () => {
    const setProxy = vi.fn(async () => {
      throw new Error("nope");
    });
    await expect(applyUpdateProxy(setProxy, {})).resolves.toBeUndefined();
  });
});
