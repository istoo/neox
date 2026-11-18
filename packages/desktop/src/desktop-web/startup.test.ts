import { describe, expect, it, vi } from "vitest";

import {
  buildDesktopWebStartingHtml,
  buildDesktopWebStartingUrl,
  buildDesktopWebStartupErrorHtml,
  buildDesktopWebStartupErrorUrl,
  classifyDesktopWebProbe,
  DESKTOP_WEB_STARTUP_RETRY_URL,
  normalizeDesktopWebDevUrl,
  resolveDesktopWebBaseUrl,
  resolveDesktopWebStartupLocale,
  waitForDesktopWebReady,
} from "./startup.js";

describe("resolveDesktopWebBaseUrl", () => {
  it("builds a loopback URL for TCP listen addresses", () => {
    expect(resolveDesktopWebBaseUrl("127.0.0.1:6768")).toBe("http://127.0.0.1:6768/");
    expect(resolveDesktopWebBaseUrl("  localhost:6868  ")).toBe("http://localhost:6868/");
    expect(resolveDesktopWebBaseUrl("[::1]:6768")).toBe("http://[::1]:6768/");
  });

  it("points wildcard binds at loopback", () => {
    expect(resolveDesktopWebBaseUrl("0.0.0.0:6868")).toBe("http://127.0.0.1:6868/");
    expect(resolveDesktopWebBaseUrl("[::]:6868")).toBe("http://127.0.0.1:6868/");
  });

  it("rejects sockets, pipes, and malformed addresses", () => {
    expect(resolveDesktopWebBaseUrl("/tmp/neolix.sock")).toBeNull();
    expect(resolveDesktopWebBaseUrl("unix:///tmp/neolix.sock")).toBeNull();
    expect(resolveDesktopWebBaseUrl("\\\\.\\pipe\\neolix")).toBeNull();
    expect(resolveDesktopWebBaseUrl("127.0.0.1")).toBeNull();
    expect(resolveDesktopWebBaseUrl(":6768")).toBeNull();
    expect(resolveDesktopWebBaseUrl("127.0.0.1:0")).toBeNull();
    expect(resolveDesktopWebBaseUrl("127.0.0.1:70000")).toBeNull();
    expect(resolveDesktopWebBaseUrl("::1:6768")).toBeNull();
  });
});

describe("normalizeDesktopWebDevUrl", () => {
  it("accepts http(s) and rejects everything else", () => {
    expect(normalizeDesktopWebDevUrl("http://localhost:5173")).toBe("http://localhost:5173/");
    expect(normalizeDesktopWebDevUrl(" https://dev.example.test/app/ ")).toBe(
      "https://dev.example.test/app/",
    );
    expect(normalizeDesktopWebDevUrl("file:///tmp/index.html")).toBeNull();
    expect(normalizeDesktopWebDevUrl("not a url")).toBeNull();
    expect(normalizeDesktopWebDevUrl("   ")).toBeNull();
  });
});

describe("classifyDesktopWebProbe", () => {
  it("treats 200 as ready and 503 as still starting", () => {
    expect(classifyDesktopWebProbe(200)).toBe("ready");
    expect(classifyDesktopWebProbe(503)).toBe("starting");
    expect(classifyDesktopWebProbe(404)).toBe("failed");
    expect(classifyDesktopWebProbe(500)).toBe("failed");
  });
});

describe("waitForDesktopWebReady", () => {
  it("waits while the daemon answers 503 and succeeds on 200", async () => {
    const statuses = [503, 503, 200];
    const fetchImpl = vi.fn(async () => ({
      status: statuses.shift() ?? 200,
      body: null,
    }));

    const result = await waitForDesktopWebReady({
      baseUrl: "http://127.0.0.1:6768/",
      fetchImpl,
      sleep: async () => {},
    });

    expect(result).toEqual({ ok: true, baseUrl: "http://127.0.0.1:6768/" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("fails immediately when the address answers with another status", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 404, body: null }));

    const result = await waitForDesktopWebReady({
      baseUrl: "http://127.0.0.1:6768/",
      fetchImpl,
      sleep: async () => {},
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toContain("HTTP 404");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports a timeout while the daemon is still starting", async () => {
    let clock = 0;
    const result = await waitForDesktopWebReady({
      baseUrl: "http://127.0.0.1:6768/",
      timeoutMs: 1_000,
      intervalMs: 250,
      fetchImpl: async () => ({ status: 503, body: null }),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });

    expect(result).toEqual({
      ok: false,
      reason: "The web interface at http://127.0.0.1:6768/ was still starting after 1s.",
    });
  });

  it("reports the last connection error when the server never answers", async () => {
    let clock = 0;
    const result = await waitForDesktopWebReady({
      baseUrl: "http://127.0.0.1:6768/",
      timeoutMs: 500,
      intervalMs: 250,
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:6768");
      },
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });

    expect(result.ok).toBe(false);
    const reason = result.ok ? "" : result.reason;
    expect(reason).toContain("did not answer within 0.5s");
    expect(reason).toContain("ECONNREFUSED");
  });
});

describe("desktop web startup waiting page", () => {
  it("shows a self-contained waiting page without scripts", () => {
    const html = buildDesktopWebStartingHtml();

    expect(html).toContain("<h1>Neox is starting</h1>");
    expect(html).toContain("Waiting for the local server");
    expect(html).not.toContain("<script");
  });

  it("builds a data URL that decodes back to the page", () => {
    const url = buildDesktopWebStartingUrl();

    expect(url.startsWith("data:text/html;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(url.slice("data:text/html;charset=utf-8,".length))).toContain(
      "Neox is starting",
    );
  });
});

describe("desktop web startup error page", () => {
  it("escapes the reason and log path and offers Retry", () => {
    const html = buildDesktopWebStartupErrorHtml({
      reason: '<boom & "bang">',
      logPath: "/tmp/a<b>&c.log",
    });

    expect(html).toContain('href="https://desktop-web-retry.invalid/retry"');
    expect(html).toContain("&lt;boom &amp; &quot;bang&quot;&gt;");
    expect(html).toContain("/tmp/a&lt;b&gt;&amp;c.log");
    expect(html).not.toContain("<script");
  });

  it("builds a data URL that decodes back to the page", () => {
    const url = buildDesktopWebStartupErrorUrl({
      reason: "No daemon",
      logPath: "/tmp/neox.log",
    });

    expect(url.startsWith("data:text/html;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(url.slice("data:text/html;charset=utf-8,".length))).toContain(
      "Neox could not start",
    );
    expect(url).toContain(encodeURIComponent(DESKTOP_WEB_STARTUP_RETRY_URL));
  });
});

describe("desktop web startup language", () => {
  it("follows the saved language before the system locale", () => {
    expect(resolveDesktopWebStartupLocale("zh-CN", "en-US")).toBe("zh-CN");
    expect(resolveDesktopWebStartupLocale("en", "zh-Hans-CN")).toBe("en");
  });

  it("follows the system locale when the setting is empty or system", () => {
    expect(resolveDesktopWebStartupLocale("", "zh-Hans-CN")).toBe("zh-CN");
    expect(resolveDesktopWebStartupLocale("system", "zh_CN")).toBe("zh-CN");
    expect(resolveDesktopWebStartupLocale("", "fr-FR")).toBe("en");
  });

  it("renders the waiting and error pages in Chinese", () => {
    expect(buildDesktopWebStartingHtml({ locale: "zh-CN" })).toContain("<h1>Neox 正在启动</h1>");
    const error = buildDesktopWebStartupErrorHtml({
      reason: "",
      logPath: "/tmp/neox.log",
      locale: "zh-CN",
    });
    expect(error).toContain("<h1>Neox 无法启动</h1>");
    expect(error).toContain("未知错误。");
    expect(error).toContain(">重试</a>");
    expect(error).toContain("日志：");
  });
});
