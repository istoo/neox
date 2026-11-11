import { describe, expect, it, vi } from "vitest";

import {
  createPluginWebHandler,
  injectPluginWebBootstrap,
  parsePluginWebPath,
  pluginWebCsp,
  type PluginWebAsset,
} from "./pluginWeb.ts";

const SESSION = "session-12345678";

function handler(asset: Partial<PluginWebAsset> | Error = {}) {
  const readAsset = vi.fn(async (): Promise<PluginWebAsset> => {
    if (asset instanceof Error) throw asset;
    return {
      contentType: "text/html",
      encoding: "utf8",
      content: "<html><head></head><body>hi</body></html>",
      ...asset,
    };
  });
  return {
    readAsset,
    handle: createPluginWebHandler({
      readAsset,
      frameAncestorOrigins: ["http://localhost:5742", "not-an-origin"],
    }),
  };
}

function request(pathname: string, search = `neolixSession=${SESSION}`) {
  return { method: "GET", pathname, searchParams: new URLSearchParams(search) };
}

describe("plugin web route", () => {
  it("serves the entry with strict CSP, nosniff, session meta, and the SDK script", async () => {
    const { handle, readAsset } = handler();
    const response = await handle(request("/plugin-web/example/web/main.html"));
    expect(readAsset).toHaveBeenCalledWith("example", "web/main.html");
    expect(response.status).toBe(200);
    expect(response.headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(response.headers["Content-Security-Policy"]).toContain("default-src 'none'");
    expect(response.headers["Content-Security-Policy"]).toContain("script-src 'self'");
    expect(response.headers["Content-Security-Policy"]).toContain(
      "frame-ancestors 'self' http://localhost:5742",
    );
    const body = String(response.body);
    expect(body).toContain(`<meta name="neolix-session" content="${SESSION}">`);
    expect(body).toContain('<script src="/plugin-web/example/__neolix_sdk.js"></script>');
    expect(body).toContain("<body>hi</body>");
  });

  it("serves the SDK script without an inline-script CSP exception", async () => {
    const { handle, readAsset } = handler();
    const response = await handle(request("/plugin-web/example/__neolix_sdk.js"));
    expect(readAsset).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(response.headers["Content-Type"]).toContain("text/javascript");
    expect(response.body).toContain('meta[name="neolix-session"]');
    expect(response.body).toContain('defineProperty(window, "neolix"');
  });

  it("serves nested script assets as bytes with their content type", async () => {
    const { handle } = handler({
      contentType: "text/javascript",
      content: "console.log('plugin')",
    });
    const response = await handle(request("/plugin-web/example/web/main.js", ""));
    expect(response.status).toBe(200);
    expect(response.headers["Content-Type"]).toBe("text/javascript");
    expect(response.headers["Content-Security-Policy"]).toBeUndefined();
    expect(new TextDecoder().decode(response.body as Uint8Array)).toBe("console.log('plugin')");
  });

  it("decodes binary assets", async () => {
    const { handle } = handler({
      contentType: "image/png",
      encoding: "base64",
      content: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
    });
    const response = await handle(request("/plugin-web/example/web/pixel.png", ""));
    expect(response.body).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  });

  it.each([
    "/plugin-web/example/../secret.html",
    "/plugin-web/example/%2e%2e/secret.html",
    "/plugin-web/example/web/..%2f..%2fsecret.html",
    "/plugin-web/example/%2Fetc%2Fpasswd.html",
    "/plugin-web/example/web%5Cmain.html",
  ])("rejects traversal before touching the daemon: %s", async (pathname) => {
    const { handle, readAsset } = handler();
    const response = await handle(request(pathname));
    expect(response.status).toBe(404);
    expect(readAsset).not.toHaveBeenCalled();
  });

  it("rejects extensions outside the daemon allowlist without calling the daemon", async () => {
    const { handle, readAsset } = handler();
    const response = await handle(request("/plugin-web/example/web/notes.txt", ""));
    expect(response.status).toBe(404);
    expect(readAsset).not.toHaveBeenCalled();
  });

  it("maps a disabled or missing plugin to 404", async () => {
    const { handle } = handler(new Error('Plugin "example" is disabled'));
    const response = await handle(request("/plugin-web/example/web/main.html"));
    expect(response.status).toBe(404);
    expect(String(response.body)).toBe("Not found");
  });

  it("requires a valid per-frame session for HTML", async () => {
    const { handle } = handler();
    expect((await handle(request("/plugin-web/example/web/main.html", ""))).status).toBe(400);
    expect(
      (await handle(request("/plugin-web/example/web/main.html", "neolixSession=short"))).status,
    ).toBe(400);
  });

  it("rejects non-GET methods", async () => {
    const { handle } = handler();
    const response = await handle({
      ...request("/plugin-web/example/web/main.html"),
      method: "POST",
    });
    expect(response.status).toBe(405);
    expect(response.headers.Allow).toBe("GET");
  });

  it("rejects malformed plugin IDs and paths", () => {
    expect(parsePluginWebPath("/plugin-web/Example/web/main.html")).toBeNull();
    expect(parsePluginWebPath("/plugin-web/example")).toBeNull();
    expect(parsePluginWebPath("/plugin-web/example/%E0%A4%A/web/main.js")).toBeNull();
    expect(parsePluginWebPath("/plugin-web/example/web/main.html")).toEqual({
      pluginId: "example",
      assetPath: "web/main.html",
    });
  });

  it("escapes the session and injects the SDK into fragments", () => {
    const html = injectPluginWebBootstrap("<p>hi</p>", "example", '"><script>alert(1)</script>');
    expect(html).not.toContain('"><script>alert(1)</script>');
    expect(html).toContain("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("<body><p>hi</p></body>");
  });

  it("drops invalid frame ancestor origins", () => {
    const csp = pluginWebCsp(["http://localhost:5742", "javascript:alert(1)", "/relative"]);
    expect(csp).toContain("frame-ancestors 'self' http://localhost:5742");
    expect(csp).not.toContain("javascript:");
  });
});
