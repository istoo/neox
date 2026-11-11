import { expect, it } from "vitest";
import {
  applyProxyEnvironment,
  bypassedHost,
  describeEffectiveProxy,
  isSocksProxy,
  parseProxyAddress,
  proxyForUrl,
  redactProxy,
  resolveProxy,
  type ResolvedProxy,
} from "./proxy-config.js";
import { parseScutil, parseWindows } from "./system-proxy.js";

const SYSTEM = { url: "", http: "", socks: "", bypass: [] as string[] };

function resolution(overrides: Partial<ResolvedProxy> = {}): ResolvedProxy {
  return {
    url: "",
    source: "none",
    bypass: [],
    httpUrl: "",
    httpProxy: "",
    httpsProxy: "",
    noProxy: "localhost,127.0.0.1,[::1],::1",
    ...overrides,
  };
}

it("reads scutil's dictionary, HTTPS before HTTP before SOCKS", () => {
  const proxy = parseScutil(`
<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7891
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 1
  SOCKSPort : 7892
  SOCKSProxy : 127.0.0.1
}`);
  expect(proxy.url).toBe("http://127.0.0.1:7891");
  expect(proxy.http).toBe("http://127.0.0.1:7890");
  expect(proxy.socks).toBe("socks5://127.0.0.1:7892");
  expect(proxy.bypass).toEqual(["*.local", "169.254/16"]);
});

it("reads Internet Options' one address and its per-protocol list", () => {
  expect(parseWindows("proxy.corp:8080", "*.corp;<local>")).toEqual({
    url: "http://proxy.corp:8080",
    http: "http://proxy.corp:8080",
    socks: "",
    bypass: ["*.corp", "<local>"],
  });
  const split = parseWindows("http=h:1;https=h:2;socks=h:3", "");
  expect(split.url).toBe("http://h:2");
  expect(split.socks).toBe("socks5://h:3");
});

it("prefers the settings proxy over the environment and the system", () => {
  const resolved = resolveProxy({
    setting: "socks5://127.0.0.1:1080",
    env: { HTTP_PROXY: "http://env:1" },
    systemProbe: () => ({ ...SYSTEM, url: "http://system:1" }),
  });
  expect(resolved.source).toBe("settings");
  expect(resolved.url).toBe("socks5://127.0.0.1:1080");
  expect(isSocksProxy(resolved.url)).toBe(true);
});

it("keeps NO_PROXY as written and ignores a malformed proxy login", () => {
  const resolved = resolveProxy({
    setting: "",
    env: {
      HTTPS_PROXY: "http://user%zz:pw@proxy.corp:8080",
      HTTP_PROXY: "http://fallback:1",
      NO_PROXY: "vendor.invalid,.example.invalid:0443",
    },
    systemProbe: () => SYSTEM,
  });
  // The malformed HTTPS_PROXY is not usable, so the valid HTTP_PROXY stands
  // in; NO_PROXY itself is a host list, never parsed as a URL.
  expect(resolved.httpsProxy).toBe("http://fallback:1/");
  expect(resolved.noProxy).toContain("vendor.invalid");
  expect(resolved.noProxy).toContain(".example.invalid:0443");
});

it("follows the environment when the settings say auto", () => {
  const resolved = resolveProxy({
    setting: "",
    env: { HTTPS_PROXY: "proxy.corp:8080" },
    systemProbe: () => ({ ...SYSTEM, url: "http://system:1" }),
  });
  expect(resolved.source).toBe("environment");
  expect(resolved.url).toBe("http://proxy.corp:8080/");
});

it("follows the system when neither settings nor environment name one", () => {
  const resolved = resolveProxy({
    setting: "",
    env: {},
    systemProbe: () => ({ ...SYSTEM, url: "http://127.0.0.1:7890", bypass: ["*.local"] }),
  });
  expect(resolved.source).toBe("system");
  expect(resolved.noProxy).toContain("*.local".replace("*", ""));
});

it("turns everything off with direct", () => {
  const resolved = resolveProxy({
    setting: "direct",
    env: { HTTPS_PROXY: "http://env:1" },
    systemProbe: () => ({ ...SYSTEM, url: "http://system:1" }),
  });
  expect(resolved.source).toBe("off");
  expect(resolved.url).toBe("");
  expect(describeEffectiveProxy({ setting: "direct" }).source).toBe("off");
});

it("leaves loopback and system exceptions direct", () => {
  const resolved = resolution({ url: "http://proxy:1", bypass: ["*.corp", "<local>"] });
  expect(proxyForUrl(new URL("http://127.0.0.1:6767"), resolved)).toBeUndefined();
  expect(proxyForUrl(new URL("http://localhost:6767"), resolved)).toBeUndefined();
  expect(proxyForUrl(new URL("https://api.vendor.com"), resolved)).toBe("http://proxy:1");
  expect(proxyForUrl(new URL("https://box.corp"), resolved)).toBeUndefined();
  expect(proxyForUrl(new URL("https://intranet"), resolved)).toBeUndefined();
});

it("a provider's own choice replaces the global one", () => {
  const resolved = resolution({ url: "http://global:1" });
  expect(proxyForUrl(new URL("https://vendor.com"), resolved, "direct")).toBeUndefined();
  expect(proxyForUrl(new URL("https://vendor.com"), resolved, "http://own:2")).toBe(
    "http://own:2/",
  );
});

it("redacts a proxy's login but keeps the address as written", () => {
  expect(redactProxy("socks5://user:pw@127.0.0.1:1080")).toBe("socks5://127.0.0.1:1080");
  expect(redactProxy("127.0.0.1:8080")).toBe("127.0.0.1:8080");
  expect(redactProxy("http://[")).toBe("");
});

it("matches the system's exception list", () => {
  expect(bypassedHost("api.example.com", ["*.example.com"])).toBe(true);
  expect(bypassedHost("example.com", [".example.com"])).toBe(true);
  expect(bypassedHost("intranet", ["<local>"])).toBe(true);
  expect(bypassedHost("api.example.com", ["other.com"])).toBe(false);
});

it("gives an agent's env the settings proxy, replacing what it had", () => {
  const env = applyProxyEnvironment(
    { PATH: "/bin", HTTPS_PROXY: "http://old:1" },
    { setting: "http://new:2", env: {} },
  );
  expect(env.PATH).toBe("/bin");
  expect(env.HTTPS_PROXY).toBe("http://new:2/");
  expect(env.HTTP_PROXY).toBe("http://new:2/");
  expect(env.NO_PROXY).toContain("127.0.0.1");
});

it("drops the proxy variables for direct, and leaves an environment proxy alone", () => {
  const direct = applyProxyEnvironment(
    { PATH: "/bin", HTTPS_PROXY: "http://old:1", NO_PROXY: "x" },
    { setting: "direct", env: {} },
  );
  expect(direct.HTTPS_PROXY).toBeUndefined();
  expect(direct.NO_PROXY).toBeUndefined();
  expect(direct.PATH).toBe("/bin");

  const untouched = applyProxyEnvironment(
    { HTTPS_PROXY: "http://env:1" },
    { setting: "", env: {} },
  );
  expect(untouched.HTTPS_PROXY).toBe("http://env:1");
});

it("adds the system proxy only where the environment names none", () => {
  const withSystem = applyProxyEnvironment(
    {},
    { setting: "", env: {}, systemProbe: () => ({ ...SYSTEM, url: "http://system:1" }) },
  );
  expect(withSystem.HTTPS_PROXY).toBe("http://system:1");
  const withEnv = applyProxyEnvironment(
    { HTTP_PROXY: "http://env:1" },
    { setting: "", env: {}, systemProbe: () => ({ ...SYSTEM, url: "http://system:1" }) },
  );
  expect(withEnv.HTTP_PROXY).toBe("http://env:1");
});

it("parses a bare host:port as an HTTP proxy", () => {
  expect(parseProxyAddress("127.0.0.1:7890")?.href).toBe("http://127.0.0.1:7890/");
});
